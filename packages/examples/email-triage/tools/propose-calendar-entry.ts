import { defineTool } from 'ctxmill';
import { z } from 'zod';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

export default defineTool({
  name: 'propose-calendar-entry',
  description: 'Create a calendar entry proposal from extracted meeting details. Requires user approval before adding to calendar.',
  requiresApproval: true,
  input: z.object({
    title: z.string().describe('Meeting title'),
    participants: z.array(z.string()).describe('List of attendee names or emails'),
    proposedTime: z.string().describe('Proposed meeting time (ISO 8601 or human-readable)'),
    duration: z.number().default(30).describe('Meeting duration in minutes'),
    location: z.string().optional().describe('Meeting location or video link'),
    agenda: z.string().optional().describe('Meeting agenda or topic'),
    notes: z.string().optional().describe('Additional notes or context from the email'),
  }),
  handler: async (input, ctx) => {
    const entry = {
      entryId: 'CAL-' + Date.now(),
      title: input.title,
      participants: input.participants,
      proposedTime: input.proposedTime,
      duration: input.duration,
      location: input.location ?? 'TBD',
      agenda: input.agenda ?? 'No agenda provided',
      notes: input.notes,
      status: 'proposed',
      createdAt: new Date().toISOString(),
    };

    // Save proposal to workspace
    const calendarDir = resolve(ctx.workspaceDir, 'calendar');
    await mkdir(calendarDir, { recursive: true });
    const entryPath = resolve(calendarDir, `${entry.entryId}.json`);
    await writeFile(entryPath, JSON.stringify(entry, null, 2), 'utf-8');

    return JSON.stringify({
      ...entry,
      message: `Calendar entry proposed: "${input.title}" with ${input.participants.length} participants — saved to calendar/${entry.entryId}.json`,
    });
  },
});
