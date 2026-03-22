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

const loadFsPromises = new Function('return import("node:fs/promises")') as () => Promise<FsPromises>;
const { readdir, readFile } = await loadFsPromises();

const API_BASE = process.env.API_BASE ?? 'http://localhost:3002';
const AGENTS_DIR = new URL('./agents/', import.meta.url);
const CLEAN_FLAG = '--clean';
const STRESS_TRIGGER_NAME = 'stress-tools-complete-to-chain-responder';

type ImportResult = {
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

async function importManifest(dir: string, manifestYaml: string): Promise<ImportResult> {
  const res = await fetch(`${API_BASE}/api/agents/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: manifestYaml }),
  });

  const body = await parseJson(res);
  return {
    name: basename(dir),
    dir,
    ok: res.ok,
    status: res.status,
    body,
  };
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

function basename(value: string): string {
  const normalized = value.replace(/\/$/, '');
  const parts = normalized.split('/');
  return parts[parts.length - 1] ?? normalized;
}

function extractAgentName(manifestYaml: string): string {
  const match = manifestYaml.match(/^\s*name:\s*([^\n]+)$/m);
  if (!match) {
    throw new Error('Unable to determine agent name from manifest.');
  }

  return match[1].trim();
}

function normalizeImportedAgent(body: unknown, fallbackName: string): AgentSummary {
  if (!body || typeof body !== 'object') {
    return { name: fallbackName };
  }

  const record = body as Record<string, unknown>;
  const id = typeof record.agentId === 'string'
    ? record.agentId
    : typeof record.id === 'string'
      ? record.id
      : undefined;
  const manifest = typeof record.manifest === 'object' && record.manifest !== null
    ? record.manifest as Record<string, unknown>
    : undefined;
  const metadata = manifest && typeof manifest.metadata === 'object' && manifest.metadata !== null
    ? manifest.metadata as Record<string, unknown>
    : undefined;
  const name = typeof record.name === 'string'
    ? record.name
    : typeof metadata?.name === 'string'
      ? metadata.name as string
      : fallbackName;

  return { name, id };
}

async function fetchAgents(): Promise<AgentSummary[]> {
  const endpoints = ['/api/agents', '/api/agent-definitions'];

  for (const endpoint of endpoints) {
    const res = await fetch(`${API_BASE}${endpoint}`);
    if (!res.ok) {
      continue;
    }

    const body = await parseJson(res);
    if (!Array.isArray(body)) {
      continue;
    }

    return body
      .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
      .map((item) => ({
        name: typeof item.name === 'string' ? item.name : '',
        id: typeof item.id === 'string' ? item.id : undefined,
      }))
      .filter((item) => item.name.startsWith('stress-'));
  }

  return [];
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
  const agents = await fetchAgents();
  if (agents.length === 0) {
    console.log('No stress agents found to delete.');
    return;
  }

  for (const agent of agents) {
    await deleteAgent(agent);
    console.log(`Deleted ${agent.name}`);
  }
}

async function registerTrigger(results: ImportResult[]): Promise<void> {
  const responder = results.find((r) => r.name === 'stress-chain-responder');
  if (!responder || !responder.ok) {
    console.log('  [SKIP] stress-chain-responder not imported — skipping trigger registration');
    return;
  }

  const agent = normalizeImportedAgent(responder.body, responder.name);
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

async function importAllManifests(): Promise<ImportResult[]> {
  const manifestPaths = await listManifestPaths();
  const results: ImportResult[] = [];

  for (const manifestPath of manifestPaths) {
    const manifestYaml = await readFile(manifestPath, 'utf8');
    const result = await importManifest(manifestPath.replace(/\/agent\.yaml$/, ''), manifestYaml);
    if (!result.ok) {
      throw new Error(`Import failed for ${manifestPath} (${result.status}): ${JSON.stringify(result.body)}`);
    }
    results.push(result);
  }

  return results;
}

function printSummary(results: ImportResult[]): void {
  console.log(`Imported ${results.length} stress agents:`);

  for (const result of results) {
    const agent = normalizeImportedAgent(result.body, result.name);
    const suffix = agent.id ? ` (${agent.id})` : '';
    console.log(`- ${agent.name}${suffix}`);
  }
}

async function main(): Promise<void> {
  if (process.argv.includes(CLEAN_FLAG)) {
    await cleanStressAgents();
    return;
  }

  const results = await importAllManifests();
  await registerTrigger(results);

  const manifestPaths = await listManifestPaths();
  const importedNames = await Promise.all(
    manifestPaths.map(async (manifestPath) => extractAgentName(await readFile(manifestPath, 'utf8'))),
  );

  printSummary(results);
  console.log(`Trigger registered: stress.tools.complete -> stress-chain-responder`);
  console.log(`Agents: ${importedNames.join(', ')}`);
}

await main();
