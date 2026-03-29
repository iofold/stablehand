import { expect, type APIRequestContext } from '@playwright/test';
import type { TestAgent } from '../support.js';

export const API_BASE =
  process.env.PLAYWRIGHT_API_BASE_URL ?? 'http://localhost:3002';

declare const process: {
  env: Record<string, string | undefined>;
  cwd(): string;
};

type FsModule = {
  readFileSync(path: string, encoding: string): string;
  mkdirSync(path: string, options: { recursive: boolean }): void;
  existsSync(path: string): boolean;
};

type PathModule = {
  join(...paths: string[]): string;
  dirname(path: string): string;
};

const loadFs = new Function('return import("node:fs")') as () => Promise<FsModule>;
const loadPath = new Function('return import("node:path")') as () => Promise<PathModule>;
const loadYaml = new Function('return import("yaml")') as () => Promise<{ parse(s: string): unknown }>;

/**
 * Import a VQA agent from its YAML manifest file.
 * Follows exact pattern from tests/e2e/support.ts importStressAgent().
 */
export async function importVQAAgent(
  request: APIRequestContext,
  agentDir: string,
): Promise<TestAgent> {
  const fs = await loadFs();
  const path = await loadPath();
  const yamlLib = await loadYaml();
  const manifestPath = path.join(
    process.cwd(), 'tests', 'e2e', 'visual-qa', 'agents', agentDir, 'agent.yaml',
  );
  const raw = yamlLib.parse(fs.readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>;
  const meta = (raw.metadata ?? {}) as Record<string, unknown>;
  const spec = (raw.spec ?? {}) as Record<string, unknown>;
  const tools = (spec.tools as Array<{ ref?: string }> | undefined) ?? [];

  const response = await request.post(`${API_BASE}/api/agents`, {
    data: {
      name: `${meta.name as string}-${Date.now()}`,
      harness: spec.harness as string,
      harnessConfig: (spec.harnessConfig ?? {}) as Record<string, unknown>,
      systemPrompt: (spec.instructions ?? '') as string,
      tools: tools.map((t) => t.ref).filter(Boolean),
      description: (meta.description ?? null) as string | null,
    },
  });
  expect(response.ok()).toBeTruthy();
  const result = (await response.json()) as { id: string; name: string };
  return { id: result.id, name: result.name };
}

/**
 * Create all 3 harness VQA agents. Returns map of harness name to agent.
 */
export async function seedVQAAgents(
  request: APIRequestContext,
): Promise<Record<string, TestAgent>> {
  const agents: Record<string, TestAgent> = {};
  for (const dir of ['vqa-langgraph', 'vqa-claude', 'vqa-pi']) {
    agents[dir] = await importVQAAgent(request, dir);
  }
  return agents;
}

/**
 * Ensure a directory exists for screenshot output.
 */
export async function ensureCaptureDir(subdir: string): Promise<string> {
  const fs = await loadFs();
  const path = await loadPath();
  const dir = path.join(process.cwd(), 'tests', 'e2e', 'visual-qa', 'captures', subdir);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Check if a specific harness API key is available.
 * Tests should skip when the required key is missing.
 */
export function hasHarnessKey(harness: 'langgraph' | 'claude-agents' | 'pi-agent'): boolean {
  if (harness === 'claude-agents') {
    return !!process.env.ANTHROPIC_API_KEY;
  }
  return !!process.env.OPENAI_API_KEY;
}

/**
 * Get harness config for inline agent creation (alternative to YAML import).
 */
export function getHarnessConfig(harness: string): Record<string, unknown> {
  switch (harness) {
    case 'langgraph':
      return { provider: 'openai', model: 'gpt-5-mini' };
    case 'claude-agents':
      return { provider: 'anthropic', model: 'claude-sonnet-4-6', temperature: 0.3 };
    case 'pi-agent':
      return { provider: 'openai', model: 'gpt-5-mini' };
    default:
      throw new Error(`Unknown harness: ${harness}`);
  }
}

/**
 * Get the standard VQA prompt for a harness.
 */
export function getVQAPrompt(harness: string): string {
  const base = 'You are a visual QA test agent. When asked to "run the visual QA sequence", follow this exact sequence:\n\n';

  switch (harness) {
    case 'langgraph':
      return base + `1. Respond with 3+ paragraphs using **bold**, *italic*, and a bullet list.\n2. Use calculator to compute 42 * 17 + 3.\n3. Use weather to get weather for "San Francisco".\n4. Write a summary referencing both results.\n5. Use emit-event to emit type "vqa.langgraph.complete" with payload {"status":"complete"}.`;
    case 'claude-agents':
      return base + `1. Respond with 3+ paragraphs using **bold**, *italic*, and a code block.\n2. Use Bash to run: echo "Hello from Claude VQA"\n3. Use Read to read /etc/hostname.\n4. Write a summary referencing both results.\n5. Use emit-event to emit type "vqa.claude.complete" with payload {"status":"complete"}.`;
    case 'pi-agent':
      return base + `1. Respond with 3+ paragraphs using **bold**, *italic*, and a numbered list.\n2. Use bash to run: echo "Hello from PI VQA"\n3. Use read to read /etc/hostname.\n4. Write a summary referencing both results.\n5. Use emit-event to emit type "vqa.pi.complete" with payload {"status":"complete"}.`;
    default:
      throw new Error(`Unknown harness: ${harness}`);
  }
}

/**
 * Get tools list for a harness.
 */
export function getToolsForHarness(harness: string): string[] {
  switch (harness) {
    case 'langgraph':
      return ['calculator', 'weather', 'emit-event'];
    case 'claude-agents':
      return ['emit-event'];
    case 'pi-agent':
      return ['emit-event'];
    default:
      return [];
  }
}
