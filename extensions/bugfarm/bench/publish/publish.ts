// `bench/cli.ts publish`: build the dataset folder, ask a person through Stablehand, then push it
// to the Hugging Face Hub (or, by default, show exactly what would be pushed).
//
// Safe by default:
// - nothing is uploaded without `--push`; `--dry-run` (the default) stops after the approval;
// - the target repo is a setting (`--hf-repo` or BUGFARM_HF_REPO), with no default org;
// - the repo is private unless `--visibility public` or BUGFARM_HF_VISIBILITY=public says otherwise;
// - an approval is bound to the dataset's sha: change a file and it has to be approved again.
//
// Re-running is safe: the approval request is idempotent per dataset sha, and a decision already
// made is read back instead of asked again.
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SpendLog } from '../../pipeline/calibrate-gateway.ts';
import { log, parseArgs, readJson, writeJson } from '../../pipeline/lib/util.ts';
import { boardFor } from '../lib/board.ts';
import { loadSettings } from '../lib/config.ts';
import { api, reconcile, pricingContext, searchTurns, turnCost } from '../lib/spend.ts';
import type { Api, Reconciliation } from '../lib/spend.ts';
import { AttemptStore, benchDir, loadDefinition } from '../lib/store.ts';
import type { BenchDefinition } from '../lib/store.ts';
import { approvalFrom, ensurePublisher, startApprovalTurn, waitForDecision, waitForRequest } from './approval.ts';
import type { Approval, ApprovalRequest } from './approval.ts';
import { renderCard } from './card.ts';
import { APPROVAL, CARD, buildDataset } from './dataset.ts';
import type { AuthoringSpend, DatasetModel, SelectionSpend } from './dataset.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const HF_PUSH = join(HERE, 'hf_push.py');
const HF_HUB_REQ = process.env.BUGFARM_HF_HUB_REQ ?? 'huggingface_hub>=0.34,<2';

type Args = ReturnType<typeof parseArgs>;

interface PublishState {
  dataset_sha: string;
  publisher_agent_id?: string;
  turn_id?: string;
  interrupt_id?: string;
  approval?: Approval;
  pushed?: { at: number; repo: string; result: unknown };
}

function str(args: Args, k: string): string | undefined {
  return typeof args[k] === 'string' ? (args[k] as string) : undefined;
}

async function selectionSpend(a: Api | undefined, def: BenchDefinition, campaign: string | undefined, gatewayUrl: string, meteringKey: string | undefined): Promise<SelectionSpend | null> {
  const tasksUsd = def.tasks.reduce((s, t) => s + (t.calibration?.cost_usd ?? 0), 0);
  if (!def.tasks.some((t) => t.calibration) && !campaign) return null;
  const out: SelectionSpend = { campaign, tasks_usd: Math.round(tasksUsd * 1e6) / 1e6, campaign_total_usd: null, campaign_calls: null, gateway_usd: null, keys: [] };
  if (!campaign || !a) return out;
  const keys = (await api<{ campaignKeys: Array<{ id: string; keyAlias: string; tags: Record<string, string>; createdAt: number; spend: { costUsd: number; calls: number } }> }>(a, 'GET', '/api/model-gateway/campaign-keys')).campaignKeys.filter((k) => k.tags?.campaign === campaign);
  out.keys = keys.map((k) => k.id);
  out.campaign_total_usd = Math.round(keys.reduce((s, k) => s + k.spend.costUsd, 0) * 1e6) / 1e6;
  out.campaign_calls = keys.reduce((s, k) => s + k.spend.calls, 0);
  if (meteringKey) {
    let usd = 0;
    for (const k of keys) usd += (await new SpendLog({ gatewayUrl, meteringKey, keyAlias: k.keyAlias, sinceMs: k.createdAt }).snapshot(0)).total_usd;
    out.gateway_usd = Math.round(usd * 1e6) / 1e6;
  }
  return out;
}

async function authoringSpend(a: Api | undefined, def: BenchDefinition, campaign: string | undefined): Promise<AuthoringSpend> {
  if (!campaign || !a) {
    const writer = def.tasks.some((t) => t.instruction_status === 'writer');
    return { campaign, total_usd: writer ? null : 0, by_item: {}, note: writer ? 'floor-agent spend not looked up (pass --factory-campaign)' : 'these tasks came from the deterministic pipeline: no model calls before calibration' };
  }
  const turns = (await searchTurns(a, { campaign })).filter((t) => !t.tags?.bench_cell && t.tags?.stage !== 'publish');
  const byItem: Record<string, number> = {};
  let total = 0;
  for (const t of turns) {
    const usd = turnCost(t).usd ?? 0;
    total += usd;
    const item = t.tags?.item;
    if (item && def.tasks.some((x) => x.item === item)) byItem[item] = Math.round(((byItem[item] ?? 0) + usd) * 1e6) / 1e6;
  }
  return { campaign, total_usd: Math.round(total * 1e6) / 1e6, by_item: byItem, note: `${turns.length} floor-agent turns (Scout, Env builder, Writer) tagged \`${campaign}\`; per task where the turn was about that task` };
}

