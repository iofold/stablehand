import { createClient } from '@connectrpc/connect';
import { HarnessService } from '@ctxmill/proto/sandbox/v1';

import type { DatabaseRepository, SandboxSessionRow } from '../../database/repository.js';
import type { TypedEventBus } from '../../events/bus.js';
import type { SandboxContainerManager } from '../../sandbox/container-manager.js';
import type { WorkspaceDiffService } from '../../sandbox/workspace-diff.js';
import type { Message } from '@ctxmill/sandbox-daemon';
import type { ContainerLifecyclePolicy } from '../container-lifecycle-policy.js';
import type { InterruptManager } from '../interrupt.js';
import type { SessionStateStore } from './session-state-store.js';
import type { SessionStatusCoordinator } from './session-status-coordinator.js';
import type { SessionEvent } from '../session-turn-service.js';

export interface Logger {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  debug(msg: string, ...args: unknown[]): void;
}

export type SessionStatus = 'ACTIVE' | 'CHECKPOINTED' | 'RESTORING' | 'TERMINATED';

export type HarnessGrpcClient = ReturnType<typeof createClient<typeof HarnessService>>;

export type ToolMetadata = {
  name: string;
  description: string;
  inputSchemaJson: string;
  location: number;
  programmatic?: boolean;
};

export interface SessionRecord {
  sessionId: string;
  conversationId: string;
  agentId: string;
  containerName: string;
  containerId: string;
  status: SessionStatus;
  harnessName: string;
  sessionWorkspaceDir?: string;
  grpcClient?: HarnessGrpcClient;
}

export function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((entry): entry is string => typeof entry === 'string');
  return strings.length > 0 ? strings : undefined;
}

export function dbSessionToRecord(
  row: SandboxSessionRow,
  grpcClient?: HarnessGrpcClient,
): SessionRecord {
  return {
    sessionId: row.id,
    conversationId: row.conversationId,
    agentId: row.agentId,
    containerName: row.containerName ?? '',
    containerId: row.containerId ?? '',
    status: (row.status as SessionRecord['status']) ?? 'ACTIVE',
    harnessName: row.harnessName,
    ...(grpcClient ? { grpcClient } : {}),
  };
}

export interface TurnQueueEntry {
  messages: Message[];
  turnId: string;
  channel: AsyncChannel<SessionEvent>;
  signal?: AbortSignal;
}

export class AsyncChannel<T> {
  private readonly buffer: T[] = [];

  private done = false;

  private error: Error | null = null;

  private waiter: { resolve: () => void; reject: (err: Error) => void } | null = null;

  push(value: T): void {
    if (this.done || this.error !== null) {
      return;
    }
    this.buffer.push(value);
    this.waiter?.resolve();
    this.waiter = null;
  }

  close(): void {
    this.done = true;
    this.waiter?.resolve();
    this.waiter = null;
  }

  fail(err: Error): void {
    this.error = err;
    this.waiter?.reject(err);
    this.waiter = null;
  }

  async *generator(): AsyncGenerator<T> {
    while (true) {
      while (this.buffer.length > 0) {
        const value = this.buffer.shift();
        if (value !== undefined) {
          yield value;
        }
      }

      if (this.error !== null) {
        throw this.error;
      }

      if (this.done) {
        return;
      }

      await new Promise<void>((resolve, reject) => {
        this.waiter = { resolve, reject };
      });
    }
  }
}

export interface SandboxSessionManagerDeps {
  containerManager: SandboxContainerManager;
  db: DatabaseRepository;
  lifecyclePolicy: ContainerLifecyclePolicy;
  stateStore: SessionStateStore;
  statusCoordinator: SessionStatusCoordinator;
  eventBus: TypedEventBus;
  maxConcurrentSessionsPerAgent?: number;
  interruptManager?: InterruptManager;
  buildSandboxSecrets: (agentId: string) => Promise<Readonly<Record<string, string>>>;
  resolveToolsForAgent?: (toolNames: string[], excludeBuiltins?: string[], agentId?: string) => ToolMetadata[];
  logger: Logger;
  config: {
    idleTimeoutMs: number;
    maxQueuedMessages: number;
    turnTimeoutMs?: number;
  };
  dataDir?: string;
  workspaceDiffService: WorkspaceDiffService;
}
