import { createHmac, timingSafeEqual } from 'node:crypto';
import { isPlainObject } from './store/payload.js';
import type { UpsertInput } from './store/validate.js';

/** Stablehand's default tolerance for the signed delivery timestamp. */
export const SIGNATURE_MAX_AGE_SEC = 300;

/** Events the worker subscribes to on each floor agent. */
export const SUBSCRIBED_EVENTS = [
  'turn.started',
  'turn.completed',
  'turn.cancelled',
  'interrupt.requested',
  'interrupt.resolved',
  'budget.threshold',
  'custom.bugfarm.rows',
] as const;

/**
 * Verify a Stablehand webhook delivery: `X-Webhook-Signature: v1=<hex>` is
 * HMAC-SHA256 over `<X-Webhook-Timestamp>.<raw body>`, and the timestamp
 * (Unix seconds) must be within five minutes.
 */
export function verifyWebhookSignature(options: {
  secret: string;
  rawBody: string;
  signatureHeader: string | undefined;
  timestampHeader: string | undefined;
  nowSec?: number;
}): boolean {
  const { secret, rawBody, signatureHeader, timestampHeader } = options;
  if (!secret || !signatureHeader || !timestampHeader) return false;
  if (!/^v1=[0-9a-f]{64}$/.test(signatureHeader)) return false;
  if (!/^(0|[1-9]\d*)$/.test(timestampHeader)) return false;
  const timestamp = Number(timestampHeader);
  if (!Number.isSafeInteger(timestamp)) return false;
  const nowSec = options.nowSec ?? Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - timestamp) > SIGNATURE_MAX_AGE_SEC) return false;
  const expected = createHmac('sha256', secret).update(`${timestampHeader}.${rawBody}`).digest('hex');
  const provided = signatureHeader.slice('v1='.length);
  return timingSafeEqual(Buffer.from(provided, 'utf8'), Buffer.from(expected, 'utf8'));
}

export interface WebhookDelivery {
  eventType: string;
  agentId: string;
  body: Record<string, unknown>;
}

export type DeliveryCheck =
  | { ok: true; delivery: WebhookDelivery }
  | { ok: false; status: number; error: string };

/** After the signature passes: the signed identity headers must match the body. */
export function checkDelivery(
  headers: { eventType: string | undefined; agentId: string | undefined },
  rawBody: string,
): DeliveryCheck {
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return { ok: false, status: 400, error: 'body is not JSON' };
  }
  if (!isPlainObject(body)) return { ok: false, status: 400, error: 'body is not a JSON object' };
  if (!headers.eventType) return { ok: false, status: 400, error: 'missing X-Event-Type' };
  if (!headers.agentId) return { ok: false, status: 400, error: 'missing X-Agent-Id' };
  if (typeof body.agentId === 'string' && body.agentId !== headers.agentId) {
    return { ok: false, status: 400, error: 'X-Agent-Id does not match the body' };
  }
  if (headers.eventType.startsWith('custom.') && body.type !== headers.eventType) {
    return { ok: false, status: 400, error: 'X-Event-Type does not match the body type' };
  }
  return { ok: true, delivery: { eventType: headers.eventType, agentId: headers.agentId, body } };
}

function millis(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Turn one verified delivery into board writes.
 *
 * - Turn events keep the campaign's view of each floor agent current.
 * - Interrupts are the publish approval: waiting, then approved or rejected.
 * - Budget thresholds show as an alert on the campaign.
 * - `custom.bugfarm.rows` lets a Stablehand agent write board rows directly;
 *   its nested payload is `{ rows: [...] }` in the ingest API's shape.
 *
 * Every write is a merge with deterministic content, so a redelivered event
 * changes nothing.
 */
export function deliveryToRows(
  delivery: WebhookDelivery,
  campaignKey: string,
  now: number = Date.now(),
): { rows: UpsertInput[]; ingest: unknown | null } {
  const { eventType, agentId, body } = delivery;
  const at = millis(body.timestamp, now);
  const floor = { last_event_at: at, last_event_type: eventType };

  const campaign = (patch: Record<string, unknown>): UpsertInput => ({
    kind: 'campaign',
    key: campaignKey,
    mode: 'merge',
    payload: patch,
  });

  switch (eventType) {
    case 'turn.started':
      return {
        rows: [campaign({
          floor: { ...floor, agents: { [agentId]: { state: 'working', last_seen_at: at, turn_id: String(body.turnId ?? '') } } },
        })],
        ingest: null,
      };
    case 'turn.completed': {
      const state = body.status === 'ERROR' ? 'error' : body.status === 'CANCELLED' ? 'cancelled' : 'idle';
      return {
        rows: [campaign({ floor: { ...floor, agents: { [agentId]: { state, last_seen_at: at } } } })],
        ingest: null,
      };
    }
    case 'turn.cancelled':
      return {
        rows: [campaign({ floor: { ...floor, agents: { [agentId]: { state: 'cancelled', last_seen_at: at } } } })],
        ingest: null,
      };
    case 'interrupt.requested':
      return {
        rows: [campaign({
          floor,
          approval: {
            state: 'waiting',
            interrupt_id: String(body.interruptId ?? ''),
            tool: String(body.toolName ?? ''),
            requested_at: at,
          },
        })],
        ingest: null,
      };
    case 'interrupt.resolved': {
      const action = String(body.action ?? '');
      const state = action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : action || 'rejected';
      return {
        rows: [campaign({
          floor,
          approval: { state, interrupt_id: String(body.interruptId ?? ''), resolved_at: at },
        })],
        ingest: null,
      };
    }
    case 'budget.threshold':
      return {
        rows: [campaign({
          floor,
          budget_alert: {
            action: String(body.action ?? 'warn'),
            threshold: Number(body.threshold ?? 0),
            spent: Number(body.spent ?? 0),
            limit: Number(body.limit ?? 0),
            at,
          },
        })],
        ingest: null,
      };
    case 'custom.bugfarm.rows':
      return { rows: [campaign({ floor })], ingest: body.payload ?? null };
    default:
      return { rows: [campaign({ floor })], ingest: null };
  }
}
