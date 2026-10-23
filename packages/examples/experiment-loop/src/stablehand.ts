import type { AgentManifest } from '@stablehand/manifest';
import { manifestToAgentPatchInput, validateManifest } from '@stablehand/manifest';

import { ApiError, mapLimit, sleep, type StablehandApi } from './api.js';
import { applyConfig, candidateManifest } from './config.js';
import { gradeAnswer } from './grader.js';
import { iterationMarkdown, resultsPage, reviewerTask } from './report.js';
import { renderTaskPrompt } from './tasks.js';
import type {
  CampaignResult,
  CandidateConfig,
  IterationRecord,
  LoopDeps,
  RunContext,
  RunStatus,
  Usage,
} from './types.js';

export const EVENT_PREFIX = 'custom.experiment';

interface ApiAgent {
  id: string;
  name: string;
  manifest?: Record<string, unknown> | null;
}

interface ApiTurn {
  id: string;
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'ERROR' | 'CANCELLED';
  error: string | null;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cost: { totalUsd: number | null; knownUsd: number; coverage: 'complete' | 'partial' | 'pending' | 'unpriced' };
  } | null;
}

interface ApiMessage {
  role: string;
  content: unknown;
}

const ZERO_USAGE: Usage = { costUsd: 0, costComplete: true, inputTokens: 0, outputTokens: 0, totalTokens: 0 };

export interface TurnOutcome {
  turnId: string | null;
  status: RunStatus;
  answer: string;
  error?: string;
  usage: Usage;
}

export interface TurnRunnerOptions {
  /** Longest a turn may run once it has started (queue time does not count). */
  timeoutSec: number;
  pollMs?: number;
  /** How long to wait for the gateway to price a finished turn. */
  costSettleMs?: number;
  /**
   * How long to keep retrying a start the agent's session limit refused.
   * Each task run gets its own sandbox, and a finished sandbox stays warm
   * until the idle timeout (5 minutes by default) frees it.
   */
  sessionWaitSec?: number;
  /** Called while a start waits for a free sandbox session. */
  onWait?: (message: string) => void;
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string' ? part.text : ''))
      .join('');
  }
  return '';
}

function toUsage(turn: ApiTurn): Usage {
  if (!turn.usage) return { ...ZERO_USAGE, costComplete: false };
  return {
    costUsd: turn.usage.cost.totalUsd ?? turn.usage.cost.knownUsd ?? 0,
    costComplete: turn.usage.cost.coverage === 'complete',
    inputTokens: turn.usage.inputTokens,
    outputTokens: turn.usage.outputTokens,
    totalTokens: turn.usage.totalTokens,
  };
}

/** Start one background turn, wait for it, and read the final answer and its priced receipt. */
export async function runTurn(
  api: StablehandApi,
  agentId: string,
  task: string,
  tags: Record<string, string>,
  idempotencyKey: string,
  options: TurnRunnerOptions,
): Promise<TurnOutcome> {
  const pollMs = options.pollMs ?? 2000;
  const waitUntil = Date.now() + (options.sessionWaitSec ?? 900) * 1000;
  let turnId: string | null = null;
  while (turnId === null) {
    try {
      const started = await api.post<{ turnId: string }>(`/api/agents/${agentId}/turns`, { task, tags }, { 'Idempotency-Key': idempotencyKey });
      turnId = started.turnId;
    } catch (error) {
      if (error instanceof ApiError && error.code === 'budget_exceeded') {
        return { turnId: null, status: 'BLOCKED', answer: '', error: error.message, usage: ZERO_USAGE };
      }
      if (error instanceof ApiError && (error.status === 429 || error.status === 503) && Date.now() < waitUntil) {
        options.onWait?.(error.code ?? `HTTP ${error.status}`);
        await sleep(Math.max(10, (error.retryAfterSec ?? 5) * 1000));
        continue;
      }
      throw error;
    }
  }

  const path = `/api/agents/${agentId}/turns/${turnId}`;
  let deadline: number | null = null;
  let detail: { turn: ApiTurn; messages: ApiMessage[] };
  for (;;) {
    await sleep(pollMs);
    detail = await api.get(path);
    if (detail.turn.status !== 'QUEUED' && detail.turn.status !== 'RUNNING') break;
    // A queued turn waits for a container; the orchestrator fails it if the queue times out.
    if (detail.turn.status === 'RUNNING' && deadline === null) deadline = Date.now() + options.timeoutSec * 1000;
    if (deadline !== null && Date.now() > deadline) {
      await api.post(`${path}/cancel`, {});
      return { turnId, status: 'TIMEOUT', answer: '', error: `no answer within ${options.timeoutSec}s`, usage: toUsage(detail.turn) };
    }
  }
  const settleBy = Date.now() + (options.costSettleMs ?? 30_000);
  while (detail.turn.usage?.cost.coverage === 'pending' && Date.now() < settleBy) {
    await sleep(Math.min(3000, pollMs * 2));
    detail = await api.get(path);
  }
  const answer = [...detail.messages].reverse()
    .find((message) => message.role === 'assistant' && messageText(message.content).trim() !== '');
  return {
    turnId,
    status: detail.turn.status === 'COMPLETED' || detail.turn.status === 'ERROR' ? detail.turn.status : 'CANCELLED',
    answer: answer ? messageText(answer.content) : '',
    ...(detail.turn.error ? { error: detail.turn.error } : {}),
    usage: toUsage(detail.turn),
  };
}

