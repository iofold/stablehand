import { z } from 'zod';
import type { ToolDefinition } from '../types.js';

/**
 * Built-in tool that allows any agent to emit custom events to the event bus.
 * Other agents can be triggered by these events via EventTriggerManager.
 */
export const emitEventTool: ToolDefinition = {
  name: 'emit-event',
  description:
    'Emit a custom event to the event bus. Other agents can be triggered by these events via event triggers.',
  location: 'orchestrator',
  input: z.object({
    type: z.string().describe('Event type, e.g. "email.classified", "response.drafted"'),
    payload: z.record(z.string(), z.unknown()).describe('Event payload data'),
  }),
  handler: async (rawInput: unknown, ctx) => {
    const input = rawInput as { type: string; payload: Record<string, unknown> };
    const eventBus = ctx.eventBus;
    if (!eventBus) {
      return 'Error: Event bus is not available in the current context';
    }

    console.log(`[emit-event] Emitting custom event: type=${input.type} agent=${ctx.agentId} keys=${Object.keys(input.payload).join(',')}`);
    eventBus.emitCustom(input.type, ctx.agentId, input.payload);
    console.log(`[emit-event] Event "${input.type}" emitted successfully`);

    return `Event "${input.type}" emitted successfully with ${Object.keys(input.payload).length} payload field(s)`;
  },
};
