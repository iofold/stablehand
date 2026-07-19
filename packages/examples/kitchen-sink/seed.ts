#!/usr/bin/env npx tsx

import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import {
  loadManifestProject,
  type LoadedManifestProject,
} from '@ctxmill/manifest/node';

type AgentPayload = LoadedManifestProject['agentCreateInput'];

type AgentResult = {
  id?: string;
  name?: string;
  error?: string;
  [key: string]: unknown;
};

type TriggerResult = {
  id?: string;
  error?: string;
  [key: string]: unknown;
};

const API_BASE = process.env.API_URL ?? 'http://localhost:3002';
const AGENTS_DIR = new URL('./agents/', import.meta.url);

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

async function fetchAgents(): Promise<Array<{ id?: string; name: string }>> {
  const res = await fetch(`${API_BASE}/api/agents`);
  if (!res.ok) {
    return [];
  }

  const body = await parseJson(res);
  if (!Array.isArray(body)) {
    return [];
  }

  return body
    .filter((item): item is Record<string, unknown> => isRecord(item) && typeof item.name === 'string')
    .map((item) => ({
      id: typeof item.id === 'string' ? item.id : undefined,
      name: item.name as string,
    }));
}

async function upsertAgent(dir: string, payload: AgentPayload, existingId?: string): Promise<AgentResult> {
  const endpoint = existingId ? `${API_BASE}/api/agents/${existingId}` : `${API_BASE}/api/agents`;
  const method = existingId ? 'PUT' : 'POST';
  const res = await fetch(endpoint, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = (await parseJson(res)) as AgentResult;
  const status = res.ok ? 'OK' : 'FAIL';
  const verb = existingId ? 'updated' : 'created';
  console.log(`  [${status}] ${dir} => ${data.name ?? data.id ?? payload.name} (${verb})`);
  if (!res.ok) {
    console.error(`        Error: ${JSON.stringify(data)}`);
  }
  return data;
}

async function registerTrigger(
  agentId: string,
  eventType: string,
  taskTemplate: string,
  label: string,
): Promise<TriggerResult | null> {
  const res = await fetch(`${API_BASE}/api/triggers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId, eventType, taskTemplate, enabled: true }),
  });
  const data = (await res.json()) as TriggerResult;
  if (res.ok) {
    console.log(`  [OK]   ${label}: on "${eventType}" => agent ${agentId}`);
  } else {
    console.error(`  [FAIL] ${label}: ${JSON.stringify(data)}`);
  }
  return res.ok ? data : null;
}

async function seed(): Promise<void> {
  console.log(`\nSeeding kitchen-sink agents against ${API_BASE}\n`);
  console.log('--- Seeding agent definitions ---\n');

  const agentDirs = (await readdir(AGENTS_DIR, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const importedAgents: Record<string, string> = {};
  const existingAgents = await fetchAgents();
  const existingByName = new Map(existingAgents.map((agent) => [agent.name, agent.id]));

  for (const dir of agentDirs) {
    const manifestUrl = new URL(`./${dir}/agent.yaml`, AGENTS_DIR);
    const project = await loadManifestProject(fileURLToPath(manifestUrl));
    const payload = project.agentCreateInput;
    const result = await upsertAgent(dir, payload, existingByName.get(payload.name));
    const agentId = typeof result.id === 'string' ? result.id : undefined;
    if (agentId) {
      importedAgents[dir] = agentId;
    }
  }

  const importedCount = Object.keys(importedAgents).length;
  console.log(`\nSeeded ${importedCount} / ${agentDirs.length} agents.\n`);

  if (importedCount === 0) {
    console.error('No agents seeded. Aborting trigger registration.');
    process.exit(1);
  }

  console.log('--- Registering event triggers ---\n');

  const langgraphId = importedAgents['langgraph-agent'];
  const claudeId = importedAgents['claude-agent'];
  const piId = importedAgents['pi-agent'];

  if (claudeId) {
    await registerTrigger(
      claudeId,
      'analysis.complete',
      'Write a polished final report based on this analysis:\n\n{{payload.analysis}}',
      'analyst -> writer',
    );
  }

  if (piId) {
    await registerTrigger(
      piId,
      'report.ready',
      'Audit log entry: Event "report.ready" received. Payload: {{payload}}',
      'writer -> auditor',
    );
  }

  if (piId) {
    const auditEvents = [
      'analysis.complete',
      'report.ready',
    ];
    for (const eventType of auditEvents) {
      await registerTrigger(
        piId,
        eventType,
        `Audit log entry: Event "${eventType}" received. Payload: {{payload}}`,
        `auditor <- ${eventType}`,
      );
    }
  }

  console.log('\n--- Seed complete ---\n');
  console.log('Agent chain:');
  console.log(
    `  ${langgraphId ? 'langgraph-analyst' : '(missing)'} ` +
    `--[analysis.complete]--> ${claudeId ? 'claude-writer' : '(missing)'} ` +
    `--[report.ready]--> ${piId ? 'pi-auditor' : '(missing)'}`,
  );
  console.log(`  ${piId ? 'pi-auditor' : '(missing)'} monitors: analysis.complete, report.ready`);
  console.log('');
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
