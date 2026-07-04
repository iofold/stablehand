import type { FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { TypedEventBus } from '../events/bus.js';

const MAX_QUEUE_SIZE = 100;
const RECENT_FRAMES_CAP = 256;

/**
 * Serve-mode SSE ids are zero-padded global seqs so lexicographic order equals
 * numeric order — pilot's proxy replay fallback compares ids as strings.
 */
export function formatSeqId(seq: number): string {
  return String(seq).padStart(12, '0');
}

/** Parse a durable seq id; null for legacy/unknown formats (treat as fresh connect). */
export function parseSeqId(id: string | undefined): number | null {
  if (!id || !/^\d{1,15}$/.test(id)) {
    return null;
  }
  const parsed = Number(id);
  return Number.isSafeInteger(parsed) ? parsed : null;
}
const MAX_HEARTBEAT_FAILURES = 3;

export type WireMode = 'legacy' | 'canonical';

/** Both renderings of a canonical frame; legacy is null for canonical-only frames. */
export interface WireRenderings {
  legacy: Record<string, unknown> | null;
  canonical: Record<string, unknown>;
}

interface ConnectionState {
  queue: string[];
  draining: boolean;
  lastEventTime: number;
  consecutiveHeartbeatFailures: number;
  agentId: string;
  clientId: string;
  /** Wire negotiation (ADR-015): which vocabulary this client receives. */
  wireMode?: WireMode;
}

/**
 * Manages SSE connections per agent, broadcasting AG-UI events
 * and sending periodic heartbeats to keep connections alive.
 */
export class SSEManager {
  private connections = new Map<string, Set<FastifyReply>>();
  private heartbeatIntervals = new Map<FastifyReply, NodeJS.Timeout>();
  private lastActivityMap = new Map<string, number>();
  private connectionState = new Map<FastifyReply, ConnectionState>();
  /** Attach buffer: recent frames per agent for the replay→live-tail handoff. */
  private recentFrames = new Map<string, Array<{ seq: number; renderings: WireRenderings }>>();
  private eventBus?: TypedEventBus;

  constructor(eventBus?: TypedEventBus) {
    this.eventBus = eventBus;
  }

  /**
   * Subscribe a client connection to an agent's event stream.
   * Sets up heartbeat and cleanup on disconnect.
   */
  subscribe(agentId: string, reply: FastifyReply): void {
    const clientId = randomUUID();
    const state: ConnectionState = {
      queue: [],
      draining: false,
      lastEventTime: Date.now(),
      consecutiveHeartbeatFailures: 0,
      agentId,
      clientId,
    };
    this.connectionState.set(reply, state);

    if (!this.connections.has(agentId)) {
      this.connections.set(agentId, new Set());
    }
    this.connections.get(agentId)!.add(reply);

    // Emit client connected event
    if (this.eventBus) {
      this.eventBus.emit('client.connected', {
        agentId,
        clientId,
        timestamp: Date.now(),
      });
    }

    // Listen for errors on the raw stream
    reply.raw.on('error', () => this.unsubscribe(agentId, reply));

    // Listen for drain to flush queued items
    reply.raw.on('drain', () => {
      const st = this.connectionState.get(reply);
      if (!st) return;
      if (st.queue.length === 0) {
        st.draining = false;
        return;
      }
      while (st.queue.length > 0) {
        const item = st.queue[0];
        const ok = reply.raw.write(item);
        st.queue.shift();
        if (!ok) {
          // Back-pressured again, wait for next drain
          return;
        }
      }
      st.draining = false;
    });

    // Send heartbeat comment every 15s to keep connection alive
    const interval = setInterval(() => {
      const st = this.connectionState.get(reply);
      try {
        reply.raw.write(': heartbeat\n\n');
        // Reset consecutive failures on success
        if (st) {
          st.consecutiveHeartbeatFailures = 0;
        }
      } catch (err) {
        console.warn('[SSE] Heartbeat failed for agent', agentId, err);
        if (st) {
          st.consecutiveHeartbeatFailures++;
          if (st.consecutiveHeartbeatFailures >= MAX_HEARTBEAT_FAILURES) {
            this.unsubscribe(agentId, reply);
          }
        } else {
          // No state means we should clean up
          this.unsubscribe(agentId, reply);
        }
      }
    }, 15_000);
    this.heartbeatIntervals.set(reply, interval);

    // Cleanup on close
    reply.raw.on('close', () => this.unsubscribe(agentId, reply));
  }

  /**
   * Unsubscribe a client connection from an agent's event stream.
   */
  unsubscribe(agentId: string, reply: FastifyReply): void {
    const state = this.connectionState.get(reply);
    this.connections.get(agentId)?.delete(reply);
    if (this.connections.get(agentId)?.size === 0) {
      this.connections.delete(agentId);
    }
    const interval = this.heartbeatIntervals.get(reply);
    if (interval) {
      clearInterval(interval);
      this.heartbeatIntervals.delete(reply);
    }
    this.connectionState.delete(reply);

    // Emit client disconnected event
    if (this.eventBus && state) {
      this.eventBus.emit('client.disconnected', {
        agentId,
        clientId: state.clientId,
        timestamp: Date.now(),
      });
    }
  }

  /**
   * Serve-mode broadcast (ADR-015): the event id is the durable global seq.
   * Each client receives its negotiated vocabulary (Phase B: legacy default,
   * ?wire=canonical opt-in). Frames also land in a small per-agent ring buffer
   * so subscribeDurable can close the SERIAL-vs-commit-order race between a
   * reconnect's DB replay and the live tail.
   */
  broadcastFrame(agentId: string, renderings: WireRenderings, seq: number): void {
    this.lastActivityMap.set(agentId, Date.now());

    let ring = this.recentFrames.get(agentId);
    if (!ring) {
      ring = [];
      this.recentFrames.set(agentId, ring);
    }
    ring.push({ seq, renderings });
    if (ring.length > RECENT_FRAMES_CAP) {
      ring.splice(0, ring.length - RECENT_FRAMES_CAP);
    }

    const rendered: Partial<Record<WireMode, string | null>> = {};
    const clients = this.connections.get(agentId);
    if (!clients || clients.size === 0) return;
    for (const reply of clients) {
      const state = this.connectionState.get(reply);
      const mode: WireMode = state?.wireMode ?? 'legacy';
      if (!(mode in rendered)) {
        const event = mode === 'canonical' ? renderings.canonical : renderings.legacy;
        rendered[mode] = event ? `id: ${formatSeqId(seq)}\ndata: ${JSON.stringify(event)}\n\n` : null;
      }
      const data = rendered[mode];
      if (data) {
        this.writeToClient(agentId, reply, data);
      }
    }
  }

  /**
   * Serve-mode subscribe: the caller replayed durable frames after the
   * client's acked seq and passes exactly what it wrote (`replayedSeqs`).
   * Buffered frames the DB query could not see yet — a batch with lower seqs
   * that committed after the query (SERIAL-vs-commit-order race) — are
   * flushed from the ring before attaching to the live tail.
   */
  subscribeDurable(
    agentId: string,
    reply: FastifyReply,
    afterSeq: number,
    replayedSeqs: ReadonlySet<number>,
    wireMode: WireMode = 'legacy',
  ): void {
    const ring = this.recentFrames.get(agentId) ?? [];
    const gap = ring
      .filter((entry) => entry.seq > afterSeq && !replayedSeqs.has(entry.seq))
      .sort((a, b) => a.seq - b.seq);
    try {
      for (const entry of gap) {
        const event = wireMode === 'canonical' ? entry.renderings.canonical : entry.renderings.legacy;
        if (event) {
          reply.raw.write(`id: ${formatSeqId(entry.seq)}\ndata: ${JSON.stringify(event)}\n\n`);
        }
      }
    } catch (writeErr) {
      console.debug('[SSE] Failed to flush attach buffer for agent', agentId, writeErr);
      return;
    }
    this.subscribe(agentId, reply);
    const state = this.connectionState.get(reply);
    if (state) {
      state.wireMode = wireMode;
    }
  }

  private writeToClient(agentId: string, reply: FastifyReply, data: string): void {
    const state = this.connectionState.get(reply);
    if (state) {
      state.lastEventTime = Date.now();
    }

    if (state && (state.queue.length > 0 || state.draining)) {
      if (state.queue.length >= MAX_QUEUE_SIZE) {
        console.warn('[SSE] Disconnecting slow client');
        this.unsubscribe(agentId, reply);
        try {
          reply.raw.end();
        } catch (endErr) {
          console.debug('[SSE] Failed to end slow client connection', endErr);
        }
      } else {
        state.queue.push(data);
      }
      return;
    }

    try {
      const ok = reply.raw.write(data);
      if (ok === false && state) {
        state.draining = true;
      }
    } catch (writeErr) {
      console.debug('[SSE] Write failed for agent', agentId, '— client likely disconnected', writeErr);
      this.unsubscribe(agentId, reply);
    }
  }

  /**
   * Get the number of active SSE clients for an agent.
   */
  getClientCount(agentId: string): number {
    return this.connections.get(agentId)?.size ?? 0;
  }

  /**
   * Get agent IDs that have at least one connected SSE client.
   */
  getActiveAgentIds(): string[] {
    const ids: string[] = [];
    for (const [agentId, clients] of this.connections) {
      if (clients.size > 0) {
        ids.push(agentId);
      }
    }
    return ids;
  }

  /**
   * Get the timestamp of the last SSE event broadcast for an agent.
   * Returns undefined if no event has been broadcast.
   */
  getLastActivity(agentId: string): number | undefined {
    return this.lastActivityMap.get(agentId);
  }

  /**
   * Tear down all connections and intervals. Call on server shutdown.
   */
  shutdown(): void {
    for (const [agentId, clients] of this.connections) {
      for (const reply of clients) {
        this.unsubscribe(agentId, reply);
        try {
          reply.raw.end();
        } catch (endErr) {
          console.debug('[SSE] Failed to end connection during shutdown for agent', agentId, endErr);
        }
      }
    }
    this.connections.clear();
    this.heartbeatIntervals.clear();
    this.connectionState.clear();
    this.recentFrames.clear();
  }
}
