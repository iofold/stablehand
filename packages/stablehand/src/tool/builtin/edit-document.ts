import { z } from 'zod';
import type { ToolDefinition } from '@stablehand/sandbox-daemon';

/**
 * `edit_document`: put a draft in front of a person, who can approve it as
 * is, edit the text and approve, or reject it with a note. The run waits on
 * a durable interrupt (the dashboard renders it as an editable document, on
 * a phone too). Opt-in: an agent lists it under `tools` to get it.
 *
 * Returns JSON: `{ approved, edited, content, note? }` on approve, or
 * `{ approved: false, note? }` on reject.
 */
export const EDIT_DOCUMENT_TOOL_NAME = 'edit_document';

export const editDocumentInputSchema = z.object({
  title: z.string().describe('Short title the reviewer sees, e.g. "LinkedIn post: pricing change"'),
  content: z.string().describe('The full draft text. The reviewer may edit it before approving.'),
  format: z.string().optional().describe('Format label shown to the reviewer, e.g. "linkedin", "x-thread", "markdown"'),
});

export const editDocumentTool: ToolDefinition = {
  name: EDIT_DOCUMENT_TOOL_NAME,
  description:
    'Show a draft to a person for review. They approve it, edit it and approve, or reject it with a note. '
    + 'The run pauses until they decide. Returns JSON {approved, edited, content, note}: when approved, use '
    + 'the returned content, which may include their edits.',
  location: 'orchestrator',
  requiresApproval: true,
  input: editDocumentInputSchema,
  handler: async () => 'Error: edit_document must be handled by the orchestrator via gRPC proxy',
};

/** The tool result for a resolved review. */
export function editDocumentResult(
  original: string,
  resolution: { action: string; data?: unknown },
): string {
  const data = typeof resolution.data === 'object' && resolution.data !== null && !Array.isArray(resolution.data)
    ? resolution.data as Record<string, unknown>
    : {};
  const note = typeof data.note === 'string' && data.note.trim() !== ''
    ? data.note.trim()
    : typeof resolution.data === 'string' && resolution.data.trim() !== ''
      ? resolution.data.trim()
      : undefined;
  if (resolution.action !== 'approve') {
    return JSON.stringify({ approved: false, ...(note ? { note } : {}) });
  }
  const content = typeof data.content === 'string' ? data.content : original;
  return JSON.stringify({
    approved: true,
    edited: content !== original,
    content,
    ...(note ? { note } : {}),
  });
}
