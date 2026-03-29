declare const process: {
  env: Record<string, string | undefined>;
  argv: string[];
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

type ManifestModel = {
  provider?: unknown;
  id?: unknown;
  apiKeyRef?: unknown;
};

type ManifestToolRef = {
  ref?: unknown;
};

type ManifestMetadata = {
  name?: unknown;
  displayName?: unknown;
  description?: unknown;
  labels?: unknown;
};

type ManifestSpec = {
  harness?: unknown;
  harnessConfig?: unknown;
  model?: unknown;
  instructions?: unknown;
  tools?: unknown;
  nativeTools?: unknown;
  resources?: unknown;
};

type ParsedManifest = {
  metadata?: unknown;
  spec?: unknown;
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

const loadFsPromises = new Function('return import("node:fs/promises")') as () => Promise<FsPromises>;
const loadYaml = new Function('return import("yaml")') as () => Promise<YamlModule>;
const { readdir, readFile } = await loadFsPromises();
const { parse: parseYaml } = await loadYaml();

const API_BASE = process.env.API_BASE ?? 'http://localhost:3002';
const AGENTS_DIR = new URL('./agents/', import.meta.url);
const CLEAN_FLAG = '--clean';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function pickString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Manifest field ${fieldName} must be a non-empty string.`);
  }
  return value;
}

function toObject(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error('Expected object in manifest.');
  }
  return value;
}

function toHarnessConfig(spec: ManifestSpec): Record<string, unknown> {
  if (isRecord(spec.harnessConfig)) {
    return { ...spec.harnessConfig };
  }

  const model = spec.model as ManifestModel | undefined;
  if (!isRecord(model)) {
    throw new Error('Manifest spec.harnessConfig or spec.model is required.');
  }

  const provider = pickString(model.provider, 'spec.model.provider');
  const modelId = pickString(model.id, 'spec.model.id');
  const harnessConfig: Record<string, unknown> = {
    provider,
    model: modelId,
  };

  if (typeof model.apiKeyRef === 'string' && model.apiKeyRef.trim() !== '') {
    harnessConfig.apiKeyRef = model.apiKeyRef;
  }

  return harnessConfig;
}

function toToolRefs(rawTools: unknown): string[] {
  if (!Array.isArray(rawTools)) {
    return [];
  }

  return rawTools
    .map((tool) => (isRecord(tool) ? (tool as ManifestToolRef).ref : undefined))
    .filter((toolRef): toolRef is string => typeof toolRef === 'string' && toolRef.trim() !== '');
}

function parseManifestToPayload(manifestYaml: string): AgentPayload {
  const parsed = parseYaml(manifestYaml) as ParsedManifest;
  const metadata = toObject(parsed.metadata);
  const spec = toObject(parsed.spec) as ManifestSpec;

  const payloadMetadata: Record<string, unknown> = {};
  if (typeof (metadata as ManifestMetadata).displayName === 'string') {
    payloadMetadata.displayName = (metadata as ManifestMetadata).displayName;
  }
  if (isRecord((metadata as ManifestMetadata).labels)) {
    payloadMetadata.labels = (metadata as ManifestMetadata).labels as Record<string, unknown>;
  }
  if (isRecord(spec.nativeTools)) {
    payloadMetadata.nativeTools = spec.nativeTools;
  }
  if (isRecord(spec.resources)) {
    payloadMetadata.resourceLimits = spec.resources;
  }

  const payload: AgentPayload = {
    name: pickString((metadata as ManifestMetadata).name, 'metadata.name'),
    harness: pickString(spec.harness, 'spec.harness'),
    harnessConfig: toHarnessConfig(spec),
    systemPrompt: pickString(spec.instructions, 'spec.instructions'),
    tools: toToolRefs(spec.tools),
  };

  const description = (metadata as ManifestMetadata).description;
  if (typeof description === 'string' && description.trim() !== '') {
    payload.description = description;
  }
  if (isRecord(spec.resources)) {
    payload.resourceLimits = spec.resources;
  }
  if (Object.keys(payloadMetadata).length > 0) {
    payload.metadata = payloadMetadata;
  }

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

async function listAgentDirs(): Promise<string[]> {
  const entries = await readdir(AGENTS_DIR, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => new URL(`${entry.name}/`, AGENTS_DIR).pathname).sort();
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
  const res = await fetch(`${API_BASE}/api/agents`);
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
    headers: { 'Content-Type': 'application/json' },
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
    const res = await fetch(`${API_BASE}${endpoint}`, { method: 'DELETE' });
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
    headers: { 'Content-Type': 'application/json' },
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
    const manifestYaml = await readFile(manifestPath, 'utf8');
    const payload = parseManifestToPayload(manifestYaml);
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
