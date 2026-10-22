import type { FastifyReply, FastifyRequest } from 'fastify';
import type { HttpToolDefinition } from '@stablehand/contracts';
import type { HarnessConfigSchemas } from '@stablehand/sandbox-daemon/harness/schemas';

import type { DatabaseRepository } from '../../../database/repository.js';
import type { TypedEventBus } from '../../../events/bus.js';
import type { SecretProvider } from '../../../secrets/types.js';
import type { SystemSettingsService } from '../../../settings/service.js';
import type { SandboxContainerManager } from '../../../sandbox/container-manager.js';
import type { DefaultToolRegistry } from '../../../tool/registry.js';
import type { InterruptManager } from '../../interrupt.js';
import type { TurnStartupService } from '../../turn-startup-service.js';
import type { SandboxSessionManager } from '../../sandbox-session-manager.js';
import type { SSEManager } from '../../sse.js';
import type { ContainerLifecyclePolicy } from '../../container-lifecycle-policy.js';
import type { CanonicalLog } from '../../canonical/canonical-log.js';
import type { ScheduleService } from '../../../schedules/service.js';
import type { EventTriggerManager } from '../../../events/trigger-manager.js';
import type { McpServerManager } from '../../../mcp/manager.js';

export type AgentHttpToolDefinition = HttpToolDefinition;

export type StoredAgent = NonNullable<Awaited<ReturnType<DatabaseRepository['getAgent']>>>;

export interface AgentRouteOptions {
  db: DatabaseRepository;
  sse: SSEManager;
  interrupts: InterruptManager;
  harnessSchemas: HarnessConfigSchemas;
  eventBus?: TypedEventBus;
  dataDir?: string;
  secretProvider?: SecretProvider;
  toolRegistry?: DefaultToolRegistry;
  containerManager?: Pick<SandboxContainerManager, 'listManagedContainersWithLabels' | 'removeContainer' | 'stopContainer'>;
  sessionManager?: SandboxSessionManager;
  settingsService?: SystemSettingsService;
  turnStartupService: TurnStartupService;
  /** Durable canonical event spine; present when the container wired one (ADR-015). */
  canonicalLog?: CanonicalLog;
  /** Container-owned recurring clocks, fenced before an agent is deleted. */
  scheduleService?: Pick<ScheduleService, 'stopForAgent'>;
  /** Loaded event triggers, fenced before an agent is deleted. */
  triggerManager?: Pick<EventTriggerManager, 'stopForAgent'>;
  /** Keeps each agent's declared MCP servers registered and runs OAuth connects. */
  mcpServerManager?: McpServerManager;
}

export interface AgentSubRouteOptions extends AgentRouteOptions {
  loadAgent: (
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) => Promise<void>;
}

export interface ActiveLifecycleRouteOptions {
  db: DatabaseRepository;
  lifecyclePolicy?: Pick<ContainerLifecyclePolicy, 'getActiveSandboxSessionsForReadback'>;
  sessionManager?: Pick<SandboxSessionManager, 'getActiveTurnId'>;
}
