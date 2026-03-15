import { defineTool } from 'ctxmill';
import { z } from 'zod';

export default defineTool({
  name: 'extract-meeting-details',
  description: 'Parse meeting-related information from an email body and return structured scheduling details',
  input: z.object({
    from: z.string().describe('Email sender'),
    subject: z.string().describe('Email subject'),
    body: z.string().describe('Email body to extract meeting details from'),
  }),
  handler: async (input, _ctx) => {
    // Return structured extraction for the agent to refine
    // In production, this would use NLP or a specialized parser
    const extraction = {
      extractionId: 'MTG-' + Date.now(),
      source: {
        from: input.from,
        subject: input.subject,
      },
      rawText: input.body,
      hints: {
        hasTimeReference: /\d{1,2}(:\d{2})?\s*(am|pm|AM|PM)|morning|afternoon|evening|noon/i.test(input.body),
        hasDateReference: /monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|next week|\d{1,2}\/\d{1,2}/i.test(input.body),
        hasLocationReference: /zoom|teams|meet|room|office|conference|building/i.test(input.body),
        participantCount: (input.body.match(/@[\w.]+/g) ?? []).length + 1,
      },
      extractedAt: new Date().toISOString(),
    };

    return JSON.stringify({
      ...extraction,
      message: 'Meeting details extracted — use propose-calendar-entry to create a calendar proposal',
    });
  },
});
