import { defineTool } from 'stablehand';
import { z } from 'zod';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

export default defineTool({
  name: 'write-note',
  description: 'Save a note, memo, or analysis to a file in the notes/ directory. Requires user approval.',
  input: z.object({
    filename: z.string().describe('File name (e.g. "q4-analysis.md")'),
    content: z.string().describe('Content to write'),
  }),
  requiresApproval: true,
  // Note: When session isolation is active, notes are written to the session
  // overlay. They are only visible in this session until promoted to base.
  // This is intentional — session-scoped notes support exploratory workflows.
  async handler(rawInput, ctx) {
    const input = rawInput as {
      filename: string;
      content: string;
    };
    const { filename, content } = input;
    const basePath = ctx.workspaceDir;
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
