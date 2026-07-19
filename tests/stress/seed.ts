import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import {
  loadManifestProject,
  type LoadedManifestProject,
} from '@ctxmill/manifest/node';

type AgentPayload = LoadedManifestProject['agentCreateInput'];

type SeedResult = {
  name: string;
  dir: string;
  ok: boolean;
  status: number;
  body: unknown;
};

type AgentSummary = {
  name: string;
  id?: string;
};

type TriggerPayload = {
  agentId: string;
  eventType: string;
  taskTemplate: string;
  enabled: boolean;
};

const API_BASE = process.env.API_BASE ?? 'http://localhost:3002';
const AGENTS_DIR = new URL('./agents/', import.meta.url);
const CLEAN_FLAG = '--clean';
const API_TOKEN = process.env.CTXMILL_API_TOKEN;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function parseJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function authHeaders(): Record<string, string> {
  return API_TOKEN ? { Authorization: `Bearer ${API_TOKEN}` } : {};
}

function jsonHeaders(): Record<string, string> {
  return { ...authHeaders(), 'Content-Type': 'application/json' };
}

async function listAgentDirs(): Promise<string[]> {
  const entries = await readdir(AGENTS_DIR, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => fileURLToPath(new URL(`${entry.name}/`, AGENTS_DIR)))
    .sort();
}

async function listManifestPaths(): Promise<string[]> {
  const dirs = await listAgentDirs();
  return dirs.map((dir) => `${dir}agent.yaml`);
}

function normalizeAgent(body: unknown, fallbackName: string): AgentSummary {
  if (!isRecord(body)) {
    return { name: fallbackName };
  }

  const id = typeof body.agentId === 'string'
    ? body.agentId
    : typeof body.id === 'string'
      ? body.id
      : undefined;
  const name = typeof body.name === 'string' ? body.name : fallbackName;
  return { name, id };
}

async function fetchAgents(): Promise<AgentSummary[]> {
  const res = await fetch(`${API_BASE}/api/agents`, { headers: authHeaders() });
  if (!res.ok) {
    return [];
  }

  const body = await parseJson(res);
  if (!Array.isArray(body)) {
    return [];
  }

  return body
    .filter((item): item is Record<string, unknown> => isRecord(item))
    .map((item) => ({
      name: typeof item.name === 'string' ? item.name : '',
      id: typeof item.id === 'string' ? item.id : undefined,
    }))
    .filter((item) => item.name !== '');
}

async function upsertAgent(dir: string, payload: AgentPayload, existingAgentId?: string): Promise<SeedResult> {
  const endpoint = existingAgentId
    ? `${API_BASE}/api/agents/${existingAgentId}`
    : `${API_BASE}/api/agents`;
  const method = existingAgentId ? 'PUT' : 'POST';
  const res = await fetch(endpoint, {
    method,
    headers: jsonHeaders(),
    body: JSON.stringify(payload),
  });

  const body = await parseJson(res);
  return {
    name: payload.name,
    dir,
    ok: res.ok,
    status: res.status,
    body,
  };
}

async function deleteAgent(agent: AgentSummary): Promise<void> {
  const candidatePaths = [
    agent.id ? `/api/agents/${agent.id}` : null,
    `/api/agents/${agent.name}`,
    `/api/agents/name/${agent.name}`,
    `/api/agent-definitions/${agent.name}`,
  ].filter((value): value is string => value !== null);

  for (const endpoint of candidatePaths) {
    const res = await fetch(`${API_BASE}${endpoint}`, {
      method: 'DELETE',
      headers: authHeaders(),
    });
    if (res.ok || res.status === 404) {
      return;
    }
  }

  throw new Error(`Failed to delete stress agent '${agent.name}'.`);
}

async function cleanStressAgents(): Promise<void> {
  const agents = (await fetchAgents()).filter((agent) => agent.name.startsWith('stress-'));
  if (agents.length === 0) {
    console.log('No stress agents found to delete.');
    return;
  }

  for (const agent of agents) {
    await deleteAgent(agent);
    console.log(`Deleted ${agent.name}`);
  }
}

async function registerTrigger(results: SeedResult[]): Promise<void> {
  const responder = results.find((r) => r.name === 'stress-chain-responder');
  if (!responder || !responder.ok) {
    console.log('  [SKIP] stress-chain-responder not seeded — skipping trigger registration');
    return;
  }

  const agent = normalizeAgent(responder.body, responder.name);
  if (!agent.id) {
    console.log('  [SKIP] Could not determine stress-chain-responder ID — skipping trigger');
    return;
  }

  const payload: TriggerPayload = {
    agentId: agent.id,
    eventType: 'stress.tools.complete',
    taskTemplate: 'Chain event received: {{payload}}',
    enabled: true,
  };

  const res = await fetch(`${API_BASE}/api/triggers`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify(payload),
  });

  if (res.ok || res.status === 409) {
    console.log(`  [OK] Trigger: stress.tools.complete -> ${agent.id}`);
    return;
  }

  const body = await parseJson(res);
  console.error(`  [WARN] Trigger registration returned ${res.status}: ${JSON.stringify(body)}`);
}

async function seedAllAgents(): Promise<SeedResult[]> {
  const manifestPaths = await listManifestPaths();
  const existingAgents = await fetchAgents();
  const existingByName = new Map(existingAgents.map((agent) => [agent.name, agent]));
  const results: SeedResult[] = [];

  for (const manifestPath of manifestPaths) {
    const payload = (await loadManifestProject(manifestPath)).agentCreateInput;
    const existingAgent = existingByName.get(payload.name);
    const result = await upsertAgent(manifestPath.replace(/\/agent\.yaml$/, ''), payload, existingAgent?.id);
    if (!result.ok) {
      throw new Error(`Seed failed for ${manifestPath} (${result.status}): ${JSON.stringify(result.body)}`);
    }
    results.push(result);
  }

  return results;
}

function printSummary(results: SeedResult[]): void {
  console.log(`Seeded ${results.length} stress agents:`);

  for (const result of results) {
    const agent = normalizeAgent(result.body, result.name);
    const suffix = agent.id ? ` (${agent.id})` : '';
    console.log(`- ${agent.name}${suffix}`);
  }
}

async function main(): Promise<void> {
  if (process.argv.includes(CLEAN_FLAG)) {
    await cleanStressAgents();
    return;
  }

  const results = await seedAllAgents();
  await registerTrigger(results);

  printSummary(results);
  console.log('Trigger registered: stress.tools.complete -> stress-chain-responder');
  console.log(`Agents: ${results.map((result) => result.name).join(', ')}`);
}

await main();
