import { defineTool } from 'ctxmill';
import { z } from 'zod';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';

export default defineTool({
  name: 'write-note',
  description: 'Save a note, memo, or analysis to a file in the notes/ directory. Requires user approval.',
  input: z.object({
    filename: z.string().describe('File name (e.g. "q4-analysis.md")'),
    content: z.string().describe('Content to write'),
  }),
  requiresApproval: true,
  async handler({ filename, content }, ctx) {
    const basePath = process.cwd();
    const notesDir = resolve(basePath, 'notes');
    const filePath = resolve(notesDir, filename);
    if (!filePath.startsWith(notesDir)) {
      return 'Error: Can only write to notes/ directory';
    }
    await mkdir(notesDir, { recursive: true });
    await writeFile(filePath, content, 'utf-8');
    return `Saved to notes/${filename} (${content.length} chars)`;
  },
});
