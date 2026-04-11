import type { FastifyInstance } from 'fastify';

import { requireAgent } from './agent-helpers.js';
import { conversationRoutes } from './agents/conversations.js';
import { crudRoutes } from './agents/crud.js';
import { fileRoutes } from './agents/files.js';
import { interruptRoutes } from './agents/interrupts.js';
import { knowledgeRoutes } from './agents/knowledge.js';
import { learningRoutes } from './agents/learning.js';
import { secretRoutes } from './agents/secrets.js';
import { sessionRoutes } from './agents/sessions.js';
import { streamRoutes } from './agents/stream.js';
import type { AgentRouteOptions, AgentSubRouteOptions } from './agents/types.js';
import { versionRoutes } from './agents/versions.js';
import { webhookRoutes } from './agents/webhooks.js';

export type { AgentRouteOptions, SessionsRouteOptions } from './agents/types.js';
export { globalSessionsRoutes as sessionsRoutes } from './agents/global-sessions.js';

export async function agentRoutes(app: FastifyInstance, opts: AgentRouteOptions): Promise<void> {
  const {
    db,
    sse,
    interrupts,
    harnessRegistry,
    learningPipeline,
    knowledgeStore,
    agentSessionService,
    eventBus,
    dataDir,
    secretProvider,
    toolRegistry,
    sessionManager,
    settingsService,
    runStartupService,
  } = opts;
  const loadAgent = requireAgent(db);
  const subOpts: AgentSubRouteOptions = {
    db,
    sse,
    interrupts,
    harnessRegistry,
    learningPipeline,
    knowledgeStore,
    agentSessionService,
    eventBus,
    dataDir,
    secretProvider,
    toolRegistry,
    sessionManager,
    settingsService,
    runStartupService,
    loadAgent,
  };

  await app.register(crudRoutes, subOpts);
  await app.register(sessionRoutes, subOpts);
  await app.register(conversationRoutes, subOpts);
  await app.register(streamRoutes, subOpts);
  await app.register(interruptRoutes, subOpts);
  await app.register(learningRoutes, subOpts);
  await app.register(knowledgeRoutes, subOpts);
  await app.register(fileRoutes, subOpts);
  await app.register(secretRoutes, subOpts);
  await app.register(webhookRoutes, subOpts);
  await app.register(versionRoutes, subOpts);
}