function summaryReason(m: DatasetModel, req: Omit<ApprovalRequest, 'reason'>): string {
  const repo = m.def.repo;
  const kind = m.def.task_set.kind === 'dev_standin' ? ' (dev stand-in)' : '';
  const where = req.dry_run ? `dry run of ${req.target}` : `${req.target} (${req.visibility})`;
  return `Publish ${m.tasks.length} Bugfarm ${repo} tasks${kind} to the Hugging Face Hub: ${where}. Spend so far $${req.total_spend_usd.toFixed(2)}.${req.board_url ? ` Board: ${req.board_url}` : ''}`;
}

function readState(out: string): PublishState | undefined {
  const p = join(out, '.publish', 'state.json');
  return existsSync(p) ? readJson<PublishState>(p) : undefined;
}

function writeState(out: string, s: PublishState): void {
  writeJson(join(out, '.publish', 'state.json'), s);
}

function hfPush(folder: string, repo: string, visibility: string, sha: string, dryRun: boolean): Record<string, unknown> {
  const uv = process.env.BUGFARM_UV ?? (existsSync(join(process.env.HOME ?? '', '.local', 'bin', 'uv')) ? join(process.env.HOME ?? '', '.local', 'bin', 'uv') : 'uv');
  const args = dryRun
    ? ['run', '--no-project', 'python', HF_PUSH]
    : ['run', '--no-project', '--with', HF_HUB_REQ, 'python', HF_PUSH];
  args.push('--folder', folder, '--repo', repo, '--visibility', visibility, '--dataset-sha', sha, '--commit-message', `Publish Bugfarm dataset ${sha.slice(0, 12)}`);
  if (dryRun) args.push('--dry-run');
  const r = spawnSync(uv, args, { encoding: 'utf8', env: { ...process.env }, maxBuffer: 16 * 1024 * 1024 });
  const line = (r.stdout ?? '').trim().split('\n').filter(Boolean).pop() ?? '';
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return { ok: false, error: `hf_push exited ${r.status}: ${(r.stderr ?? '').slice(-600)}` };
  }
}

