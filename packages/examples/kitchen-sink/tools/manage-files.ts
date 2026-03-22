import { z } from 'zod';
import { defineTool } from 'ctxmill';
import fs from 'fs';
import path from 'path';

export default defineTool({
  name: 'manage-files',
  description: 'Advanced filesystem operations: copy, move, get permissions, create symlinks. Operates within workspace sandbox.',
  input: z.object({
    operation: z.enum(['copy', 'move', 'symlink', 'stat', 'chmod']).describe('Operation to perform'),
    source: z.string().describe('Source file path (relative to workspace)'),
    destination: z.string().optional().describe('Destination path (for copy/move/symlink)'),
    mode: z.string().optional().describe('File mode for chmod (e.g., "755")'),
  }),
  requiresApproval: true,
  handler: async (rawInput, ctx) => {
    const input = rawInput as {
      operation: 'copy' | 'move' | 'symlink' | 'stat' | 'chmod';
      source: string;
      destination?: string;
      mode?: string;
    };
    const cwd = ctx.workspaceDir || process.cwd();
    const src = path.resolve(cwd, input.source);
    if (!src.startsWith(cwd)) {
      return JSON.stringify({ error: 'Path traversal blocked' });
    }

    switch (input.operation) {
      case 'stat': {
        if (!fs.existsSync(src)) return JSON.stringify({ error: 'File not found' });
        const stat = fs.statSync(src);
        return JSON.stringify({
          size: stat.size,
          isDirectory: stat.isDirectory(),
          isSymlink: stat.isSymbolicLink(),
          permissions: stat.mode.toString(8),
          modified: stat.mtime.toISOString(),
          created: stat.birthtime.toISOString(),
        });
      }
      case 'copy': {
        if (!input.destination) return JSON.stringify({ error: 'Destination required for copy' });
        const dst = path.resolve(cwd, input.destination);
        if (!dst.startsWith(cwd)) return JSON.stringify({ error: 'Path traversal blocked' });
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(src, dst);
        return JSON.stringify({ success: true, operation: 'copy', from: input.source, to: input.destination });
      }
      case 'move': {
        if (!input.destination) return JSON.stringify({ error: 'Destination required for move' });
        const dst = path.resolve(cwd, input.destination);
        if (!dst.startsWith(cwd)) return JSON.stringify({ error: 'Path traversal blocked' });
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.renameSync(src, dst);
        return JSON.stringify({ success: true, operation: 'move', from: input.source, to: input.destination });
      }
      case 'symlink': {
        if (!input.destination) return JSON.stringify({ error: 'Destination required for symlink' });
        const dst = path.resolve(cwd, input.destination);
        if (!dst.startsWith(cwd)) return JSON.stringify({ error: 'Path traversal blocked' });
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.symlinkSync(src, dst);
        return JSON.stringify({ success: true, operation: 'symlink', target: input.source, link: input.destination });
      }
      case 'chmod': {
        if (!input.mode) return JSON.stringify({ error: 'Mode required for chmod' });
        fs.chmodSync(src, parseInt(input.mode, 8));
        return JSON.stringify({ success: true, operation: 'chmod', path: input.source, mode: input.mode });
      }
      default:
        return JSON.stringify({ error: `Unknown operation: ${input.operation}` });
    }
  },
});
