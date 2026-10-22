import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Pure logic for the artifact-gallery extension: webhook signature
 * verification, artifact classification, and the gallery index. Kept free of
 * I/O so it is unit-testable; server.ts owns fetch/serve wiring.
 */

export interface GalleryEntry {
  id: string;
  agentId: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  kind: string | null;
  sha256: string | null;
  createdAt: number;
  /** Set when the blob is cached locally and servable. */
  cached: boolean;
}

export interface GalleryIndex {
  entries: Record<string, GalleryEntry>;
  /** Agent ids we have registered our webhook for. */
  webhookAgentIds: string[];
}

export const EMPTY_INDEX: GalleryIndex = { entries: {}, webhookAgentIds: [] };

/** Signature tolerance: deliveries older than this are replays, not late. */
const SIGNATURE_MAX_AGE_SEC = 300;

/**
 * Verify a Stablehand webhook delivery: `X-Webhook-Signature: v1=<hex>` where
 * hex = HMAC-SHA256(secret, `${timestamp}.${rawBody}`).
 */
export function verifyWebhookSignature(options: {
  secret: string;
  rawBody: string;
  signatureHeader: string | undefined;
  timestampHeader: string | undefined;
  nowSec?: number;
}): boolean {
  const { secret, rawBody, signatureHeader, timestampHeader } = options;
  if (!signatureHeader || !timestampHeader) return false;
  if (!signatureHeader.startsWith('v1=')) return false;
  const timestamp = Number(timestampHeader);
  if (!Number.isSafeInteger(timestamp)) return false;
  const nowSec = options.nowSec ?? Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - timestamp) > SIGNATURE_MAX_AGE_SEC) return false;

  const expected = createHmac('sha256', secret)
    .update(`${timestampHeader}.${rawBody}`)
    .digest('hex');
  const provided = signatureHeader.slice('v1='.length);
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(provided, 'utf8'), Buffer.from(expected, 'utf8'));
}

/** Mime types the gallery caches and serves inline. Everything else links out. */
const INLINE_MIME_PREFIXES = ['image/'];
const INLINE_MIME_EXACT = new Set([
  'text/html',
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
  'image/svg+xml',
]);

export const MAX_CACHED_BYTES = 20 * 1024 * 1024;

export function isCacheableMime(mimeType: string): boolean {
  const normalized = mimeType.toLowerCase().split(';')[0].trim();
  return INLINE_MIME_EXACT.has(normalized)
    || INLINE_MIME_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export function isImageMime(mimeType: string): boolean {
  return mimeType.toLowerCase().startsWith('image/');
}

export function isHtmlMime(mimeType: string): boolean {
  return mimeType.toLowerCase().split(';')[0].trim() === 'text/html';
}

/**
 * Response headers for serving a cached artifact blob. HTML gets a sandboxing
 * CSP so a malicious artifact cannot reach the gallery origin's cookies or
 * fetch anything beyond itself; everything gets nosniff.
 */
export function blobResponseHeaders(mimeType: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': mimeType,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'public, max-age=300',
  };
  if (isHtmlMime(mimeType) || mimeType.toLowerCase() === 'image/svg+xml') {
    headers['Content-Security-Policy'] =
      "sandbox allow-scripts; default-src 'self' 'unsafe-inline' data: blob:;";
  }
  return headers;
}

export function upsertEntry(index: GalleryIndex, entry: GalleryEntry): GalleryIndex {
  return {
    ...index,
    entries: { ...index.entries, [entry.id]: entry },
  };
}

