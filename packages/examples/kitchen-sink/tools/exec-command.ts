import { z } from 'zod';
import { defineTool } from 'stablehand';
import { execSync, type ExecSyncOptionsWithStringEncoding } from 'node:child_process';

/*
 * exec-command runs an arbitrary shell command in the orchestrator process, not in the agent's
 * sandbox: project tools execute orchestrator-side. Where the orchestrator runs as root with the
 * Docker socket mounted (the stock compose stack), that is a root shell on the host. So the tool
 * is off unless the orchestrator's environment sets STABLEHAND_ENABLE_EXEC_COMMAND=1, and even
 * then each command runs as an unprivileged user without the orchestrator's environment.
 */

export const EXEC_COMMAND_ENABLE_ENV = 'STABLEHAND_ENABLE_EXEC_COMMAND';
export const EXEC_COMMAND_UID_ENV = 'STABLEHAND_EXEC_COMMAND_UID';
export const EXEC_COMMAND_GID_ENV = 'STABLEHAND_EXEC_COMMAND_GID';
/** `nobody` / `nogroup` on the Debian-based orchestrator image. */
export const EXEC_COMMAND_DEFAULT_ID = 65534;

const DEFAULT_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

export function isExecCommandEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[EXEC_COMMAND_ENABLE_ENV] === '1';
}

export interface ExecCommandSpawnInput {
  cwd: string;
  timeoutMs: number;
  /** Where the uid/gid overrides and PATH are read from. */
  env?: NodeJS.ProcessEnv;
  /** The orchestrator's own uid; undefined where the platform has no getuid. */
  processUid?: number;
}

function parseId(value: string | undefined, name: string): number {
  if (value === undefined || value === '') return EXEC_COMMAND_DEFAULT_ID;
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be a numeric id, got ${JSON.stringify(value)}`);
  }
  const id = Number(value);
  if (id === 0) {
    throw new Error(`${name}=0 would run exec-command as root; refusing`);
  }
  return id;
}

/**
 * Spawn options for one command: none of the orchestrator's environment (database URL, secret
 * master key, provider keys) and, when the orchestrator is root, an unprivileged uid and gid.
 */
export function execCommandSpawnOptions(input: ExecCommandSpawnInput): ExecSyncOptionsWithStringEncoding {
  const env = input.env ?? process.env;
  const options: ExecSyncOptionsWithStringEncoding = {
    cwd: input.cwd,
    timeout: input.timeoutMs,
    encoding: 'utf-8',
    maxBuffer: 1024 * 1024,
    env: { PATH: env.PATH || DEFAULT_PATH, HOME: input.cwd, LANG: 'C.UTF-8' },
  };
  if (input.processUid === 0) {
    options.uid = parseId(env[EXEC_COMMAND_UID_ENV], EXEC_COMMAND_UID_ENV);
    options.gid = parseId(env[EXEC_COMMAND_GID_ENV], EXEC_COMMAND_GID_ENV);
  }
  return options;
}

function result(exitCode: number, stdout: string, stderr: string): string {
  return JSON.stringify({ exitCode, stdout: stdout.slice(0, 10000), stderr: stderr.slice(0, 5000) });
}

export const execCommandTool = defineTool({
  name: 'exec-command',
  description:
    'Execute a shell command on the orchestrator host (not in the agent sandbox) as an unprivileged user. '
    + 'Returns stdout, stderr, and exit code. Example tool; disabled unless the operator enables it.',
  input: z.object({
    command: z.string().describe('Shell command to execute'),
    timeout_ms: z.number().optional().default(30000).describe('Timeout in milliseconds'),
  }),
  requiresApproval: true,
  handler: async (rawInput, ctx) => {
    if (!isExecCommandEnabled()) {
      return result(126, '', `exec-command is disabled; set ${EXEC_COMMAND_ENABLE_ENV}=1 on the orchestrator to enable it`);
    }
    const input = rawInput as {
      command: string;
      timeout_ms: number;
    };
    let options: ExecSyncOptionsWithStringEncoding;
    try {
      options = execCommandSpawnOptions({
        cwd: ctx.workspaceDir || process.cwd(),
        timeoutMs: input.timeout_ms,
        processUid: process.getuid?.(),
      });
    } catch (err: unknown) {
      return result(126, '', (err as Error).message);
    }
    try {
      return result(0, execSync(input.command, options), '');
    } catch (err: unknown) {
      const e = err as { status?: number; stdout?: string; stderr?: string; message?: string };
      return result(e.status ?? 1, e.stdout || '', e.stderr || e.message || '');
    }
  },
});

// Tool discovery registers a file's default export. Leaving it undefined keeps exec-command out of
// every deployment that has not opted in, including the orchestrator image, which ships this
// directory as its default project.
export default isExecCommandEnabled() ? execCommandTool : undefined;
