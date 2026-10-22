#!/usr/bin/env -S node --experimental-strip-types

/**
 * Seed the content factory against a running Stablehand: the agents from
 * agents/, their tools-only secrets, the event triggers that chain them, two
 * schedules and one campaign budget. Safe to re-run: it updates what exists.
 *
 * Environment:
 *   API_URL                  Stablehand API (default http://localhost:3002)
 *   STABLEHAND_API_TOKEN     master API token (unless auth is disabled)
 *   FACTORY_CONFIG           config file (default ./factory.config.json)
 *   APIFY_TOKEN              Apify API token, stored as a tools-only secret
 *   USE_GRANOLA=1            read notes from Granola's hosted MCP server
 *   NOTES_MCP_URL            stand-in notes server (default http://notes-mcp:8787/mcp)
 *   NOTES_MCP_TOKEN          bearer token for the stand-in, if it requires one
 *   TYPEFULLY_API_KEY        enables the publisher (with TYPEFULLY_SOCIAL_SET_ID)
 *   TYPEFULLY_SOCIAL_SET_ID  Typefully social set to schedule into
 *   RUN_NOW=1                start this week's run right after seeding
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { manifestToAgentCreateInput } from '@stablehand/manifest';
import {
  createWorkspaceArchive,
  loadManifestProject,
  type LoadedManifestProject,
} from '@stablehand/manifest/node';

interface FactoryConfig {
  campaign: string;
  timezone: string;
  schedule: { weekly: string; measure: string };
  budget: { weeklyUsd: number; weeklyRuns: number };
  niche: Record<string, unknown>;
  me: { xHandle?: string; linkedinUrl?: string };
}

interface StageAgent {
  dir: string;
  name: string;
  id: string;
}

const API_BASE = process.env.API_URL ?? 'http://localhost:3002';
const API_TOKEN = process.env.STABLEHAND_API_TOKEN;
const CONFIG_PATH = process.env.FACTORY_CONFIG
  ?? fileURLToPath(new URL('./factory.config.json', import.meta.url));
const USE_GRANOLA = process.env.USE_GRANOLA === '1';
const NOTES_MCP_URL = process.env.NOTES_MCP_URL ?? 'http://notes-mcp:8787/mcp';
const NOTES_MCP_TOKEN = process.env.NOTES_MCP_TOKEN;
const APIFY_TOKEN = process.env.APIFY_TOKEN;
const TYPEFULLY_API_KEY = process.env.TYPEFULLY_API_KEY;
const TYPEFULLY_SOCIAL_SET_ID = process.env.TYPEFULLY_SOCIAL_SET_ID;
const PUBLISHING = Boolean(TYPEFULLY_API_KEY && TYPEFULLY_SOCIAL_SET_ID);
const RUN_NOW = process.env.RUN_NOW === '1' || process.argv.includes('--run-now');

export const EVENTS = {
  week: 'custom.factory.week',
  brief: 'custom.factory.brief',
  material: 'custom.factory.material',
  draft: 'custom.factory.draft',
  approved: 'custom.factory.approved',
  rejected: 'custom.factory.rejected',
  published: 'custom.factory.published',
  measure: 'custom.factory.measure',
  measured: 'custom.factory.measured',
} as const;

function headers(json = true): Record<string, string> {
  return {
    ...(API_TOKEN ? { Authorization: `Bearer ${API_TOKEN}` } : {}),
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  };
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { ...headers(init.body !== undefined && !(init.body instanceof Blob)), ...(init.headers ?? {}) },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${init.method ?? 'GET'} ${path} -> HTTP ${res.status}: ${text.slice(0, 400)}`);
  }
  return (text ? JSON.parse(text) : null) as T;
}

function post<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: 'POST', body: JSON.stringify(body) });
}

function patch<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
}

async function loadConfig(): Promise<FactoryConfig> {
  return JSON.parse(await readFile(CONFIG_PATH, 'utf8')) as FactoryConfig;
}

/** Point the notes miner at the stand-in unless Granola is wanted. */
function compileAgent(dir: string, project: LoadedManifestProject) {
  if (dir !== 'notes-miner' || USE_GRANOLA) return project.agentCreateInput;
  const manifest = structuredClone(project.manifest);
  manifest.spec.mcpServers = (manifest.spec.mcpServers ?? []).map((server) => server.name === 'notes'
    ? {
      ...server,
      url: NOTES_MCP_URL,
      description: 'Synthetic meeting notes (stand-in for Granola)',
      auth: NOTES_MCP_TOKEN ? { type: 'bearer' as const, token: '$secret:NOTES_MCP_TOKEN' } : { type: 'none' as const },
    }
    : server);
  return manifestToAgentCreateInput(manifest, {
    resolvedInstructions: project.resolvedInstructions,
    ...(project.agentCreateInput.workspaceContent ? { workspaceContent: project.agentCreateInput.workspaceContent } : {}),
  });
}

