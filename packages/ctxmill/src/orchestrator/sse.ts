import type { FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { TypedEventBus } from '../events/bus.js';

const MAX_QUEUE_SIZE = 100;
const MAX_EVENT_HISTORY = 50;
const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const MAX_HEARTBEAT_FAILURES = 3;

interface ConnectionState {
  queue: string[];
  draining: boolean;
  lastEventTime: number;
  consecutiveHeartbeatFailures: number;
  agentId: string;
  clientId: string;
  /** Last event ID this client has acknowledged (via Last-Event-ID on reconnect). */
  lastEventId?: string;
}

interface HistoryEntry {
  id: string;
  event: Record<string, unknown>;
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
  private eventHistory = new Map<string, HistoryEntry[]>();
  private eventSeq = 0;
  private eventBus?: TypedEventBus;

  constructor(eventBus?: TypedEventBus) {
    this.eventBus = eventBus;
  }

  /**
   * Subscribe a client connection to an agent's event stream.
   * Sets up heartbeat and cleanup on disconnect.
   */
  subscribe(agentId: string, reply: FastifyReply, lastEventId?: string): void {
    const clientId = randomUUID();
    const state: ConnectionState = {
      queue: [],
      draining: false,
      lastEventTime: Date.now(),
      consecutiveHeartbeatFailures: 0,
      agentId,
      clientId,
      lastEventId,
    };
    this.connectionState.set(reply, state);

    const history = this.eventHistory.get(agentId) ?? [];
    try {
      let replaying = !lastEventId;
      for (const entry of history) {
        if (!replaying) {
          if (entry.id === lastEventId) {
            replaying = true;
          }
          continue;
        }
        reply.raw.write(`id: ${entry.id}\ndata: ${JSON.stringify(entry.event)}\n\n`);
      }
    } catch (writeErr) {
      console.debug('[SSE] Failed to replay history for agent', agentId, writeErr);
      this.connectionState.delete(reply);
      return;
    }

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

        // Check idle timeout: idle > 5 minutes with no active runs
        if (st && Date.now() - st.lastEventTime > IDLE_TIMEOUT_MS) {
          console.info('[SSE] Closing idle connection for agent', agentId);
          this.unsubscribe(agentId, reply);
          try {
            reply.raw.end();
          } catch (endErr) {
            console.debug('[SSE] Failed to end idle connection for agent', agentId, endErr);
          }
          return;
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
   * Broadcast an AG-UI event to all clients subscribed to an agent.
   */
  broadcast(agentId: string, event: Record<string, unknown>): void {
    this.lastActivityMap.set(agentId, Date.now());

    this.eventSeq++;
    const eventId = `${agentId}-${this.eventSeq}`;

    if (event.type === 'RUN_FINISHED' || event.type === 'RUN_ERROR') {
      this.eventHistory.delete(agentId);
    } else {
      const history = this.eventHistory.get(agentId) ?? [];
      history.push({ id: eventId, event });
      if (history.length > MAX_EVENT_HISTORY) {
        history.splice(0, history.length - MAX_EVENT_HISTORY);
      }
      this.eventHistory.set(agentId, history);
    }

    const clients = this.connections.get(agentId);
    if (!clients || clients.size === 0) return;
    const data = `id: ${eventId}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const reply of clients) {
      const state = this.connectionState.get(reply);
      if (state) {
        state.lastEventTime = Date.now();
      }

      // If there's already a backlog or we're back-pressured, queue directly
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
        continue;
      }

      try {
        const ok = reply.raw.write(data);
        if (ok === false && state) {
          // Kernel buffer full. The data was accepted by Node's internal buffer
          // but we should queue future writes until 'drain' fires.
          // Push a sentinel so queue.length > 0 triggers queueing for next events.
          // The drain handler will clear it.
          state.draining = true;
        }
      } catch (writeErr) {
        console.debug('[SSE] Write failed for agent', agentId, '— client likely disconnected', writeErr);
        this.unsubscribe(agentId, reply);
      }
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
    this.eventHistory.clear();
  }
}
