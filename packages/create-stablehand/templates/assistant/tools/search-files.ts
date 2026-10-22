import { defineTool } from 'stablehand';
import { z } from 'zod';
import { readdir, readFile } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';

const searchFilesInput = z.object({
  pattern: z.string().describe('Text or regex pattern to search for'),
  directory: z.string().default('.').describe('Directory to search in'),
  fileExtensions: z.array(z.string()).optional().describe('File extensions to include'),
});

export default defineTool({
  name: 'search-files',
  description: 'Search for text patterns across project files',
  input: searchFilesInput,
  async handler(input, ctx) {
    const { pattern, directory, fileExtensions } = searchFilesInput.parse(input);
    const basePath = resolve(ctx.workspaceDir);
    const searchDir = resolve(basePath, directory);
    if (searchDir !== basePath && !searchDir.startsWith(`${basePath}/`)) {
      return 'Error: Cannot search outside the project';
    }
    const regex = new RegExp(pattern, 'gi');
    const results: string[] = [];

    async function walk(dir: string, depth = 0): Promise<void> {
      if (depth > 5 || results.length > 50) return;
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full, depth + 1);
        } else {
          if (fileExtensions && !fileExtensions.some(ext => entry.name.endsWith(ext))) continue;
          try {
            const content = await readFile(full, 'utf-8');
            const lines = content.split('\n');
            for (let i = 0; i < lines.length; i++) {
              if (regex.test(lines[i])) {
                results.push(`${relative(basePath, full)}:${i + 1}: ${lines[i].trim()}`);
                if (results.length >= 50) return;
              }
              regex.lastIndex = 0;
            }
          } catch {
            // Binary or unreadable file: nothing to search.
            continue;
          }
        }
      }
    }

    await walk(searchDir);
    return results.length > 0
      ? `Found ${results.length} matches:\n${results.join('\n')}`
      : 'No matches found';
  },
});
