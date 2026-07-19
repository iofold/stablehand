import type { DatabaseRepository } from '../database/repository.js';
import type { MessageSelect } from '../database/types.js';
import type { EventMap, TypedEventBus } from '../events/bus.js';

interface Logger {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}

export interface MessagePublisherDeps {
  eventBus: Pick<TypedEventBus, 'emitAsync'>;
}

export interface PendingMessagePublisherDeps extends MessagePublisherDeps {
  db: Pick<DatabaseRepository, 'getMessagesPendingCanonicalPublish'>;
  logger: Logger;
}

function requireCanonicalIdentity(message: MessageSelect): {
  agentId: string;
  turnId: string;
  messageSeq: number;
  role: 'assistant' | 'tool';
} {
  if (
    !message.turnId
    || !message.agentId
    || message.messageSeq == null
    || (message.role !== 'assistant' && message.role !== 'tool')
  ) {
    throw new Error(`Message ${message.id} does not have canonical turn/sequence identity`);
  }
  return {
    agentId: message.agentId,
    turnId: message.turnId,
    messageSeq: message.messageSeq,
    role: message.role,
  };
}

function committedPayload(message: MessageSelect): EventMap['message.committed'] {
  const identity = requireCanonicalIdentity(message);
  return {
    turnId: identity.turnId,
    agentId: identity.agentId,
    conversationId: message.conversationId,
    messageId: message.id,
    messageSeq: identity.messageSeq,
    role: identity.role,
    content: message.content,
    ...(Array.isArray(message.parts)
      ? { parts: message.parts as EventMap['message.committed']['parts'] }
      : {}),
    ...(Array.isArray(message.toolCalls)
      ? { toolCalls: message.toolCalls as EventMap['message.committed']['toolCalls'] }
      : {}),
    ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
    timestamp: message.createdAt,
  };
}

function updatedPayload(message: MessageSelect): EventMap['message.updated'] {
  const identity = requireCanonicalIdentity(message);
  if (identity.role !== 'assistant') {
    throw new Error(`Only assistant message ${message.id} may publish message.updated`);
  }
  return {
    turnId: identity.turnId,
    agentId: identity.agentId,
    conversationId: message.conversationId,
    messageId: message.id,
    messageSeq: identity.messageSeq,
    messageRevision: message.messageRevision,
    role: 'assistant',
    content: message.content,
    ...(Array.isArray(message.parts)
      ? { parts: message.parts as EventMap['message.updated']['parts'] }
      : {}),
    ...(Array.isArray(message.toolCalls)
      ? { toolCalls: message.toolCalls as EventMap['message.updated']['toolCalls'] }
      : {}),
    timestamp: Date.now(),
  };
}

/**
 * Publish every canonical state transition still pending for one durable row.
 * The -1/0/N watermark makes baseline-vs-update state explicit across crashes.
 */
export async function publishMessageCanonicalState(
  deps: MessagePublisherDeps,
  message: MessageSelect,
): Promise<number> {
  let publishedRevision = message.publishedRevision;
  let published = 0;

  if (publishedRevision < 0) {
    await deps.eventBus.emitAsync('message.committed', committedPayload(message));
    publishedRevision = 0;
    published++;
  }

  if (message.messageRevision > publishedRevision) {
    await deps.eventBus.emitAsync('message.updated', updatedPayload(message));
    published++;
  }

  return published;
}

/** Rebuild frames left pending by a crash or prior event-store failure. */
export async function reconcilePendingMessagePublishesOnStartup(
  deps: PendingMessagePublisherDeps,
): Promise<number> {
  const pending = await deps.db.getMessagesPendingCanonicalPublish();
  let published = 0;
  for (const message of pending) {
    published += await publishMessageCanonicalState(deps, message);
  }
  if (published > 0) {
    deps.logger.info(
      '[MessagePublisher] rebuilt %d canonical message frame(s) from durable rows',
      published,
    );
  }
  return published;
}