export async function findAgentByName(api: StablehandApi, name: string): Promise<ApiAgent | null> {
  const agents = await api.get<ApiAgent[]>('/api/agents');
  return agents.find((agent) => agent.name === name) ?? null;
}

export async function requireAgent(api: StablehandApi, name: string): Promise<ApiAgent> {
  const agent = await findAgentByName(api, name);
  if (!agent) throw new Error(`agent ${name} not found; run the seed first`);
  return agent;
}

export interface UploadInput {
  agentId: string;
  name: string;
  mimeType: string;
  kind: string;
  content: string;
  metadata: Record<string, unknown>;
}

export async function uploadArtifact(api: StablehandApi, input: UploadInput): Promise<string> {
  const form = new FormData();
  form.append('agentId', input.agentId);
  form.append('name', input.name);
  form.append('kind', input.kind);
  form.append('metadata', JSON.stringify(input.metadata));
  form.append('file', new Blob([input.content], { type: input.mimeType }), input.name);
  const created = await api.request<{ id: string }>('POST', '/api/artifacts/upload', { body: form });
  return created.id;
}

export async function emitEvent(api: StablehandApi, type: string, payload: Record<string, unknown>): Promise<void> {
  await api.post('/api/triggers/emit', { type, payload });
}

export interface StablehandDepsOptions {
  api: StablehandApi;
  campaignId: string;
  /** The `campaign` tag value the tag budget selects on. */
  campaignTag: string;
  productionManifest: AgentManifest;
  candidateAgentId: string;
  proposerAgentId: string;
  concurrency: number;
  turn: TurnRunnerOptions;
  log: (line: string) => void;
}

export function runTags(campaignTag: string, context: RunContext, taskId?: string): Record<string, string> {
  return {
    campaign: campaignTag,
    loop: context.campaignId,
    iteration: String(context.iteration),
    role: context.role,
    ...(context.repeat !== undefined ? { repeat: String(context.repeat) } : {}),
    ...(taskId ? { task: taskId } : {}),
  };
}

function idempotencyKey(context: RunContext, suffix: string): string {
  return [context.campaignId, context.iteration, context.role, context.repeat ?? 0, suffix].join(':');
}

