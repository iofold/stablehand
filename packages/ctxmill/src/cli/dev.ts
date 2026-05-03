#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import type { FastifyInstance } from 'fastify';
import { createContainer, type AppContainer } from '../config/container.js';
import { createServer } from '../orchestrator/server.js';
import { discoverAgents, discoverManifests, discoverTools } from '../agent/discovery.js';
import { manifestToDefinition } from '../manifest/convert.js';
import type { CTXMillConfig } from '../config/types.js';
import type { AgentDefinition } from '../types.js';
import type { ToolDefinition } from '../tool/types.js';

import { ensureAgentWorkspace, seedAgentWorkspace } from '../workspace/ensure.js';
import { DefaultOrchestratorToolRegistry, registerDefaultToolHandlers } from '../orchestrator/grpc/orchestrator-service.js';

export async function startDev() {
  const cwd = process.cwd();

  // Load config — env var override takes precedence
  let config: { preset: string } = { preset: process.env.CTXMILL_PRESET || 'docker' };
  const configPath = join(cwd, 'ctxmill.config.ts');
  if (!process.env.CTXMILL_PRESET && existsSync(configPath)) {
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

  const model = process.env.OPENAI_MODEL;
  if (!model) {
    console.error('\n  Set OPENAI_MODEL in .env or environment before starting ctxmill dev\n');
    process.exit(1);
  }

  const provider: 'anthropic' | 'openai' | 'google' = model.includes('claude')
    ? 'anthropic'
    : model.includes('gemini')
      ? 'google'
      : 'openai';

  // Pick the API key that matches the detected provider — no cross-provider fallback
  const apiKey = provider === 'anthropic'
    ? process.env.ANTHROPIC_API_KEY
    : provider === 'google'
      ? process.env.GOOGLE_API_KEY
      : process.env.OPENAI_API_KEY;
  if (!apiKey) {
    const keyName = provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : provider === 'google' ? 'GOOGLE_API_KEY' : 'OPENAI_API_KEY';
    console.error(`\n  Set ${keyName} in .env or environment (detected provider: ${provider})\n`);
    process.exit(1);
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

  console.log(`  \x1b[1mPreset:\x1b[0m   ${config.preset}`);
  console.log(`  \x1b[1mProvider:\x1b[0m ${provider} (${model})`);
  console.log(`  \x1b[1mAgents:\x1b[0m   ${agents.length} [${agents.join(', ')}]`);
  console.log(`  \x1b[1mTools:\x1b[0m    ${tools.length} [${tools.join(', ')}]`);
  console.log('');

  // ── Build DI container (database + services) ─────────
  const apiPort = parseInt(process.env.CTXMILL_PORT || '3001', 10);
  const uiPort = parseInt(process.env.CTXMILL_UI_PORT || '3200', 10);

  const userConfig: CTXMillConfig = {
    preset: config.preset as CTXMillConfig['preset'],
  };
  const container: AppContainer = await createContainer(userConfig, dataDir);
  console.log('  \x1b[32m✓\x1b[0m Database initialized');
  console.log('  \x1b[1mExecution:\x1b[0m sandbox (Docker containers)');

  // ── Discover agents & tools from project directories ─
  let agentDefs: AgentDefinition[] = [];
  let toolDefs: ToolDefinition[] = [];

  if (existsSync(agentsDir)) {
    agentDefs = await discoverAgents(agentsDir);
    const manifests = await discoverManifests(agentsDir);
    const manifestDefs = manifests.map((m) => manifestToDefinition(m, { projectDir: cwd }));
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
  for (const def of agentDefs) {
    const existing = await container.db.listAgents();
    const alreadyRegistered = existing.find((a) => a.name === def.name);
    if (!alreadyRegistered) {
      await container.db.createAgent({
        name: def.name,
        harness: def.harness,
        harnessConfig: JSON.stringify(def.harnessConfig),
        systemPrompt: def.systemPrompt,
        tools: def.tools,
        description: def.description ?? null,
        metadata: def.metadata ?? null,
        status: 'created',
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
      conversationId: '',
      instanceId: ctx.sessionId,
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
        if (container.eventBus) {
          container.eventBus.emit('run.tool_started', {
            turnId: ctx.sessionId,
            agentId: ctx.agentId,
            conversationId: ctx.sessionId,
            toolCallId: ctx.requestId,
            toolName: tool.name,
            args: args as Record<string, unknown>,
            requiresApproval: true,
            timestamp: Date.now(),
          });
        }

        const resolution = await container.interruptManager.waitForApproval(
            ctx.sessionId, ctx.agentId, ctx.requestId, tool.name, args as Record<string, unknown>, undefined, undefined, ctx.sessionId,
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
    dataDir,
    triggerManager: container.triggerManager,
    sse: container.sseManager,
    interrupts: container.interruptManager,
    secretProvider: container.secretProvider,
    containerManager: container.containerManager,
    artifactStore: container.artifactStore,
    artifactBucket: process.env.S3_BUCKET || 'ctxmill-artifacts',
    agentSessionService: container.agentSessionService,
    runStartupService: container.runStartupService,
    toolRegistry,
    toolDefinitionRegistry: container.toolRegistry,
    toolExecutor: container.toolExecutor,
    settingsService: container.settingsService,
    sessionManager: container.sessionManager,
  });
  await server.listen({ port: apiPort, host: '0.0.0.0' });
  console.log(`  \x1b[32mAPI:\x1b[0m  http://localhost:${apiPort}`);

  void container.lifecyclePolicy.start().catch((err: unknown) => {
    console.error('  \x1b[33mLifecycle startup failed (non-fatal):\x1b[0m', err);
  });

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
    container.sseBroadcaster.shutdown();
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

startDev().catch(console.error);
