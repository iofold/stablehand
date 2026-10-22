import { defineTool } from 'stablehand';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const readFileInput = z.object({
  path: z.string().describe('Relative file path to read'),
});

export default defineTool({
  name: 'read-file',
  description: 'Read the contents of a file',
  input: readFileInput,
  async handler(input, ctx) {
    const { path: filePath } = readFileInput.parse(input);
    const basePath = resolve(ctx.workspaceDir);
    const resolved = resolve(basePath, filePath);
    if (resolved !== basePath && !resolved.startsWith(`${basePath}/`)) {
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
