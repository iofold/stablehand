#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import type { FastifyInstance } from 'fastify';
import { createContainer, type AppContainer } from '../config/container.js';
import { createServer } from '../orchestrator/server.js';
import { discoverAgents, discoverManifestProjects, discoverTools } from '../agent/discovery.js';
import type { AgentCreateInput } from '@stablehand/contracts';
import type { LoadedManifestProject } from '@stablehand/manifest/node';
import type { StablehandConfig } from '../config/types.js';
import type { AgentDefinition } from '@stablehand/sandbox-daemon';
import type { ToolDefinition } from '@stablehand/sandbox-daemon';

import { ensureAgentWorkspace, seedAgentWorkspace } from '../workspace/ensure.js';
import {
  DefaultOrchestratorToolRegistry,
  registerDefaultToolHandlers,
  type OrchestratorToolHandler,
  type ToolHandlerContext,
} from '../orchestrator/grpc/orchestrator-service.js';
import { createToolApprovalGate } from '../orchestrator/tool-approval-gate.js';
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

  // ctx-tl9r: install the process-level safety net before any runtime work.
  // Startup reconciliation and crash takeover (ADR 025) talk to Docker while
  // containers may be disappearing; a stray docker-modem rejection during
  // boot must be logged, not take the control plane down.
  process.on('unhandledRejection', (err) => console.error('[UNHANDLED REJECTION]', err));
  process.on('uncaughtException', (err) => console.error('[UNCAUGHT EXCEPTION]', err));

  // Load optional project config. Runtime services only require DATABASE_URL.
  let config: StablehandConfig = {};
  const configPath = join(cwd, 'stablehand.config.ts');
  if (existsSync(configPath)) {
    const mod = await import(pathToFileURL(configPath).href);
    config = mod.default;
  }

  const dataDir = process.env.STABLEHAND_DATA_DIR
    ? resolve(process.env.STABLEHAND_DATA_DIR)
    : join(cwd, '.stablehand');
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

  // Discover tools. A tool module can decline to register by leaving its default export
  // undefined (the kitchen-sink exec-command does unless explicitly enabled), so list what
  // was actually loaded rather than the files on disk.
  const toolsDir = join(cwd, 'tools');
  const toolDefs: ToolDefinition[] = existsSync(toolsDir) ? await discoverTools(toolsDir) : [];
  const tools = toolDefs.map((tool) => tool.name);

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
  const apiPort = parseInt(process.env.STABLEHAND_PORT || '3001', 10);
  const uiPort = parseInt(process.env.STABLEHAND_UI_PORT || '3200', 10);

  const container: AppContainer = await createContainer(config, dataDir);
  console.log('  \x1b[32m✓\x1b[0m Database initialized');
  console.log('  \x1b[1mExecution:\x1b[0m sandbox (Docker containers)');

  // ── Discover agents & tools from project directories ─
  let agentDefs: AgentDefinition[] = [];
  let manifestProjects: LoadedManifestProject[] = [];

  if (existsSync(agentsDir)) {
    agentDefs = await discoverAgents(agentsDir);
    manifestProjects = await discoverManifestProjects(agentsDir);
    const manifestDefs = manifestProjects.map((project) =>
      agentInputToDefinition(project.agentCreateInput, project.projectDir),
    );
    agentDefs = [...agentDefs, ...manifestDefs];
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

  const makeToolContext = (ctx: ToolHandlerContext) => ({
    agentId: ctx.agentId,
    conversationId: ctx.conversationId ?? '',
    turnId: ctx.turnId,
    ...(ctx.sandboxSessionId ? { sandboxSessionId: ctx.sandboxSessionId } : {}),
    requestId: ctx.requestId,
    workspaceDir: '/workspace',
    eventBus: container.eventBus,
  });
  // One approval gate for every orchestrator-side tool that declares
  // requiresApproval: project-local tools here, provider tools (HTTP, MCP)
  // through the registry delegate (ctx-9gy9).
  const approvalGate = createToolApprovalGate({
    interruptManager: container.interruptManager,
    eventBus: container.eventBus,
  });
  const toolRegistry = new DefaultOrchestratorToolRegistry(
    container.toolRegistry,
    makeToolContext,
    { approvalGate },
  );
  if (container.eventBus) {
    registerDefaultToolHandlers(toolRegistry, container.eventBus);
  }
  for (const tool of toolDefs) {
    const run: OrchestratorToolHandler = async (args, ctx) => tool.handler(args, makeToolContext(ctx));
    toolRegistry.set(tool.name, tool.requiresApproval ? approvalGate(tool.name, run) : run);
  }

  const server: FastifyInstance = await createServer({
    db: container.db,
    port: apiPort,
    host: '0.0.0.0',
    eventBus: container.eventBus,
    harnessSchemas: container.harnessSchemas,
    dataDir,
    triggerManager: container.triggerManager,
    turnDispatcher: container.turnDispatcher,
    scheduleService: container.scheduleService,
    sse: container.sseManager,
    interrupts: container.interruptManager,
    secretProvider: container.secretProvider,
    containerManager: container.containerManager,
    artifactStore: container.artifactStore,
    artifactBucket: process.env.S3_BUCKET || 'stablehand-artifacts',
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
  // durable HITL resumption), so schedule activation and listen are both
  // intentionally inside this fail-closed barrier rather than preceding or
  // racing recovery.
  await startRuntimeApi({
    server,
    runtime: container,
    listen: { port: apiPort, host: '0.0.0.0' },
  });
  console.log(`  \x1b[32mAPI:\x1b[0m  http://localhost:${apiPort}`);

  // ── Start UI server ─────────────────────────────────
  // Docker-first workflow: disable UI auto-probing unless explicitly enabled.
  let viteProcess: ChildProcess | null = null;
  const uiMode = process.env.STABLEHAND_UI_MODE || 'disabled';
  const uiDistDir = join(cwd, 'node_modules', 'stablehand', 'ui', 'dist');
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
        STABLEHAND_PORT: String(apiPort),
        STABLEHAND_UI_PORT: String(uiPort),
        STABLEHAND_API_ORIGIN:
          process.env.STABLEHAND_API_ORIGIN || `http://localhost:${apiPort}`,
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

  // Keep the process alive
  await new Promise(() => {});
}

startDev().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
