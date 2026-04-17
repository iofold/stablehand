#!/usr/bin/env node
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';

const apiUrl = process.env.PLAYWRIGHT_API_BASE_URL ?? 'http://localhost:3002';
const uiUrl = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3200';
const outDir = process.env.CTXMILL_VERIFY_STABILIZATION_OUT ?? `.tmp/verify-stabilization-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const statusSet = new Set(['QUEUED', 'ACTIVE', 'PAUSED', 'CHECKPOINTED', 'RESTORING', 'TERMINATED', 'COMPLETED', 'ERROR', 'CANCELLED', 'IDLE']);
const evidence = [];
const createdAgents = [];

await mkdir(outDir, { recursive: true });

function assert(condition, message, details) {
  if (!condition) {
    throw new Error(`${message}${details === undefined ? '' : `\n${JSON.stringify(details, null, 2)}`}`);
  }
  evidence.push({ ok: true, message, details });
}

async function parseResponse(res) {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
}

async function api(path, init) {
  const res = await fetch(`${apiUrl}${path}`, init);
  return { res, body: await parseResponse(res) };
}

async function createAgent(prefix) {
  const result = await api('/api/agents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: `${prefix}-${Date.now()}`,
      harness: 'langgraph',
      harnessConfig: { provider: 'openai', model: 'gpt-5.4-mini' },
      systemPrompt: 'Deterministic stabilization verification agent. Keep responses short.',
      tools: [],
      description: 'Created by verify-stabilization.mjs',
    }),
  });
  assert(result.res.status === 201, `created ${prefix} agent`, result.body);
  createdAgents.push(result.body.id);
  return result.body;
}

try {
  const health = await api('/health');
  assert(health.res.ok && health.body.status === 'ok', 'API health responds', health.body);

  const schemaVersion = execFileSync('docker', [
    'compose', 'exec', '-T', 'postgres', 'psql', '-U', 'ctxmill', '-d', 'ctxmill', '-Atc',
    "select version || ':' || baseline from ctxmill_schema_version where id = 'baseline';",
  ], { cwd: process.cwd(), encoding: 'utf8' }).trim();
  assert(schemaVersion.length > 0, 'strict schema baseline is initialized', { schemaVersion });

  const artifactAgent = await createAgent('verify-artifact');
  const form = new FormData();
  form.append('file', new Blob(['stabilization artifact body'], { type: 'text/plain' }), 'stabilization-artifact.txt');
  form.append('agentId', artifactAgent.id);
  form.append('name', 'stabilization-artifact.txt');
  const uploadRes = await fetch(`${apiUrl}/api/artifacts/upload`, { method: 'POST', body: form });
  const uploaded = await parseResponse(uploadRes);
  assert(uploadRes.ok && uploaded.id, 'direct artifact upload works', uploaded);
  assert(uploaded.storageKey === `artifacts/${uploaded.id}/stabilization-artifact.txt`, 'artifact object key is globally scoped', uploaded);

  const deleted = await api(`/api/agents/${artifactAgent.id}`, { method: 'DELETE' });
  createdAgents.splice(createdAgents.indexOf(artifactAgent.id), 1);
  assert(deleted.res.status === 204, 'agent deletion succeeds', deleted.body);
  const artifact = await api(`/api/artifacts/${uploaded.id}`);
  assert(artifact.res.ok, 'artifact metadata survives agent deletion', artifact.body);
  assert(artifact.body.agentId == null || artifact.body.agentId === '', 'surviving artifact is global/unowned', artifact.body);

  const signedAgent = await createAgent('verify-signed-upload');
  const uploadUrl = await api('/api/artifacts/upload-url', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agentId: signedAgent.id, name: 'pending.txt', mimeType: 'text/plain', sizeBytes: 7 }),
  });
  assert(uploadUrl.res.ok && uploadUrl.body.artifactId, 'signed upload URL is issued', uploadUrl.body);
  assert(
    uploadUrl.body.storageKey === `artifacts/${uploadUrl.body.artifactId}/pending.txt`,
    'signed-upload object key is globally scoped',
    uploadUrl.body,
  );
  const pending = await api(`/api/artifacts/${uploadUrl.body.artifactId}`);
  assert(pending.body.status === 'pending_upload', 'signed upload starts as pending_upload', pending.body);
  const pendingDownload = await api(`/api/artifacts/${uploadUrl.body.artifactId}/download-url`);
  assert(pendingDownload.res.status === 409, 'pending signed upload is not downloadable before object exists', pendingDownload.body);

  const runAgent = await createAgent('verify-status');
  const start = await api(`/api/agents/${runAgent.id}/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ task: 'Say hello for stabilization verification.', mode: 'background' }),
  });
  assert(start.res.ok, 'background session start accepted', start.body);

  let rows = [];
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const sessions = await api(`/api/agents/${runAgent.id}/sessions`);
    rows = Array.isArray(sessions.body) ? sessions.body : sessions.body?.sessions ?? [];
    if (rows.length > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert(rows.length > 0, 'sessions endpoint returns at least one row', rows);
  assert(rows.every((row) => statusSet.has(row.status)), 'session rows use unified uppercase status taxonomy', rows.map((row) => row.status));
  assert(rows.every((row) => !('sandboxSessionStatus' in row)), 'session rows do not expose split sandboxSessionStatus', rows);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  try {
    const uiAgent = await createAgent('verify-ui');
    await page.goto(uiUrl, { waitUntil: 'domcontentloaded' });
    await page.getByText('Agent Dashboard').waitFor({ timeout: 15_000 });
    await page.screenshot({ path: `${outDir}/dashboard.png`, fullPage: true });

    await page.goto(`${uiUrl}/agents/${uiAgent.id}`, { waitUntil: 'domcontentloaded' });
    await page.getByText(uiAgent.name).first().waitFor({ timeout: 15_000 });
    await page.screenshot({ path: `${outDir}/agent-detail.png`, fullPage: true });

    await page.goto(`${uiUrl}/agents/${uiAgent.id}/sessions/new`, { waitUntil: 'domcontentloaded' });
    await page.getByPlaceholder('Message the agent...').waitFor({ timeout: 15_000 });
    await page.screenshot({ path: `${outDir}/session-new.png`, fullPage: true });
    evidence.push({ ok: true, message: 'UI screenshots captured', details: { outDir } });
  } finally {
    await browser.close();
  }
} finally {
  for (const id of createdAgents) {
    await fetch(`${apiUrl}/api/agents/${id}`, { method: 'DELETE' }).catch(() => undefined);
  }
}

await writeFile(`${outDir}/evidence.json`, JSON.stringify({ evidence }, null, 2));
console.log(`[verify:stabilization] success; evidence written to ${outDir}`);
