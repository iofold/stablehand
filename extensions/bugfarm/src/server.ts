import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import type { ChangeHub } from './hub.js';
import type { BoardRow } from './shared/board.js';
import type { BoardStore, ResetScope } from './store/store.js';
import { UpsertValidationError } from './store/store.js';
import { UpsertBodySchema, UpsertInputSchema, formatIssues, type UpsertInput } from './store/validate.js';
import { checkDelivery, deliveryToRows, verifyWebhookSignature } from './webhooks.js';
import type { LinkStatus } from './stablehand.js';

export interface ServerDeps {
  store: Pick<BoardStore, 'upsert' | 'changes' | 'current' | 'epoch' | 'reset' | 'summary' | 'ping'>;
  hub: Pick<ChangeHub, 'subscribe' | 'poke' | 'reset' | 'size'>;
  ingestToken: string;
  viewToken: string;
  webhookSecret: string;
  campaignKey: string;
  webDir: string | null;
  link: () => LinkStatus | null;
  sim: () => { running: boolean } | null;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
  heartbeatMs?: number;
}

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const VIEW_COOKIE = 'bugfarm_view';

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'self'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly extra: Record<string, unknown> = {}) {
    super(message);
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...SECURITY_HEADERS,
    ...headers,
  });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, `body is larger than ${MAX_BODY_BYTES} bytes`);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'body is not valid JSON');
  }
}

