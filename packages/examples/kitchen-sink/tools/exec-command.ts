import { z } from 'zod';
import { defineTool } from 'ctxmill';
import { execSync } from 'child_process';

export default defineTool({
  name: 'exec-command',
  description: 'Execute a shell command in the agent workspace. Returns stdout, stderr, and exit code. Commands run in a sandboxed workspace directory.',
  input: z.object({
    command: z.string().describe('Shell command to execute'),
    timeout_ms: z.number().optional().default(30000).describe('Timeout in milliseconds'),
  }),
  requiresApproval: true,
  handler: async (rawInput, ctx) => {
    const input = rawInput as {
      command: string;
      timeout_ms: number;
    };
    const cwd = ctx.workspaceDir || process.cwd();
    try {
      const stdout = execSync(input.command, {
        cwd,
        timeout: input.timeout_ms,
        encoding: 'utf-8',
        maxBuffer: 1024 * 1024,
      });
      return JSON.stringify({ exitCode: 0, stdout: stdout.slice(0, 10000), stderr: '' });
    } catch (err: unknown) {
      const e = err as { status?: number; stdout?: string; stderr?: string; message?: string };
      return JSON.stringify({
        exitCode: e.status ?? 1,
        stdout: (e.stdout || '').slice(0, 10000),
        stderr: (e.stderr || e.message || '').slice(0, 5000),
      });
    }
  },
});
