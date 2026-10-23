import { chmodSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { manifestToAgentCreateInput, parseManifestString, validateManifest } from '@stablehand/manifest';
import { starterRuleRows, RULE_KINDS } from '../playbook.js';
import type { BoardRow, CampaignPayload, ItemPayload } from '../shared/board.js';
import { MAX_WAIT_SECONDS } from '../tools.js';

/**
 * Operator CLI for Bugfarm.
 *
 *   bugfarm seed      create or update the floor agents, their tools and secrets, the budget policy
 *                     and the starter playbook
 *   bugfarm campaign  start a campaign on the worker and follow it
 *   bugfarm run       seed, then start a campaign and follow it: the one command
 *   bugfarm rule add  add a playbook rule by hand
 *   bugfarm status    print the current campaign
 *
 * Settings come from the environment (see README): STABLEHAND_BASE_URL and STABLEHAND_ADMIN_TOKEN
 * for seeding, BUGFARM_URL and BUGFARM_INGEST_TOKEN for the worker, BUGFARM_TOOLS_URL and
 * BUGFARM_TOOLS_TOKEN for the agents' tools. Secrets are read from the environment and never
 * printed.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));

function agentsDir(): string {
  const configured = process.env.BUGFARM_AGENTS_DIR;
  if (configured) return configured;
  for (const candidate of [path.resolve(HERE, '../../agents'), path.resolve(HERE, '../agents')]) {
    if (existsSync(path.join(candidate, 'scout.yaml'))) return candidate;
  }
  throw new Error('cannot find the agent manifests; set BUGFARM_AGENTS_DIR to extensions/bugfarm/agents');
}

function parseArgs(argv: string[]): { _: string[]; [key: string]: string | boolean | string[] } {
  const out: { _: string[]; [key: string]: string | boolean | string[] } = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq > 0) out[arg.slice(2, eq)] = arg.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) out[arg.slice(2)] = argv[++i];
      else out[arg.slice(2)] = true;
    } else out._.push(arg);
  }
  return out;
}

function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

async function http(base: string, token: string, method: string, pathname: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${base.replace(/\/+$/, '')}${pathname}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 500) };
  }
  return { status: res.status, json };
}

async function ok(base: string, token: string, method: string, pathname: string, body?: unknown): Promise<unknown> {
  const res = await http(base, token, method, pathname, body);
  if (res.status >= 300) throw new Error(`${method} ${pathname} returned ${res.status}: ${JSON.stringify(res.json).slice(0, 600)}`);
  return res.json;
}

// ---------------------------------------------------------------------------------------------
// HTTP tools per role. The orchestrator calls them; the worker answers.

type Role = 'scout' | 'env_builder' | 'writer';

function httpTools(role: Role, toolsUrl: string): Array<Record<string, unknown>> {
  const auth = { type: 'bearer', secretName: 'BUGFARM_TOOLS_TOKEN' };
  const url = (name: string) => `${toolsUrl.replace(/\/+$/, '')}/tools/v1/${name}`;
  if (role === 'scout') {
    return [{
      name: 'submit_candidates',
      description: 'Hand Bugfarm your ranked list of bug-fix pull requests, best first. Submitting again replaces the list.',
      endpoint: url('submit_candidates'),
      method: 'POST',
      timeoutMs: 60_000,
      authentication: auth,
      inputSchema: {
        type: 'object',
        required: ['candidates'],
        properties: {
          candidates: {
            type: 'array',
            description: 'Ranked candidates, best first.',
            items: {
              type: 'object',
              required: ['pr', 'sha', 'title'],
              properties: {
                pr: { type: 'integer', description: 'Pull request number.' },
                sha: { type: 'string', description: 'The unit\'s commit sha from `mine_prs.py units`.' },
                title: { type: 'string', description: 'Pull request title.' },
                url: { type: 'string', description: 'Pull request URL.' },
                merged_at: { type: 'string', description: 'When it merged (ISO-8601).' },
                issue: { description: 'Number of the issue it closes; omit when none.' },
                issue_title: { description: 'Title of that issue; omit when none.' },
                issue_body: { description: 'Body of that issue as `details` printed it; omit when none.' },
                pr_body: { description: 'Pull request description as `details` printed it.' },
                why: { type: 'string', description: 'One sentence: what breaks for a user.' },
              },
            },
          },
        },
      },
    }];
  }
  if (role === 'env_builder') {
    return [
      {
        name: 'start_job',
        description: 'Start a Bugfarm worker job. Use kind "build_env" with args {"repo": "<owner/name>", "dockerfile": "<the whole Dockerfile>"} to build the environment image and check that pytest collects. Answers with a job_id; poll it with job_status.',
        endpoint: url('start_job'),
        method: 'POST',
        timeoutMs: 60_000,
        authentication: auth,
        inputSchema: {
          type: 'object',
          required: ['kind', 'args'],
          properties: {
            kind: { type: 'string', description: 'build_env' },
            args: { type: 'object', description: '{"repo": "<owner/name>", "dockerfile": "<Dockerfile text>"}' },
          },
        },
      },
      {
        name: 'job_status',
        description: `Wait up to wait_seconds (at most ${MAX_WAIT_SECONDS}) for a job, then answer with its status, progress and, once done, its result. Call again while the status is queued or running.`,
        endpoint: url('job_status'),
        method: 'POST',
        timeoutMs: (MAX_WAIT_SECONDS + 30) * 1000,
        authentication: auth,
        inputSchema: {
          type: 'object',
          required: ['job_id'],
          properties: {
            job_id: { type: 'string', description: 'The id start_job returned.' },
            wait_seconds: { type: 'number', description: `Seconds to wait for the job to finish, up to ${MAX_WAIT_SECONDS}.` },
          },
        },
      },
    ];
  }
  return [{
    name: 'submit_instruction',
    description: 'Record the task instruction and check it for leaks of the fix. Answers clean: true, or the leaks to rewrite. The last submission counts.',
    endpoint: url('submit_instruction'),
    method: 'POST',
    timeoutMs: 60_000,
    authentication: auth,
    inputSchema: {
      type: 'object',
      required: ['instruction'],
      properties: { instruction: { type: 'string', description: 'The full instruction, in Markdown.' } },
    },
  }];
}

const ROLE_BY_FILE: Record<string, Role> = { 'scout.yaml': 'scout', 'env-builder.yaml': 'env_builder', 'writer.yaml': 'writer' };

async function seed(args: ReturnType<typeof parseArgs>): Promise<void> {
  const base = env('STABLEHAND_BASE_URL');
  const admin = env('STABLEHAND_ADMIN_TOKEN');
  const toolsUrl = env('BUGFARM_TOOLS_URL', 'http://bugfarm:8095');
  const toolsToken = env('BUGFARM_TOOLS_TOKEN');
  const api = (method: string, pathname: string, body?: unknown) => ok(base, admin, method, `/api${pathname}`, body);
  const dir = agentsDir();
  const existing = await api('GET', '/agents') as Array<{ id: string; name: string }>;

  for (const file of readdirSync(dir).filter((f) => f in ROLE_BY_FILE).sort()) {
    const role = ROLE_BY_FILE[file];
    const manifest = validateManifest(parseManifestString(readFileSync(path.join(dir, file), 'utf8')));
    // The manifest snapshot is left out: HTTP tools are not part of the manifest format.
    const input = Object.fromEntries(Object.entries(manifestToAgentCreateInput(manifest)).filter(([key]) => key !== 'manifest'));
    const body = { ...input, httpTools: httpTools(role, toolsUrl) };
    const found = existing.find((agent) => agent.name === manifest.metadata.name);
    const patch = Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'name'));
    const agent = found
      ? await api('PATCH', `/agents/${found.id}`, patch) as { id: string }
      : await api('POST', '/agents', body) as { id: string };
    await api('POST', `/agents/${agent.id}/secrets`, { key: 'BUGFARM_TOOLS_TOKEN', value: toolsToken, scope: 'tools' });
    if (role === 'scout') {
      if (process.env.GITHUB_TOKEN) await api('POST', `/agents/${agent.id}/secrets`, { key: 'GITHUB_TOKEN', value: process.env.GITHUB_TOKEN, scope: 'sandbox' });
      const helper = readFileSync(path.join(dir, 'scout', 'mine_prs.py'), 'utf8');
      await api('POST', `/agents/${agent.id}/files`, { path: 'bugfarm/mine_prs.py', content: helper });
    }
    console.log(`${found ? 'updated' : 'created'} ${manifest.metadata.name} (${manifest.spec.harness}, ${String(manifest.spec.harnessConfig.model)}) ${agent.id}`);
  }

  const tag = typeof args['budget-tag'] === 'string' ? args['budget-tag'] : process.env.BUGFARM_BUDGET_TAG;
  const cap = Number(args.cap ?? process.env.BUGFARM_CAP_USD ?? 0);
  if (tag && cap > 0) {
    const name = `bugfarm:${tag}`;
    const { policies } = await api('GET', '/budgets') as { policies: Array<{ id: string; name: string }> };
    const doc = {
      selector: { campaign: tag },
      window: 'rolling-30d',
      limits: { costUsd: cap },
      actions: [{ threshold: 0.5, action: 'warn' }, { threshold: 0.85, action: 'warn' }, { threshold: 1, action: 'block' }],
    };
    const policy = policies.find((p) => p.name === name);
    if (policy) await api('PATCH', `/budgets/${policy.id}`, { doc, enabled: true });
    else await api('POST', '/budgets', { name, enabled: true, doc });
    console.log(`budget policy ${name}: $${cap} over 30 days on turns tagged campaign=${tag} (warn at 50% and 85%, block at 100%)`);
  }

  const keyFile = typeof args['worker-key-file'] === 'string' ? args['worker-key-file'] : null;
  if (keyFile) {
    const created = await api('POST', '/keys', {
      name: `bugfarm-worker-${Date.now()}`,
      capabilities: ['agents:read', 'conversations:write', 'webhooks:manage'],
      note: 'Bugfarm worker: starts and reads floor-agent turns, registers webhooks',
    }) as { token: string; id: string };
    writeFileSync(keyFile, `STABLEHAND_API_KEY=${created.token}\n`, { mode: 0o600 });
    chmodSync(keyFile, 0o600);
    console.log(`minted scoped worker key ${created.id} (agents:read, conversations:write, webhooks:manage) into ${keyFile}`);
  }

  if (process.env.BUGFARM_URL && process.env.BUGFARM_INGEST_TOKEN) {
    const state = await workerState();
    const have = new Set(state.rows.filter((row) => row.kind === 'rule').map((row) => row.key));
    const missing = starterRuleRows().filter((row) => !have.has(row.key));
    if (missing.length > 0) await ok(env('BUGFARM_URL'), env('BUGFARM_INGEST_TOKEN'), 'POST', '/internal/v1/rows', { rows: missing });
    console.log(`playbook: ${missing.length} starter rule(s) added, ${have.size} already there`);
  }
}

// ---------------------------------------------------------------------------------------------
// The worker

async function workerState(): Promise<{ rows: BoardRow[]; cursor: number }> {
  const base = env('BUGFARM_URL');
  const headers: Record<string, string> = {};
  if (process.env.BUGFARM_VIEW_TOKEN) headers.Cookie = `bugfarm_view=${encodeURIComponent(process.env.BUGFARM_VIEW_TOKEN)}`;
  const res = await fetch(`${base.replace(/\/+$/, '')}/api/state`, { headers });
  if (!res.ok) throw new Error(`GET /api/state returned ${res.status}`);
  return await res.json() as { rows: BoardRow[]; cursor: number };
}

function launchBody(args: ReturnType<typeof parseArgs>): Record<string, unknown> {
  const num = (key: string) => (typeof args[key] === 'string' ? Number(args[key]) : undefined);
  const body: Record<string, unknown> = {
    repo: typeof args.repo === 'string' ? args.repo : 'fastapi/fastapi',
    batch_size: num('batch-size') ?? num('candidates'),
    batches: num('batches'),
    cap_usd: num('cap'),
    budget_tag: typeof args['budget-tag'] === 'string' ? args['budget-tag'] : process.env.BUGFARM_BUDGET_TAG,
    id: typeof args.id === 'string' ? args.id : undefined,
    since: typeof args.since === 'string' ? args.since : undefined,
    rebuild_env: args['rebuild-env'] === true ? true : undefined,
    writer_concurrency: num('writers'),
  };
  return Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined));
}

const STEP_LABEL: Record<string, string> = {
  mined: 'mined', env_ready: 'env ready', fail_pass: 'fails→passes', controls: 'controls ✓', calibrating: 'calibrating', accepted: 'accepted', rejected: 'rejected',
};

async function follow(id: string): Promise<CampaignPayload | null> {
  const seen = new Map<string, string>();
  let down = false;
  for (;;) {
    let state: Awaited<ReturnType<typeof workerState>>;
    try {
      state = await workerState();
    } catch (err) {
      // The worker restarting (or being killed for the resume demo) is not the end of the campaign.
      if (!down) console.log(`${new Date().toISOString().slice(11, 19)}  worker unreachable (${(err as Error).message}); waiting for it to come back`);
      down = true;
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      continue;
    }
    if (down) console.log(`${new Date().toISOString().slice(11, 19)}  worker is back`);
    down = false;
    const campaign = state.rows.find((row) => row.kind === 'campaign' && row.key === id)?.payload as (CampaignPayload & { last_error?: string }) | undefined;
    const items = state.rows.filter((row) => row.kind === 'item' && (row.payload as ItemPayload).campaign === id) as Array<BoardRow<'item'>>;
    for (const row of items) {
      const p = row.payload;
      const line = `${STEP_LABEL[p.stage] ?? p.stage}${p.reject_reason ? ` (${p.reject_reason})` : ''}${p.activity ? ` · ${p.activity}` : ''}`;
      if (seen.get(row.key) !== line) {
        seen.set(row.key, line);
        console.log(`${new Date().toISOString().slice(11, 19)}  ${row.key.split(':').pop()}  ${line}`);
      }
    }
    if (campaign && campaign.status !== 'running' && campaign.status !== 'recovering') {
      const count = (stage: string) => items.filter((row) => row.payload.stage === stage).length;
      console.log(`campaign ${id}: ${campaign.status}${campaign.last_error ? ` (${campaign.last_error})` : ''}; ${items.length} candidates, ${count('calibrating')} handed to calibration, ${count('rejected')} rejected, $${(campaign.spend_usd ?? 0).toFixed(2)} spent, recovered ${campaign.recovered_from_crash ?? 0}×`);
      return campaign;
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
}

async function startCampaign(args: ReturnType<typeof parseArgs>): Promise<string> {
  const created = await ok(env('BUGFARM_URL'), env('BUGFARM_INGEST_TOKEN'), 'POST', '/internal/v1/campaigns', launchBody(args)) as { id: string };
  console.log(`campaign ${created.id} started; the board updates live`);
  return created.id;
}

async function status(): Promise<void> {
  const state = await workerState();
  const campaigns = state.rows.filter((row) => row.kind === 'campaign').sort((a, b) => b.id - a.id);
  const latest = campaigns[0];
  if (!latest) {
    console.log('no campaign yet');
    return;
  }
  const c = latest.payload as CampaignPayload;
  const items = state.rows.filter((row) => row.kind === 'item' && (row.payload as ItemPayload).campaign === latest.key);
  const byStage = new Map<string, number>();
  for (const row of items) byStage.set((row.payload as ItemPayload).stage, (byStage.get((row.payload as ItemPayload).stage) ?? 0) + 1);
  console.log(JSON.stringify({ id: latest.key, status: c.status, batch: c.batch, spend_usd: c.spend_usd, cap_usd: c.cap_usd, recovered_from_crash: c.recovered_from_crash, stages: Object.fromEntries(byStage) }, null, 2));
}

async function addRule(args: ReturnType<typeof parseArgs>): Promise<void> {
  const kind = String(args.kind ?? '');
  if (!(RULE_KINDS as readonly string[]).includes(kind)) throw new Error(`--kind must be one of ${RULE_KINDS.join(', ')}`);
  const text = String(args.text ?? '').trim();
  if (!text) throw new Error('--text is required');
  const id = typeof args.id === 'string' ? args.id : `${kind}-${Date.now().toString(36)}`;
  const payload: Record<string, unknown> = { text, kind, batch_introduced: Number(args.batch ?? 0), status: 'trial', source: 'hand' };
  if (typeof args.repo === 'string') payload.repo = args.repo;
  await ok(env('BUGFARM_URL'), env('BUGFARM_INGEST_TOKEN'), 'POST', '/internal/v1/rows', { rows: [{ kind: 'rule', key: id, payload }] });
  console.log(`rule ${id} added`);
}

const USAGE = `usage: bugfarm <command> [options]

  seed [--budget-tag TAG --cap USD] [--worker-key-file PATH]
      Create or update the floor agents from agents/*.yaml with their HTTP tools and tools secret,
      upload the Scout's helper, set a budget policy on campaign=TAG, mint a scoped worker key
      into PATH (never printed), and add the starter playbook rules.
  campaign start --repo owner/name [--candidates 15] [--batches 1] [--cap 15] [--budget-tag TAG] [--id ID] [--follow]
  campaign follow ID
  run --repo owner/name [--candidates 15] [--cap 15] [--budget-tag TAG]
      seed, start a campaign and follow it until it stops.
  rule add --kind scout_filter|writer_rule|env_recipe --text "..." [--repo owner/name] [--id ID]
  status
`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const [cmd, sub] = args._;
  switch (cmd) {
    case 'seed':
      await seed(args);
      return;
    case 'campaign':
      if (sub === 'start') {
        const id = await startCampaign(args);
        if (args.follow) await follow(id);
        return;
      }
      if (sub === 'follow' && args._[2]) {
        await follow(args._[2]);
        return;
      }
      break;
    case 'run': {
      await seed(args);
      const id = await startCampaign(args);
      await follow(id);
      return;
    }
    case 'rule':
      if (sub === 'add') {
        await addRule(args);
        return;
      }
      break;
    case 'status':
      await status();
      return;
    default:
      break;
  }
  console.log(USAGE);
  process.exitCode = cmd ? 2 : 0;
}

main().catch((err: unknown) => {
  console.error(`bugfarm: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
