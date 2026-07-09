import type { DatabaseRepository } from '../database/repository.js';
import type { SpineConsumer, SpineRawEvent } from '../events/spine-consumer-runner.js';
import type { CallbackDispatcher } from './callback-dispatcher.js';
import { isValidWebhookEvent, type ValidWebhookEvent } from './webhook-events.js';

type EnqueueCallbackArgs = Parameters<CallbackDispatcher['enqueue']>[0];

interface WebhookRelayDeps {
  db: Pick<DatabaseRepository, 'listWebhooks'>;
  callbackDispatcher: Pick<CallbackDispatcher, 'enqueue'>;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function buildWebhookPayload(
  eventType: ValidWebhookEvent,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  switch (eventType) {
    case 'turn.completed':
      return {
        turnId: payload.turnId,
        sessionId: payload.sessionId,
        agentId: payload.agentId,
        conversationId: payload.conversationId,
        status: payload.status,
        error: payload.error,
        durationMs: payload.durationMs,
        timestamp: payload.timestamp,
      };
    case 'turn.started':
      return {
        turnId: payload.turnId,
        sessionId: payload.sessionId,
        agentId: payload.agentId,
        conversationId: payload.conversationId,
        mode: payload.mode,
        taskDescription: payload.taskDescription,
        timestamp: payload.timestamp,
      };
    case 'run.tool_started':
      return {
        turnId: payload.turnId,
        agentId: payload.agentId,
        conversationId: payload.conversationId,
        toolCallId: payload.toolCallId,
        toolName: payload.toolName,
        args: payload.args,
        requiresApproval: payload.requiresApproval,
        timestamp: payload.timestamp,
      };
    case 'run.interrupted':
      return {
        turnId: payload.turnId,
        agentId: payload.agentId,
        conversationId: payload.conversationId,
        toolCallId: payload.toolCallId,
        toolName: payload.toolName,
        args: payload.args,
        interruptId: payload.interruptId,
        timestamp: payload.timestamp,
      };
    case 'run.tool_result':
      return {
        turnId: payload.turnId,
        agentId: payload.agentId,
        conversationId: payload.conversationId,
        toolCallId: payload.toolCallId,
        toolName: payload.toolName,
        result: payload.result,
        durationMs: payload.durationMs,
        error: payload.error,
        timestamp: payload.timestamp,
      };
    case 'run.interrupt_resolved':
      return {
        turnId: payload.turnId,
        agentId: payload.agentId,
        conversationId: payload.conversationId,
        interruptId: payload.interruptId,
        action: payload.action,
        timestamp: payload.timestamp,
      };
    case 'message.committed':
      return {
        turnId: payload.turnId,
        agentId: payload.agentId,
        conversationId: payload.conversationId,
        messageId: payload.messageId,
        messageSeq: payload.messageSeq,
        role: payload.role,
        content: payload.content,
        parts: payload.parts,
        toolCalls: payload.toolCalls,
        toolCallId: payload.toolCallId,
        timestamp: payload.timestamp,
      };
    case 'feedback.received':
      return {
        feedbackId: payload.feedbackId,
        turnId: payload.turnId,
        agentId: payload.agentId,
        type: payload.type,
        messageId: payload.messageId,
        timestamp: payload.timestamp,
      };
  }
}

export class WebhookRelay {
  constructor(private readonly deps: WebhookRelayDeps) {}

  async handleRawEvent(event: SpineRawEvent): Promise<void> {
    if (!isValidWebhookEvent(event.sourceType)) {
      return;
    }

    const eventType = event.sourceType;
    const agentId = optionalString(event.payload.agentId) ?? event.agentId;
    if (!agentId) {
      return;
    }

    const webhookPayload = buildWebhookPayload(eventType, event.payload);
    const hooks = await this.deps.db.listWebhooks(agentId);
    const deliveries: EnqueueCallbackArgs[] = [];

    for (const hook of hooks) {
      if ((hook.events as string[]).includes(eventType)) {
        deliveries.push({
          agentId,
          sessionId: optionalString(event.payload.turnId),
          callbackUrl: hook.url,
          eventType,
          eventSeq: event.seq,
          payload: webhookPayload,
        });
      }
    }

    for (const delivery of deliveries) {
      await this.deps.callbackDispatcher.enqueue(delivery);
    }
  }
}

export function createWebhookRelaySpineConsumer(deps: WebhookRelayDeps): SpineConsumer {
  const relay = new WebhookRelay(deps);
  return {
    name: 'webhook-relay',
    wants: (sourceType) => isValidWebhookEvent(sourceType),
    handle: (event) => relay.handleRawEvent(event),
  };
}
