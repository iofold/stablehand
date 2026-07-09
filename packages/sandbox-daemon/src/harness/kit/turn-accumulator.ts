import type { Message } from '../../types.js';
import type { AgentEvent, MessageCommittedAgentEvent } from '../types.js';

type DoneEvent = Extract<AgentEvent, { type: 'done' }>;

type AccumulatedToolCall = NonNullable<Message['toolCalls']>[number] & {
  args: string;
  status: 'complete' | 'error';
};

export class TurnAccumulator {
  private readonly turnId: string;
  private assistantText = '';
  private readonly toolCalls: AccumulatedToolCall[] = [];
  private done: DoneEvent | undefined;

  constructor(options: { turnId: string }) {
    this.turnId = options.turnId;
  }

  appendText(content: string): Extract<AgentEvent, { type: 'text_delta' }> {
    this.recordAssistantText(content);
    return { type: 'text_delta', content };
  }

  recordAssistantText(content: string): void {
    this.assistantText += content;
  }

  hasCommitContent(): boolean {
    return this.assistantText.length > 0 || this.toolCalls.length > 0;
  }

  recordToolStart(tool: { id: string; name: string; args: unknown }): void {
    this.toolCalls.push({
      id: tool.id,
      name: tool.name,
      arguments: this.toToolArguments(tool.args),
      args: this.stringifyArgs(tool.args),
      status: 'complete',
    });
  }

  recordToolEnd(tool: { id: string; result: string; error?: string }): void {
    if (!tool.error) {
      return;
    }

    const existing = this.toolCalls.find((call) => call.id === tool.id);
    if (existing) {
      existing.status = 'error';
    }
  }

  recordDone(event: DoneEvent): void {
    this.done = event;
  }

  createMessageCommitted(messageSeq: number): MessageCommittedAgentEvent | undefined {
    if (this.assistantText.length === 0 && this.toolCalls.length === 0) {
      return undefined;
    }

    return {
      type: 'message_committed',
      role: 'assistant',
      content: this.assistantText,
      ...(this.toolCalls.length > 0 ? { toolCalls: [...this.toolCalls] } : {}),
      turnId: this.turnId,
      messageSeq,
    };
  }

  doneEvent(): DoneEvent | undefined {
    return this.done;
  }

  private toToolArguments(args: unknown): Record<string, unknown> {
    if (typeof args === 'object' && args !== null && !Array.isArray(args)) {
      return Object.fromEntries(Object.entries(args));
    }
    return {};
  }

  private stringifyArgs(args: unknown): string {
    if (typeof args === 'string') {
      return args;
    }
    return JSON.stringify(args ?? {});
  }
}