function safeEqual(provided: string, expected: string): boolean {
  if (!expected) return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function bearer(req: IncomingMessage): string {
  const header = req.headers.authorization ?? '';
  return header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
}

function cookie(req: IncomingMessage, name: string): string {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return '';
}

function nonNegativeInt(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (!/^\d+$/.test(value)) throw new HttpError(400, `expected a non-negative integer, got "${value}"`);
  return Number(value);
}

export function createBugfarmServer(deps: ServerDeps): Server {
  const logger = deps.logger ?? console;
  const heartbeatMs = deps.heartbeatMs ?? 15_000;
  const seenDeliveries = new Set<string>();

  function rememberDelivery(id: string): boolean {
    if (seenDeliveries.has(id)) return false;
    seenDeliveries.add(id);
    if (seenDeliveries.size > 2000) {
      const oldest = seenDeliveries.values().next().value;
      if (oldest !== undefined) seenDeliveries.delete(oldest);
    }
    return true;
  }

  async function ingest(rows: UpsertInput[]): Promise<{ cursor: number; results: unknown[] }> {
    try {
      const result = await deps.store.upsert(rows);
      if (result.rows.length > 0) void deps.hub.poke();
      return { cursor: result.cursor, results: result.results };
    } catch (err) {
      if (err instanceof UpsertValidationError) {
        throw new HttpError(422, err.message, { index: err.index, kind: err.kind, key: err.key });
      }
      throw err;
    }
  }

  function requireIngest(req: IncomingMessage): void {
    if (!deps.ingestToken) {
      throw new HttpError(503, 'Ingest is off. Set BUGFARM_INGEST_TOKEN to let the pipeline write to the board.');
    }
    if (!safeEqual(bearer(req), deps.ingestToken)) {
      throw new HttpError(401, 'missing or wrong ingest token');
    }
  }

  /** Returns true when the request may see the board; otherwise it has already responded. */
  function allowView(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
    if (!deps.viewToken) return true;
    if (safeEqual(cookie(req, VIEW_COOKIE), deps.viewToken)) return true;
    const key = url.searchParams.get('key');
    if (key !== null && safeEqual(key, deps.viewToken) && req.method === 'GET' && !url.pathname.startsWith('/api/')) {
      url.searchParams.delete('key');
      res.writeHead(303, {
        Location: `${url.pathname}${url.search}`,
        'Set-Cookie': `${VIEW_COOKIE}=${encodeURIComponent(deps.viewToken)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`,
        ...SECURITY_HEADERS,
      });
      res.end();
      return false;
    }
    if (url.pathname.startsWith('/api/')) {
      sendJson(res, 401, { error: 'This board is private. Open it with ?key=<view token> once.' });
    } else {
      res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
      res.end('This board is private. Open it with ?key=<view token> once; the browser remembers it.');
    }
    return false;
  }

  async function stream(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const lastEventId = nonNegativeInt(req.headers['last-event-id'] as string | undefined);
    const since = lastEventId ?? nonNegativeInt(url.searchParams.get('since')) ?? 0;
    const clientEpoch = url.searchParams.get('epoch');
    const epoch = await deps.store.epoch();

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...SECURITY_HEADERS,
    });
    res.write('retry: 2000\n\n');
    res.write(`event: hello\ndata: ${JSON.stringify({ epoch })}\n\n`);

    const subscriber = {
      sendRow(row: BoardRow) {
        res.write(`id: ${row.id}\nevent: change\ndata: ${JSON.stringify(row)}\n\n`);
      },
      sendReset(newEpoch: string) {
        res.write(`event: reset\ndata: ${JSON.stringify({ epoch: newEpoch })}\n\n`);
      },
    };
    if (clientEpoch && clientEpoch !== epoch) {
      // The board was cleared since this client loaded; it must start over.
      subscriber.sendReset(epoch);
      res.end();
      return;
    }

    const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), heartbeatMs);
    heartbeat.unref();
    let unsubscribe: (() => void) | null = null;
    let closed = false;
    req.on('close', () => {
      closed = true;
      clearInterval(heartbeat);
      unsubscribe?.();
    });
    unsubscribe = await deps.hub.subscribe(subscriber, since);
    if (closed) unsubscribe();
  }

  async function serveStatic(res: ServerResponse, pathname: string): Promise<boolean> {
    if (!deps.webDir) return false;
    const root = path.resolve(deps.webDir);
    let relative = decodeURIComponent(pathname).replace(/^\/+/, '');
    if (relative === '') relative = 'index.html';
    let file = path.resolve(root, relative);
    if (file !== root && !file.startsWith(root + path.sep)) return false;
    let info = await stat(file).catch(() => null);
    if (!info?.isFile()) {
      // Client-side routes fall back to the app; missing assets stay 404.
      if (path.extname(relative)) return false;
      file = path.join(root, 'index.html');
      info = await stat(file).catch(() => null);
      if (!info?.isFile()) return false;
    }
    const ext = path.extname(file);
    const isHtml = ext === '.html';
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Cache-Control': isHtml ? 'no-cache' : relative.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'public, max-age=3600',
      ...(isHtml ? { 'Content-Security-Policy': PAGE_CSP } : {}),
      ...SECURITY_HEADERS,
    });
    res.end(await readFile(file));
    return true;
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://bugfarm.local');
    const { pathname } = url;
    const method = req.method ?? 'GET';

    if (method === 'GET' && pathname === '/healthz') {
      let db = false;
      let summary = null;
      try {
        db = await deps.store.ping();
        summary = await deps.store.summary();
      } catch (err) {
        logger.warn('[bugfarm] health check could not reach the database', err);
      }
      sendJson(res, db ? 200 : 503, {
        ok: db,
        db,
        board: summary,
        subscribers: deps.hub.size,
        ingest: deps.ingestToken ? 'on' : 'off',
        stablehand: deps.link(),
        simulator: deps.sim(),
      });
      return;
    }

    if (method === 'POST' && pathname === '/hooks/stablehand') {
      const rawBody = await readBody(req);
      const valid = verifyWebhookSignature({
        secret: deps.webhookSecret,
        rawBody,
        signatureHeader: req.headers['x-webhook-signature'] as string | undefined,
        timestampHeader: req.headers['x-webhook-timestamp'] as string | undefined,
      });
      if (!valid) {
        sendJson(res, 401, { error: 'invalid signature' });
        return;
      }
      const checked = checkDelivery({
        eventType: req.headers['x-event-type'] as string | undefined,
        agentId: req.headers['x-agent-id'] as string | undefined,
      }, rawBody);
      if (!checked.ok) {
        sendJson(res, checked.status, { error: checked.error });
        return;
      }
      const deliveryId = req.headers['x-delivery-id'] as string | undefined;
      if (deliveryId && !rememberDelivery(deliveryId)) {
        sendJson(res, 200, { ok: true, duplicate: true });
        return;
      }
      const { rows, ingest: nested } = deliveryToRows(checked.delivery, deps.campaignKey);
      let extra: UpsertInput[] = [];
      if (nested !== null) {
        const parsed = UpsertBodySchema.safeParse(nested);
        if (!parsed.success) {
          sendJson(res, 422, { error: `custom.bugfarm.rows payload: ${formatIssues(parsed.error)}` });
          return;
        }
        extra = parsed.data.rows;
      }
      const result = await ingest([...rows, ...extra]);
      sendJson(res, 200, { ok: true, cursor: result.cursor });
      return;
    }

    if (pathname.startsWith('/internal/')) {
      requireIngest(req);
      if (method === 'POST' && pathname === '/internal/v1/rows') {
        const parsed = UpsertBodySchema.safeParse(parseJson(await readBody(req)));
        if (!parsed.success) throw new HttpError(400, formatIssues(parsed.error));
        sendJson(res, 200, await ingest(parsed.data.rows));
        return;
      }
      const single = /^\/internal\/v1\/rows\/([a-z]+)\/(.+)$/.exec(pathname);
      if (method === 'PUT' && single) {
        const body = parseJson(await readBody(req));
        const mode = url.searchParams.get('mode') ?? undefined;
        const parsed = UpsertInputSchema.safeParse({ kind: single[1], key: decodeURIComponent(single[2]), payload: body, mode });
        if (!parsed.success) throw new HttpError(400, formatIssues(parsed.error));
        sendJson(res, 200, await ingest([parsed.data]));
        return;
      }
      if (method === 'POST' && pathname === '/internal/v1/reset') {
        const body = parseJson(await readBody(req)) as { confirm?: unknown; scope?: unknown };
        if (body?.confirm !== 'erase-board') {
          throw new HttpError(400, 'Send {"confirm":"erase-board"} to clear the board.');
        }
        const scope: ResetScope = body.scope === 'simulated' ? 'simulated' : 'all';
        const result = await deps.store.reset(scope);
        await deps.hub.reset(result.epoch);
        sendJson(res, 200, { ok: true, scope, ...result });
        return;
      }
      throw new HttpError(404, 'no such ingest route');
    }

    if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'method not allowed');
    if (!allowView(req, res, url)) return;

    if (pathname === '/api/state') {
      const current = await deps.store.current();
      sendJson(res, 200, current);
      return;
    }
    if (pathname === '/api/changes') {
      const since = nonNegativeInt(url.searchParams.get('since')) ?? 0;
      const limit = nonNegativeInt(url.searchParams.get('limit')) ?? 1000;
      const [page, epoch] = await Promise.all([deps.store.changes(since, limit), deps.store.epoch()]);
      sendJson(res, 200, { epoch, ...page });
      return;
    }
    if (pathname === '/api/stream') {
      await stream(req, res, url);
      return;
    }
    if (pathname.startsWith('/api/')) throw new HttpError(404, 'no such route');

    if (await serveStatic(res, pathname)) return;
    if (pathname === '/' || pathname === '/index.html') {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
      res.end('The board page is not built. Run `pnpm --filter @stablehand-ext/bugfarm build`, or set BUGFARM_WEB_DIR.');
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
    res.end('not found');
  }

  return createServer((req, res) => {
    route(req, res).catch((err: unknown) => {
      if (err instanceof HttpError) {
        if (!res.headersSent) sendJson(res, err.status, { error: err.message, ...err.extra });
        else res.end();
        return;
      }
      logger.error('[bugfarm] request failed:', err);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
      else res.end();
    });
  });
}
