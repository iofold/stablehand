import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = join(EXT_DIR, '..', '..');
export const CONFIG = JSON.parse(readFileSync(join(EXT_DIR, 'runner', 'config.json'), 'utf8'));

function readEnvToken() {
  if (process.env.CTXMILL_API_TOKEN) return process.env.CTXMILL_API_TOKEN;
  const env = readFileSync(join(REPO_ROOT, '.env'), 'utf8');
  const m = env.match(/^CTXMILL_API_TOKEN=(.+)$/m);
  if (!m) throw new Error('CTXMILL_API_TOKEN not found');
  return m[1].trim();
}

const TOKEN = readEnvToken();

export async function api(method, path, body, opts = {}) {
  const res = await fetch(`${CONFIG.apiBase}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      ...(body !== undefined && !opts.raw ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.headers ?? {}),
    },
    body: body === undefined ? undefined : opts.raw ? body : JSON.stringify(body),
  });
  if (res.status === 204) return null;
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok && !opts.allowError) {
    throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  }
  return json;
}

export function loadSlice() {
  return JSON.parse(readFileSync(join(EXT_DIR, 'slice', 'slice.json'), 'utf8'));
}

export function loadRows() {
  const rows = JSON.parse(readFileSync(join(EXT_DIR, 'slice', 'all_rows.json'), 'utf8'));
  return new Map(rows.map((r) => [r.task_id, r]));
}

export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
