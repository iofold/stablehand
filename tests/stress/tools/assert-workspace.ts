import { defineTool } from 'ctxmill';
import { z } from 'zod';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

export default defineTool({
  name: 'assert-workspace',
  description: 'Verify workspace state: check if files exist, read content, or list directory. For stress test validation.',
  input: z.object({
    action: z.enum(['exists', 'read', 'list']),
    path: z.string().describe('Relative path within workspace'),
  }),
  async handler({ action, path: relPath }, ctx) {
    const fullPath = resolve(ctx.workspaceDir, relPath);
    if (!fullPath.startsWith(ctx.workspaceDir)) {
      return 'ERROR: path traversal detected';
    }

    switch (action) {
      case 'exists':
        return existsSync(fullPath) ? `EXISTS: ${relPath}` : `MISSING: ${relPath}`;
      case 'read':
        if (!existsSync(fullPath)) return `MISSING: ${relPath}`;
        return readFileSync(fullPath, 'utf-8').slice(0, 4096);
      case 'list':
        if (!existsSync(fullPath)) return `MISSING: ${relPath}`;
        return readdirSync(fullPath).join('\n');
    }
  },
});
