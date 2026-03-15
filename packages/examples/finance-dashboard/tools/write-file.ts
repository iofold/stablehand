import { defineTool } from 'ctxmill';
import { z } from 'zod';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

/** Patterns that should never be written via this tool. */
const BLOCKED_PATTERNS = ['.env', '.git', 'credentials', '.pem', '.key', '.secret', '.token'];

export default defineTool({
  name: 'write-file',
  description: 'Write or update a file in the agent workspace. Requires user approval.',
  input: z.object({
    path: z.string().describe('Relative file path within the workspace (e.g. "data/report.json")'),
    content: z.string().describe('File content to write'),
  }),
  requiresApproval: true,
  async handler({ path, content }, ctx) {
    const basePath = ctx.workspaceDir;
    const filePath = resolve(basePath, path);

    // Path traversal check
    if (!filePath.startsWith(basePath)) {
      return 'Error: Path traversal detected — file must be within the workspace directory';
    }

    // Blocked pattern check
    const lower = filePath.toLowerCase();
    const blocked = BLOCKED_PATTERNS.find((pattern) => lower.includes(pattern));
    if (blocked) {
      return `Error: Writing to paths containing "${blocked}" is not allowed`;
    }

    // Ensure parent directories exist
    mkdirSync(dirname(filePath), { recursive: true });

    // Write the file
    writeFileSync(filePath, content, 'utf-8');

    return `Wrote ${content.length} chars to ${path}`;
  },
});
