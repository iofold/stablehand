#!/usr/bin/env npx tsx

/**
 * Seed the Overnight Analyst flagship example against a running Stablehand:
 * one agent (from the manifest), one schedule, one trigger, and a scoped key
 * for the artifact gallery. Manifests cannot carry schedules or triggers by
 * design, so this script wires the two-object pair the docs describe: the
 * schedule emits a custom event on a cron, the trigger turns that event into
 * a background briefing turn.
 *
 * Idempotent: anything that already exists by name is left alone.
 *
 * Environment:
 *   API_URL               Stablehand base URL     (default http://localhost:3002)
 *   STABLEHAND_API_TOKEN  master API token        (required unless auth disabled)
 *   ANALYST_SOURCES       sources sentence        (default HN + The Verge)
 *   ANALYST_CRON          cron expression         (default "0 7 * * *")
 *   ANALYST_TZ            IANA timezone           (default "Asia/Kolkata")
 *   ANALYST_GALLERY       auto | rotate | off     (default auto)
 *   GALLERY_API_KEY       the gallery's current key, to check it still works
 *
 * Gallery key: the gallery reads artifacts with its own scoped key
 * (artifacts:read + webhooks:manage, bound to this agent), never the master
 * token. When a new key is minted the seed prints one line,
 * `GALLERY_API_KEY=cmk_...`, for .env. A key's secret is shown only once, so
 * with ANALYST_GALLERY=auto an existing key is kept unless GALLERY_API_KEY is
 * passed and refused; `rotate` replaces it.
 */

import { fileURLToPath } from 'node:url';

import { loadManifestProject } from '@stablehand/manifest/node';

const API_BASE = (process.env.API_URL ?? 'http://localhost:3002').replace(/\/+$/, '');
const API_TOKEN = process.env.STABLEHAND_API_TOKEN;
const SOURCES = process.env.ANALYST_SOURCES
  ?? 'https://news.ycombinator.com and https://www.theverge.com';
const CRON = process.env.ANALYST_CRON ?? '0 7 * * *';
const TIMEZONE = process.env.ANALYST_TZ ?? 'Asia/Kolkata';
const GALLERY_MODE = (process.env.ANALYST_GALLERY ?? 'auto').trim().toLowerCase();
const CURRENT_GALLERY_KEY = process.env.GALLERY_API_KEY?.trim() ?? '';
const AGENT_NAME = 'overnight-analyst';
const EVENT_TYPE = 'custom.overnight.brief';
const SCHEDULE_NAME = 'overnight-analyst-daily';
const GALLERY_KEY_NAME = 'artifact-gallery';
const GALLERY_CAPABILITIES = ['artifacts:read', 'webhooks:manage'];

function jsonHeaders(token: string | undefined = API_TOKEN): Record<string, string> {
  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    'Content-Type': 'application/json',
  };
}

