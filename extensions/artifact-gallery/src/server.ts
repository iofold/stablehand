import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readWebhookBody } from './webhook-body.js';
import {
  EMPTY_INDEX,
  MAX_CACHED_BYTES,
  blobResponseHeaders,
  isCacheableMime,
  missingGalleryConfig,
  renderGalleryPage,
  renderNotConnectedPage,
  sortedEntries,
  upsertEntry,
  verifyWebhookSignature,
  type GalleryEntry,
  type GalleryIndex,
} from './gallery.js';

/**
 * artifact-gallery: reference Stablehand extension (ctx-7ay9).
 *
 * Out-of-process service on a least-privilege scoped key
 * (artifacts:read + webhooks:manage). Ingests artifact.created webhook
 * deliveries plus a periodic read-API sweep (which also discovers agents whose
 * first artifact predates their webhook), caches visual artifact blobs
 * locally, and serves a public gallery with stable /a/:id links. The local
 * store is a rebuildable projection — deleting it loses nothing.
 */

const BASE_URL = (process.env.STABLEHAND_BASE_URL ?? 'http://localhost:3002').replace(/\/+$/, '');
const API_KEY = process.env.STABLEHAND_API_KEY ?? '';
const PORT = Number(process.env.GALLERY_PORT ?? 8090);
const PUBLIC_URL = (process.env.GALLERY_PUBLIC_URL ?? `http://localhost:${PORT}`).replace(/\/+$/, '');
const DATA_DIR = process.env.GALLERY_DATA_DIR ?? path.join(process.cwd(), 'data');
const WEBHOOK_SECRET = process.env.GALLERY_WEBHOOK_SECRET ?? '';
const SYNC_INTERVAL_MS = Number(process.env.GALLERY_SYNC_INTERVAL_MS ?? 60_000);

// Without a key or secret the service still starts and explains what is
// missing, so a compose stack brought up before the seed does not crash-loop.
const MISSING_CONFIG = missingGalleryConfig({ apiKey: API_KEY, webhookSecret: WEBHOOK_SECRET });

const INDEX_PATH = path.join(DATA_DIR, 'index.json');
const BLOB_DIR = path.join(DATA_DIR, 'blobs');

let index: GalleryIndex = EMPTY_INDEX;
const agentNames: Record<string, string> = {};

