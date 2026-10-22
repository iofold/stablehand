import { createClient } from '@connectrpc/connect';
import { HarnessService } from '@stablehand/proto/sandbox/v1';
import type { BuiltinToolPolicy } from '@stablehand/contracts';

import type { DatabaseRepository, SandboxSessionRow } from '../../database/repository.js';
import type { TypedEventBus } from '../../events/bus.js';
import type { SandboxContainerManager } from '../../sandbox/container-manager.js';
import type { WorkspaceDiffService } from '../../sandbox/workspace-diff.js';
import type { AgentDefinition, Message } from '@stablehand/sandbox-daemon';
import type { ContainerLifecyclePolicy } from '../container-lifecycle-policy.js';
import type { InterruptManager } from '../interrupt.js';
import type { SessionStateStore } from './session-state-store.js';
import type { SessionStatusCoordinator } from './session-status-coordinator.js';
import type { SessionEvent } from '../session-turn-service.js';
import type { InterruptContinuationExecution } from './interrupt-resume-service.js';
import type { TurnDeliveryFence } from '../turn-delivery-fence.js';
import type { TurnSecrets } from './turn-secrets.js';

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
  restoreFenceToken: number;
  runtimeDefinitionHash?: string;
  status: SessionStatus;
  harnessName: string;
  sessionWorkspaceDir?: string;
  grpcClient?: HarnessGrpcClient;
}

export interface SessionRecoveryAuthority {
  attemptId: string;
  turnId: string;
  fence: TurnDeliveryFence;
}

export interface SessionEnsureOptions {
  concurrencyReservationId?: string;
  recoveryAuthority?: SessionRecoveryAuthority;
  runtimeDefinitionHash?: string;
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
    restoreFenceToken: row.restoreFenceToken,
    runtimeDefinitionHash: row.runtimeDefinitionHash ?? '',
    status: (row.status as SessionRecord['status']) ?? 'ACTIVE',
    harnessName: row.harnessName,
    ...(grpcClient ? { grpcClient } : {}),
  };
}

export interface TurnQueueEntry {
  messages: Message[];
  turnId: string;
  turnSecrets?: TurnSecrets;
  channel: AsyncChannel<SessionEvent>;
  signal?: AbortSignal;
}

export interface TurnDeliveryOptions {
  signal?: AbortSignal;
  turnSecrets?: TurnSecrets;
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

/** Which sandbox session the stable secrets are being assembled for. */
export interface SandboxSecretsContext {
  sessionId: string;
}

export type BuildSandboxSecrets = (
  agentId: string,
  context?: SandboxSecretsContext,
) => Promise<Readonly<Record<string, string>>>;

export interface SandboxSessionManagerDeps {
  containerManager: SandboxContainerManager;
  db: DatabaseRepository;
  lifecyclePolicy: ContainerLifecyclePolicy;
  stateStore: SessionStateStore;
  statusCoordinator: SessionStatusCoordinator;
  eventBus: TypedEventBus;
  maxConcurrentSessionsPerAgent?: number;
  interruptManager?: InterruptManager;
  buildSandboxSecrets: BuildSandboxSecrets;
  /**
   * Release per-session credentials (the session's gateway key) once its
   * runtime is gone or never came up. Best effort; must not throw.
   */
  releaseSandboxCredentials?: (sessionId: string) => Promise<void>;
  resolveRuntimeDefinitionHash?: (
    agentId: string,
    agentDef: AgentDefinition,
  ) => Promise<string>;
  resolveToolsForAgent?: (
    toolNames: string[],
    builtinToolPolicy?: BuiltinToolPolicy,
    agentId?: string,
  ) => ToolMetadata[];
  logger: Logger;
  config: {
    idleTimeoutMs: number;
    maxQueuedMessages: number;
    turnTimeoutMs?: number;
  };
  dataDir?: string;
  workspaceDiffService: WorkspaceDiffService;
  executeInterruptContinuation?: (
    input: InterruptContinuationExecution,
  ) => Promise<void>;
  resolveTurnSecrets: (turnId: string) => Promise<TurnSecrets>;
}
