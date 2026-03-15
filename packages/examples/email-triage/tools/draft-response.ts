import { defineTool } from 'ctxmill';
import { z } from 'zod';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

export default defineTool({
  name: 'draft-response',
  description: 'Draft an email response to an urgent message. Saves the draft for review before sending.',
  requiresApproval: true,
  input: z.object({
    originalFrom: z.string().describe('Original sender to reply to'),
    originalSubject: z.string().describe('Original email subject'),
    responseBody: z.string().describe('Drafted response text'),
    priority: z.enum(['urgent', 'normal']).default('urgent').describe('Response priority'),
  }),
  handler: async (input, ctx) => {
    const draft = {
      draftId: 'DRF-' + Date.now(),
      to: input.originalFrom,
      subject: `Re: ${input.originalSubject}`,
      body: input.responseBody,
      priority: input.priority,
      status: 'draft',
      createdAt: new Date().toISOString(),
    };

    // Save draft to workspace
    const draftsDir = resolve(ctx.workspaceDir, 'drafts');
    await mkdir(draftsDir, { recursive: true });
    const draftPath = resolve(draftsDir, `${draft.draftId}.json`);
    await writeFile(draftPath, JSON.stringify(draft, null, 2), 'utf-8');

    return JSON.stringify({
      ...draft,
      message: `Draft saved to drafts/${draft.draftId}.json — awaiting user review before sending`,
    });
  },
});
