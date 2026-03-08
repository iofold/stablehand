#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import type { FastifyInstance } from 'fastify';
import { createContainer, type AppContainer } from '../config/container.js';
import { createServer } from '../orchestrator/server.js';
import { discoverAgents, discoverTools } from '../agent/discovery.js';
import type { CTXMillConfig } from '../config/types.js';
import type { AgentDefinition } from '../types.js';
import type { ToolDefinition } from '../tool/types.js';

export async function startDev() {
  const cwd = process.cwd();

  // Load config
  let config: { preset: string } = { preset: 'local' };
  const configPath = join(cwd, 'ctxmill.config.ts');
  if (existsSync(configPath)) {
    const mod = await import(pathToFileURL(configPath).href);
    config = mod.default;
  }

  // Ensure .ctxmill directory
  const dataDir = join(cwd, '.ctxmill');
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

  // Check for API key — support both Anthropic and OpenAI-compatible providers
  const apiKey = process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error('\n  Set ANTHROPIC_API_KEY or OPENAI_API_KEY in .env or environment\n');
    console.error('  echo "ANTHROPIC_API_KEY=sk-ant-..." > .env\n');
    process.exit(1);
  }

  // Auto-detect provider from which key is set and model name
  const model = process.env.OPENAI_MODEL || 'claude-sonnet-4-20250514';
  const provider: 'anthropic' | 'openai' =
    process.env.OPENAI_API_KEY && !process.env.ANTHROPIC_API_KEY
      ? 'openai'
      : model.includes('claude')
        ? 'anthropic'
        : 'openai';

  // Discover agents
  const agentsDir = join(cwd, 'agents');
  const agents: string[] = [];
  if (existsSync(agentsDir)) {
    for (const entry of readdirSync(agentsDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const agentFile = join(agentsDir, entry.name, 'agent.ts');
        if (existsSync(agentFile)) {
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

  // Count knowledge items
  let knowledgeCount = 0;
  for (const agentName of agents) {
    const knowledgePath = join(agentsDir, agentName, 'knowledge.yaml');
    if (existsSync(knowledgePath)) {
      const { readFileSync } = await import('node:fs');
      const content = readFileSync(knowledgePath, 'utf-8');
      const matches = content.match(/^\s*- content:/gm);
      knowledgeCount += matches ? matches.length : 0;
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
  console.log(`  \x1b[1mKnowledge:\x1b[0m ${knowledgeCount} items`);
  console.log(`  \x1b[1mLearning:\x1b[0m  enabled`);
  console.log('');

  // ── Build DI container (database + services) ─────────
  const apiPort = parseInt(process.env.CTXMILL_PORT || '3001', 10);
  const uiPort = parseInt(process.env.CTXMILL_UI_PORT || '3101', 10);

  const userConfig: CTXMillConfig = {
    preset: config.preset as CTXMillConfig['preset'],
    llm: {
      provider,
      model,
      apiKey: apiKey,
      baseUrl: process.env.OPENAI_BASE_URL,
    },
  };
  const container: AppContainer = await createContainer(userConfig, dataDir);
  console.log('  \x1b[32m✓\x1b[0m Database initialized');

  // ── Discover agents & tools from project directories ─
  let agentDefs: AgentDefinition[] = [];
  let toolDefs: ToolDefinition[] = [];

  if (existsSync(agentsDir)) {
    agentDefs = await discoverAgents(agentsDir);
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
        model: def.model,
        systemPrompt: def.systemPrompt,
        tools: def.tools,
        description: def.description ?? null,
        metadata: def.metadata ?? null,
        status: 'created',
      });
    }
  }
  console.log(`  \x1b[32m✓\x1b[0m Registered ${agentDefs.length} agent(s), ${toolDefs.length} tool(s)`);

  // Build agent map (DB id → definition) for the server
  // The route looks up by DB-generated UUID, so we need to map DB IDs to definitions.
  const agentMap = new Map<string, AgentDefinition>();
  const dbAgents = await container.db.listAgents();
  for (const def of agentDefs) {
    const dbAgent = dbAgents.find((a) => a.name === def.name);
    if (dbAgent) {
      agentMap.set(dbAgent.id, def);
    }
  }

  // ── Start Fastify orchestrator ───────────────────────
  const server: FastifyInstance = await createServer({
    db: container.db,
    executor: container.agentExecutor,
    agents: agentMap,
    port: apiPort,
    host: '0.0.0.0',
    runRegistry: container.runRegistry,
    learningPipeline: container.learningPipeline,
    knowledgeStore: container.knowledgeStore,
  });
  await server.listen({ port: apiPort, host: '0.0.0.0' });
  console.log(`  \x1b[32mAPI:\x1b[0m  http://localhost:${apiPort}`);

  // ── Start UI server ─────────────────────────────────
  // In published mode, serve pre-built static files from ctxmill/ui/dist
  // In monorepo dev, spawn Vite dev server from the UI package
  let viteProcess: ChildProcess | null = null;
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

  if (existsSync(join(uiDistDir, 'index.html'))) {
    // Serve pre-built static UI via Fastify
    try {
      // @fastify/static is an optional dependency
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = await import(/* webpackIgnore: true */ '@fastify/static' as string);
      const fastifyStatic = mod.default ?? mod;
      await server.register(fastifyStatic, {
        root: uiDistDir,
        prefix: '/',
        wildcard: false,
      });
      console.log(`  \x1b[32mUI:\x1b[0m   http://localhost:${apiPort} (embedded)`);
    } catch {
      console.log('  \x1b[33mUI:\x1b[0m   (install @fastify/static for embedded UI)');
    }
  } else if (existsSync(join(monorepoUiDir, 'vite.config.ts'))) {
    // Monorepo development: spawn Vite dev server
    viteProcess = spawn('npx', ['vite', '--port', String(uiPort), '--host', '0.0.0.0'], {
      cwd: monorepoUiDir,
      stdio: 'pipe',
      env: { ...process.env, CTXMILL_PORT: String(apiPort), CTXMILL_UI_PORT: String(uiPort) },
    });
    viteProcess.on('error', () => {});
    console.log(`  \x1b[32mUI:\x1b[0m   http://localhost:${uiPort}`);
  } else {
    console.log('  \x1b[33mUI:\x1b[0m   (no UI available — install @ctxmill/ui for the web dashboard)');
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
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  // Keep the process alive
  await new Promise(() => {});
}

startDev().catch(console.error);
