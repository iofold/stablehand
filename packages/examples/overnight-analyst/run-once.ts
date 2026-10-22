#!/usr/bin/env npx tsx

/**
 * Fire one Overnight Analyst run now and wait for its receipt: emits the
 * event the schedule would, follows the turn the trigger starts, finds the
 * brief it uploads, waits for the gateway to price the run, and (with
 * GALLERY_URL) waits until the gallery serves the brief.
 *
 * Exit code 0 means the run completed and uploaded overnight-brief.html.
 * The last line is machine-readable for install.sh:
 *   RESULT status=COMPLETED turn=<id> brief=<artifactId> cost_usd=<n|unknown> coverage=<c>
 *
 * Environment:
 *   API_URL               Stablehand base URL   (default http://localhost:3002)
 *   STABLEHAND_API_TOKEN  master API token      (required unless auth disabled)
 *   ANALYST_SOURCES       sources sentence      (default https://news.ycombinator.com)
 *   RUN_TIMEOUT_MS        give up after         (default 900000, 15 minutes)
 *   COST_WAIT_MS          wait for pricing      (default 180000)
 *   GALLERY_URL           gallery base URL      (optional, e.g. http://gallery:8090)
 *   POLL_MS               poll interval         (default 3000)
 */

export {};

const API_BASE = (process.env.API_URL ?? 'http://localhost:3002').replace(/\/+$/, '');
const API_TOKEN = process.env.STABLEHAND_API_TOKEN;
const SOURCES = process.env.ANALYST_SOURCES ?? 'https://news.ycombinator.com';
const RUN_TIMEOUT_MS = Number(process.env.RUN_TIMEOUT_MS ?? 900_000);
const COST_WAIT_MS = Number(process.env.COST_WAIT_MS ?? 180_000);
const GALLERY_URL = process.env.GALLERY_URL?.replace(/\/+$/, '') ?? '';
const POLL_MS = Number(process.env.POLL_MS ?? 3_000);
const AGENT_NAME = 'overnight-analyst';
const EVENT_TYPE = 'custom.overnight.brief';
const BRIEF_NAME = 'overnight-brief.html';
const TERMINAL = new Set(['COMPLETED', 'ERROR', 'CANCELLED']);

interface Turn {
  id: string;
  status: string;
  queuedAt: number;
  startedAt: number;
  completedAt: number | null;
  error: string | null;
  stopReason?: { code: string; capUsd?: number; spentUsd?: number | null };
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    modelCalls: { observed: number };
    cost: { totalUsd: number | null; knownUsd: number; coverage: string };
  } | null;
  gatewayMode?: 'gateway_only' | 'mixed' | null;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      ...(API_TOKEN ? { Authorization: `Bearer ${API_TOKEN}` } : {}),
      'Content-Type': 'application/json',
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${init?.method ?? 'GET'} ${path} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return (text ? JSON.parse(text) : null) as T;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function formatUsd(value: number): string {
  return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

function elapsed(since: number): string {
  const seconds = Math.round((Date.now() - since) / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

async function findTurn(agentId: string, since: number): Promise<Turn | undefined> {
  const { turns } = await api<{ turns: Turn[] }>(`/api/agents/${agentId}/turns`);
  return turns
    .filter((turn) => turn.queuedAt >= since)
    .sort((a, b) => a.queuedAt - b.queuedAt)[0];
}

async function getTurn(agentId: string, turnId: string): Promise<Turn> {
  const { turn } = await api<{ turn: Turn }>(`/api/agents/${agentId}/turns/${turnId}`);
  return turn;
}

async function waitFor<T>(label: string, timeoutMs: number, probe: () => Promise<T | undefined>): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) {
      console.log(`${label}: gave up after ${Math.round(timeoutMs / 1000)}s`);
      return undefined;
    }
    await sleep(POLL_MS);
  }
}