async function request(path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { ...jsonHeaders(), ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${init?.method ?? 'GET'} ${path} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return text ? (JSON.parse(text) as unknown) : null;
}

async function ensureAgent(): Promise<string> {
  const agents = await request('/api/agents') as Array<{ id: string; name: string }>;
  const existing = agents.find((agent) => agent.name === AGENT_NAME);
  if (existing) {
    console.log(`agent ${AGENT_NAME} already exists (${existing.id})`);
    return existing.id;
  }
  const manifestUrl = new URL('./agents/overnight-analyst/agent.yaml', import.meta.url);
  const project = await loadManifestProject(fileURLToPath(manifestUrl));
  const created = await request('/api/agents', {
    method: 'POST',
    body: JSON.stringify(project.agentCreateInput),
  }) as { id: string };
  console.log(`created agent ${AGENT_NAME} (${created.id})`);
  return created.id;
}

async function ensureSchedule(agentId: string): Promise<void> {
  const listed = await request('/api/schedules') as { schedules: Array<{ name: string }> };
  if (listed.schedules.some((schedule) => schedule.name === SCHEDULE_NAME)) {
    console.log(`schedule ${SCHEDULE_NAME} already exists`);
    return;
  }
  await request('/api/schedules', {
    method: 'POST',
    body: JSON.stringify({
      agentId,
      name: SCHEDULE_NAME,
      cronExpression: CRON,
      timezone: TIMEZONE,
      eventType: EVENT_TYPE,
      payload: { sources: SOURCES },
      enabled: true,
    }),
  });
  console.log(`created schedule ${SCHEDULE_NAME} (${CRON} ${TIMEZONE})`);
}

async function ensureTrigger(agentId: string): Promise<void> {
  const listed = await request('/api/triggers') as Array<{ agentId?: string; eventType?: string }>;
  const triggers = Array.isArray(listed) ? listed : [];
  if (triggers.some((trigger) => trigger.agentId === agentId && trigger.eventType === EVENT_TYPE)) {
    console.log('trigger already exists');
    return;
  }
  await request('/api/triggers', {
    method: 'POST',
    body: JSON.stringify({
      agentId,
      eventType: EVENT_TYPE,
      taskTemplate: 'Overnight briefing run. Sources: {{payload.sources}}. Follow your '
        + 'standing procedure: browse and screenshot each source, upload the screenshots, '
        + 'then write and upload the interactive HTML brief, and end with your 5-bullet summary.',
      enabled: true,
    }),
  });
  console.log(`created trigger for ${EVENT_TYPE}`);
}

interface ApiKeyRow {
  id: string;
  name: string;
  status: 'active' | 'expired' | 'revoked';
}

function isGalleryKey(key: ApiKeyRow): boolean {
  return key.name === GALLERY_KEY_NAME || key.name.startsWith(`${GALLERY_KEY_NAME}-`);
}

async function currentGalleryKeyWorks(): Promise<boolean> {
  const res = await fetch(`${API_BASE}/api/artifacts?limit=1`, { headers: jsonHeaders(CURRENT_GALLERY_KEY) });
  await res.text();
  if (res.ok) return true;
  console.log(`the gallery key in GALLERY_API_KEY was refused (HTTP ${res.status}); minting a new one`);
  return false;
}

async function ensureGalleryKey(agentId: string): Promise<void> {
  if (GALLERY_MODE === 'off') return;
  if (GALLERY_MODE !== 'auto' && GALLERY_MODE !== 'rotate') {
    throw new Error(`ANALYST_GALLERY must be auto, rotate or off (got ${GALLERY_MODE})`);
  }
  if (GALLERY_MODE === 'auto' && CURRENT_GALLERY_KEY && await currentGalleryKeyWorks()) {
    console.log('gallery key works');
    return;
  }

  const { keys } = await request('/api/keys') as { keys: ApiKeyRow[] };
  const galleryKeys = keys.filter(isGalleryKey);
  const active = galleryKeys.filter((key) => key.status === 'active');
  if (GALLERY_MODE === 'auto' && !CURRENT_GALLERY_KEY && active.length > 0) {
    console.log(`scoped key ${active[0].name} already exists; its secret was shown once when it was created.`);
    console.log('Pass it as GALLERY_API_KEY to check it, or set ANALYST_GALLERY=rotate to replace it.');
    return;
  }

  // Key names are unique for good, revoked ones included.
  const taken = new Set(galleryKeys.map((key) => key.name));
  const name = taken.has(GALLERY_KEY_NAME) ? `${GALLERY_KEY_NAME}-${Date.now()}` : GALLERY_KEY_NAME;
  const created = await request('/api/keys', {
    method: 'POST',
    body: JSON.stringify({
      name,
      capabilities: GALLERY_CAPABILITIES,
      agentId,
      note: 'artifact-gallery for the Overnight Analyst (created by its seed)',
      expiresAt: null,
    }),
  }) as { id: string; token: string };
  for (const old of active) {
    await request(`/api/keys/${encodeURIComponent(old.id)}`, { method: 'DELETE' });
    console.log(`revoked previous gallery key ${old.name}`);
  }
  console.log(`created scoped key ${name} (${GALLERY_CAPABILITIES.join(' + ')}, this agent only)`);
  console.log('Put this line in .env, then run `docker compose up -d gallery`:');
  console.log(`GALLERY_API_KEY=${created.token}`);
}

const agentId = await ensureAgent();
await ensureSchedule(agentId);
await ensureTrigger(agentId);
await ensureGalleryKey(agentId);
console.log('\nOvernight Analyst is scheduled. Briefings appear under Artifacts and in the');
console.log('artifact gallery after each run. To run one now: run-once.ts in this directory.');