export async function publish(argsIn: unknown): Promise<void> {
  const args = argsIn as Args;
  const id = str(args, 'bench');
  if (!id) throw new Error('publish needs --bench <id>');
  const def = loadDefinition(id);
  const s = loadSettings();
  const a: Api | undefined = s.stablehandToken ? { url: s.stablehandUrl, token: s.stablehandToken } : undefined;
  if (!a) throw new Error('publish needs STABLEHAND_API_TOKEN: approvals go through Stablehand');
  const out = resolve(str(args, 'out') ?? join(benchDir(def.id), 'dataset'));
  const push = Boolean(args.push);
  if (push && args['dry-run']) throw new Error('pass --push or --dry-run, not both');
  const dryRun = !push;
  const target = str(args, 'hf-repo') ?? process.env.BUGFARM_HF_REPO ?? null;
  const visibilityRaw = str(args, 'visibility') ?? process.env.BUGFARM_HF_VISIBILITY ?? 'private';
  if (visibilityRaw !== 'private' && visibilityRaw !== 'public') throw new Error('--visibility must be private or public');
  const visibility = visibilityRaw as 'private' | 'public';
  if (push && !target) throw new Error('--push needs a target repo: --hf-repo <org/name> or BUGFARM_HF_REPO');
  const targetLabel = target ?? '<target repo not set: BUGFARM_HF_REPO>';
  const store = new AttemptStore(def.id);

  // 1. The numbers: reconcile the benchmark, and look up the other campaigns' spend.
  log('publish', `reconciling ${def.campaign} with the gateway and Stablehand`);
  const keyFile = join(benchDir(def.id), 'campaign-key.json');
  let rec: Reconciliation | null = null;
  try {
    rec = await reconcile(store, def, pricingContext({ stablehand: a, gatewayUrl: s.gatewayUrl, meteringKey: s.meteringKey, campaignKeyFile: existsSync(keyFile) ? keyFile : undefined }), s.runtimeKey);
  } catch (e) {
    log('publish', `could not reconcile (${String(e)}); the card will say so`);
  }
  const selection = await selectionSpend(a, def, str(args, 'selection-campaign'), s.gatewayUrl, s.meteringKey);
  const authoring = await authoringSpend(a, def, str(args, 'factory-campaign'));

  // 2. The folder.
  const swebench = (str(args, 'swebench') ?? '').split(',').filter(Boolean).map((p) => resolve(p));
  const model = await buildDataset(def, store, { out, swebenchSources: swebench, reconciliation: rec, selection, authoring, target: { repo: target, visibility }, boardUrl: s.boardPublicUrl });
  writeFileSync(join(out, CARD), renderCard(model, null));
  log('publish', `built ${out}: ${model.tasks.length} tasks, ${model.files} files, ${(model.bytes / 1e6).toFixed(1)} MB, dataset sha256 ${model.sha.slice(0, 16)}`);
  if (args['build-only']) {
    console.log(JSON.stringify({ out, dataset_sha256: model.sha, tasks: model.tasks.length, files: model.files, bytes: model.bytes }, null, 2));
    return;
  }

  // 3. Ask a person (or read back the answer they already gave for this exact dataset).
  let state = readState(out);
  if (state && state.dataset_sha !== model.sha) {
    log('publish', `the dataset changed since its last approval request (${state.dataset_sha.slice(0, 12)} -> ${model.sha.slice(0, 12)}); asking again`);
    state = undefined;
  }
  state ??= { dataset_sha: model.sha };
  const reqBase = {
    dataset_sha: model.sha,
    tasks: model.tasks.length,
    total_spend_usd: model.ledger.totals.campaign_usd,
    board_url: s.boardPublicUrl ? `${s.boardPublicUrl}/#/leaderboard` : null,
    target: targetLabel,
    visibility,
    dry_run: dryRun,
    campaign: def.campaign,
    bench: def.id,
  };
  const request: ApprovalRequest = { ...reqBase, reason: summaryReason(model, reqBase) };
  const board = str(args, 'board-campaign') ? boardFor(def.id, s.boardUrl, s.boardToken) : undefined;
  if (!state.approval) {
    state.publisher_agent_id ??= await ensurePublisher(a, str(args, 'publisher-model') ?? 'gpt-5.4-mini');
    state.turn_id ??= await startApprovalTurn(a, state.publisher_agent_id, request);
    writeState(out, state);
    const interrupt = await waitForRequest(a, state.publisher_agent_id, state.turn_id);
    state.interrupt_id = interrupt.id;
    writeState(out, state);
    const reason = typeof interrupt.args?.reason === 'string' ? interrupt.args.reason : request.reason;
    console.log(`\nWaiting for approval: ${reason}`);
    console.log(`  interrupt ${interrupt.id} on agent ${state.publisher_agent_id}`);
    if (s.stablehandUiUrl) console.log(`  approve or reject it on the dashboard: ${s.stablehandUiUrl}/  (or ${s.stablehandUiUrl}/agents/${state.publisher_agent_id})`);
    console.log(`  or: POST ${s.stablehandUrl}/api/agents/${state.publisher_agent_id}/interrupt {"action":"approve","interruptId":"${interrupt.id}","reason":"..."}\n`);
    if (board) await board.write([{ kind: 'campaign', key: str(args, 'board-campaign') as string, payload: { approval: { state: 'waiting', interrupt_id: interrupt.id, tool: 'request-approval', requested_at: interrupt.createdAt } } }]);
    const decided = await waitForDecision(a, interrupt.id, { timeoutMs: Number(str(args, 'wait-minutes') ?? 240) * 60_000 });
    state.approval = approvalFrom(decided, request);
    writeState(out, state);
    if (board) await board.write([{ kind: 'campaign', key: str(args, 'board-campaign') as string, payload: { approval: { state: state.approval.action === 'approve' ? 'approved' : 'rejected', interrupt_id: interrupt.id, resolved_at: state.approval.resolved_at ?? Date.now() } } }]);
  }
  const approval = state.approval as Approval;
  writeJson(join(out, APPROVAL), approval);
  writeFileSync(join(out, CARD), renderCard(model, approval));
  const resolver = approval.resolved_by?.type === 'api_key' ? `key ${approval.resolved_by.keyName ?? approval.resolved_by.keyId}` : approval.resolved_by?.type ?? 'unknown';
  log('publish', `${approval.action === 'approve' ? 'approved' : 'rejected'} by ${resolver}: ${approval.reason ?? '(no reason)'}`);
  if (approval.action !== 'approve') {
    console.log(JSON.stringify({ published: false, rejected: true, approval, out }, null, 2));
    process.exitCode = 3;
    return;
  }

  // 4. Push, or show what a push would do.
  const result = hfPush(out, target ?? 'unset/unset', visibility, model.sha, dryRun);
  if (!dryRun && result.ok) {
    state.pushed = { at: Date.now(), repo: target as string, result };
    writeState(out, state);
    const items = def.tasks.map((t) => ({ kind: 'item' as const, key: t.item, payload: { stage: 'published' as const, published_to: target, dataset_sha: model.sha } }));
    const b = boardFor(def.id, s.boardUrl, s.boardToken);
    await b.write(items);
  }
  console.log(JSON.stringify({ published: !dryRun && Boolean(result.ok), dry_run: dryRun, target: targetLabel, visibility, out, dataset_sha256: model.sha, approval: { action: approval.action, resolved_by: approval.resolved_by, reason: approval.reason, resolved_at: approval.resolved_at, interrupt_id: approval.interrupt_id }, hub: result }, null, 2));
  if (!result.ok) process.exitCode = 1;
}