async function upsertAgent(dir: string, existing: Map<string, string>): Promise<StageAgent> {
  const manifestPath = fileURLToPath(new URL(`./agents/${dir}/agent.yaml`, import.meta.url));
  const project = await loadManifestProject(manifestPath);
  const payload = compileAgent(dir, project);
  const existingId = existing.get(payload.name);
  const saved = existingId
    ? await patch<{ id: string }>(`/api/agents/${existingId}`, payload)
    : await post<{ id: string }>('/api/agents', payload);
  console.log(`  ${existingId ? 'updated' : 'created'} ${payload.name}`);

  if (project.workspace.fileCount > 0) {
    const archive = await createWorkspaceArchive(project.workspace);
    await request(`/api/agents/${saved.id}/workspace`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/gzip', 'Content-Encoding': 'gzip' },
      body: new Blob([new Uint8Array(archive)]),
    });
    console.log(`    workspace: ${project.workspace.fileCount} files`);
  }
  return { dir, name: payload.name, id: saved.id };
}

async function putToolSecret(agent: StageAgent, key: string, value: string): Promise<void> {
  await post(`/api/agents/${agent.id}/secrets`, { key, value, scope: 'tools' });
  console.log(`    ${agent.name}: stored ${key} (tools only, never in the sandbox)`);
}

async function refreshMcp(agent: StageAgent, server: string): Promise<void> {
  const body = await post<{ servers: Array<{ name: string; state: string; message?: string; toolCount: number }> }>(
    `/api/agents/${agent.id}/mcp-servers/${server}/refresh`,
    {},
  );
  const status = body.servers.find((candidate) => candidate.name === server);
  console.log(`    ${agent.name}/${server}: ${status?.state ?? 'unknown'}, ${status?.toolCount ?? 0} tools${status?.message ? ` (${status.message})` : ''}`);
}

async function ensureTrigger(agent: StageAgent, eventType: string, taskTemplate: string): Promise<void> {
  const triggers = await request<Array<{ id: string; agentId: string; eventType: string; taskTemplate: string; enabled: boolean }>>('/api/triggers');
  const existing = triggers.find((trigger) => trigger.agentId === agent.id && trigger.eventType === eventType);
  if (!existing) {
    await post('/api/triggers', { agentId: agent.id, eventType, taskTemplate, enabled: true });
  } else if (existing.taskTemplate !== taskTemplate || !existing.enabled) {
    await request(`/api/triggers/${existing.id}`, {
      method: 'PUT',
      body: JSON.stringify({ taskTemplate, enabled: true }),
    });
  }
  console.log(`  ${eventType} -> ${agent.name}`);
}

async function ensureSchedule(
  name: string,
  cronExpression: string,
  timezone: string,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const { schedules } = await request<{ schedules: Array<{ id: string; name: string }> }>('/api/schedules');
  const existing = schedules.find((schedule) => schedule.name === name);
  const body = { cronExpression, timezone, eventType, payload, enabled: true };
  if (existing) {
    await patch(`/api/schedules/${existing.id}`, body);
  } else {
    await post('/api/schedules', { name, ...body });
  }
  console.log(`  ${name}: ${cronExpression} (${timezone}) emits ${eventType}`);
}

async function ensureBudget(config: FactoryConfig): Promise<void> {
  const name = `${config.campaign} weekly budget`;
  const doc = {
    selector: { campaign: config.campaign },
    window: 'rolling-7d',
    limits: { costUsd: config.budget.weeklyUsd, turns: config.budget.weeklyRuns },
    actions: [
      { threshold: 0.5, action: 'warn' },
      { threshold: 1, action: 'block' },
    ],
  };
  const { policies } = await request<{ policies: Array<{ id: string; name: string }> }>('/api/budgets');
  const existing = policies.find((policy) => policy.name === name);
  if (existing) {
    await patch(`/api/budgets/${existing.id}`, { doc, enabled: true });
  } else {
    await post('/api/budgets', { name, enabled: true, doc });
  }
  console.log(`  ${name}: $${config.budget.weeklyUsd} and ${config.budget.weeklyRuns} runs per rolling 7 days, warn at 50%, block at 100%`);
}