/** Loop dependencies backed by a running Stablehand. */
export function createStablehandDeps(options: StablehandDepsOptions): LoopDeps {
  const { api } = options;
  const productionName = options.productionManifest.metadata.name;
  let lastWaitLog = 0;
  const turn: TurnRunnerOptions = {
    ...options.turn,
    onWait: (reason) => {
      if (Date.now() - lastWaitLog < 60_000) return;
      lastWaitLog = Date.now();
      options.log(`[${options.campaignId}] waiting for a free sandbox session (${reason}); finished sandboxes free up after the idle timeout`);
    },
  };
  return {
    async applyCandidate(config: CandidateConfig) {
      const manifest = candidateManifest(options.productionManifest, config, options.campaignTag);
      await api.patch(`/api/agents/${options.candidateAgentId}`, manifestToAgentPatchInput(manifest));
    },
    async runTasks(tasks, context) {
      return mapLimit(tasks, options.concurrency, async (task) => {
        const outcome = await runTurn(
          api,
          options.candidateAgentId,
          renderTaskPrompt(task),
          runTags(options.campaignTag, context, task.id),
          idempotencyKey(context, task.id),
          turn,
        );
        return { taskId: task.id, ...outcome };
      });
    },
    async propose(prompt, context) {
      const outcome = await runTurn(
        api,
        options.proposerAgentId,
        prompt,
        runTags(options.campaignTag, context),
        idempotencyKey(context, 'proposal'),
        turn,
      );
      return { turnId: outcome.turnId, status: outcome.status, text: outcome.answer, usage: outcome.usage, ...(outcome.error ? { error: outcome.error } : {}) };
    },
    grade: gradeAnswer,
    async record(record: IterationRecord) {
      const stem = `${record.campaignId}-iteration-${String(record.iteration).padStart(2, '0')}`;
      const metadata = {
        campaign: record.campaignId,
        iteration: record.iteration,
        decision: record.decision,
        score: record.score,
        bestScore: record.bestScore,
        costUsd: Number(record.receipt.costUsd.toFixed(6)),
        totalTokens: record.receipt.totalTokens,
        runs: record.receipt.runs,
      };
      const reportId = await uploadArtifact(api, {
        agentId: options.candidateAgentId,
        name: `${stem}.md`,
        mimeType: 'text/markdown',
        kind: 'experiment-iteration',
        content: iterationMarkdown(record, productionName),
        metadata,
      });
      const receiptId = await uploadArtifact(api, {
        agentId: options.candidateAgentId,
        name: `${stem}.json`,
        mimeType: 'application/json',
        kind: 'experiment-receipt',
        content: `${JSON.stringify(record, null, 1)}\n`,
        metadata,
      });
      await emitEvent(api, `${EVENT_PREFIX}.iteration`, { ...metadata, spentUsd: Number(record.spentUsd.toFixed(6)), reportId, receiptId });
    },
    log: options.log,
  };
}

export interface PublishedCampaign {
  resultsArtifactId: string;
  campaignArtifactId: string;
  reviewTurnId: string | null;
}

export interface SavedCampaign {
  result: CampaignResult;
  resultsArtifactId: string;
  reviewTurnId: string | null;
  reviewerAgentId: string | null;
  productionAgentId: string;
}

/**
 * Upload the results page, start the review turn (which draws the chart and
 * opens the approval card), then save the campaign so `--await` can resume.
 */
export async function publishCampaign(
  api: StablehandApi,
  options: {
    result: CampaignResult;
    candidateAgentId: string;
    productionAgentId: string;
    productionName: string;
    reviewerAgentId: string | null;
    campaignTag: string;
  },
): Promise<PublishedCampaign> {
  const { result } = options;
  const resultsArtifactId = await uploadArtifact(api, {
    agentId: options.candidateAgentId,
    name: `${result.campaignId}-results.html`,
    mimeType: 'text/html',
    kind: 'experiment-results',
    content: resultsPage(result),
    metadata: {
      campaign: result.campaignId,
      baselineScore: result.baselineScore,
      winnerScore: result.winnerScore,
      winnerIteration: result.winnerIteration,
      spentUsd: Number(result.spentUsd.toFixed(6)),
      stopReason: result.stopReason,
    },
  });

  let reviewTurnId: string | null = null;
  if (options.reviewerAgentId && result.winnerIteration > 0) {
    const context: RunContext = { campaignId: result.campaignId, iteration: result.iterations.length, role: 'reviewer' };
    const started = await api.post<{ turnId: string }>(
      `/api/agents/${options.reviewerAgentId}/turns`,
      {
        task: reviewerTask(result, { resultsArtifactId, productionAgent: options.productionName }),
        tags: runTags(options.campaignTag, context),
      },
      { 'Idempotency-Key': idempotencyKey(context, 'review') },
    );
    reviewTurnId = started.turnId;
  }

  const saved: SavedCampaign = {
    result,
    resultsArtifactId,
    reviewTurnId,
    reviewerAgentId: options.reviewerAgentId,
    productionAgentId: options.productionAgentId,
  };
  const campaignArtifactId = await uploadArtifact(api, {
    agentId: options.candidateAgentId,
    name: `${result.campaignId}-campaign.json`,
    mimeType: 'application/json',
    kind: 'experiment-campaign',
    content: `${JSON.stringify(saved, null, 1)}\n`,
    metadata: { campaign: result.campaignId, reviewTurnId, resultsArtifactId },
  });
  await emitEvent(api, `${EVENT_PREFIX}.finished`, {
    campaign: result.campaignId,
    baselineScore: result.baselineScore,
    winnerScore: result.winnerScore,
    winnerIteration: result.winnerIteration,
    holdoutBaseline: result.holdout?.baselineScore ?? null,
    holdoutWinner: result.holdout?.winnerScore ?? null,
    spentUsd: Number(result.spentUsd.toFixed(6)),
    stopReason: result.stopReason,
    resultsArtifactId,
    campaignArtifactId,
    reviewTurnId,
  });
  return { resultsArtifactId, campaignArtifactId, reviewTurnId };
}

