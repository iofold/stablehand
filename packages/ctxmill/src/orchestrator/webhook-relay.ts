import type { DatabaseRepository } from '../database/repository.js';
import type { SpineConsumer, SpineRawEvent } from '../events/spine-consumer-runner.js';
import type { CallbackDispatcher } from './callback-dispatcher.js';
import { materializeTurnUsage } from './usage.js';
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
    'sandboxSessionId',
    'agentId',
    'conversationId',
    'status',
    'error',
    'durationMs',
    'usage',
    'timestamp',
  ],
  'turn.started': [
    'turnId',
    'sandboxSessionId',
    'agentId',
    'conversationId',
    'mode',
    'taskDescription',
    'timestamp',
  ],
  'budget.threshold': [
    'policyId',
    'policyName',
    'bucket',
    'action',
    'threshold',
    'metric',
    'spent',
    'limit',
    'agentId',
    'timestamp',
  ],
  'tool_call.started': [
    'turnId',
    'agentId',
    'conversationId',
    'toolCallId',
    'toolCallName',
    'args',
    'requiresApproval',
    'timestamp',
  ],
  'interrupt.requested': [
    'turnId',
    'sandboxSessionId',
    'agentId',
    'conversationId',
    'toolCallId',
    'toolCallName',
    'args',
    'interruptId',
    'timestamp',
  ],
  'tool_call.completed': [
    'turnId',
    'agentId',
    'conversationId',
    'toolCallId',
    'toolCallName',
    'result',
    'durationMs',
    'error',
    'timestamp',
  ],
  'interrupt.resolved': [
    'turnId',
    'sandboxSessionId',
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
  'message.updated': [
    'turnId',
    'agentId',
    'conversationId',
    'messageId',
    'messageSeq',
    'messageRevision',
    'role',
    'content',
    'parts',
    'toolCalls',
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
    webhookPayload[field] = eventType === 'turn.completed' && field === 'usage'
      ? materializeTurnUsage(
        payload.usage && typeof payload.usage === 'object'
          ? payload.usage as Record<string, unknown>
          : null,
      )
      : payload[field];
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
          turnId: optionalString(event.payload.turnId),
          webhookId: hook.id,
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
