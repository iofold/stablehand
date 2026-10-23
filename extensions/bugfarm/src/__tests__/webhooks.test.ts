import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { checkDelivery, deliveryToRows, verifyWebhookSignature } from '../webhooks.js';

const secret = 'test-secret';
const NOW = 1_800_000_000;

function sign(timestamp: string, body: string, key = secret): string {
  return `v1=${createHmac('sha256', key).update(`${timestamp}.${body}`).digest('hex')}`;
}

describe('webhook signatures', () => {
  const body = '{"agentId":"a-1","turnId":"t-1"}';
  const ts = String(NOW);

  it('accepts a valid delivery', () => {
    expect(verifyWebhookSignature({ secret, rawBody: body, signatureHeader: sign(ts, body), timestampHeader: ts, nowSec: NOW })).toBe(true);
  });

  it('rejects a wrong secret, a changed body, a stale timestamp and missing headers', () => {
    expect(verifyWebhookSignature({ secret, rawBody: body, signatureHeader: sign(ts, body, 'other'), timestampHeader: ts, nowSec: NOW })).toBe(false);
    expect(verifyWebhookSignature({ secret, rawBody: `${body} `, signatureHeader: sign(ts, body), timestampHeader: ts, nowSec: NOW })).toBe(false);
    expect(verifyWebhookSignature({ secret, rawBody: body, signatureHeader: sign(ts, body), timestampHeader: ts, nowSec: NOW + 301 })).toBe(false);
    expect(verifyWebhookSignature({ secret, rawBody: body, signatureHeader: undefined, timestampHeader: ts, nowSec: NOW })).toBe(false);
    expect(verifyWebhookSignature({ secret, rawBody: body, signatureHeader: 'v1=zz', timestampHeader: ts, nowSec: NOW })).toBe(false);
    expect(verifyWebhookSignature({ secret: '', rawBody: body, signatureHeader: sign(ts, body, ''), timestampHeader: ts, nowSec: NOW })).toBe(false);
  });
});

describe('delivery checks', () => {
  it('requires the signed agent header to match the body', () => {
    expect(checkDelivery({ eventType: 'turn.started', agentId: 'a-2' }, '{"agentId":"a-1"}')).toMatchObject({ ok: false, status: 400 });
    expect(checkDelivery({ eventType: 'turn.started', agentId: 'a-1' }, '{"agentId":"a-1"}')).toMatchObject({ ok: true });
  });

  it('requires a custom event type to match the body type', () => {
    expect(checkDelivery({ eventType: 'custom.bugfarm.rows', agentId: 'a-1' }, '{"agentId":"a-1","type":"custom.other"}')).toMatchObject({ ok: false });
    expect(checkDelivery({ eventType: 'custom.bugfarm.rows', agentId: 'a-1' }, 'not json')).toMatchObject({ ok: false, status: 400 });
  });
});

describe('deliveries become campaign updates', () => {
  it('tracks floor agents, approvals and budget alerts', () => {
    const started = deliveryToRows({ eventType: 'turn.started', agentId: 'scout', body: { turnId: 't1', timestamp: 5 } }, 'main');
    expect(started.rows[0]).toMatchObject({
      kind: 'campaign',
      key: 'main',
      mode: 'merge',
      payload: { floor: { last_event_type: 'turn.started', agents: { scout: { state: 'working', turn_id: 't1', last_seen_at: 5 } } } },
    });

    const waiting = deliveryToRows({ eventType: 'interrupt.requested', agentId: 'publisher', body: { interruptId: 'i1', toolName: 'request-approval', timestamp: 6 } }, 'main');
    expect(waiting.rows[0].payload).toMatchObject({ approval: { state: 'waiting', interrupt_id: 'i1', requested_at: 6 } });

    const approved = deliveryToRows({ eventType: 'interrupt.resolved', agentId: 'publisher', body: { interruptId: 'i1', action: 'approve', timestamp: 7 } }, 'main');
    expect(approved.rows[0].payload).toMatchObject({ approval: { state: 'approved', resolved_at: 7 } });

    const budget = deliveryToRows({ eventType: 'budget.threshold', agentId: 'scout', body: { action: 'warn', threshold: 0.85, spent: 425, limit: 500, timestamp: 8 } }, 'main');
    expect(budget.rows[0].payload).toMatchObject({ budget_alert: { action: 'warn', threshold: 0.85, spent: 425, limit: 500, at: 8 } });

    const failed = deliveryToRows({ eventType: 'turn.completed', agentId: 'scout', body: { status: 'ERROR', timestamp: 9 } }, 'main');
    expect(failed.rows[0].payload).toMatchObject({ floor: { agents: { scout: { state: 'error' } } } });
  });

  it('passes custom.bugfarm.rows through to ingest', () => {
    const nested = { rows: [{ kind: 'item', key: 'x', payload: { stage: 'mined' } }] };
    const result = deliveryToRows({ eventType: 'custom.bugfarm.rows', agentId: 'scout', body: { type: 'custom.bugfarm.rows', payload: nested, timestamp: 1 } }, 'main');
    expect(result.ingest).toEqual(nested);
  });
});
