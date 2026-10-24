import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_INDEX,
  blobResponseHeaders,
  isCacheableMime,
  missingGalleryConfig,
  renderGalleryPage,
  renderNotConnectedPage,
  sortedEntries,
  upsertEntry,
  verifyWebhookSignature,
  type GalleryEntry,
} from './gallery.js';

function sign(secret: string, timestamp: string, body: string): string {
  return `v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

const NOW_SEC = 1_700_000_000;

describe('artifact-gallery webhook signatures', () => {
  const secret = 'test-secret';
  const body = '{"artifactId":"a-1"}';
  const ts = String(NOW_SEC);

  it('accepts a valid Stablehand delivery signature', () => {
    expect(verifyWebhookSignature({
      secret,
      rawBody: body,
      signatureHeader: sign(secret, ts, body),
      timestampHeader: ts,
      nowSec: NOW_SEC,
    })).toBe(true);
  });

  it('rejects wrong secret, tampered body, stale timestamp, and missing headers', () => {
    expect(verifyWebhookSignature({
      secret: 'other-secret',
      rawBody: body,
      signatureHeader: sign(secret, ts, body),
      timestampHeader: ts,
      nowSec: NOW_SEC,
    })).toBe(false);
    expect(verifyWebhookSignature({
      secret,
      rawBody: '{"artifactId":"tampered"}',
      signatureHeader: sign(secret, ts, body),
      timestampHeader: ts,
      nowSec: NOW_SEC,
    })).toBe(false);
    const staleTs = String(NOW_SEC - 600);
    expect(verifyWebhookSignature({
      secret,
      rawBody: body,
      signatureHeader: sign(secret, staleTs, body),
      timestampHeader: staleTs,
      nowSec: NOW_SEC,
    })).toBe(false);
    expect(verifyWebhookSignature({
      secret,
      rawBody: body,
      signatureHeader: undefined,
      timestampHeader: ts,
      nowSec: NOW_SEC,
    })).toBe(false);
  });
});

describe('artifact-gallery classification and serving', () => {
  it('caches visual and textual types, refuses binaries', () => {
    expect(isCacheableMime('image/png')).toBe(true);
    expect(isCacheableMime('text/html; charset=utf-8')).toBe(true);
    expect(isCacheableMime('application/json')).toBe(true);
    expect(isCacheableMime('application/octet-stream')).toBe(false);
    expect(isCacheableMime('application/zip')).toBe(false);
  });

  it('sandboxes html and svg responses and nosniffs everything', () => {
    const html = blobResponseHeaders('text/html');
    expect(html['Content-Security-Policy']).toContain('sandbox');
    expect(html['X-Content-Type-Options']).toBe('nosniff');
    const png = blobResponseHeaders('image/png');
    expect(png['Content-Security-Policy']).toBeUndefined();
    expect(png['X-Content-Type-Options']).toBe('nosniff');
  });

  it.each([
    'image/svg+xml',
    'image/svg+xml; charset=utf-8',
    'IMAGE/SVG+XML; CHARSET=UTF-8',
    'image/svg+xml ; charset=utf-8',
    'text/html; charset=utf-8',
    'TEXT/HTML; CHARSET=UTF-8',
  ])('isolates active artifact content with MIME type %s', (mimeType) => {
    expect(isCacheableMime(mimeType)).toBe(true);
    const headers = blobResponseHeaders(mimeType);
    expect(headers['Content-Type']).toBe(mimeType);
    expect(headers['Content-Security-Policy']).toContain('sandbox allow-scripts;');
    expect(headers['Content-Security-Policy']).not.toContain('allow-same-origin');
  });
});

describe('artifact-gallery index and rendering', () => {
  const entry = (id: string, createdAt: number, overrides: Partial<GalleryEntry> = {}): GalleryEntry => ({
    id,
    agentId: 'agent-1',
    name: `artifact-${id}`,
    mimeType: 'image/png',
    sizeBytes: 1024,
    kind: null,
    sha256: null,
    createdAt,
    cached: true,
    ...overrides,
  });

  it('sorts newest first and escapes hostile names in the page', () => {
    let index = EMPTY_INDEX;
    index = upsertEntry(index, entry('old', 1_000));
    index = upsertEntry(index, entry('new', 2_000, { name: '<script>alert(1)</script>' }));

    const sorted = sortedEntries(index);
    expect(sorted.map((e) => e.id)).toEqual(['new', 'old']);

    const page = renderGalleryPage({ entries: sorted });
    expect(page).not.toContain('<script>alert(1)</script>');
    expect(page).toContain('&lt;script&gt;');
    expect(page).toContain('/a/new');
  });

  it('renders an honest empty state', () => {
    const page = renderGalleryPage({ entries: [] });
    expect(page).toContain('No artifacts yet');
  });
});

describe('artifact-gallery before it is connected', () => {
  it('names each missing setting in the order to fix it', () => {
    expect(missingGalleryConfig({ apiKey: '', webhookSecret: '' }))
      .toEqual(['STABLEHAND_API_KEY', 'GALLERY_WEBHOOK_SECRET']);
    expect(missingGalleryConfig({ apiKey: 'cmk_x', webhookSecret: '' }))
      .toEqual(['GALLERY_WEBHOOK_SECRET']);
    expect(missingGalleryConfig({ apiKey: 'cmk_x', webhookSecret: 's' })).toEqual([]);
  });

  it('explains how to connect instead of showing an empty gallery', () => {
    const html = renderNotConnectedPage(['STABLEHAND_API_KEY']);
    expect(html).toContain('<code>STABLEHAND_API_KEY</code> is not set');
    expect(html).toContain('docker compose up -d gallery');
    expect(html).not.toContain('class="grid"');
  });
});