export async function loadSavedCampaign(api: StablehandApi, candidateAgentId: string, campaignId: string): Promise<SavedCampaign> {
  const listed = await api.get<{ artifacts: Array<{ id: string; name: string }> }>(`/api/artifacts?agentId=${candidateAgentId}&limit=500`);
  const artifact = listed.artifacts.find((entry) => entry.name === `${campaignId}-campaign.json`);
  if (!artifact) throw new Error(`no saved campaign ${campaignId} on the candidate agent`);
  return JSON.parse(await api.download(`/api/artifacts/${artifact.id}/download`)) as SavedCampaign;
}

export type ReviewDecision = 'approve' | 'reject' | 'no-decision' | 'pending';

interface ApiEvent {
  type: string;
  payload: string;
}

/**
 * Wait for the person's answer on the approval card. The decision is read
 * from the `interrupt.resolved` event Stablehand writes when the card is
 * resolved, not from the reviewer model's reply.
 */
export async function awaitReview(
  api: StablehandApi,
  reviewerAgentId: string,
  turnId: string,
  options: { timeoutMs: number; pollMs?: number; log?: (line: string) => void },
): Promise<ReviewDecision> {
  const deadline = Date.now() + options.timeoutMs;
  let announced = false;
  for (;;) {
    const resolved = await api.get<{ events: ApiEvent[] }>(`/api/events?type=interrupt.resolved&turnId=${turnId}&limit=20`);
    for (const event of resolved.events) {
      const payload = JSON.parse(event.payload) as { action?: string };
      if (payload.action === 'approve' || payload.action === 'reject') return payload.action;
    }
    if (!announced) {
      const requested = await api.get<{ events: ApiEvent[] }>(`/api/events?type=interrupt.requested&turnId=${turnId}&limit=5`);
      if (requested.events.length > 0) {
        announced = true;
        options.log?.('The approval card is waiting on the reviewer agent. Open it in the dashboard to approve or reject.');
      }
    }
    const detail = await api.get<{ turn: ApiTurn }>(`/api/agents/${reviewerAgentId}/turns/${turnId}`);
    if (detail.turn.status !== 'QUEUED' && detail.turn.status !== 'RUNNING') {
      const last = await api.get<{ events: ApiEvent[] }>(`/api/events?type=interrupt.resolved&turnId=${turnId}&limit=20`);
      const action = last.events
        .map((event) => (JSON.parse(event.payload) as { action?: string }).action)
        .find((value) => value === 'approve' || value === 'reject');
      return action === 'approve' || action === 'reject' ? action : 'no-decision';
    }
    if (Date.now() > deadline) return 'pending';
    await sleep(options.pollMs ?? 5000);
  }
}

/** Write the winning settings into the live production agent's own manifest. */
export async function promote(
  api: StablehandApi,
  options: { productionAgentId: string; winner: CandidateConfig; fallbackManifest: AgentManifest },
): Promise<void> {
  const agent = await api.get<ApiAgent>(`/api/agents/${options.productionAgentId}`);
  const live = agent.manifest ? validateManifest(agent.manifest) : options.fallbackManifest;
  await api.patch(`/api/agents/${options.productionAgentId}`, manifestToAgentPatchInput(applyConfig(live, options.winner)));
}