async function seed(): Promise<void> {
  const config = await loadConfig();
  console.log(`\nSeeding the content factory against ${API_BASE}\n`);

  const listed = await request<Array<{ id: string; name: string }>>('/api/agents');
  const existing = new Map(listed.map((agent) => [agent.name, agent.id]));
  const dirs = ['scout', 'notes-miner', 'writer', 'editor', 'measure', ...(PUBLISHING ? ['publisher'] : [])];
  const agents: Record<string, StageAgent> = {};
  console.log('Agents');
  for (const dir of dirs) {
    agents[dir] = await upsertAgent(dir, existing);
  }
  const stage = (dir: string): StageAgent => {
    const agent = agents[dir];
    if (!agent) throw new Error(`agent ${dir} was not seeded`);
    return agent;
  };

  console.log('\nSecrets');
  if (APIFY_TOKEN) {
    await putToolSecret(stage('scout'), 'APIFY_TOKEN', APIFY_TOKEN);
    await putToolSecret(stage('measure'), 'APIFY_TOKEN', APIFY_TOKEN);
  } else {
    console.log('  APIFY_TOKEN not set: the scout and measure agents will report "needs sign-in" until you add it');
  }
  if (NOTES_MCP_TOKEN && !USE_GRANOLA) {
    await putToolSecret(stage('notes-miner'), 'NOTES_MCP_TOKEN', NOTES_MCP_TOKEN);
  }
  if (PUBLISHING && TYPEFULLY_API_KEY && TYPEFULLY_SOCIAL_SET_ID) {
    const publisher = stage('publisher');
    await putToolSecret(publisher, 'TYPEFULLY_API_KEY', TYPEFULLY_API_KEY);
    await patch(`/api/agents/${publisher.id}`, {
      httpTools: [{
        name: 'typefully_create_draft',
        description: 'Create a Typefully draft for LinkedIn or X and schedule it into the next free slot. Waits for the owner\'s approval.',
        endpoint: `https://api.typefully.com/v2/social-sets/${encodeURIComponent(TYPEFULLY_SOCIAL_SET_ID)}/drafts`,
        method: 'POST',
        inputSchema: {
          type: 'object',
          properties: {
            platforms: { type: 'object', description: 'Typefully platforms object, e.g. {"x": {"enabled": true, "posts": [{"text": "..."}]}}' },
            publish_at: { type: 'string', description: '"next-free-slot" or an ISO 8601 time' },
            draft_title: { type: 'string' },
          },
          required: ['platforms'],
        },
        authentication: { type: 'bearer', secretName: 'TYPEFULLY_API_KEY' },
        requiresApproval: true,
        timeoutMs: 30_000,
      }],
    });
    console.log('    factory-publisher: typefully_create_draft asks for approval on every call');
  }

  console.log('\nMCP servers');
  await refreshMcp(stage('scout'), 'apify');
  await refreshMcp(stage('measure'), 'apify');
  await refreshMcp(stage('notes-miner'), 'notes');

  console.log('\nTriggers');
  await ensureTrigger(stage('scout'), EVENTS.week,
    'Weekly scout run for the content factory.\nNiche config: {{payload.niche}}\nOwner accounts: {{payload.me}}\nFollow your steps.');
  await ensureTrigger(stage('scout'), EVENTS.measured,
    'File this engagement report for next week\'s brief:\n\n{{payload.report}}');
  await ensureTrigger(stage('notes-miner'), EVENTS.brief,
    'This week\'s brief from the scout (week {{payload.week}}):\n\n{{payload.brief}}\n\nMine this week\'s meeting notes and follow your steps. Pass the brief on unchanged.');
  await ensureTrigger(stage('writer'), EVENTS.material,
    'Write this week\'s drafts (week {{payload.week}}).\n\nWhat\'s working:\n{{payload.brief}}\n\nStories from the owner\'s meetings:\n{{payload.stories}}');
  await ensureTrigger(stage('editor'), EVENTS.draft,
    'Review this draft.\nchannel: {{payload.channel}}\ntitle: {{payload.title}}\nstory: {{payload.story}}\nweek: {{payload.week}}\n\ntext:\n{{payload.text}}');
  await ensureTrigger(stage('measure'), EVENTS.measure,
    'Measure the owner\'s posts from the last 7 days. Owner accounts: {{payload.me}}');
  if (PUBLISHING) {
    await ensureTrigger(stage('publisher'), EVENTS.approved,
      'Schedule this approved post.\nchannel: {{payload.channel}}\ntitle: {{payload.title}}\n\ntext:\n{{payload.text}}');
  }

  console.log('\nSchedules');
  await ensureSchedule(`${config.campaign}-weekly`, config.schedule.weekly, config.timezone, EVENTS.week, {
    niche: config.niche,
    me: config.me,
  });
  await ensureSchedule(`${config.campaign}-measure`, config.schedule.measure, config.timezone, EVENTS.measure, {
    me: config.me,
  });

  console.log('\nBudget');
  await ensureBudget(config);

  if (RUN_NOW) {
    await post('/api/triggers/emit', { type: EVENTS.week, payload: { niche: config.niche, me: config.me } });
    console.log(`\nStarted this week's run (emitted ${EVENTS.week}).`);
  }

  console.log('\nSeed complete.');
  console.log('Chain: scout -> notes miner -> writer -> editor (one review card per draft)'
    + `${PUBLISHING ? ' -> publisher' : ''}; measure runs on its own schedule and feeds the scout.`);
  if (USE_GRANOLA) {
    console.log('Next: open factory-notes-miner > Tools in the dashboard and press Connect on "notes" to sign in to Granola.');
  }
  if (!PUBLISHING) {
    console.log('Publishing is off: approved drafts land as artifacts (kind approved-draft).');
  }
}

seed().catch((error: unknown) => {
  console.error('Seed failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
