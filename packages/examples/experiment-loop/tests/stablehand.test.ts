import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it } from 'vitest';

import { StablehandApi } from '../src/api.js';
import { configFromManifest, loadManifest } from '../src/config.js';
import { runCampaign } from '../src/loop.js';
import { awaitReview, createStablehandDeps, loadSavedCampaign, promote, publishCampaign, runTurn } from '../src/stablehand.js';
import { loadTaskSet, pickTasks } from '../src/tasks.js';
import type { CampaignResult } from '../src/types.js';
import { FakeApi } from './fake-api.js';

const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url));
const FAST = { timeoutSec: 5, pollMs: 1, costSettleMs: 200 };

describe('Stablehand adapter', () => {
  let fake: FakeApi;
  let api: StablehandApi;

  beforeEach(() => {
    fake = new FakeApi();
    api = new StablehandApi({ baseUrl: 'http://stablehand.test', token: 'cmk_loop', fetchImpl: fake.fetch });
  });

  it('runs a turn to the end, waits for the gateway price and reads the last answer', async () => {
    fake.turnScripts.push({ statuses: ['QUEUED', 'RUNNING', 'COMPLETED'], answer: '{"a": 1}', coverage: ['pending', 'pending', 'pending', 'complete'], costUsd: 0.0031 });
    const outcome = await runTurn(api, 'agent-x', 'do the task', { campaign: 'c' }, 'key-1', FAST);
    expect(outcome).toMatchObject({ status: 'COMPLETED', answer: '{"a": 1}', usage: { costUsd: 0.0031, costComplete: true, totalTokens: 340 } });
    const start = fake.calls('POST', /\/turns$/)[0]!;
    expect(start.headers['idempotency-key']).toBe('key-1');
    expect(start.json).toEqual({ task: 'do the task', tags: { campaign: 'c' } });
  });

  it('waits for a free sandbox session when the agent is at its session limit', async () => {
    const limit = { status: 429, body: { error: 'Concurrent session limit (20) reached', code: 'concurrency_limit_reached' }, headers: { 'retry-after': '0' } };
    fake.turnStartRefusals.push(limit, limit);
    const waits: string[] = [];
    const outcome = await runTurn(api, 'agent-x', 'task', {}, 'key-3', { ...FAST, onWait: (reason) => waits.push(reason) });
    expect(outcome.status).toBe('COMPLETED');
    expect(waits).toEqual(['concurrency_limit_reached', 'concurrency_limit_reached']);

    fake.turnStartRefusals.push(limit);
    await expect(runTurn(api, 'agent-x', 'task', {}, 'key-4', { ...FAST, sessionWaitSec: 0 })).rejects.toThrow('concurrency_limit_reached');
  });

  it('rides out an orchestrator restart on requests that are safe to repeat', async () => {
    let down = 2;
    const flaky: typeof fetch = async (input, init) => {
      if (down > 0) {
        down -= 1;
        throw new TypeError('fetch failed');
      }
      return fake.fetch(input, init);
    };
    const restarting = new StablehandApi({ baseUrl: 'http://stablehand.test', fetchImpl: flaky, retryUnreachableMs: 5000 });
    fake.turnScripts.push({ statuses: ['COMPLETED'], answer: 'done' });
    expect(await runTurn(restarting, 'agent-x', 'task', {}, 'key-5', FAST)).toMatchObject({ status: 'COMPLETED', answer: 'done' });

    down = 1;
    await expect(restarting.post('/api/triggers/emit', { type: 'custom.experiment.x', payload: {} })).rejects.toThrow('fetch failed');
  });

  it('reports a run the tag budget refused as BLOCKED', async () => {
    fake.turnStartError = { status: 429, body: { error: 'Budget "x" exhausted', code: 'budget_exceeded' } };
    const outcome = await runTurn(api, 'agent-x', 'task', {}, 'key-2', FAST);
    expect(outcome).toMatchObject({ status: 'BLOCKED', turnId: null, usage: { costUsd: 0 } });
  });

  it('runs a campaign end to end against the fake API and leaves receipts, artifacts and events', async () => {
    const production = (await loadManifest(join(PACKAGE_DIR, 'agents/ops-assistant/agent.yaml'))).manifest;
    const taskSet = await loadTaskSet(join(PACKAGE_DIR, 'tasks/tasks.json'));
    const slice = pickTasks(taskSet, ['fx-price-lookup', 'fx-distinct-customers']);
    // Baseline: one right, one using a function Excel 2016 lacks. Proposal fixes it.
    fake.turnScripts.push(
      { statuses: ['COMPLETED'], answer: '=INDEX(C2:C9,MATCH("P-1043",A2:A9,0))' },
      { statuses: ['COMPLETED'], answer: '=COUNTA(UNIQUE(B2:B10))' },
      { statuses: ['COMPLETED'], answer: JSON.stringify({ summary: 'Excel 2016 only', instructions: 'Use only functions that exist in Excel 2016.' }) },
      { statuses: ['COMPLETED'], answer: '=VLOOKUP("P-1043",A2:D9,3,FALSE)' },
      { statuses: ['COMPLETED'], answer: '=SUMPRODUCT(1/COUNTIF(B2:B10,B2:B10))' },
    );
    for (const name of ['ops-assistant', 'ops-assistant-candidate', 'loop-proposer']) {
      await api.post('/api/agents', { name, manifest: name === 'ops-assistant' ? production : null });
    }
    const [productionAgent, candidate, proposer] = fake.agents;
    const result = await runCampaign({
      campaignId: 'exp-fake',
      agentName: 'ops-assistant',
      baseline: configFromManifest(production),
      slice,
      holdout: [],
      searchSpace: { models: ['gpt-5.4-mini'], reasoning: [], maxTokens: null, nativeTools: [], maxInstructionChars: 6000 },
      maxIterations: 1,
      baselineRepeats: 1,
      minGain: 0.05,
      budgetUsd: 1,
      proposerEstimateUsd: 0.02,
      maxInvalidInARow: 2,
    }, createStablehandDeps({
      api,
      campaignId: 'exp-fake',
      campaignTag: 'experiment-loop',
      productionManifest: production,
      candidateAgentId: candidate!.id,
      proposerAgentId: proposer!.id,
      concurrency: 1,
      turn: FAST,
      log: () => undefined,
    }));

    expect(result.iterations.map((record) => [record.decision, record.score])).toEqual([['baseline', 0.5], ['keep', 1]]);
    expect(result.spentUsd).toBeCloseTo(0.01, 9);
    // The candidate agent was patched with the proposal, through its manifest.
    const patches = fake.calls('PATCH', new RegExp(`/api/agents/${candidate!.id}$`));
    expect((patches[1]?.json as { systemPrompt: string }).systemPrompt).toBe('Use only functions that exist in Excel 2016.');
    expect((patches[1]?.json as { metadata: unknown }).metadata).toMatchObject({ defaultTags: { campaign: 'experiment-loop' } });
    // Every task run carries the campaign tag the budget selects on.
    const starts = fake.calls('POST', /\/turns$/).map((request) => request.json as { tags: Record<string, string> });
    expect(starts.every((start) => start.tags.campaign === 'experiment-loop' && start.tags.loop === 'exp-fake')).toBe(true);
    expect(starts[0]?.tags).toMatchObject({ role: 'baseline', iteration: '0', task: 'fx-price-lookup' });
    // Each iteration left a report and a receipt artifact and one event.
    expect(fake.artifacts.map((artifact) => [artifact.name, artifact.kind])).toEqual([
      ['exp-fake-iteration-00.md', 'experiment-iteration'],
      ['exp-fake-iteration-00.json', 'experiment-receipt'],
      ['exp-fake-iteration-01.md', 'experiment-iteration'],
      ['exp-fake-iteration-01.json', 'experiment-receipt'],
    ]);
    expect(fake.artifacts[2]?.content).toContain('# Iteration 1: kept');
    expect(fake.artifacts[2]?.content).toContain('+   Use only functions that exist in Excel 2016.');
    expect(fake.events.map((event) => event.type)).toEqual(['custom.experiment.iteration', 'custom.experiment.iteration']);
    expect(fake.events[1]?.payload).toMatchObject({ iteration: 1, decision: 'keep', score: 1 });

    // Publishing: results page, review turn, saved campaign that --await can load.
    fake.turnScripts.push({ statuses: ['RUNNING'], answer: '' });
    await api.post('/api/agents', { name: 'loop-reviewer' });
    const reviewer = fake.agents.at(-1)!;
    const published = await publishCampaign(api, {
      result,
      candidateAgentId: candidate!.id,
      productionAgentId: productionAgent!.id,
      productionName: 'ops-assistant',
      reviewerAgentId: reviewer.id,
      campaignTag: 'experiment-loop',
    });
    expect(published.reviewTurnId).toBeTruthy();
    const reviewStart = fake.calls('POST', new RegExp(`/api/agents/${reviewer.id}/turns$`))[0]?.json as { task: string };
    expect(reviewStart.task).toContain('Call request-approval with exactly this input');
    const saved = await loadSavedCampaign(api, candidate!.id, 'exp-fake');
    expect(saved.reviewTurnId).toBe(published.reviewTurnId);
    expect((saved.result as CampaignResult).winner.instructions).toBe('Use only functions that exist in Excel 2016.');
    expect(fake.events.at(-1)).toMatchObject({ type: 'custom.experiment.finished', payload: { winnerIteration: 1 } });

    // The decision comes from the interrupt.resolved event, then promotion patches production's own manifest.
    fake.events.push({ type: 'interrupt.resolved', turnId: published.reviewTurnId!, payload: { action: 'approve' } });
    expect(await awaitReview(api, reviewer.id, published.reviewTurnId!, { timeoutMs: 1000, pollMs: 1 })).toBe('approve');
    await promote(api, { productionAgentId: productionAgent!.id, winner: result.winner, fallbackManifest: production });
    const promoted = fake.calls('PATCH', new RegExp(`/api/agents/${productionAgent!.id}$`)).at(-1)?.json as { name: string; systemPrompt: string; metadata?: unknown };
    expect(promoted.name).toBe('ops-assistant');
    expect(promoted.systemPrompt).toBe('Use only functions that exist in Excel 2016.');
    expect(promoted.metadata).not.toMatchObject({ defaultTags: { campaign: 'experiment-loop' } });
  });

  it('reports no decision when the review run ends without the card being resolved, and pending on timeout', async () => {
    fake.turnScripts.push({ statuses: ['COMPLETED'], answer: 'Rejected' }, { statuses: ['RUNNING'], answer: '' });
    const done = await api.post<{ turnId: string }>('/api/agents/r/turns', { task: 'x' });
    expect(await awaitReview(api, 'r', done.turnId, { timeoutMs: 1000, pollMs: 1 })).toBe('no-decision');
    const waiting = await api.post<{ turnId: string }>('/api/agents/r/turns', { task: 'x' });
    expect(await awaitReview(api, 'r', waiting.turnId, { timeoutMs: 5, pollMs: 2 })).toBe('pending');
  });
});
