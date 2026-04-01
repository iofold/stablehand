import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ToolDefinition } from '../tool/types.js';

export interface PtcCodegenOptions {
  tools: ToolDefinition[];
  scriptDir: string;
  daemonPort: number;
}

export async function generatePtcScripts(opts: PtcCodegenOptions): Promise<string[]> {
  const tools = opts.tools.filter((tool) => tool.programmatic === true);
  if (tools.length === 0) {
    return [];
  }

  await mkdir(opts.scriptDir, { recursive: true });
  await writeFile(join(opts.scriptDir, '_runtime.ts'), buildRuntimeSource(opts.daemonPort), 'utf8');

  const scriptPaths: string[] = [];

  for (const tool of tools) {
    const scriptPath = join(opts.scriptDir, `${tool.name}.ts`);
    await writeFile(scriptPath, buildToolSource(tool.name), 'utf8');
    scriptPaths.push(scriptPath);
  }

  return scriptPaths;
}

function buildRuntimeSource(daemonPort: number): string {
  return `const TOOL_API_BASE_URL = ${JSON.stringify(`http://localhost:${daemonPort}`)};

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function callTool(name: string, args: unknown): Promise<unknown> {
  try {
    const response = await fetch(\`${'${TOOL_API_BASE_URL}'}/tools/${'${encodeURIComponent(name)}'}\`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(args ?? {}),
    });

    const payload = await response.json().catch(() => ({
      error: 'Tool API returned invalid JSON',
    }));

    if (!response.ok) {
      const message = typeof payload === 'object'
        && payload !== null
        && 'error' in payload
        && typeof payload.error === 'string'
        ? payload.error
        : \`Tool API returned HTTP ${'${response.status}'}\`;
      throw new Error(message);
    }

    return payload;
  } catch (error) {
    const message = getErrorMessage(error);
    console.error(\`[ptc-runtime] ${'${name}'} failed: ${'${message}'}\`);
    throw new Error(\`Tool ${'${name}'} failed: ${'${message}'}\`);
  }
}
`;
}

function buildToolSource(toolName: string): string {
  return `import { callTool } from './_runtime.ts';

const TOOL_NAME = ${JSON.stringify(toolName)};

function parseScalar(value: string): unknown {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  if (value === 'undefined') return undefined;

  const numericValue = Number(value);
  if (value.trim() !== '' && Number.isFinite(numericValue)) {
    return numericValue;
  }

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function parseCliArgs(argv: string[]): unknown {
  if (argv.length === 0) {
    return {};
  }

  const entries = argv.map((arg) => {
    const separatorIndex = arg.indexOf('=');
    if (separatorIndex <= 0) {
      return null;
    }

    return [arg.slice(0, separatorIndex), parseScalar(arg.slice(separatorIndex + 1))] as const;
  });

  if (entries.every((entry) => entry !== null)) {
    return Object.fromEntries(entries);
  }

  if (argv.length === 1) {
    return parseScalar(argv[0]);
  }

  return argv.map(parseScalar);
}

function summarizeResult(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) {
    return {
      kind: 'array',
      length: value.length,
      preview: value.slice(0, 3),
    };
  }

  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    const summary: Record<string, unknown> = {
      kind: 'object',
      keyCount: keys.length,
      keys: keys.slice(0, 20),
    };

    if (typeof record.error === 'string') {
      summary.error = record.error;
    }
    if (typeof record.success === 'boolean') {
      summary.success = record.success;
    }
    if (typeof record.status === 'string') {
      summary.status = record.status;
    }

    return summary;
  }

  if (typeof value === 'string') {
    return {
      kind: 'string',
      length: value.length,
      preview: value.slice(0, 200),
    };
  }

  return {
    kind: typeof value,
    value,
  };
}

async function main(): Promise<void> {
  const argv = typeof Bun !== 'undefined' ? Bun.argv.slice(2) : process.argv.slice(2);
  const args = parseCliArgs(argv);
  const result = await callTool(TOOL_NAME, args);

  console.log(JSON.stringify({
    tool: TOOL_NAME,
    summary: summarizeResult(result),
  }));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(\`[ptc] ${'${TOOL_NAME}'} failed: ${'${message}'}\`);
  process.exitCode = 1;
});
`;
}
