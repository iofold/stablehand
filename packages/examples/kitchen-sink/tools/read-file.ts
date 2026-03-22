import { defineTool } from 'ctxmill';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export default defineTool({
  name: 'read-file',
  description: 'Read the contents of a file. Use this to examine documents, configs, data files, etc.',
  input: z.object({
    path: z.string().describe('Relative file path to read'),
  }),
  async handler(rawInput, ctx) {
    const input = rawInput as {
      path: string;
    };
    const filePath = input.path;
    // Sandbox to workspace directory (session-scoped when isolation is active)
    const basePath = ctx.workspaceDir;
    const resolved = resolve(basePath, filePath);
    if (!resolved.startsWith(basePath)) {
      return 'Error: Cannot read files outside the project directory';
    }
    try {
      const content = await readFile(resolved, 'utf-8');
      return content.length > 10000
        ? content.slice(0, 10000) + '\n... (truncated)'
        : content;
    } catch (err) {
      return `Error reading file: ${(err as Error).message}`;
    }
  },
});
