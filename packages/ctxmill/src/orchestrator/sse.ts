import type { FastifyReply } from 'fastify';

/**
 * Manages SSE connections per agent, broadcasting AG-UI events
 * and sending periodic heartbeats to keep connections alive.
 */
export class SSEManager {
  private connections = new Map<string, Set<FastifyReply>>();
  private heartbeatIntervals = new Map<FastifyReply, NodeJS.Timeout>();
  private lastActivityMap = new Map<string, number>();

  /**
   * Subscribe a client connection to an agent's event stream.
   * Sets up heartbeat and cleanup on disconnect.
   */
  subscribe(agentId: string, reply: FastifyReply): void {
    if (!this.connections.has(agentId)) {
      this.connections.set(agentId, new Set());
    }
    this.connections.get(agentId)!.add(reply);

    // Send heartbeat comment every 15s to keep connection alive
    const interval = setInterval(() => {
      try {
        reply.raw.write(': heartbeat\n\n');
      } catch {
        // Connection may have closed; cleanup will handle it
        this.unsubscribe(agentId, reply);
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
    this.connections.get(agentId)?.delete(reply);
    if (this.connections.get(agentId)?.size === 0) {
      this.connections.delete(agentId);
    }
    const interval = this.heartbeatIntervals.get(reply);
    if (interval) {
      clearInterval(interval);
      this.heartbeatIntervals.delete(reply);
    }
  }

  /**
   * Broadcast an AG-UI event to all clients subscribed to an agent.
   */
  broadcast(agentId: string, event: Record<string, unknown>): void {
    const clients = this.connections.get(agentId);
    if (!clients || clients.size === 0) return;
    this.lastActivityMap.set(agentId, Date.now());
    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const reply of clients) {
      try {
        reply.raw.write(data);
      } catch {
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
        } catch {
          // ignore
        }
      }
    }
    this.connections.clear();
    this.heartbeatIntervals.clear();
  }
}
