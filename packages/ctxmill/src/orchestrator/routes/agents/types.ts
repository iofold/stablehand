import type { FastifyReply, FastifyRequest } from 'fastify';

import type { DatabaseRepository } from '../../../database/repository.js';
import type { TypedEventBus } from '../../../events/bus.js';
import type { HarnessRegistry } from '../../../harness/types.js';
import type { SecretProvider } from '../../../secrets/types.js';
import type { SystemSettingsService } from '../../../settings/service.js';
import type { SandboxContainerManager } from '../../../sandbox/container-manager.js';
import type { HttpAuthConfig, HttpEndpointConfig } from '../../../tool/providers/http.js';
import type { DefaultToolRegistry } from '../../../tool/registry.js';
import type { AgentResourceLimits } from '../../../types.js';
import type { AgentSessionService } from '../../agent-session-service.js';
import type { InterruptManager } from '../../interrupt.js';
import type { RunStartupService } from '../../run-startup-service.js';
import type { SandboxSessionManager } from '../../sandbox-session-manager.js';
import type { SSEManager } from '../../sse.js';
import type { ContainerLifecyclePolicy } from '../../container-lifecycle-policy.js';

export type AgentHttpToolDefinition = {
  name: string;
  description: string;
  endpoint: string;
  method?: HttpEndpointConfig['method'];
  inputSchema?: Record<string, unknown>;
  headers?: Record<string, string>;
  timeout?: number;
  authentication?: HttpAuthConfig;
};

export type StoredAgent = NonNullable<Awaited<ReturnType<DatabaseRepository['getAgent']>>>;

export interface AgentRouteOptions {
  db: DatabaseRepository;
  sse: SSEManager;
  interrupts: InterruptManager;
  harnessRegistry: HarnessRegistry;
  agentSessionService: AgentSessionService;
  eventBus?: TypedEventBus;
  dataDir?: string;
  secretProvider?: SecretProvider;
  toolRegistry?: DefaultToolRegistry;
  containerManager?: Pick<SandboxContainerManager, 'listManagedContainersWithLabels' | 'removeContainer' | 'stopContainer'>;
  sessionManager?: SandboxSessionManager;
  settingsService?: SystemSettingsService;
  runStartupService: RunStartupService;
}

export interface AgentSubRouteOptions extends AgentRouteOptions {
  loadAgent: (
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) => Promise<void>;
}

export interface SessionsRouteOptions {
  db: DatabaseRepository;
  lifecyclePolicy?: Pick<ContainerLifecyclePolicy, 'getActiveSandboxSessionsForReadback'>;
  sessionManager?: Pick<SandboxSessionManager, 'getActiveTurnId'>;
}

export type AgentRouteBody = {
  name?: string;
  harness?: string;
  harnessConfig?: Record<string, unknown>;
  systemPrompt?: string;
  tools?: string[];
  httpTools?: AgentHttpToolDefinition[];
  description?: string;
  metadata?: Record<string, unknown>;
  resourceLimits?: AgentResourceLimits | null;
};
