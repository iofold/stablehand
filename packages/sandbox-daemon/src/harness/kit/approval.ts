import type { AgentEvent, ApprovalCallback } from '../types.js';

export const TOOL_REJECTION_MESSAGE = 'Tool call was rejected by the user.';

export type NormalizedApprovalResult =
  | { approved: true }
  | { approved: false; rejectionMessage: string };

export async function requestToolApproval(options: {
  id: string;
  turnId: string;
  toolName: string;
  args: Record<string, unknown>;
  onApprovalNeeded: ApprovalCallback;
  emit: (event: AgentEvent) => void;
}): Promise<NormalizedApprovalResult> {
  options.emit({
    type: 'approval_needed',
    id: options.id,
    tool: options.toolName,
    args: options.args,
  });

  const response = await options.onApprovalNeeded({
    id: options.id,
    turnId: options.turnId,
    toolName: options.toolName,
    args: options.args,
  });

  options.emit({
    type: 'approval_resolved',
    id: options.id,
    action: response.action,
  });

  if (response.action !== 'approve') {
    return { approved: false, rejectionMessage: TOOL_REJECTION_MESSAGE };
  }

  return { approved: true };
}
