import { expect } from 'vitest';
import type { AgentEvent, HarnessExportedState, MessageCommittedAgentEvent } from '../../types.js';

export interface AgentEventContractTrace {
  events: AgentEvent[];
  turnId: string;
  exportedState?: HarnessExportedState;
  expectedStateVersion?: string;
  requireDoneUsage?: boolean;
}

function assertNoEventsAfterDone(events: AgentEvent[]): void {
  const doneIndex = events.findIndex((event) => event.type === 'done');
  if (doneIndex < 0) {
    return;
  }
  expect(events.slice(doneIndex + 1)).toEqual([]);
}

function assertToolCallsArePaired(events: AgentEvent[]): void {
  const starts = new Map<string, Extract<AgentEvent, { type: 'tool_call_start' }>>();
  const ends = new Map<string, Extract<AgentEvent, { type: 'tool_call_end' }>>();

  for (const event of events) {
    if (event.type === 'tool_call_start') {
      expect(starts.has(event.id)).toBe(false);
      starts.set(event.id, event);
    }
    if (event.type === 'tool_call_end') {
      expect(ends.has(event.id)).toBe(false);
      ends.set(event.id, event);
    }
  }

  for (const id of starts.keys()) {
    expect(ends.has(id)).toBe(true);
  }
  for (const id of ends.keys()) {
    expect(starts.has(id)).toBe(true);
  }
}

function messageEvents(events: AgentEvent[]): MessageCommittedAgentEvent[] {
  return events.filter((event): event is MessageCommittedAgentEvent => event.type === 'message_committed');
}

function toolStartEvents(events: AgentEvent[]): Array<Extract<AgentEvent, { type: 'tool_call_start' }>> {
  return events.filter((event): event is Extract<AgentEvent, { type: 'tool_call_start' }> =>
    event.type === 'tool_call_start',
  );
}

function toolEndEvents(events: AgentEvent[]): Array<Extract<AgentEvent, { type: 'tool_call_end' }>> {
  return events.filter((event): event is Extract<AgentEvent, { type: 'tool_call_end' }> =>
    event.type === 'tool_call_end',
  );
}

export function assertAgentEventContract({
  events,
  turnId,
  exportedState,
  expectedStateVersion = '2',
  requireDoneUsage = true,
}: AgentEventContractTrace): void {
  assertNoEventsAfterDone(events);
  assertToolCallsArePaired(events);

  for (const event of messageEvents(events)) {
    expect(event.turnId).toBe(turnId);
  }

  if (exportedState) {
    expect(exportedState.stateVersion).toBe(expectedStateVersion);
  }

  const done = events.find((event): event is Extract<AgentEvent, { type: 'done' }> => event.type === 'done');
  expect(done).toBeDefined();
  if (requireDoneUsage) {
    expect(done?.usage).toEqual(expect.objectContaining({
      inputTokens: expect.any(Number),
      outputTokens: expect.any(Number),
      totalTokens: expect.any(Number),
    }));
  }
}

export function assertPlainTextTurnContract(
  trace: AgentEventContractTrace & { expectedContent: string },
): void {
  assertAgentEventContract(trace);

  const committed = messageEvents(trace.events);
  expect(committed).toHaveLength(1);
  expect(committed[0]).toEqual(expect.objectContaining({
    role: 'assistant',
    content: trace.expectedContent,
  }));
  expect(committed[0]?.toolCalls ?? []).toEqual([]);
}

export function assertToolRoundTripContract(
  trace: AgentEventContractTrace & {
    expectedTool: {
      id: string;
      name: string;
      args: unknown;
      result: string;
    };
    expectedContent?: string;
  },
): void {
  assertAgentEventContract(trace);

  expect(toolStartEvents(trace.events)).toContainEqual(expect.objectContaining({
    id: trace.expectedTool.id,
    name: trace.expectedTool.name,
    args: trace.expectedTool.args,
  }));
  expect(toolEndEvents(trace.events)).toContainEqual(expect.objectContaining({
    id: trace.expectedTool.id,
    result: trace.expectedTool.result,
  }));

  const committed = messageEvents(trace.events);
  expect(committed).toHaveLength(1);
  expect(committed[0]).toEqual(expect.objectContaining({
    role: 'assistant',
    ...(trace.expectedContent !== undefined ? { content: trace.expectedContent } : {}),
  }));
  expect(committed[0]?.toolCalls).toContainEqual(expect.objectContaining({
    id: trace.expectedTool.id,
    name: trace.expectedTool.name,
    arguments: trace.expectedTool.args,
    status: 'complete',
  }));
}

export function assertToolErrorContract(
  trace: AgentEventContractTrace & {
    expectedTool: {
      id: string;
      name: string;
      args: unknown;
      error: string;
    };
  },
): void {
  assertAgentEventContract(trace);

  expect(toolStartEvents(trace.events)).toContainEqual(expect.objectContaining({
    id: trace.expectedTool.id,
    name: trace.expectedTool.name,
    args: trace.expectedTool.args,
  }));
  expect(toolEndEvents(trace.events)).toContainEqual(expect.objectContaining({
    id: trace.expectedTool.id,
    result: trace.expectedTool.error,
    error: trace.expectedTool.error,
  }));

  const committed = messageEvents(trace.events);
  expect(committed).toHaveLength(1);
  expect(committed[0]?.toolCalls).toContainEqual(expect.objectContaining({
    id: trace.expectedTool.id,
    name: trace.expectedTool.name,
    arguments: trace.expectedTool.args,
    status: 'error',
  }));
}

export function assertApprovalFlowContract(
  events: AgentEvent[],
  expected: {
    tool: string;
    action: 'approve' | 'reject';
    args: unknown;
  },
): void {
  const needed = events.find((event): event is Extract<AgentEvent, { type: 'approval_needed' }> =>
    event.type === 'approval_needed',
  );
  expect(needed).toEqual(expect.objectContaining({
    tool: expected.tool,
    args: expected.args,
  }));

  expect(events).toContainEqual(expect.objectContaining({
    type: 'approval_resolved',
    id: needed?.id,
    action: expected.action,
  }));
}

export function assertAbortContract(events: AgentEvent[]): void {
  expect(events.some((event) => event.type === 'done')).toBe(false);
  assertNoEventsAfterDone(events);
  assertToolCallsArePaired(events);
}

export function assertRestorePromptShape(actual: string[], expected: string[]): void {
  expect(actual).toEqual(expected);
}
