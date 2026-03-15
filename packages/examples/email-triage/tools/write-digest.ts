import { defineTool } from 'ctxmill';
import { z } from 'zod';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

export default defineTool({
  name: 'write-digest',
  description: 'Write an email digest summary to the workspace. Requires user approval.',
  requiresApproval: true,
  input: z.object({
    date: z.string().describe('Digest date (e.g., "2026-03-12")'),
    content: z.string().describe('Formatted digest content in Markdown'),
    emailCount: z.number().describe('Total number of emails summarized'),
  }),
  handler: async (input, ctx) => {
    const digestsDir = resolve(ctx.workspaceDir, 'digests');
    await mkdir(digestsDir, { recursive: true });

    const filename = `digest-${input.date}.md`;
    const filePath = resolve(digestsDir, filename);
    await writeFile(filePath, input.content, 'utf-8');

    return JSON.stringify({
      digestId: 'DIG-' + Date.now(),
      filename,
      date: input.date,
      emailCount: input.emailCount,
      charCount: input.content.length,
      savedTo: `digests/${filename}`,
      createdAt: new Date().toISOString(),
      message: `Digest for ${input.date} saved to digests/${filename} (${input.emailCount} emails, ${input.content.length} chars)`,
    });
  },
});
