#!/usr/bin/env npx tsx

/**
 * Seed the Overnight Analyst flagship example against a running CTXMill:
 * one agent (from the manifest), one schedule, one trigger. Manifests cannot
 * carry schedules or triggers by design, so this script wires the two-object
 * pair the docs describe: the schedule emits a custom event on a cron, the
 * trigger turns that event into a background briefing turn.
 *
 * Idempotent: re-running updates nothing that already exists by name.
 *
 * Environment:
 *   API_URL            CTXMill base URL       (default http://localhost:3002)
 *   CTXMILL_API_TOKEN  API token              (required unless auth disabled)
 *   ANALYST_SOURCES    sources sentence       (default HN + The Verge)
 *   ANALYST_CRON       cron expression        (default "0 7 * * *")
 *   ANALYST_TZ         IANA timezone          (default "Asia/Kolkata")
 */

import { fileURLToPath } from 'node:url';

import { loadManifestProject } from '@ctxmill/manifest/node';

const API_BASE = process.env.API_URL ?? 'http://localhost:3002';
const API_TOKEN = process.env.CTXMILL_API_TOKEN;
const SOURCES = process.env.ANALYST_SOURCES
  ?? 'https://news.ycombinator.com and https://www.theverge.com';
const CRON = process.env.ANALYST_CRON ?? '0 7 * * *';
const TIMEZONE = process.env.ANALYST_TZ ?? 'Asia/Kolkata';
const EVENT_TYPE = 'custom.overnight.brief';
const SCHEDULE_NAME = 'overnight-analyst-daily';

function jsonHeaders(): Record<string, string> {
  return {
    ...(API_TOKEN ? { Authorization: `Bearer ${API_TOKEN}` } : {}),
    'Content-Type': 'application/json',
  };
}

async function request(path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { ...jsonHeaders(), ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  const body = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    throw new Error(`${init?.method ?? 'GET'} ${path} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return body;
}

async function ensureAgent(): Promise<string> {
  const agents = await request('/api/agents') as Array<{ id: string; name: string }>;
  const existing = agents.find((agent) => agent.name === 'overnight-analyst');
  if (existing) {
    console.log(`agent overnight-analyst already exists (${existing.id})`);
    return existing.id;
  }
  const manifestUrl = new URL('./agents/overnight-analyst/agent.yaml', import.meta.url);
  const project = await loadManifestProject(fileURLToPath(manifestUrl));
  const created = await request('/api/agents', {
    method: 'POST',
    body: JSON.stringify(project.agentCreateInput),
  }) as { id: string };
  console.log(`created agent overnight-analyst (${created.id})`);
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
  console.log('created trigger for custom.overnight.brief');
}

const agentId = await ensureAgent();
await ensureSchedule(agentId);
await ensureTrigger(agentId);
console.log('\nOvernight Analyst is scheduled. Briefings will appear as artifacts');
console.log('(and in the artifact-gallery extension, if you run it) after each fire.');