async function api(pathname: string, init?: RequestInit): Promise<Response> {
  return fetch(`${BASE_URL}${pathname}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  });
}

async function loadIndex(): Promise<void> {
  try {
    index = JSON.parse(await readFile(INDEX_PATH, 'utf8')) as GalleryIndex;
  } catch {
    index = EMPTY_INDEX;
  }
}

async function saveIndex(): Promise<void> {
  await writeFile(INDEX_PATH, JSON.stringify(index, null, 2));
}

function blobPath(artifactId: string): string {
  // Artifact ids are UUIDs; refuse anything path-shaped anyway.
  if (!/^[A-Za-z0-9_-]+$/.test(artifactId)) throw new Error('invalid artifact id');
  return path.join(BLOB_DIR, artifactId);
}

interface ApiArtifact {
  id: string;
  agentId: string;
  name: string;
  mimeType: string | null;
  sizeBytes: number | null;
  kind?: string | null;
  sha256?: string | null;
  createdAt: number;
}

async function ingestArtifact(artifact: ApiArtifact): Promise<void> {
  if (index.entries[artifact.id]?.cached) return;
  const mimeType = artifact.mimeType ?? 'application/octet-stream';
  const sizeBytes = artifact.sizeBytes ?? 0;
  let cached = false;
  if (isCacheableMime(mimeType) && sizeBytes > 0 && sizeBytes <= MAX_CACHED_BYTES) {
    const res = await api(`/api/artifacts/${artifact.id}/download`);
    if (res.ok) {
      const bytes = Buffer.from(await res.arrayBuffer());
      await writeFile(blobPath(artifact.id), bytes);
      cached = true;
    } else {
      console.warn(`[gallery] download failed for ${artifact.id}: ${res.status}`);
    }
  }
  const entry: GalleryEntry = {
    id: artifact.id,
    agentId: artifact.agentId,
    name: artifact.name,
    mimeType,
    sizeBytes,
    kind: artifact.kind ?? null,
    sha256: artifact.sha256 ?? null,
    createdAt: artifact.createdAt,
    cached,
  };
  index = upsertEntry(index, entry);
  await saveIndex();
  console.log(`[gallery] indexed ${artifact.id} (${artifact.name}, ${mimeType}${cached ? ', cached' : ''})`);
}

async function syncArtifacts(): Promise<void> {
  let offset = 0;
  const limit = 100;
  for (;;) {
    const res = await api(`/api/artifacts?limit=${limit}&offset=${offset}`);
    if (!res.ok) {
      console.warn(`[gallery] artifact list failed: ${res.status}`);
      return;
    }
    const { artifacts } = await res.json() as { artifacts: ApiArtifact[] };
    for (const artifact of artifacts) {
      await ingestArtifact(artifact);
    }
    if (artifacts.length < limit) return;
    offset += limit;
  }
}

/**
 * Register our webhook for every agent seen in the index. Agents are learned
 * from artifacts (keeps the key at artifacts:read + webhooks:manage — no agent
 * enumeration); a brand-new agent's first artifact arrives via the periodic
 * sweep, after which its webhook covers the rest.
 */
async function ensureWebhooks(): Promise<void> {
  const known = new Set(index.webhookAgentIds);
  const agentIds = new Set(Object.values(index.entries).map((entry) => entry.agentId));
  for (const agentId of agentIds) {
    // Artifacts uploaded outside an agent turn carry agentId null; there is no
    // agent to register against, so skip instead of POSTing /agents/null/webhooks.
    if (!agentId || known.has(agentId)) continue;
    const res = await api(`/api/agents/${agentId}/webhooks`, {
      method: 'POST',
      body: JSON.stringify({
        url: `${PUBLIC_URL}/hooks/stablehand`,
        events: ['artifact.created'],
        secret: WEBHOOK_SECRET,
      }),
    });
    if (res.ok || res.status === 409) {
      index = { ...index, webhookAgentIds: [...index.webhookAgentIds, agentId] };
      await saveIndex();
      console.log(`[gallery] webhook registered for agent ${agentId}`);
    } else {
      console.warn(`[gallery] webhook registration failed for ${agentId}: ${res.status}`);
    }
  }
}

/**
 * The startup probe, retried while Stablehand is still booting (connection
 * refused or a 5xx), so the gallery can start alongside the stack. A 4xx is
 * returned at once: the key is wrong, and retrying will not fix it.
 */
async function waitForStablehand(): Promise<Response> {
  const deadline = Date.now() + Number(process.env.GALLERY_STARTUP_WAIT_MS ?? 180_000);
  for (;;) {
    try {
      const res = await api('/api/artifacts?limit=1');
      if (res.status < 500 || Date.now() >= deadline) return res;
      console.log(`[gallery] Stablehand answered ${res.status}; retrying`);
    } catch (err) {
      if (Date.now() >= deadline) throw err;
      console.log(`[gallery] waiting for Stablehand at ${BASE_URL}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', PUBLIC_URL);

    if (MISSING_CONFIG.length > 0) {
      if (req.method === 'GET' && url.pathname === '/healthz') {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, connected: false, missing: MISSING_CONFIG }));
        return;
      }
      res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderNotConnectedPage(MISSING_CONFIG));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        artifacts: Object.keys(index.entries).length,
        webhookAgents: index.webhookAgentIds.length,
      }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/hooks/stablehand') {
      const rawBody = await readWebhookBody(req);
      if (rawBody === undefined) {
        res.writeHead(413, { 'Content-Type': 'application/json', Connection: 'close' });
        res.end(JSON.stringify({ error: 'webhook body exceeds the 1 MiB limit' }));
        return;
      }
      const valid = verifyWebhookSignature({
        secret: WEBHOOK_SECRET,
        rawBody,
        signatureHeader: req.headers['x-webhook-signature'] as string | undefined,
        timestampHeader: req.headers['x-webhook-timestamp'] as string | undefined,
      });
      if (!valid) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid signature' }));
        return;
      }
      const eventType = req.headers['x-event-type'];
      if (eventType === 'artifact.created') {
        const payload = JSON.parse(rawBody) as { artifactId?: string };
        if (payload.artifactId) {
          const detail = await api(`/api/artifacts/${payload.artifactId}`);
          if (detail.ok) {
            await ingestArtifact(await detail.json() as ApiArtifact);
          }
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === 'GET' && url.pathname.startsWith('/a/')) {
      const artifactId = decodeURIComponent(url.pathname.slice('/a/'.length));
      const entry = index.entries[artifactId];
      if (!entry?.cached) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('artifact not in gallery cache');
        return;
      }
      const bytes = await readFile(blobPath(artifactId));
      res.writeHead(200, blobResponseHeaders(entry.mimeType));
      res.end(bytes);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderGalleryPage({ entries: sortedEntries(index), agentNames }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  } catch (err) {
    console.error('[gallery] request failed:', err);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('internal error');
  }
});

async function main(): Promise<void> {
  if (MISSING_CONFIG.length > 0) {
    console.warn(`[gallery] not connected: set ${MISSING_CONFIG.join(' and ')} (scoped key: artifacts:read + webhooks:manage)`);
    server.listen(PORT, () => {
      console.log(`[gallery] waiting for configuration on :${PORT}`);
    });
    return;
  }
  await mkdir(BLOB_DIR, { recursive: true });
  if (!existsSync(INDEX_PATH)) await writeFile(INDEX_PATH, JSON.stringify(EMPTY_INDEX));
  await loadIndex();

  // Startup probe per the EXTENDING.md handshake: one allowed endpoint, one
  // deliberately forbidden endpoint — proves the key is scoped, not master.
  const allowed = await waitForStablehand();
  if (!allowed.ok) {
    console.error(`[gallery] startup probe failed: GET /api/artifacts → ${allowed.status}. Check the scoped key.`);
    process.exit(1);
  }
  const forbidden = await api('/api/keys');
  if (forbidden.status === 403) {
    console.log('[gallery] key scope verified: master-only route correctly refused (403)');
  } else {
    console.warn(`[gallery] WARNING: /api/keys returned ${forbidden.status} — this key may be over-privileged; use a scoped key (artifacts:read + webhooks:manage)`);
  }

  await syncArtifacts();
  await ensureWebhooks();
  setInterval(() => {
    void syncArtifacts().then(() => ensureWebhooks()).catch((err) => {
      console.warn('[gallery] periodic sync failed:', err);
    });
  }, SYNC_INTERVAL_MS).unref();

  server.listen(PORT, () => {
    console.log(`[gallery] serving ${Object.keys(index.entries).length} artifacts on :${PORT} (public: ${PUBLIC_URL}, instance ${randomUUID().slice(0, 8)})`);
  });
}

void main();
