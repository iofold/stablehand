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

const WEBHOOK_PAYLOAD_FIELDS = {
  'turn.completed': [
    'turnId',
    'sessionId',
    'agentId',
    'conversationId',
    'status',
    'error',
    'durationMs',
    'timestamp',
  ],
  'turn.started': [
    'turnId',
    'sessionId',
    'agentId',
    'conversationId',
    'mode',
    'taskDescription',
    'timestamp',
  ],
  'run.tool_started': [
    'turnId',
    'agentId',
    'conversationId',
    'toolCallId',
    'toolName',
    'args',
    'requiresApproval',
    'timestamp',
  ],
  'run.interrupted': [
    'turnId',
    'agentId',
    'conversationId',
    'toolCallId',
    'toolName',
    'args',
    'interruptId',
    'timestamp',
  ],
  'run.tool_result': [
    'turnId',
    'agentId',
    'conversationId',
    'toolCallId',
    'toolName',
    'result',
    'durationMs',
    'error',
    'timestamp',
  ],
  'run.interrupt_resolved': [
    'turnId',
    'agentId',
    'conversationId',
    'interruptId',
    'action',
    'timestamp',
  ],
  'message.committed': [
    'turnId',
    'agentId',
    'conversationId',
    'messageId',
    'messageSeq',
    'role',
    'content',
    'parts',
    'toolCalls',
    'toolCallId',
    'timestamp',
  ],
  'feedback.received': [
    'feedbackId',
    'turnId',
    'agentId',
    'type',
    'messageId',
    'timestamp',
  ],
} as const satisfies Record<ValidWebhookEvent, readonly string[]>;

export function buildWebhookPayload(
  eventType: ValidWebhookEvent,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const webhookPayload: Record<string, unknown> = {};
  for (const field of WEBHOOK_PAYLOAD_FIELDS[eventType]) {
    webhookPayload[field] = payload[field];
  }
  return webhookPayload;
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
