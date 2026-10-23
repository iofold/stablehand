#!/usr/bin/env -S node --experimental-strip-types

/**
 * Seed the folder review against a running Stablehand: the agent from agent/
 * with the folder and its tools in the workspace, two triggers that keep one
 * review in one conversation (start and follow-up questions), and a weekly
 * budget. Safe to re-run: it updates what exists.
 *
 * Environment:
 *   API_URL               Stablehand API (default http://localhost:3002)
 *   STABLEHAND_API_TOKEN  master API token (unless auth is disabled)
 *   REVIEW_CONFIG         config file (default ./review.config.json)
 *   RUN_NOW=1             start the review right after seeding
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createWorkspaceArchive, loadManifestProject } from '@stablehand/manifest/node';

export interface ReviewConfig {
  campaign: string;
  reviewId: string;
  request: string;
  events: { start: string; question: string };
  budget: { weeklyUsd: number; weeklyRuns: number };
}

const API_BASE = process.env.API_URL ?? 'http://localhost:3002';
const API_TOKEN = process.env.STABLEHAND_API_TOKEN;
const CONFIG_PATH = process.env.REVIEW_CONFIG
  ?? fileURLToPath(new URL('./review.config.json', import.meta.url));
const MANIFEST_PATH = fileURLToPath(new URL('./agent/agent.yaml', import.meta.url));
const RUN_NOW = process.env.RUN_NOW === '1' || process.argv.includes('--run-now');

/** Every event of one review carries its id, so they share a conversation. */
export const REVIEW_KEY = '{{payload.reviewId}}';

export const TASK_TEMPLATES = {
  start: 'Review the folder. Review id: {{payload.reviewId}}. Today is {{payload.today}}.\n\n{{payload.request}}',
  question: 'Question about review {{payload.reviewId}} (today is {{payload.today}}): {{payload.question}}',
} as const;

/** Today's date as the agent should read it, YYYY-MM-DD. */
export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function headers(json = true): Record<string, string> {
  return {
    ...(API_TOKEN ? { Authorization: `Bearer ${API_TOKEN}` } : {}),
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  };
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { ...headers(init.body !== undefined && !(init.body instanceof Blob)), ...(init.headers ?? {}) },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${init.method ?? 'GET'} ${path} -> HTTP ${res.status}: ${text.slice(0, 400)}`);
  }
  return (text ? JSON.parse(text) : null) as T;
}

function post<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: 'POST', body: JSON.stringify(body) });
}

function patch<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
}

async function upsertAgent(): Promise<string> {
  const project = await loadManifestProject(MANIFEST_PATH);
  const payload = project.agentCreateInput;
  const listed = await request<Array<{ id: string; name: string }>>('/api/agents');
  const existingId = listed.find((agent) => agent.name === payload.name)?.id;
  const saved = existingId
    ? await patch<{ id: string }>(`/api/agents/${existingId}`, payload)
    : await post<{ id: string }>('/api/agents', payload);
  console.log(`  ${existingId ? 'updated' : 'created'} ${payload.name}`);
  const archive = await createWorkspaceArchive(project.workspace);
  await request(`/api/agents/${saved.id}/workspace`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/gzip', 'Content-Encoding': 'gzip' },
    body: new Blob([new Uint8Array(archive)]),
  });
  const documents = project.workspace.files.filter((file) => file.destinationPath.startsWith('folder/')).length;
  console.log(`    workspace: ${documents} documents in folder/, plus the reader and the citation checker in tools/`);
  return saved.id;
}

async function ensureTrigger(agentId: string, eventType: string, taskTemplate: string): Promise<void> {
  const triggers = await request<Array<{ id: string; agentId: string; eventType: string }>>('/api/triggers');
  const existing = triggers.find((trigger) => trigger.agentId === agentId && trigger.eventType === eventType);
  const body = { taskTemplate, conversationKey: REVIEW_KEY, enabled: true };
  const saved = existing
    ? await request<{ conversationKey?: string }>(`/api/triggers/${existing.id}`, { method: 'PUT', body: JSON.stringify(body) })
    : await post<{ conversationKey?: string }>('/api/triggers', { agentId, eventType, ...body });
  if (saved.conversationKey !== REVIEW_KEY) {
    throw new Error('this Stablehand ignored the trigger\'s conversationKey, so follow-up questions would start new conversations. '
      + 'Update Stablehand to a version with trigger conversation keys.');
  }
  console.log(`  ${eventType} -> folder-review, one conversation per ${REVIEW_KEY}`);
}

async function ensureBudget(config: ReviewConfig): Promise<void> {
  const name = `${config.campaign} weekly budget`;
  const doc = {
    selector: { campaign: config.campaign },
    window: 'rolling-7d',
    limits: { costUsd: config.budget.weeklyUsd, turns: config.budget.weeklyRuns },
    actions: [
      { threshold: 0.5, action: 'warn' },
      { threshold: 1, action: 'block' },
    ],
  };
  const { policies } = await request<{ policies: Array<{ id: string; name: string }> }>('/api/budgets');
  const existing = policies.find((policy) => policy.name === name);
  if (existing) {
    await patch(`/api/budgets/${existing.id}`, { doc, enabled: true });
  } else {
    await post('/api/budgets', { name, enabled: true, doc });
  }
  console.log(`  ${name}: $${config.budget.weeklyUsd} and ${config.budget.weeklyRuns} runs per rolling 7 days, warn at 50%, block at 100%`);
}

async function seed(): Promise<void> {
  const config = JSON.parse(await readFile(CONFIG_PATH, 'utf8')) as ReviewConfig;
  console.log(`\nSeeding the folder review against ${API_BASE}\n`);

  console.log('Agent');
  const agentId = await upsertAgent();

  console.log('\nTriggers');
  await ensureTrigger(agentId, config.events.start, TASK_TEMPLATES.start);
  await ensureTrigger(agentId, config.events.question, TASK_TEMPLATES.question);

  console.log('\nBudget');
  await ensureBudget(config);

  if (RUN_NOW) {
    await post('/api/triggers/emit', {
      type: config.events.start,
      payload: { reviewId: config.reviewId, request: config.request, today: today() },
    });
    console.log(`\nStarted review ${config.reviewId}.`);
  }
  console.log('\nSeed complete. Start a review with review.ts start, then ask follow-up questions with review.ts ask.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  seed().catch((error: unknown) => {
    console.error('Seed failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