export function sortedEntries(index: GalleryIndex): GalleryEntry[] {
  return Object.values(index.entries).sort((a, b) => b.createdAt - a.createdAt);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const BRAND_MARK_SVG = `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4.7 19.3h2.5v-6.5a4.8 4.8 0 0 1 9.6 0v6.5h2.5" stroke="#2dd4bf" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="15" r="2" fill="#2dd4bf"/></svg>`;

/** What the gallery still needs before it can sync, in the order to fix it. */
export function missingGalleryConfig(env: {
  apiKey: string;
  webhookSecret: string;
}): string[] {
  const missing: string[] = [];
  if (!env.apiKey) missing.push('STABLEHAND_API_KEY');
  if (!env.webhookSecret) missing.push('GALLERY_WEBHOOK_SECRET');
  return missing;
}

const PAGE_STYLE = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; }
  body { background: #0b0b0d; color: #e4e4e7; font: 15px/1.5 system-ui, sans-serif; padding: 24px; }
  header { display: flex; align-items: center; gap: 10px; margin-bottom: 20px; }
  header h1 { font-size: 20px; letter-spacing: -0.02em; }
  header span { color: #71717a; font-size: 13px; margin-left: auto; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 14px; }
  .card { background: #18181b; border: 1px solid #27272a; border-radius: 10px; overflow: hidden; }
  .card img { width: 100%; height: 160px; object-fit: cover; display: block; background: #101012; }
  .card .doc { display: flex; align-items: center; justify-content: center; height: 160px; background: #101012; color: #2dd4bf; font-weight: 600; text-decoration: none; text-align: center; }
  .card .doc.muted { color: #52525b; }
  figcaption { padding: 10px 12px; display: grid; gap: 2px; }
  figcaption strong { font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  figcaption span, figcaption time { color: #71717a; font-size: 12px; }
  .empty { color: #71717a; padding: 60px 0; text-align: center; }
  .setup { max-width: 640px; display: grid; gap: 12px; color: #a1a1aa; }
  .setup code { color: #e4e4e7; background: #18181b; padding: 1px 5px; border-radius: 4px; }
`;

/**
 * Shown instead of the gallery while the service has no scoped key or
 * webhook secret yet, so a stack started before the seed explains itself
 * instead of restarting in a loop.
 */
export function renderNotConnectedPage(missing: readonly string[]): string {
  const items = missing.map((name) => `<code>${escapeHtml(name)}</code>`).join(' and ');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Artifact gallery: not connected</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<header>${BRAND_MARK_SVG}<h1>Artifact gallery</h1></header>
<div class="setup">
  <p>The gallery is running but cannot read artifacts yet: ${items} ${missing.length === 1 ? 'is' : 'are'} not set.</p>
  <p>The Overnight Analyst seed creates a scoped key for it. Put the <code>GALLERY_API_KEY</code> line the seed prints into <code>.env</code>, then run <code>docker compose up -d gallery</code>. <code>install.sh</code> does both for you.</p>
</div>
</body>
</html>`;
}

/** Server-rendered gallery page: zero client dependencies. */
export function renderGalleryPage(options: {
  entries: GalleryEntry[];
  agentNames?: Record<string, string>;
  title?: string;
}): string {
  const title = options.title ?? 'Agent Artifact Gallery';
  const cards = options.entries.map((entry) => {
    const agentLabel = options.agentNames?.[entry.agentId] ?? `${entry.agentId.slice(0, 8)}…`;
    const href = `/a/${encodeURIComponent(entry.id)}`;
    const preview = entry.cached && isImageMime(entry.mimeType)
      ? `<a href="${href}"><img src="${href}" alt="${escapeHtml(entry.name)}" loading="lazy"></a>`
      : entry.cached && isHtmlMime(entry.mimeType)
        ? `<a class="doc html" href="${href}">interactive<br>HTML</a>`
        : entry.cached
          ? `<a class="doc" href="${href}">${escapeHtml(entry.mimeType.split('/')[1] ?? 'file')}</a>`
          : `<span class="doc muted">not cached</span>`;
    return `<figure class="card">
      ${preview}
      <figcaption>
        <strong title="${escapeHtml(entry.name)}">${escapeHtml(entry.name)}</strong>
        <span>${escapeHtml(agentLabel)} · ${formatBytes(entry.sizeBytes)}${entry.kind ? ` · ${escapeHtml(entry.kind)}` : ''}</span>
        <time datetime="${new Date(entry.createdAt).toISOString()}">${new Date(entry.createdAt).toLocaleString()}</time>
      </figcaption>
    </figure>`;
  }).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<header>${BRAND_MARK_SVG}<h1>${escapeHtml(title)}</h1><span>${options.entries.length} artifact${options.entries.length === 1 ? '' : 's'}</span></header>
${options.entries.length === 0
    ? '<p class="empty">No artifacts yet. Agent-published artifacts appear here automatically.</p>'
    : `<div class="grid">\n${cards}\n</div>`}
</body>
</html>`;
}
