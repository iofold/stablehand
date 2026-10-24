import type { IncomingMessage } from 'node:http';

const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;

/** Undefined means the caller must reject the request and close its connection. */
export async function readWebhookBody(req: IncomingMessage): Promise<string | undefined> {
  if (Number(req.headers['content-length']) > MAX_WEBHOOK_BODY_BYTES) return undefined;

  const chunks: Buffer[] = [];
  let receivedBytes = 0;
  // Keep the stream open on an early return so the caller can send a 413 before
  // closing the connection, rather than destroying it inside the iterator.
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    const bytes = chunk as Buffer;
    receivedBytes += bytes.length;
    if (receivedBytes > MAX_WEBHOOK_BODY_BYTES) return undefined;
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString('utf8');
}
