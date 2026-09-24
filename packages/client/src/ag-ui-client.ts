import {
  A2UiRenderEventSchema,
  AgUiContextEntrySchema,
  AgUiMessageSchema,
  AgUiToolSchema,
  CanonicalStreamEventSchema,
  InterruptRequestedEventSchema,
  InterruptResolveInputSchema,
  InterruptResolveResponseSchema,
  TurnCancelResponseSchema,
  type AgUiContextEntryInput,
  type AgUiMessageInput,
  type AgUiToolInput,
  type CanonicalStreamEvent,
} from '@stablehand/contracts';
import { z } from 'zod';

import { StablehandContractError } from './errors.js';
import { parseServerSentEvents } from './sse.js';
import {
  StablehandTransport,
  type StablehandClientOptions,
  type StablehandRequestOptions,
} from './transport.js';

export interface StablehandAgUiRunInput extends StablehandRequestOptions {
  agentId: string;
  threadId?: string;
  runId?: string;
  messages: AgUiMessageInput[];
  tools?: AgUiToolInput[];
  context?: AgUiContextEntryInput[];
  state?: unknown;
  forwardedProps?: unknown;
}

export interface StablehandInterruptRequest {
  interruptId: string;
  turnId: string;
  conversationId: string;
  agentId: string;
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
}

export interface StablehandA2UIBlock {
  id: string;
  component: string;
  props: Record<string, unknown>;
}

export interface ResolveInterruptInput extends StablehandRequestOptions {
  agentId: string;
  interruptId: string;
  // ctx-iqzy: 'submit' was removed server-side; approve/reject only.
  action: 'approve' | 'reject';
  data?: unknown;
}

const AgUiRunRequestSchema = z.strictObject({
  threadId: z.string().trim().min(1).optional(),
  runId: z.string().trim().min(1),
  messages: z.array(AgUiMessageSchema),
  tools: z.array(AgUiToolSchema).optional(),
  context: z.array(AgUiContextEntrySchema).optional(),
  state: z.unknown().optional(),
  forwardedProps: z.unknown().optional(),
});

function segment(value: string, name: string): string {
  const parsed = z.string().trim().min(1).safeParse(value);
  if (!parsed.success) {
    throw new StablehandContractError({
      direction: 'request',
      method: 'PARAM',
      path: name,
      issues: parsed.error.issues,
    });
  }
  return encodeURIComponent(parsed.data);
}

export function createStablehandId(prefix: string): string {
  const value = globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${value}`;
}

export function createUserMessage(content: string): AgUiMessageInput {
  return AgUiMessageSchema.parse({
    id: createStablehandId('message'),
    role: 'user',
    content,
  });
}

export function parseCanonicalStreamEvent(value: unknown): CanonicalStreamEvent {
  return CanonicalStreamEventSchema.parse(value);
}

export function getA2UIBlock(event: CanonicalStreamEvent): StablehandA2UIBlock | null {
  const parsed = A2UiRenderEventSchema.safeParse(event);
  return parsed.success ? parsed.data.block : null;
}

export function getInterruptRequest(
  event: CanonicalStreamEvent,
): StablehandInterruptRequest | null {
  const parsed = InterruptRequestedEventSchema.safeParse(event);
  if (!parsed.success) return null;
  const request = parsed.data;
  return {
    interruptId: request.interruptId,
    turnId: request.turnId,
    conversationId: request.conversationId,
    agentId: request.agentId,
    toolCallId: request.toolCallId,
    toolName: request.toolName,
    args: request.args,
  };
}

export class StablehandAgUiClient {
  private readonly transport: StablehandTransport;

  constructor(options: StablehandClientOptions = {}) {
    this.transport = new StablehandTransport({
      ...options,
      retry: { maxAttempts: 1 },
    });
  }

  async *streamAgentRun(
    input: StablehandAgUiRunInput,
  ): AsyncGenerator<CanonicalStreamEvent> {
    const runId = input.runId ?? createStablehandId('turn');
    const stream = await this.transport.openStream({
      method: 'POST',
      path: `/ag-ui/${segment(input.agentId, 'agentId')}/run`,
      requestSchema: AgUiRunRequestSchema,
      json: {
        ...(input.threadId ? { threadId: input.threadId } : {}),
        runId,
        messages: input.messages,
        ...(input.tools ? { tools: input.tools } : {}),
        ...(input.context ? { context: input.context } : {}),
        ...(input.state !== undefined ? { state: input.state } : {}),
        ...(input.forwardedProps !== undefined ? { forwardedProps: input.forwardedProps } : {}),
      },
      signal: input.signal,
      timeoutMs: input.timeoutMs,
    });

    try {
      for await (const frame of parseServerSentEvents(stream.body)) {
        if (frame.data === null) continue;
        let raw: unknown;
        try {
          raw = JSON.parse(frame.data) as unknown;
        } catch {
          throw new StablehandContractError({
            direction: 'stream',
            method: 'POST',
            path: `/ag-ui/${segment(input.agentId, 'agentId')}/run`,
            issues: [{
              code: 'custom',
              path: [],
              message: 'SSE data is not valid JSON',
              input: frame.data,
            }],
          });
        }
        const parsed = CanonicalStreamEventSchema.safeParse(raw);
        if (!parsed.success) {
          throw new StablehandContractError({
            direction: 'stream',
            method: 'POST',
            path: `/ag-ui/${segment(input.agentId, 'agentId')}/run`,
            issues: parsed.error.issues,
          });
        }
        yield parsed.data;
      }
    } finally {
      await stream.close();
    }
  }

  resolveInterrupt(input: ResolveInterruptInput) {
    const {
      agentId,
      signal,
      timeoutMs,
      idempotencyKey,
      ...body
    } = input;
    return this.transport.request({
      method: 'POST',
      path: `/agents/${segment(agentId, 'agentId')}/interrupt`,
      requestSchema: InterruptResolveInputSchema,
      responseSchema: InterruptResolveResponseSchema,
      json: body,
      signal,
      timeoutMs,
      idempotencyKey,
    });
  }

  cancelTurn(input: {
    agentId: string;
    turnId: string;
  } & StablehandRequestOptions) {
    const {
      agentId,
      turnId,
      ...requestOptions
    } = input;
    return this.transport.request({
      method: 'POST',
      path: `/agents/${segment(agentId, 'agentId')}/turns/${segment(turnId, 'turnId')}/cancel`,
      responseSchema: TurnCancelResponseSchema,
      ...requestOptions,
    });
  }
}

export function createStablehandAgUiClient(
  options?: StablehandClientOptions,
): StablehandAgUiClient {
  return new StablehandAgUiClient(options);
}
