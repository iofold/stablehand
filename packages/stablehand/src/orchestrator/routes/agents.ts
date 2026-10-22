import type { FastifyInstance } from 'fastify';

import { requireAgent } from './agent-helpers.js';
import { conversationRoutes } from './agents/conversations.js';
import { crudRoutes } from './agents/crud.js';
import { fileRoutes } from './agents/files.js';
import { interruptRoutes } from './agents/interrupts.js';
import { mcpServerRoutes } from './agents/mcp.js';
import { feedbackRoutes } from './agents/feedback.js';
import { secretRoutes } from './agents/secrets.js';
import { turnRoutes } from './agents/turns.js';
import { streamRoutes } from './agents/stream.js';
import type { AgentRouteOptions, AgentSubRouteOptions } from './agents/types.js';
import { webhookRoutes } from './agents/webhooks.js';

export type { ActiveLifecycleRouteOptions, AgentRouteOptions } from './agents/types.js';
export {
  activeConversationRoutes,
  activeSandboxSessionRoutes,
} from './agents/active-lifecycle.js';

export async function agentRoutes(app: FastifyInstance, opts: AgentRouteOptions): Promise<void> {
  const loadAgent = requireAgent(opts.db);
  // Spread, don't enumerate: new AgentRouteOptions fields must reach the
  // subroutes. Fastify's own `prefix` must NOT ride along or every subroute
  // would be double-prefixed.
  const routeOpts = { ...opts } as AgentRouteOptions & { prefix?: string };
  delete routeOpts.prefix;
  const subOpts: AgentSubRouteOptions = {
    ...routeOpts,
    loadAgent,
  };

  await app.register(crudRoutes, subOpts);
  await app.register(turnRoutes, subOpts);
  await app.register(conversationRoutes, subOpts);
  await app.register(streamRoutes, subOpts);
  await app.register(interruptRoutes, subOpts);
  await app.register(feedbackRoutes, subOpts);
  await app.register(fileRoutes, subOpts);
  await app.register(secretRoutes, subOpts);
  await app.register(mcpServerRoutes, subOpts);
  await app.register(webhookRoutes, subOpts);
}
