import type { DatabaseRepository } from '../database/repository.js';
import type { SpineConsumer, SpineRawEvent } from '../events/spine-consumer-runner.js';
import type { CallbackDispatcher } from './callback-dispatcher.js';
import {
  CustomWebhookPayloadSchema,
  type BuiltinWebhookEventName,
} from '@ctxmill/contracts';
import { materializeTurnUsage } from './usage.js';
import {
  isBuiltinWebhookEvent,
  isValidWebhookEvent,
} from './webhook-events.js';

type EnqueueCallbackArgs = Parameters<CallbackDispatcher['enqueue']>[0];

interface WebhookRelayDeps {
  db: Pick<DatabaseRepository, 'listWebhooks'>;
  callbackDispatcher: Pick<CallbackDispatcher, 'enqueue'>;
  logger?: Pick<Console, 'warn'>;
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
    'comment',
    'timestamp',
  ],
  'artifact.created': [
    'artifactId',
    'agentId',
    'turnId',
    'name',
    'mimeType',
    'sizeBytes',
    'kind',
    'sha256',
    'timestamp',
  ],
} as const satisfies Record<BuiltinWebhookEventName, readonly string[]>;

export function buildWebhookPayload(
  eventType: BuiltinWebhookEventName,
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

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function buildCustomWebhookPayload(
  event: SpineRawEvent,
  agentId: string,
): Record<string, unknown> {
  if (
    event.payload.type === event.sourceType
    && event.payload.agentId === agentId
    && isJsonObject(event.payload.payload)
  ) {
    return event.payload;
  }

  return {
    type: event.sourceType,
    agentId,
    ...(event.turnId ? { turnId: event.turnId } : {}),
    ...(event.conversationId ? { conversationId: event.conversationId } : {}),
    payload: event.payload,
    timestamp: typeof event.payload.timestamp === 'number'
      ? event.payload.timestamp
      : event.createdAt,
  };
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

    let webhookPayload: Record<string, unknown>;
    if (isBuiltinWebhookEvent(eventType)) {
      webhookPayload = buildWebhookPayload(eventType, event.payload);
    } else {
      const parsed = CustomWebhookPayloadSchema.safeParse(
        buildCustomWebhookPayload(event, agentId),
      );
      if (!parsed.success) {
        (this.deps.logger ?? console).warn(
          `[WebhookRelay] skipping invalid custom webhook payload for ${eventType} at seq ${event.seq}`,
        );
        return;
      }
      webhookPayload = parsed.data;
    }
    const hooks = await this.deps.db.listWebhooks(agentId);
    const deliveries: EnqueueCallbackArgs[] = [];

    for (const hook of hooks) {
      if ((hook.events as string[]).includes(eventType)) {
        deliveries.push({
          agentId,
          turnId: optionalString(webhookPayload.turnId) ?? event.turnId ?? undefined,
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
