import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ToolDefinition } from '../../tool/types.js';
import { generatePtcScripts } from '../ptc-codegen.js';

const tempDirs: string[] = [];

function makeTool(name: string, programmatic: boolean): ToolDefinition {
  return {
    name,
    description: `${name} tool`,
    input: {},
    programmatic,
    handler: async () => JSON.stringify({ ok: true, tool: name }),
  };
}

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ptc-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('generatePtcScripts', () => {
  it('returns empty array when no programmatic tools', async () => {
    const scriptDir = await makeTempDir();

    const scripts = await generatePtcScripts({
      tools: [makeTool('search', false), makeTool('emit-event', false)],
      scriptDir,
      daemonPort: 8080,
      token: 'test-token',
    });

    expect(scripts).toEqual([]);
  });

  it('creates _runtime.ts with callTool function', async () => {
    const scriptDir = await makeTempDir();

    await generatePtcScripts({
      tools: [makeTool('search', true)],
      scriptDir,
      daemonPort: 4312,
      token: 'test-token',
    });

    const runtimeSource = await readFile(join(scriptDir, '_runtime.ts'), 'utf8');

    expect(runtimeSource).toContain('export async function callTool');
    expect(runtimeSource).toContain('fetch(');
    expect(runtimeSource).toContain('http://localhost:4312');
    expect(runtimeSource).toContain('const TOOL_API_TOKEN = "test-token";');
    expect(runtimeSource).toContain("'authorization': `Bearer ${TOOL_API_TOKEN}`");
  });

  it('creates per-tool wrapper scripts', async () => {
    const scriptDir = await makeTempDir();

    const scripts = await generatePtcScripts({
      tools: [makeTool('lookup-record', true)],
      scriptDir,
      daemonPort: 8080,
      token: 'test-token',
    });

    expect(scripts).toHaveLength(1);

    const wrapperSource = await readFile(join(scriptDir, 'lookup-record.ts'), 'utf8');

    expect(wrapperSource).toContain("import { callTool } from './_runtime.ts';");
    expect(wrapperSource).toContain('const TOOL_NAME = "lookup-record";');
  });

  it('handles multiple programmatic tools', async () => {
    const scriptDir = await makeTempDir();

    const scripts = await generatePtcScripts({
      tools: [
        makeTool('alpha', true),
        makeTool('beta', true),
        makeTool('gamma', false),
      ],
      scriptDir,
      daemonPort: 8080,
      token: 'test-token',
    });

    expect(scripts.map((script) => basename(script)).sort()).toEqual(['alpha.ts', 'beta.ts']);
  });

  it('generated scripts do not expose raw payloads on error', async () => {
    const scriptDir = await makeTempDir();

    await generatePtcScripts({
      tools: [makeTool('dangerous-tool', true)],
      scriptDir,
      daemonPort: 8080,
      token: 'test-token',
    });

    const runtimeSource = await readFile(join(scriptDir, '_runtime.ts'), 'utf8');

    expect(runtimeSource).toContain('console.error(`[');
    expect(runtimeSource).toContain('throw new Error(`Tool ${name} failed: ${message}`);');
    expect(runtimeSource).not.toContain('console.log(');
    expect(runtimeSource).not.toContain('JSON.stringify(payload)');
  });
});
