import { z } from 'zod';
import type { ToolDefinition } from '@stablehand/sandbox-daemon';

export const requestApprovalTool: ToolDefinition = {
  name: 'request-approval',
  description:
    'Request human approval before proceeding with an action. The run will pause until a human approves or rejects the request.',
  location: 'orchestrator',
  requiresApproval: true,
  input: z.object({
    reason: z.string().describe('Description of the action that needs approval'),
    details: z.record(z.string(), z.unknown()).optional().describe('Additional context for the approver'),
  }),
  handler: async (_rawInput: unknown) => {
    return 'Error: request-approval must be handled by the orchestrator via gRPC proxy';
  },
};
