#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import type { FastifyInstance } from 'fastify';
import { createContainer, type AppContainer } from '../config/container.js';
import { createServer } from '../orchestrator/server.js';
import { discoverAgents, discoverManifestProjects, discoverTools } from '../agent/discovery.js';
import type { AgentCreateInput } from '@ctxmill/contracts';
import type { LoadedManifestProject } from '@ctxmill/manifest/node';
import type { CTXMillConfig } from '../config/types.js';
import type { AgentDefinition } from '@ctxmill/sandbox-daemon';
import type { ToolDefinition } from '@ctxmill/sandbox-daemon';

import { ensureAgentWorkspace, seedAgentWorkspace } from '../workspace/ensure.js';
import { DefaultOrchestratorToolRegistry, registerDefaultToolHandlers } from '../orchestrator/grpc/orchestrator-service.js';
import { startRuntimeApi } from './runtime-startup.js';

function agentInputToDefinition(
  input: AgentCreateInput,
  projectDir: string,
): AgentDefinition {
  return {
    name: input.name,
    harness: input.harness,
    harnessConfig: input.harnessConfig,
    tools: input.tools,
    systemPrompt: input.systemPrompt,
    ...(input.nativeToolPolicy ? { nativeToolPolicy: input.nativeToolPolicy } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    ...(input.mode !== undefined ? { mode: input.mode } : {}),
    ...(input.workspaceContent !== undefined
      ? { workspaceContent: input.workspaceContent }
      : {}),
    ...(input.resourceLimits ? { resourceLimits: input.resourceLimits } : {}),
    projectDir,
  };
}

export async function startDev() {
  const cwd = process.cwd();

  // Load optional project config. Runtime services only require DATABASE_URL.
  let config: CTXMillConfig = {};
  const configPath = join(cwd, 'ctxmill.config.ts');
  if (existsSync(configPath)) {
    const mod = await import(pathToFileURL(configPath).href);
    config = mod.default;
  }

  const dataDir = process.env.CTXMILL_DATA_DIR
    ? resolve(process.env.CTXMILL_DATA_DIR)
    : join(cwd, '.ctxmill');
  mkdirSync(dataDir, { recursive: true });

  // Load .env file if present
  const envPath = join(cwd, '.env');
  if (existsSync(envPath)) {
    const { readFileSync } = await import('node:fs');
    const envContent = readFileSync(envPath, 'utf-8');
    for (const line of envContent.split('\n')) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx > 0) {
          const key = trimmed.slice(0, eqIdx).trim();
          const value = trimmed.slice(eqIdx + 1).trim();
          if (!process.env[key]) {
            process.env[key] = value;
          }
        }
      }
    }
  }

  // Discover agents
  const agentsDir = join(cwd, 'agents');
  const agents: string[] = [];
  if (existsSync(agentsDir)) {
    for (const entry of readdirSync(agentsDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const hasTs = existsSync(join(agentsDir, entry.name, 'agent.ts'));
        const hasYaml = existsSync(join(agentsDir, entry.name, 'agent.yaml'))
          || existsSync(join(agentsDir, entry.name, 'agent.yml'));
        if (hasTs || hasYaml) {
          agents.push(entry.name);
        }
      }
    }
  }

  // Discover tools
  const toolsDir = join(cwd, 'tools');
  const tools: string[] = [];
  if (existsSync(toolsDir)) {
    for (const entry of readdirSync(toolsDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        tools.push(entry.name.replace('.ts', ''));
      }
    }
  }

  // Print startup banner
  console.log(`
  \x1b[36m╔═══════════════════════════════════════╗
  ║          C T X M I L L               ║
  ║   Vertical AI Product Framework      ║
  ╚═══════════════════════════════════════╝\x1b[0m
  `);

  console.log('  \x1b[1mModels:\x1b[0m    per-agent harness configuration');
  console.log(`  \x1b[1mAgents:\x1b[0m   ${agents.length} [${agents.join(', ')}]`);
  console.log(`  \x1b[1mTools:\x1b[0m    ${tools.length} [${tools.join(', ')}]`);
  console.log('');

  // ── Build DI container (database + services) ─────────
  const apiPort = parseInt(process.env.CTXMILL_PORT || '3001', 10);
  const uiPort = parseInt(process.env.CTXMILL_UI_PORT || '3200', 10);

  const container: AppContainer = await createContainer(config, dataDir);
  console.log('  \x1b[32m✓\x1b[0m Database initialized');
  console.log('  \x1b[1mExecution:\x1b[0m sandbox (Docker containers)');

  // ── Discover agents & tools from project directories ─
  let agentDefs: AgentDefinition[] = [];
  let manifestProjects: LoadedManifestProject[] = [];
  let toolDefs: ToolDefinition[] = [];

  if (existsSync(agentsDir)) {
    agentDefs = await discoverAgents(agentsDir);
    manifestProjects = await discoverManifestProjects(agentsDir);
    const manifestDefs = manifestProjects.map((project) =>
      agentInputToDefinition(project.agentCreateInput, project.projectDir),
    );
    agentDefs = [...agentDefs, ...manifestDefs];
  }
  if (existsSync(toolsDir)) {
    toolDefs = await discoverTools(toolsDir);
  }

  // Register discovered tools with the executor
  for (const tool of toolDefs) {
    container.toolExecutor.register(tool);
  }

  // Register discovered agents in the database
  const manifestProjectsByName = new Map(
    manifestProjects.map((project) => [project.agentCreateInput.name, project]),
  );
  for (const def of agentDefs) {
    const existing = await container.db.listAgents();
    const alreadyRegistered = existing.find((a) => a.name === def.name);
    if (!alreadyRegistered) {
      const manifestProject = manifestProjectsByName.get(def.name);
      await container.db.createAgent({
        name: def.name,
        harness: def.harness,
        harnessConfig: JSON.stringify(def.harnessConfig),
        systemPrompt: def.systemPrompt,
        tools: def.tools,
        description: def.description ?? null,
        metadata: def.metadata ?? null,
        manifest: manifestProject?.agentCreateInput.manifest,
      });
    }
  }

  // Ensure workspace directories for all registered agents
  const allDbAgents = await container.db.listAgents();
  for (const dbAgent of allDbAgents) {
    const workspaceDir = ensureAgentWorkspace(dataDir, dbAgent.id);
    seedAgentWorkspace(workspaceDir);
    if (dbAgent.workspaceDir !== workspaceDir) {
      await container.db.updateAgent(dbAgent.id, { workspaceDir });
    }
  }

  console.log(`  \x1b[32m✓\x1b[0m Registered ${agentDefs.length} agent(s), ${toolDefs.length} tool(s)`);

  const toolRegistry = new DefaultOrchestratorToolRegistry(
    container.toolRegistry,
    (ctx) => ({
      agentId: ctx.agentId,
      conversationId: ctx.conversationId ?? '',
      turnId: ctx.turnId,
      requestId: ctx.requestId,
      workspaceDir: '/workspace',
      eventBus: container.eventBus,
    }),
  );
  if (container.eventBus) {
    registerDefaultToolHandlers(toolRegistry, container.eventBus);
  }
  for (const tool of toolDefs) {
    toolRegistry.set(tool.name, async (args, ctx) => {
      if (tool.requiresApproval && container.interruptManager && container.sseManager) {
        if (
          !ctx.sandboxSessionId
          || !ctx.deliveryFence
          || !ctx.activeGeneration
        ) {
          throw new Error(
            'Sandbox callback delivery authority is required for approval persistence',
          );
        }
        const callbackAuthority = {
          turnId: ctx.turnId,
          sandboxSessionId: ctx.sandboxSessionId,
          agentId: ctx.agentId,
          expectedDeliveryFence: ctx.deliveryFence,
          expectedActiveGeneration: ctx.activeGeneration,
        };

        if (container.eventBus) {
          const didEmit = await container.eventBus.emitAsync(
            'tool_call.started',
            {
              turnId: ctx.turnId,
              agentId: ctx.agentId,
              conversationId: ctx.conversationId ?? '',
              toolCallId: ctx.requestId,
              toolCallName: tool.name,
              args: args as Record<string, unknown>,
              requiresApproval: true,
              timestamp: Date.now(),
            },
            {
              deliveryFence: ctx.deliveryFence,
              sandboxSessionId: ctx.sandboxSessionId,
              activeGeneration: ctx.activeGeneration,
            },
          );
          if (!didEmit) {
            throw new Error(
              'Sandbox callback delivery ownership changed before approval event persistence',
            );
          }
        }

        const resolution = await container.interruptManager.waitForApproval(
          ctx.turnId,
          ctx.agentId,
          ctx.requestId,
          tool.name,
          args as Record<string, unknown>,
          undefined,
          ctx.sandboxSessionId,
          ctx.conversationId,
          callbackAuthority,
        );

        if (resolution.action !== 'approve') {
          return JSON.stringify({ error: `Tool call rejected: ${resolution.data ?? resolution.action}` });
        }
      }

      return tool.handler(args, {} as Parameters<typeof tool.handler>[1]);
    });
  }

  const server: FastifyInstance = await createServer({
    db: container.db,
    port: apiPort,
    host: '0.0.0.0',
    eventBus: container.eventBus,
    harnessSchemas: container.harnessSchemas,
    dataDir,
    triggerManager: container.triggerManager,
    sse: container.sseManager,
    interrupts: container.interruptManager,
    secretProvider: container.secretProvider,
    containerManager: container.containerManager,
    artifactStore: container.artifactStore,
    artifactBucket: process.env.S3_BUCKET || 'ctxmill-artifacts',
    turnStartupService: container.turnStartupService,
    toolRegistry,
    toolDefinitionRegistry: container.toolRegistry,
    toolExecutor: container.toolExecutor,
    settingsService: container.settingsService,
    sessionManager: container.sessionManager,
    lifecyclePolicy: container.lifecyclePolicy,
    canonicalLog: container.canonicalLog,
    modelGateway: container.modelGateway,
  });
  // Boot order matters (ctx-wbt, ADR-014): seed slot accounting from live
  // containers BEFORE lifecycle reconciliation so reconciliation-driven
  // removals free real slots; reconcile stranded turns AFTER it so sandbox
  // rows are repaired first. Fastify listen runs onReady hooks (including
  // durable HITL resumption), so it is intentionally inside this fail-closed
  // barrier rather than preceding or racing it.
  await startRuntimeApi({
    server,
    runtime: container,
    listen: { port: apiPort, host: '0.0.0.0' },
  });
  console.log(`  \x1b[32mAPI:\x1b[0m  http://localhost:${apiPort}`);

  // ── Start UI server ─────────────────────────────────
  // Docker-first workflow: disable UI auto-probing unless explicitly enabled.
  let viteProcess: ChildProcess | null = null;
  const uiMode = process.env.CTXMILL_UI_MODE || 'disabled';
  const uiDistDir = join(cwd, 'node_modules', 'ctxmill', 'ui', 'dist');
  // Try common monorepo layouts: packages/<name>/ or packages/examples/<name>/
  const monorepoUiCandidates = [
    join(cwd, '..', 'ui'),                       // sibling package
    join(cwd, '..', '..', 'packages', 'ui'),      // packages/<name>/
    join(cwd, '..', '..', '..', 'packages', 'ui'), // packages/examples/<name>/
  ];
  const monorepoUiDir = monorepoUiCandidates.find(
    (d) => existsSync(join(d, 'vite.config.ts')),
  ) ?? monorepoUiCandidates[0];

  if (uiMode === 'embedded' && existsSync(join(uiDistDir, 'index.html'))) {
    try {
      const mod = await import(/* webpackIgnore: true */ '@fastify/static' as string);
      const fastifyStatic = mod.default ?? mod;
      await server.register(fastifyStatic, {
        root: uiDistDir,
        prefix: '/',
        wildcard: false,
      });
      console.log(`  \x1b[32mUI:\x1b[0m   http://localhost:${apiPort} (embedded)`);
    } catch {
      console.log('  \x1b[33mUI:\x1b[0m   embedded mode requested but @fastify/static is unavailable');
    }
  } else if (uiMode === 'vite' && existsSync(join(monorepoUiDir, 'vite.config.ts'))) {
    viteProcess = spawn('npx', ['vite', '--port', String(uiPort), '--host', '0.0.0.0'], {
      cwd: monorepoUiDir,
      stdio: 'pipe',
      env: {
        ...process.env,
        CTXMILL_PORT: String(apiPort),
        CTXMILL_UI_PORT: String(uiPort),
        CTXMILL_API_ORIGIN:
          process.env.CTXMILL_API_ORIGIN || `http://localhost:${apiPort}`,
      },
    });
    viteProcess.on('error', () => {});
    console.log(`  \x1b[32mUI:\x1b[0m   http://localhost:${uiPort}`);
  } else {
    console.log('  \x1b[33mUI:\x1b[0m   disabled (use the Docker UI service)');
  }

  console.log('');
  console.log('  \x1b[2mPress Ctrl+C to stop\x1b[0m');
  console.log('');

  // ── Graceful shutdown ────────────────────────────────
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\n  Shutting down...');
    if (viteProcess) {
      viteProcess.kill('SIGTERM');
    }
    await server.close();
    await container.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  process.on('unhandledRejection', (err) => console.error('[UNHANDLED REJECTION]', err));
  process.on('uncaughtException', (err) => console.error('[UNCAUGHT EXCEPTION]', err));

  // Keep the process alive
  await new Promise(() => {});
}

startDev().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
