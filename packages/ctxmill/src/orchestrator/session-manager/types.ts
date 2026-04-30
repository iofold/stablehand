import { createClient } from '@connectrpc/connect';
import { HarnessService } from '@ctxmill/proto/sandbox/v1';

import type { DatabaseRepository } from '../../database/repository.js';
import type { TypedEventBus } from '../../events/bus.js';
import type { SandboxContainerManager } from '../../sandbox/container-manager.js';
import type { WorkspaceDiffService } from '../../sandbox/workspace-diff.js';
import type { Message } from '../../types.js';
import type { ContainerLifecyclePolicy } from '../container-lifecycle-policy.js';
import type { InterruptManager } from '../interrupt.js';
import type { SessionEvent } from '../session-turn-service.js';

export interface Logger {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  debug(msg: string, ...args: unknown[]): void;
}

export type SessionStatus = 'ACTIVE' | 'PAUSED' | 'CHECKPOINTED' | 'RESTORING' | 'TERMINATED';

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
  /** @deprecated Turn ownership is tracked by SessionStateStore. */
  currentTurnAbortController?: AbortController;
  /** @deprecated Turn ownership is tracked by SessionStateStore. */
  currentTurnId?: string;
  grpcClient?: HarnessGrpcClient;
}

export interface TurnQueueEntry {
  messages: Message[];
  turnId: string;
  channel: AsyncChannel<SessionEvent>;
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
  eventBus?: TypedEventBus;
  maxConcurrentSessionsPerAgent?: number;
  interruptManager?: InterruptManager;
  buildSandboxSecrets: (agentId: string) => Readonly<Record<string, string>>;
  resolveToolsForAgent?: (toolNames: string[], excludeBuiltins?: string[]) => ToolMetadata[];
  logger: Logger;
  config: {
    idleTimeoutMs: number;
    maxQueuedMessages: number;
    turnTimeoutMs?: number;
  };
  dataDir?: string;
  workspaceDiffService: WorkspaceDiffService;
}
