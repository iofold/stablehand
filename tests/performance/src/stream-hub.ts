import type {
  AgentEventStreamItem,
} from '../../../packages/client/src/index.js';

import {
  eventTurnId,
  observeTurnEvent,
  type TurnEventObservation,
} from './events.js';

interface AgentStreamHubOptions {
  agentId: string;
  clients: number;
  stream: (input: {
    agentId: string;
    signal: AbortSignal;
  }) => AsyncGenerator<AgentEventStreamItem>;
  now?: () => number;
}

export interface TurnStreamResult {
  observation: TurnEventObservation;
  clientEventCounts: number[];
  clientEventSequences: string[][];
  heartbeatCounts: number[];
}

interface TurnTracker {
  observations: TurnEventObservation[];
  eventSequences: string[][];
  heartbeatCounts: number[];
  terminalClients: Set<number>;
  resolve: (result: TurnStreamResult) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

function errorValue(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export class AgentStreamHub {
  private readonly abort = new AbortController();
  private readonly ready: Array<Promise<void>>;
  private readonly resolveReady: Array<() => void>;
  private readonly rejectReady: Array<(error: Error) => void>;
  private readonly trackers = new Map<string, TurnTracker>();
  private readonly now: () => number;
  private tasks: Array<Promise<void>> = [];
  private started = false;

  constructor(private readonly options: AgentStreamHubOptions) {
    if (!Number.isInteger(options.clients) || options.clients < 1) {
      throw new Error('AgentStreamHub clients must be a positive integer');
    }
    this.now = options.now ?? Date.now;
    this.resolveReady = [];
    this.rejectReady = [];
    this.ready = Array.from({ length: options.clients }, (_, index) =>
      new Promise<void>((resolve, reject) => {
        this.resolveReady[index] = resolve;
        this.rejectReady[index] = reject;
      }));
  }

  async start(timeoutMs: number): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.tasks = Array.from(
      { length: this.options.clients },
      (_, clientIndex) => this.consume(clientIndex),
    );
    await this.withTimeout(
      Promise.all(this.ready).then(() => undefined),
      timeoutMs,
      `Timed out opening ${this.options.clients} SSE client(s) for agent ${this.options.agentId}`,
    );
  }

  trackTurn(turnId: string, timeoutMs: number): Promise<TurnStreamResult> {
    if (!this.started) {
      throw new Error('AgentStreamHub must be started before tracking a turn');
    }
    if (this.trackers.has(turnId)) {
      throw new Error(`Turn ${turnId} is already tracked`);
    }

    return new Promise<TurnStreamResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.trackers.delete(turnId);
        reject(new Error(
          `Timed out waiting for turn ${turnId} on ${this.options.clients} SSE client(s)`,
        ));
      }, timeoutMs);
      this.trackers.set(turnId, {
        observations: Array.from(
          { length: this.options.clients },
          () => ({}),
        ),
        eventSequences: Array.from(
          { length: this.options.clients },
          () => [],
        ),
        heartbeatCounts: Array.from(
          { length: this.options.clients },
          () => 0,
        ),
        terminalClients: new Set(),
        resolve,
        reject,
        timeout,
      });
    });
  }

  cancelTurn(turnId: string, error: unknown): void {
    const tracker = this.trackers.get(turnId);
    if (!tracker) return;
    clearTimeout(tracker.timeout);
    this.trackers.delete(turnId);
    tracker.reject(errorValue(error));
  }

  async stop(): Promise<void> {
    if (!this.abort.signal.aborted) {
      this.abort.abort(new Error('SSE hub stopped'));
    }
    for (const [turnId, tracker] of this.trackers) {
      clearTimeout(tracker.timeout);
      tracker.reject(new Error(`SSE hub stopped before turn ${turnId} completed`));
    }
    this.trackers.clear();
    await Promise.allSettled(this.tasks);
  }

  private async consume(clientIndex: number): Promise<void> {
    try {
      const stream = this.options.stream({
        agentId: this.options.agentId,
        signal: this.abort.signal,
      });
      for await (const item of stream) {
        if (item.event?.type === 'CONNECTED') {
          this.resolveReady[clientIndex]?.();
          continue;
        }
        if (item.event === null) {
          for (const tracker of this.trackers.values()) {
            tracker.heartbeatCounts[clientIndex] =
              (tracker.heartbeatCounts[clientIndex] ?? 0) + 1;
          }
          continue;
        }

        const turnId = eventTurnId(item.event);
        if (!turnId) continue;
        const tracker = this.trackers.get(turnId);
        if (!tracker) continue;
        tracker.eventSequences[clientIndex]!.push(
          `${item.id ?? 'missing-id'}:${item.event.type}`,
        );
        const observation = tracker.observations[clientIndex]!;
        observeTurnEvent(observation, item.event, this.now());
        if (
          item.event.type === 'RUN_FINISHED'
          || item.event.type === 'RUN_ERROR'
        ) {
          tracker.terminalClients.add(clientIndex);
          if (tracker.terminalClients.size === this.options.clients) {
            clearTimeout(tracker.timeout);
            this.trackers.delete(turnId);
            tracker.resolve({
              observation: tracker.observations[0]!,
              clientEventCounts: tracker.observations.map(
                (entry) => entry.eventCount ?? 0,
              ),
              clientEventSequences: tracker.eventSequences,
              heartbeatCounts: tracker.heartbeatCounts,
            });
          }
        }
      }
      if (!this.abort.signal.aborted) {
        throw new Error(`SSE stream ended for agent ${this.options.agentId}`);
      }
    } catch (error) {
      if (this.abort.signal.aborted) return;
      const normalized = errorValue(error);
      this.rejectReady[clientIndex]?.(normalized);
      for (const [turnId, tracker] of this.trackers) {
        clearTimeout(tracker.timeout);
        tracker.reject(normalized);
        this.trackers.delete(turnId);
      }
    }
  }

  private async withTimeout<T>(
    operation: Promise<T>,
    timeoutMs: number,
    message: string,
  ): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}
