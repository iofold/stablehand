#!/usr/bin/env npx tsx

import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import {
  createWorkspaceArchive,
  loadManifestProject,
  type LoadedManifestProject,
} from '@stablehand/manifest/node';

type AgentPayload = LoadedManifestProject['agentCreateInput'];

type AgentResult = {
  id?: string;
  name?: string;
  error?: string;
  [key: string]: unknown;
};

type TriggerResult = {
  id?: string;
  taskTemplate?: string;
  enabled?: boolean;
  error?: string;
  [key: string]: unknown;
};

const API_BASE = process.env.API_URL ?? 'http://localhost:3002';
const API_TOKEN = process.env.STABLEHAND_API_TOKEN;
const AGENTS_DIR = new URL('./agents/', import.meta.url);

function authHeaders(): Record<string, string> {
  return API_TOKEN ? { Authorization: `Bearer ${API_TOKEN}` } : {};
}

function jsonHeaders(): Record<string, string> {
  return { ...authHeaders(), 'Content-Type': 'application/json' };
}

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
  const res = await fetch(`${API_BASE}/api/agents`, { headers: authHeaders() });
  const body = await parseJson(res);
  if (!res.ok) {
    throw new Error(`Agent listing failed (${res.status}): ${JSON.stringify(body)}`);
  }
  if (!Array.isArray(body)) {
    throw new Error(`Agent listing returned an invalid response: ${JSON.stringify(body)}`);
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
    headers: jsonHeaders(),
    body: JSON.stringify(payload),
  });
  const body = await parseJson(res);
  const data = isRecord(body) ? body as AgentResult : {};
  const verb = existingId ? 'updated' : 'created';
  if (!res.ok) {
    throw new Error(`Agent ${verb} failed for ${dir} (${res.status}): ${JSON.stringify(body)}`);
  }
  if (typeof data.id !== 'string') {
    throw new Error(`Agent ${verb} returned no id for ${dir}: ${JSON.stringify(body)}`);
  }
  console.log(`  [OK] ${dir} => ${data.name ?? data.id} (${verb})`);
  return data;
}

async function uploadWorkspace(
  dir: string,
  agentId: string,
  project: LoadedManifestProject,
): Promise<void> {
  if (project.workspace.files.length === 0 && project.workspace.directories.length === 0) {
    return;
  }

  const archive = await createWorkspaceArchive(project.workspace);
  const res = await fetch(`${API_BASE}/api/agents/${encodeURIComponent(agentId)}/workspace`, {
    method: 'POST',
    headers: {
      ...authHeaders(),
      'Content-Type': 'application/gzip',
      'Content-Encoding': 'gzip',
    },
    body: new Blob([new Uint8Array(archive)]),
  });
  const data = await parseJson(res);
  if (!res.ok) {
    throw new Error(`Workspace upload failed for ${dir} (${res.status}): ${JSON.stringify(data)}`);
  }
  console.log(`  [OK] ${dir} workspace uploaded (${project.workspace.fileCount} files)`);
}

async function registerTrigger(
  agentId: string,
  eventType: string,
  taskTemplate: string,
  label: string,
): Promise<TriggerResult> {
  const res = await fetch(`${API_BASE}/api/triggers`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({ agentId, eventType, taskTemplate, enabled: true }),
  });
  const body = await parseJson(res);
  const data = isRecord(body) ? body as TriggerResult : {};
  if (!res.ok) {
    throw new Error(`Trigger registration failed for ${label} (${res.status}): ${JSON.stringify(body)}`);
  }
  if (typeof data.id !== 'string') {
    throw new Error(`Trigger registration returned no id for ${label}: ${JSON.stringify(body)}`);
  }

  if (data.taskTemplate !== taskTemplate || data.enabled !== true) {
    const updateRes = await fetch(`${API_BASE}/api/triggers/${encodeURIComponent(data.id)}`, {
      method: 'PUT',
      headers: jsonHeaders(),
      body: JSON.stringify({ taskTemplate, enabled: true }),
    });
    const updateBody = await parseJson(updateRes);
    if (!updateRes.ok) {
      throw new Error(
        `Trigger reconciliation failed for ${label} (${updateRes.status}): ${JSON.stringify(updateBody)}`,
      );
    }
    if (!isRecord(updateBody) || typeof updateBody.id !== 'string') {
      throw new Error(`Trigger reconciliation returned no id for ${label}: ${JSON.stringify(updateBody)}`);
    }
    console.log(`  [OK]   ${label}: trigger reconciled`);
    return updateBody as TriggerResult;
  }

  console.log(`  [OK]   ${label}: on "${eventType}" => agent ${agentId}`);
  return data;
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
      await uploadWorkspace(dir, agentId, project);
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
