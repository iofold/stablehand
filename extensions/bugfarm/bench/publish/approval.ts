// Asking a person before anything is published.
//
// Approvals in Stablehand are raised by an agent's `request-approval` tool: the turn pauses, the
// request shows in the dashboard (and on a phone), and whoever resolves it is recorded with their
// reason. Bugfarm's Publisher is a small Stablehand agent whose one job is to raise that request
// with the publish summary. This module never trusts the agent's reply: it reads the decision, the
// resolver and the reason from the interrupt record itself.
import { log } from '../../pipeline/lib/util.ts';
import { api } from '../lib/spend.ts';
import type { Api } from '../lib/spend.ts';

export const PUBLISHER_NAME = 'bugfarm-publisher';

export interface ApprovalRequest {
  reason: string;
  dataset_sha: string;
  tasks: number;
  total_spend_usd: number;
  board_url: string | null;
  target: string;
  visibility: 'private' | 'public';
  dry_run: boolean;
  campaign: string;
  bench: string;
}

export interface ResolvedBy {
  type: 'api_key' | 'master_token' | 'unauthenticated' | string;
  keyId?: string;
  keyName?: string;
}

export interface Approval {
  interrupt_id: string;
  agent_id: string;
  turn_id: string;
  action: 'approve' | 'reject';
  resolved_at: number | null;
  resolved_by: ResolvedBy | null;
  reason: string | null;
  requested_at: number;
  request: ApprovalRequest;
}

interface InterruptRow {
  id: string;
  agentId: string;
  turnId: string;
  toolName: string;
  args?: Record<string, unknown>;
  status: string;
  createdAt: number;
  resolvedAt?: number | null;
  resolvedAction?: string | null;
  resolvedBy?: ResolvedBy | null;
  resolvedReason?: string | null;
}

const SYSTEM_PROMPT = `You are the Bugfarm publisher. You ask a person to approve publishing a dataset, using the request-approval tool, and you report their answer.
Never publish anything yourself and never call any other tool.`;

export function publisherBody(model: string): Record<string, unknown> {
  return {
    name: PUBLISHER_NAME,
    description: 'Asks a person to approve each Bugfarm dataset before it is pushed to the Hugging Face Hub.',
    harness: 'pi-agent',
    harnessConfig: { model, provider: 'openai', limits: { maxCostUsd: 0.25, maxToolCalls: 4 } },
    systemPrompt: SYSTEM_PROMPT,
    tools: ['request-approval'],
    builtinToolPolicy: { policy: 'allow', names: ['request-approval'] },
    nativeToolPolicy: { policy: 'none' },
    egress: { mode: 'deny' },
    mode: 'background',
    resourceLimits: { timeoutSec: 3600 },
    metadata: { bugfarm: { role: 'publisher' } },
  };
}

export async function ensurePublisher(a: Api, model: string): Promise<string> {
  const agents = await api<Array<{ id: string; name: string }>>(a, 'GET', '/api/agents');
  const found = agents.find((x) => x.name === PUBLISHER_NAME);
  if (found) return found.id;
  const created = await api<{ id: string }>(a, 'POST', '/api/agents', publisherBody(model));
  log('publish', `created the ${PUBLISHER_NAME} agent ${created.id}`);
  return created.id;
}

export function approvalTask(req: ApprovalRequest): string {
  const details = {
    tasks: req.tasks,
    total_spend_usd: req.total_spend_usd,
    board: req.board_url,
    target: `${req.target} (${req.visibility}${req.dry_run ? ', dry run: nothing is uploaded' : ''})`,
    dataset_sha256: req.dataset_sha,
    campaign: req.campaign,
    benchmark: req.bench,
  };
  return [
    'A Bugfarm dataset is ready to publish. Call the request-approval tool exactly once, with these arguments copied exactly:',
    '',
    `reason: ${JSON.stringify(req.reason)}`,
    `details: ${JSON.stringify(details)}`,
    '',
    'Do not call any other tool. When request-approval returns, reply with one line: APPROVED or REJECTED, then the reason it gave, if any.',
  ].join('\n');
}

/** Start the Publisher's turn. The same dataset sha always maps to the same turn (idempotency key). */
export async function startApprovalTurn(a: Api, agentId: string, req: ApprovalRequest): Promise<string> {
  const started = await api<{ turnId: string }>(
    a,
    'POST',
    `/api/agents/${agentId}/turns`,
    { task: approvalTask(req), tags: { campaign: req.campaign, stage: 'publish', bench: req.bench, dataset: req.dataset_sha.slice(0, 16) } },
    { 'Idempotency-Key': `bugfarm-publish-${req.dataset_sha.slice(0, 32)}` },
  );
  return started.turnId;
}

async function interruptsFor(a: Api, agentId: string): Promise<InterruptRow[]> {
  return (await api<{ interrupts: InterruptRow[] }>(a, 'GET', `/api/interrupts?agentId=${encodeURIComponent(agentId)}&status=all&limit=50`)).interrupts;
}

/** Wait until the Publisher's turn has raised its approval request; fail if the turn ends without one. */
export async function waitForRequest(a: Api, agentId: string, turnId: string, timeoutMs = 10 * 60_000): Promise<InterruptRow> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const mine = (await interruptsFor(a, agentId)).filter((i) => i.turnId === turnId && i.toolName === 'request-approval');
    if (mine.length) return mine.sort((x, y) => y.createdAt - x.createdAt)[0];
    const turn = (await api<{ turn: { status: string; error?: string | null } }>(a, 'GET', `/api/turns/${turnId}`)).turn;
    if (['COMPLETED', 'ERROR', 'CANCELLED'].includes(turn.status)) {
      throw new Error(`the publisher's turn ${turnId} ended ${turn.status} without asking for approval${turn.error ? `: ${turn.error}` : ''}`);
    }
    if (Date.now() > deadline) throw new Error(`no approval request from turn ${turnId} after ${Math.round(timeoutMs / 60_000)} minutes`);
    await new Promise((r) => setTimeout(r, 3000));
  }
}

/**
 * Wait for a person's decision. A request left alone past Stablehand's live window (5 minutes) is
 * parked (`timed_out`) but still actionable, so this keeps waiting until it is resolved by someone.
 */
export async function waitForDecision(a: Api, interruptId: string, opts: { timeoutMs: number; onWaiting?: (row: InterruptRow) => void }): Promise<InterruptRow> {
  const deadline = Date.now() + opts.timeoutMs;
  let announced = false;
  for (;;) {
    const row = await api<InterruptRow>(a, 'GET', `/api/interrupts/${encodeURIComponent(interruptId)}`);
    if ((row.status === 'resolved' || row.status === 'resume_failed') && (row.resolvedAction === 'approve' || row.resolvedAction === 'reject')) return row;
    if (!announced) {
      opts.onWaiting?.(row);
      announced = true;
    }
    if (Date.now() > deadline) throw new Error(`approval ${interruptId} is still waiting for a person; run publish again to keep waiting`);
    await new Promise((r) => setTimeout(r, 5000));
  }
}

export function approvalFrom(row: InterruptRow, req: ApprovalRequest): Approval {
  return {
    interrupt_id: row.id,
    agent_id: row.agentId,
    turn_id: row.turnId,
    action: row.resolvedAction === 'approve' ? 'approve' : 'reject',
    resolved_at: row.resolvedAt ?? null,
    resolved_by: row.resolvedBy ?? null,
    reason: row.resolvedReason ?? null,
    requested_at: row.createdAt,
    request: req,
  };
}
