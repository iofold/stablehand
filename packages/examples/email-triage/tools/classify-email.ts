import { defineTool } from 'ctxmill';
import { z } from 'zod';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

export default defineTool({
  name: 'classify-email',
  description: 'Classify an email by priority and category, and store the classification for digest generation',
  input: z.object({
    from: z.string().describe('Sender email address or name'),
    subject: z.string().describe('Email subject line'),
    body: z.string().describe('Email body text'),
    priority: z.enum(['urgent', 'normal', 'low']).describe('Classified priority level'),
    category: z.enum(['meeting_request', 'action_required', 'info', 'spam']).describe('Classified category'),
    rationale: z.string().describe('Brief explanation for the classification decision'),
  }),
  handler: async (input, ctx) => {
    const classification = {
      id: 'CLS-' + Date.now(),
      from: input.from,
      subject: input.subject,
      bodyPreview: input.body.substring(0, 200),
      priority: input.priority,
      category: input.category,
      rationale: input.rationale,
      classifiedAt: new Date().toISOString(),
    };

    // Persist classification to local store for digest-writer
    const dataDir = resolve(ctx.workspaceDir, '.data');
    const storePath = resolve(dataDir, 'classifications.json');

    await mkdir(dataDir, { recursive: true });

    let classifications: unknown[] = [];
    try {
      const existing = await readFile(storePath, 'utf-8');
      classifications = JSON.parse(existing);
    } catch {
      // File doesn't exist yet — start fresh
    }

    classifications.push(classification);
    await writeFile(storePath, JSON.stringify(classifications, null, 2), 'utf-8');

    // Determine routing
    let routeTo = 'digest-writer';
    if (input.priority === 'urgent' && input.category === 'action_required') {
      routeTo = 'urgent-responder';
    } else if (input.category === 'meeting_request') {
      routeTo = 'meeting-scheduler';
    }

    // Auto-emit the email.classified event so downstream agents are triggered
    const eventBus = ctx.eventBus;
    if (eventBus) {
      console.log(`[classify-email] Auto-emitting email.classified event for ${input.from} / ${input.subject}`);
      eventBus.emitCustom('email.classified', ctx.agentId, {
        from: input.from,
        subject: input.subject,
        body: input.body,
        priority: input.priority,
        category: input.category,
        classifiedAt: classification.classifiedAt,
        routeTo,
      });
      console.log(`[classify-email] Event emitted successfully`);
    } else {
      console.warn(`[classify-email] No event bus available — email.classified event NOT emitted`);
    }

    return JSON.stringify({
      ...classification,
      routeTo,
      message: `Email classified as ${input.priority}/${input.category} → routed to ${routeTo}. Event "email.classified" emitted to trigger downstream agents.`,
    });
  },
});
