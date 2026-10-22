import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ToolContext } from '@stablehand/sandbox-daemon';

import { discoverTools } from '../../packages/stablehand/src/agent/discovery.js';
import {
  EXEC_COMMAND_DEFAULT_ID,
  EXEC_COMMAND_ENABLE_ENV,
  execCommandSpawnOptions,
  execCommandTool,
} from '../../packages/examples/kitchen-sink/tools/exec-command.js';

// The orchestrator image copies this directory to /app/project/tools, and `stablehand dev`
// registers exactly what discoverTools() returns for it.
const KITCHEN_SINK_TOOLS = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../packages/examples/kitchen-sink/tools',
);
const SCRUBBED = ['DATABASE_URL', 'SECRET_MASTER_KEY', EXEC_COMMAND_ENABLE_ENV] as const;

async function discoveredToolNames(): Promise<string[]> {
  // Tool modules decide at import time, so re-import them under the current environment.
  vi.resetModules();
  const tools = await discoverTools(KITCHEN_SINK_TOOLS);
  return tools.map((tool) => tool.name);
}

describe('kitchen-sink exec-command is opt-in', () => {
  const saved = new Map<string, string | undefined>();
  let workspaceDir: string;
  let ctx: ToolContext;

  beforeEach(() => {
    for (const name of SCRUBBED) {
      saved.set(name, process.env[name]);
      delete process.env[name];
    }
    workspaceDir = mkdtempSync(join(tmpdir(), 'exec-command-test-'));
    // Readable by the unprivileged user the tool drops to when the suite runs as root.
    chmodSync(workspaceDir, 0o777);
    ctx = { agentId: 'agent', conversationId: 'conversation', workspaceDir };
  });

  afterEach(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it('is not registered by default', async () => {
    const names = await discoveredToolNames();
    expect(names).not.toContain('exec-command');
    // The rest of the example project still loads.
    expect(names).toEqual(expect.arrayContaining(['calculator', 'weather', 'read-file', 'execute-trade']));
  });

  it('stays off for anything other than an explicit "1"', async () => {
    for (const value of ['', '0', 'true', 'yes', 'on']) {
      process.env[EXEC_COMMAND_ENABLE_ENV] = value;
      expect(await discoveredToolNames(), value).not.toContain('exec-command');
    }
  });

  it('is registered when the operator sets STABLEHAND_ENABLE_EXEC_COMMAND=1', async () => {
    process.env[EXEC_COMMAND_ENABLE_ENV] = '1';
    expect(await discoveredToolNames()).toContain('exec-command');
  });

  it('refuses to run when disabled, even if called directly', async () => {
    const marker = join(workspaceDir, 'ran');
    const output = JSON.parse(await execCommandTool.handler({ command: `touch ${marker}`, timeout_ms: 5000 }, ctx));
    expect(output.exitCode).toBe(126);
    expect(output.stderr).toContain(EXEC_COMMAND_ENABLE_ENV);
    expect(existsSync(marker)).toBe(false);
  });

  it('runs without the orchestrator environment and never as root', async () => {
    process.env[EXEC_COMMAND_ENABLE_ENV] = '1';
    process.env.DATABASE_URL = 'postgres://user:secret@postgres/stablehand';
    process.env.SECRET_MASTER_KEY = 'super-secret';
    const output = JSON.parse(await execCommandTool.handler({
      command: 'echo "db=${DATABASE_URL:-unset} key=${SECRET_MASTER_KEY:-unset}"; id -u; pwd',
      timeout_ms: 5000,
    }, ctx));
    expect(output.exitCode).toBe(0);
    const [secrets, uid, cwd] = output.stdout.trim().split('\n');
    expect(secrets).toBe('db=unset key=unset');
    expect(uid).not.toBe('0');
    expect(cwd).toBe(workspaceDir);
  });

  it('drops to an unprivileged user when the orchestrator runs as root', () => {
    const asRoot = execCommandSpawnOptions({ cwd: '/srv', timeoutMs: 1000, env: { PATH: '/bin' }, processUid: 0 });
    expect([asRoot.uid, asRoot.gid]).toEqual([EXEC_COMMAND_DEFAULT_ID, EXEC_COMMAND_DEFAULT_ID]);
    expect(asRoot.env).toEqual({ PATH: '/bin', HOME: '/srv', LANG: 'C.UTF-8' });

    const configured = execCommandSpawnOptions({
      cwd: '/srv',
      timeoutMs: 1000,
      env: { STABLEHAND_EXEC_COMMAND_UID: '1234', STABLEHAND_EXEC_COMMAND_GID: '2345' },
      processUid: 0,
    });
    expect([configured.uid, configured.gid]).toEqual([1234, 2345]);

    expect(() => execCommandSpawnOptions({
      cwd: '/srv', timeoutMs: 1000, env: { STABLEHAND_EXEC_COMMAND_UID: '0' }, processUid: 0,
    })).toThrow(/root/);

    const unprivileged = execCommandSpawnOptions({ cwd: '/srv', timeoutMs: 1000, env: {}, processUid: 1000 });
    expect(unprivileged.uid).toBeUndefined();
  });
});
