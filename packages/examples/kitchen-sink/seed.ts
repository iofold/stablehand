#!/usr/bin/env npx tsx

declare const process: {
  env: Record<string, string | undefined>;
  exit(code?: number): never;
};

type DirectoryEntry = {
  name: string;
  isDirectory(): boolean;
};

type FsPromises = {
  readdir(path: string | URL, options: { withFileTypes: true }): Promise<DirectoryEntry[]>;
  readFile(path: string | URL, encoding: 'utf8'): Promise<string>;
};

type YamlModule = {
  parse(source: string): unknown;
};

type AgentPayload = {
  name: string;
  harness: string;
  harnessConfig: Record<string, unknown>;
  systemPrompt: string;
  tools: string[];
  description?: string;
  metadata?: Record<string, unknown>;
  resourceLimits?: Record<string, unknown>;
};

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

const loadFsPromises = new Function('return import("node:fs/promises")') as () => Promise<FsPromises>;
const loadYaml = new Function('return import("yaml")') as () => Promise<YamlModule>;
const { readdir, readFile } = await loadFsPromises();
const { parse: parseYaml } = await loadYaml();

const API_BASE = process.env.API_URL ?? 'http://localhost:3002';
const AGENTS_DIR = new URL('./agents/', import.meta.url);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function requireString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Manifest field ${fieldName} must be a non-empty string.`);
  }
  return value;
}

function parseManifestToPayload(manifestYaml: string): AgentPayload {
  const parsed = parseYaml(manifestYaml) as Record<string, unknown>;
  const metadata = isRecord(parsed.metadata) ? parsed.metadata : {};
  const spec = isRecord(parsed.spec) ? parsed.spec : {};
  const agentMetadata: Record<string, unknown> = {};

  if (typeof metadata.displayName === 'string') {
    agentMetadata.displayName = metadata.displayName;
  }
  if (isRecord(metadata.labels)) {
    agentMetadata.labels = metadata.labels;
  }
  if (isRecord(spec.nativeTools)) {
    agentMetadata.nativeTools = spec.nativeTools;
  }
  if (isRecord(spec.resources)) {
    agentMetadata.resourceLimits = spec.resources;
  }

  let harnessConfig: Record<string, unknown>;
  if (isRecord(spec.harnessConfig)) {
    harnessConfig = { ...spec.harnessConfig };
  } else {
    const model = isRecord(spec.model) ? spec.model : null;
    if (!model) {
      throw new Error('Manifest requires spec.harnessConfig or spec.model.');
    }
    harnessConfig = {
      provider: requireString(model.provider, 'spec.model.provider'),
      model: requireString(model.id, 'spec.model.id'),
    };
    if (typeof model.apiKeyRef === 'string' && model.apiKeyRef.trim() !== '') {
      harnessConfig.apiKeyRef = model.apiKeyRef;
    }
  }

  const tools = Array.isArray(spec.tools)
    ? spec.tools
        .map((tool) => (isRecord(tool) && typeof tool.ref === 'string' ? tool.ref : null))
        .filter((tool): tool is string => tool !== null)
    : [];

  const payload: AgentPayload = {
    name: requireString(metadata.name, 'metadata.name'),
    harness: requireString(spec.harness, 'spec.harness'),
    harnessConfig,
    systemPrompt: requireString(spec.instructions, 'spec.instructions'),
    tools,
  };

  if (typeof metadata.description === 'string' && metadata.description.trim() !== '') {
    payload.description = metadata.description;
  }
  if (Object.keys(agentMetadata).length > 0) {
    payload.metadata = agentMetadata;
  }
  if (isRecord(spec.resources)) {
    payload.resourceLimits = spec.resources;
  }

  // Preserve the full manifest so spec fields survive the API → DB round-trip.
  (payload as Record<string, unknown>).manifest = parsed;

  return payload;
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
    const manifestYaml = await readFile(manifestUrl, 'utf8');
    const payload = parseManifestToPayload(manifestYaml);
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
