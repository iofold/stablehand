import { defineTool } from 'ctxmill';
import { z } from 'zod';
import { readdir, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';

export default defineTool({
  name: 'list-directory',
  description: 'List files and directories in a path. Use this to explore project structure.',
  input: z.object({
    path: z.string().default('.').describe('Directory path relative to project root'),
  }),
  async handler({ path: dirPath }, ctx) {
    const basePath = ctx.workspaceDir;
    const resolved = resolve(basePath, dirPath);
    if (!resolved.startsWith(basePath)) {
      return 'Error: Cannot access directories outside the project';
    }
    try {
      const entries = await readdir(resolved, { withFileTypes: true });
      const lines = await Promise.all(
        entries
          .filter(e => !e.name.startsWith('.') && e.name !== 'node_modules')
          .slice(0, 100)
          .map(async (e) => {
            const fullPath = join(resolved, e.name);
            const s = await stat(fullPath).catch(() => null);
            const size = s ? (s.isDirectory() ? 'dir' : `${s.size}b`) : '?';
            return `${e.isDirectory() ? '📁' : '📄'} ${e.name} (${size})`;
          })
      );
      return lines.join('\n') || '(empty directory)';
    } catch (err) {
      return `Error: ${(err as Error).message}`;
    }
  },
});
