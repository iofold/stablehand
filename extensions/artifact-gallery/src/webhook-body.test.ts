import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyWebhookSignature } from './gallery.js';
import { readWebhookBody } from './webhook-body.js';

const BODY_LIMIT_BYTES = 1024 * 1024;

function request(body: Buffer, contentLength?: number): IncomingMessage {
  const req = new IncomingMessage(new Socket());
  if (contentLength !== undefined) req.headers['content-length'] = String(contentLength);
  req.push(body);
  req.push(null);
  return req;
}

describe('gallery webhook body limit', () => {
  it('preserves the raw body used to verify a valid webhook signature', async () => {
    const body = '{"artifactId":"synthetic-artifact"}';
    const rawBody = await readWebhookBody(request(Buffer.from(body), Buffer.byteLength(body)));
    const timestamp = '1700000000';
    const signature = createHmac('sha256', 'synthetic-secret')
      .update(`${timestamp}.${body}`).digest('hex');
    expect(rawBody).toBe(body);
    expect(verifyWebhookSignature({
      secret: 'synthetic-secret',
      rawBody: rawBody ?? '',
      signatureHeader: `v1=${signature}`,
      timestampHeader: timestamp,
      nowSec: Number(timestamp),
    })).toBe(true);
  });

  it('refuses an oversized Content-Length before reading the request stream', async () => {
    const req = request(Buffer.from('small body'), BODY_LIMIT_BYTES + 1);
    expect(await readWebhookBody(req)).toBeUndefined();
    expect(req.readableDidRead).toBe(false);
  });

  it('refuses a chunked body once its bytes exceed the limit', async () => {
    const rawBody = await readWebhookBody(request(Buffer.alloc(BODY_LIMIT_BYTES + 1)));
    expect(typeof rawBody).toBe('undefined');
  });

  it('allows a body exactly at the byte limit', async () => {
    const rawBody = await readWebhookBody(request(Buffer.alloc(BODY_LIMIT_BYTES, 0x61)));
    expect(rawBody).toHaveLength(BODY_LIMIT_BYTES);
  });
});