async function main(): Promise<number> {
  const agents = await api<Array<{ id: string; name: string; harnessConfig?: { model?: string } }>>('/api/agents');
  const agent = agents.find((candidate) => candidate.name === AGENT_NAME);
  if (!agent) {
    console.log(`no agent named ${AGENT_NAME}; run seed.ts first`);
    return 1;
  }

  const firedAt = Date.now();
  // Turns are stamped by the orchestrator's clock; allow for a little skew.
  const since = firedAt - 5_000;
  await api('/api/triggers/emit', {
    method: 'POST',
    body: JSON.stringify({ type: EVENT_TYPE, payload: { sources: SOURCES } }),
  });
  console.log(`fired ${EVENT_TYPE} for ${SOURCES}`);

  const queued = await waitFor('waiting for the trigger to queue a run', 120_000, () => findTurn(agent.id, since));
  if (!queued) return 1;
  console.log(`run ${queued.id} queued`);

  let lastStatus = queued.status;
  const finished = await waitFor('waiting for the run', RUN_TIMEOUT_MS, async () => {
    const turn = await getTurn(agent.id, queued.id);
    if (turn.status !== lastStatus) {
      console.log(`run ${turn.status.toLowerCase()} (${elapsed(firedAt)})`);
      lastStatus = turn.status;
    }
    return TERMINAL.has(turn.status) ? turn : undefined;
  });
  if (!finished) return 1;

  const { artifacts } = await api<{ artifacts: Array<{ id: string; name: string }> }>(
    `/api/artifacts?turnId=${encodeURIComponent(finished.id)}`,
  );
  const brief = artifacts.find((artifact) => artifact.name === BRIEF_NAME);
  console.log(`files: ${artifacts.map((artifact) => artifact.name).join(', ') || 'none'}`);

  // The gateway prices a run from its spend logs a little after it ends.
  const priced = finished.gatewayMode
    ? await waitFor('waiting for the gateway to price the run', COST_WAIT_MS, async () => {
      const turn = await getTurn(agent.id, finished.id);
      return turn.usage && turn.usage.cost.coverage !== 'pending' ? turn : undefined;
    }) ?? finished
    : finished;

  const usage = priced.usage;
  const cost = usage?.cost;
  const costText = cost?.totalUsd != null
    ? formatUsd(cost.totalUsd)
    : cost && cost.knownUsd > 0 ? `at least ${formatUsd(cost.knownUsd)} (${cost.coverage})` : 'not reported';
  console.log('');
  console.log('Receipt');
  console.log(`  status   ${priced.status}${priced.stopReason ? ` (${priced.stopReason.code})` : ''}`);
  console.log(`  model    ${agent.harnessConfig?.model ?? 'unknown'}${priced.gatewayMode ? ' via the model gateway' : ''}`);
  if (usage) {
    console.log(`  tokens   ${usage.inputTokens} in, ${usage.outputTokens} out, ${usage.modelCalls.observed} model calls`);
  }
  console.log(`  cost     ${costText}`);
  console.log(`  time     ${priced.completedAt ? Math.round((priced.completedAt - priced.startedAt) / 1000) : '?'}s running, ${elapsed(firedAt)} since the event`);
  console.log(`  brief    ${brief ? brief.id : 'missing'}`);
  if (priced.error) console.log(`  error    ${priced.error.slice(0, 300)}`);

  if (brief && GALLERY_URL) {
    const shown = await waitFor('waiting for the gallery to show the brief', 150_000, async () => {
      const res = await fetch(`${GALLERY_URL}/a/${encodeURIComponent(brief.id)}`).catch(() => undefined);
      if (res) await res.arrayBuffer();
      return res?.ok ? true : undefined;
    });
    console.log(`  gallery  ${shown ? 'showing the brief' : 'not yet showing the brief'}`);
  }

  const costValue = cost?.totalUsd ?? (cost && cost.knownUsd > 0 ? cost.knownUsd : null);
  console.log(
    `RESULT status=${priced.status} turn=${priced.id} brief=${brief?.id ?? 'missing'} `
    + `cost_usd=${costValue ?? 'unknown'} coverage=${cost?.coverage ?? 'none'}`,
  );
  return priced.status === 'COMPLETED' && brief ? 0 : 1;
}

process.exitCode = await main();
