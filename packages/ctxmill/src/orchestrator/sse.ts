import type { FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { TypedEventBus } from '../events/bus.js';

const MAX_QUEUE_SIZE = 100;
const DURABLE_REPLAY_PAGE_SIZE = 1_000;
const DURABLE_TAIL_POLL_INTERVAL_MS = 250;

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

export function writeSseHead(reply: FastifyReply): void {
  // Writing to reply.raw bypasses Fastify's reply pipeline, which is where
  // @fastify/cors put its headers. Carry them over or cross-origin browsers
  // (e.g. the hosted artifact console) cancel the stream right after the 200.
  const corsHeaders: Record<string, string> = {};
  for (const [name, value] of Object.entries(reply.getHeaders())) {
    if (name.toLowerCase().startsWith('access-control-') || name.toLowerCase() === 'vary') {
      if (typeof value === 'string') corsHeaders[name] = value;
      else if (Array.isArray(value)) corsHeaders[name] = value.join(', ');
    }
  }
  reply.raw.writeHead(200, {
    ...corsHeaders,
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
}

const MAX_HEARTBEAT_FAILURES = 3;
export type StreamAuthorizationCheck = () => Promise<boolean>;

interface ConnectionState {
  queue: string[];
  draining: boolean;
  drainWaiters: Set<(connected: boolean) => void>;
  lastEventTime: number;
  consecutiveHeartbeatFailures: number;
  agentId: string;
  clientId: string;
  durableTail: DurableTailState | null;
  authorizationCheck: StreamAuthorizationCheck | null;
  authorizationCheckInFlight: boolean;
}

export interface DurableSseFrame {
  seq: number;
  event: Record<string, unknown>;
}

export interface DurableTailSource {
  getWatermark(): Promise<number>;
  getPage(
    afterSeq: number,
    throughSeq: number,
    limit: number,
  ): Promise<DurableSseFrame[]>;
}

interface DurableTailState {
  cursor: number;
  source: DurableTailSource;
  draining: boolean;
  rerun: boolean;
  pollInterval: NodeJS.Timeout | null;
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
  private eventBus?: TypedEventBus;

  constructor(eventBus?: TypedEventBus) {
    this.eventBus = eventBus;
  }

  /**
   * Subscribe a client connection to an agent's event stream.
   * Sets up heartbeat and cleanup on disconnect.
   */
  subscribe(
    agentId: string,
    reply: FastifyReply,
    authorizationCheck?: StreamAuthorizationCheck,
  ): void {
    this.registerConnection(agentId, reply, null, authorizationCheck ?? null);
  }

  /**
   * Subscribe through the durable database tail. The connection is registered
   * before its first query, local broadcasts wake the tail after commit, and a
   * polling fallback observes commits from other orchestrator processes.
   */
  async subscribeDurable(
    agentId: string,
    reply: FastifyReply,
    afterSeq: number,
    initialThroughSeq: number,
    source: DurableTailSource,
    authorizationCheck?: StreamAuthorizationCheck,
  ): Promise<void> {
    const durableTail: DurableTailState = {
      cursor: afterSeq,
      source,
      draining: false,
      rerun: false,
      pollInterval: null,
    };
    this.registerConnection(agentId, reply, durableTail, authorizationCheck ?? null);
    try {
      await this.drainDurableTail(reply, initialThroughSeq);
    } catch (error) {
      this.unsubscribe(agentId, reply);
      throw error;
    }

    const state = this.connectionState.get(reply);
    if (!state?.durableTail) return;
    state.durableTail.pollInterval = setInterval(() => {
      this.wakeDurableTail(reply);
    }, DURABLE_TAIL_POLL_INTERVAL_MS);
    // Close the cross-process race between the fixed initial watermark and
    // installing the fallback poller.
    this.wakeDurableTail(reply);
  }

  private registerConnection(
    agentId: string,
    reply: FastifyReply,
    durableTail: DurableTailState | null,
    authorizationCheck: StreamAuthorizationCheck | null,
  ): void {
    const clientId = randomUUID();
    const state: ConnectionState = {
      queue: [],
      draining: false,
      drainWaiters: new Set(),
      lastEventTime: Date.now(),
      consecutiveHeartbeatFailures: 0,
      agentId,
      clientId,
      durableTail,
      authorizationCheck,
      authorizationCheckInFlight: false,
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
        this.resolveDrainWaiters(st, true);
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
      this.resolveDrainWaiters(st, true);
    });

    // Send heartbeat comment every 15s to keep connection alive
    const interval = setInterval(() => {
      void this.sendHeartbeat(agentId, reply);
    }, 15_000);
    this.heartbeatIntervals.set(reply, interval);

    // Cleanup on close
    reply.raw.on('close', () => this.unsubscribe(agentId, reply));
  }

  private async sendHeartbeat(agentId: string, reply: FastifyReply): Promise<void> {
    const state = this.connectionState.get(reply);
    if (!state) {
      this.unsubscribe(agentId, reply);
      return;
    }

    if (state.authorizationCheck) {
      if (state.authorizationCheckInFlight) return;
      state.authorizationCheckInFlight = true;
      let live = false;
      try {
        live = await state.authorizationCheck();
      } catch (error) {
        console.warn('[SSE] Scoped key revalidation failed for agent', agentId, error);
      }

      const current = this.connectionState.get(reply);
      if (!current) return;
      current.authorizationCheckInFlight = false;
      if (!live) {
        this.unsubscribe(agentId, reply);
        try {
          reply.raw.end();
        } catch (error) {
          console.debug('[SSE] Failed to close unauthorized stream for agent', agentId, error);
        }
        return;
      }
    }

    const current = this.connectionState.get(reply);
    if (!current) return;
    try {
      reply.raw.write(': heartbeat\n\n');
      current.consecutiveHeartbeatFailures = 0;
    } catch (error) {
      console.warn('[SSE] Heartbeat failed for agent', agentId, error);
      current.consecutiveHeartbeatFailures++;
      if (current.consecutiveHeartbeatFailures >= MAX_HEARTBEAT_FAILURES) {
        this.unsubscribe(agentId, reply);
      }
    }
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
    if (state?.durableTail?.pollInterval) {
      clearInterval(state.durableTail.pollInterval);
      state.durableTail.pollInterval = null;
    }
    if (state) {
      this.resolveDrainWaiters(state, false);
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
   * Serve-mode broadcast: ordinary subscribers receive the durable frame
   * immediately. Durable subscribers treat this as a low-latency wake and read
   * the database, preserving sequence order and cross-process correctness.
   */
  broadcastFrame(agentId: string, event: Record<string, unknown>, seq: number): void {
    this.lastActivityMap.set(agentId, Date.now());

    const clients = this.connections.get(agentId);
    if (!clients || clients.size === 0) return;
    const data = `id: ${formatSeqId(seq)}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const reply of clients) {
      const state = this.connectionState.get(reply);
      if (!state) continue;
      if (state.durableTail) {
        state.durableTail.rerun = true;
        this.wakeDurableTail(reply);
        continue;
      }
      this.writeToClient(agentId, reply, data);
    }
  }

  private wakeDurableTail(reply: FastifyReply): void {
    void this.drainDurableTail(reply).catch((error) => {
      const state = this.connectionState.get(reply);
      if (!state) return;
      console.warn('[SSE] Durable tail query failed for agent', state.agentId, error);
    });
  }

  private async drainDurableTail(
    reply: FastifyReply,
    initialThroughSeq?: number,
  ): Promise<void> {
    const initialState = this.connectionState.get(reply);
    const initialTail = initialState?.durableTail;
    if (!initialState || !initialTail) return;
    if (initialTail.draining) {
      initialTail.rerun = true;
      return;
    }

    initialTail.draining = true;
    let fixedThroughSeq = initialThroughSeq;
    try {
      do {
        const state = this.connectionState.get(reply);
        const tail = state?.durableTail;
        if (!state || !tail) return;
        tail.rerun = false;
        const throughSeq = fixedThroughSeq
          ?? await tail.source.getWatermark();
        fixedThroughSeq = undefined;
        const targetSeq = Math.max(tail.cursor, throughSeq);

        while (tail.cursor < targetSeq) {
          const page = await tail.source.getPage(
            tail.cursor,
            targetSeq,
            DURABLE_REPLAY_PAGE_SIZE,
          );
          if (page.length === 0) {
            // The watermark is agent-scoped while this tail may select only
            // run-channel rows. Advancing over other channels is intentional.
            tail.cursor = targetSeq;
            break;
          }

          for (const frame of page) {
            if (frame.seq <= tail.cursor || frame.seq > targetSeq) {
              throw new Error(
                `Durable tail returned out-of-range seq ${frame.seq} ` +
                `after ${tail.cursor} through ${targetSeq}`,
              );
            }
            this.writeToClient(
              state.agentId,
              reply,
              `id: ${formatSeqId(frame.seq)}\ndata: ${JSON.stringify(frame.event)}\n\n`,
            );
            if (!this.connectionState.has(reply)) return;
            tail.cursor = frame.seq;
            const drain = this.waitForDrain(reply);
            if (drain && !await drain) return;
          }

          if (page.length < DURABLE_REPLAY_PAGE_SIZE) {
            tail.cursor = targetSeq;
            break;
          }
        }
      } while (this.connectionState.get(reply)?.durableTail?.rerun);
    } finally {
      const state = this.connectionState.get(reply);
      if (state?.durableTail) {
        state.durableTail.draining = false;
      }
    }
  }

  private waitForDrain(reply: FastifyReply): Promise<boolean> | null {
    const state = this.connectionState.get(reply);
    if (!state || (!state.draining && state.queue.length === 0)) {
      return null;
    }
    return new Promise((resolve) => {
      state.drainWaiters.add(resolve);
    });
  }

  private resolveDrainWaiters(state: ConnectionState, connected: boolean): void {
    for (const resolve of state.drainWaiters) {
      resolve(connected);
    }
    state.drainWaiters.clear();
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
  }
}
