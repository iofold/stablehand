import { describe, expect, it } from 'vitest';
import { JobRunner, jobIdFor, type JobHandler } from '../jobs/runner.js';
import type { JobKind } from '../shared/board.js';
import { createToolHandlers, ToolError } from '../tools.js';
import { MemoryStore } from './memory-store.js';

const quiet = { log: () => undefined, warn: () => undefined };

function handlers(impl: Partial<Record<JobKind, JobHandler>>): Record<JobKind, JobHandler> {
  const none: JobHandler = async () => ({});
  return { build_env: none, check_candidate: none, package_task: none, run_controls: none, ...impl };
}

describe('JobRunner', () => {
  it('runs a job, records progress and its result, and returns the same job for the same id', async () => {
    const store = new MemoryStore();
    let runs = 0;
    const runner = new JobRunner({
      store,
      logger: quiet,
      limits: {},
      handlers: handlers({
        build_env: async (ctx) => {
          runs++;
          await ctx.progress('building');
          return { ok: true, repo: ctx.args.repo };
        },
      }),
    });
    const id = jobIdFor('build_env', { repo: 'a/b', dockerfile: 'FROM x' });
    const job = await runner.submit('build_env', { repo: 'a/b', dockerfile: 'FROM x' }, { id });
    const done = await runner.settle(job.id);
    expect(done).toMatchObject({ status: 'done', result: { ok: true, repo: 'a/b' }, runs: 1 });
    expect(store.history.some((row) => row.kind === 'job' && (row.payload as { progress?: string }).progress === 'building')).toBe(true);
    const again = await runner.submit('build_env', { repo: 'a/b', dockerfile: 'FROM x' }, { id });
    expect(again.status).toBe('done');
    expect(runs).toBe(1);
  });

  it('resumes jobs a previous process left running', async () => {
    const store = new MemoryStore();
    await store.upsert([
      { kind: 'job', key: 'j-running', payload: { kind: 'check_candidate', status: 'running', args: { repo: 'a/b', sha: 'abc1234' }, runs: 1 } },
      { kind: 'job', key: 'j-done', payload: { kind: 'check_candidate', status: 'done', args: {}, result: { accepted: false } } },
    ]);
    const seen: string[] = [];
    const runner = new JobRunner({
      store,
      logger: quiet,
      limits: {},
      handlers: handlers({ check_candidate: async (ctx) => { seen.push(ctx.id); return { accepted: true }; } }),
    });
    expect(await runner.resume()).toBe(1);
    expect(await runner.settle('j-running')).toMatchObject({ status: 'done', runs: 2, result: { accepted: true } });
    expect(seen).toEqual(['j-running']);
  });

  it('marks a throwing job failed with its error', async () => {
    const store = new MemoryStore();
    const runner = new JobRunner({ store, logger: quiet, limits: {}, handlers: handlers({ run_controls: async () => { throw new Error('harbor fell over'); } }) });
    const job = await runner.submit('run_controls', { repo: 'a/b', sha: 'abc1234' });
    expect(await runner.settle(job.id)).toMatchObject({ status: 'failed' });
    expect((await runner.get(job.id))?.error).toContain('harbor fell over');
  });

  it('long-polls: wait returns as soon as the job finishes', async () => {
    const store = new MemoryStore();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const runner = new JobRunner({ store, logger: quiet, limits: {}, handlers: handlers({ build_env: async () => { await gate; return { ok: true }; } }) });
    const job = await runner.submit('build_env', { repo: 'a/b', dockerfile: 'FROM y' });
    const waiting = runner.wait(job.id, 10_000);
    setTimeout(release, 10);
    const started = Date.now();
    expect(await waiting).toMatchObject({ status: 'done' });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(await runner.wait(job.id, 0)).toMatchObject({ status: 'done' });
  });
});

describe('floor tools', () => {
  const req = (turnId: string) => ({ headers: { 'x-turn-id': turnId } }) as never;

  it('records Scout candidates on the turn and refuses calls from other roles', async () => {
    const store = new MemoryStore();
    await store.upsert([
      { kind: 'turn', key: 't-scout', payload: { turn_id: 't-scout', role: 'scout', agent_id: 'a', campaign: 'c', batch: 1, stage: 'scout', item: 'c:batch-1', status: 'running' } },
      { kind: 'turn', key: 't-writer', payload: { turn_id: 't-writer', role: 'writer', agent_id: 'a', campaign: 'c', batch: 1, stage: 'write', item: 'c:x', status: 'running' } },
    ]);
    const tools = createToolHandlers({ jobs: {} as never, store, floor: null, itemContext: () => { throw new Error('unused'); } });
    const answer = await tools.handle('submit_candidates', { candidates: [{ pr: 7, sha: 'abcdef1', title: 'Fix x' }, { pr: 'x' }] }, req('t-scout'));
    expect(answer).toMatchObject({ accepted: 1, dropped: 1 });
    expect(store.payload<{ submission: { candidates: unknown[] } }>('turn', 't-scout')?.submission.candidates).toHaveLength(1);
    await expect(tools.handle('submit_candidates', { candidates: [{ pr: 7, sha: 'abcdef1' }] }, req('t-writer'))).rejects.toBeInstanceOf(ToolError);
  });

  it('drops pull requests an earlier batch of the campaign used, and says which', async () => {
    const store = new MemoryStore();
    await store.upsert([
      { kind: 'turn', key: 't2', payload: { turn_id: 't2', role: 'scout', agent_id: 'a', campaign: 'c', batch: 2, stage: 'scout', item: 'c:batch-2', status: 'running' } },
      { kind: 'item', key: 'c:x@1', payload: { stage: 'rejected', campaign: 'c', batch: 1, pr: 7 } },
      { kind: 'item', key: 'other:x@1', payload: { stage: 'rejected', campaign: 'other', batch: 1, pr: 8 } },
    ]);
    const tools = createToolHandlers({ jobs: {} as never, store, floor: null, itemContext: () => { throw new Error('unused'); } });
    const answer = await tools.handle('submit_candidates', { candidates: [{ pr: 7, sha: 'abcdef1', title: 'Fix x' }, { pr: 8, sha: 'abcdef2', title: 'Fix y' }] }, req('t2'));
    expect(answer).toMatchObject({ accepted: 1, already_used: [7] });
    expect(String(answer.message)).toContain('#7');
    await expect(tools.handle('submit_candidates', { candidates: [{ pr: 7, sha: 'abcdef1', title: 'Fix x' }] }, req('t2'))).rejects.toThrow('already used');
  });

  it('finds the turn through its tags when the foreman has not recorded it yet', async () => {
    const store = new MemoryStore();
    const floor = {
      lookupTurn: async (id: string) => ({ id, agentId: 'ag', status: 'RUNNING' as const, error: null, stopCode: null, costUsd: null, costCoverage: null, tags: { campaign: 'tag', batch: '2', stage: 'scout', item: 'c9:batch-2' } }),
    };
    const tools = createToolHandlers({ jobs: {} as never, store, floor, itemContext: () => { throw new Error('unused'); } });
    await tools.handle('submit_candidates', { candidates: [{ pr: 3, sha: 'abcdef12', title: 't' }] }, req('t-new'));
    expect(store.payload('turn', 't-new')).toMatchObject({ role: 'scout', campaign: 'c9', batch: 2, item: 'c9:batch-2', submission: { candidates: [{ pr: 3 }] } });
  });
});
