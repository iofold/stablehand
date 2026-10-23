import { averageByTask, decide, mean, measureNoise } from './decide.js';
import { diffConfigs } from './diff.js';
import type { Grade } from './grader.js';
import { answerKeyValues, buildProposerPrompt, parseProposal } from './proposal.js';
import type { Task } from './tasks.js';
import type {
  CampaignResult,
  CandidateConfig,
  Decision,
  HoldoutCheck,
  IterationRecord,
  LoopDeps,
  LoopSettings,
  ProposerRun,
  Receipt,
  RunContext,
  StopReason,
  TaskResult,
  TaskRun,
} from './types.js';

/** Projections carry this headroom so the last iteration does not overshoot. */
const PROJECTION_HEADROOM = 1.25;

export function receiptOf(runs: ReadonlyArray<Pick<TaskRun, 'turnId' | 'usage'>>): Receipt {
  return {
    runs: runs.length,
    turnIds: runs.map((run) => run.turnId).filter((id): id is string => id !== null),
    costUsd: runs.reduce((sum, run) => sum + run.usage.costUsd, 0),
    costComplete: runs.every((run) => run.usage.costComplete),
    inputTokens: runs.reduce((sum, run) => sum + run.usage.inputTokens, 0),
    outputTokens: runs.reduce((sum, run) => sum + run.usage.outputTokens, 0),
    totalTokens: runs.reduce((sum, run) => sum + run.usage.totalTokens, 0),
  };
}

function failedGrade(task: Task, run: TaskRun): Grade {
  return {
    taskId: task.id,
    score: 0,
    checks: [],
    error: `the run ended with ${run.status}${run.error ? `: ${run.error}` : ''}`,
  };
}

/** The lowest-scoring repeat of each task: the most useful failure to show the proposer. */
function worstPerTask(results: readonly TaskResult[]): TaskResult[] {
  const worst = new Map<string, TaskResult>();
  for (const result of results) {
    const current = worst.get(result.taskId);
    if (!current || result.score < current.score) worst.set(result.taskId, result);
  }
  return [...worst.values()];
}

export async function runCampaign(settings: LoopSettings, deps: LoopDeps): Promise<CampaignResult> {
  const { campaignId } = settings;
  const tasksById = new Map([...settings.slice, ...settings.holdout].map((task) => [task.id, task]));
  const answerKey = answerKeyValues(settings.slice);
  const iterations: IterationRecord[] = [];
  let spent = 0;

  const grade = (runs: TaskRun[], repeat: number): TaskResult[] => runs.map((run) => {
    const task = tasksById.get(run.taskId);
    if (!task) throw new Error(`runTasks returned unknown task ${run.taskId}`);
    const result = run.status === 'COMPLETED' ? deps.grade(task, run.answer) : failedGrade(task, run);
    return { ...run, repeat, score: result.score, grade: result };
  });

  const finish = async (
    partial: Omit<IterationRecord, 'campaignId' | 'receipt' | 'spentUsd' | 'finishedAt'>,
    runs: ReadonlyArray<Pick<TaskRun, 'turnId' | 'usage'>>,
  ): Promise<IterationRecord> => {
    const receipt = receiptOf(runs);
    spent += receipt.costUsd;
    const record: IterationRecord = { campaignId, ...partial, receipt, spentUsd: spent, finishedAt: new Date().toISOString() };
    iterations.push(record);
    await deps.record(record);
    const score = record.score === null ? 'no score' : `score ${record.score.toFixed(3)}`;
    deps.log(`[${campaignId}] iteration ${record.iteration} ${record.decision}: ${score}, best ${record.bestScore.toFixed(3)}, `
      + `$${receipt.costUsd.toFixed(4)} (campaign $${spent.toFixed(4)} of $${settings.budgetUsd.toFixed(2)}). ${record.reason}`);
    return record;
  };

  const context = (iteration: number, role: RunContext['role'], repeat?: number): RunContext => ({
    campaignId,
    iteration,
    role,
    ...(repeat !== undefined ? { repeat } : {}),
  });

  // Iteration 0: the baseline, run more than once to measure run-to-run noise.
  const baselineStarted = new Date().toISOString();
  await deps.applyCandidate(settings.baseline);
  const repeats = Math.max(1, settings.baselineRepeats);
  const baselineRuns = await Promise.all(Array.from({ length: repeats }, (_, repeat) => (
    deps.runTasks(settings.slice, context(0, 'baseline', repeat))
  )));
  const baselineResults = baselineRuns.flatMap((runs, repeat) => grade(runs, repeat));
  const noise = repeats > 1 ? measureNoise(baselineResults) : 0;
  const margin = Math.max(settings.minGain, noise);
  let bestConfig: CandidateConfig = settings.baseline;
  let bestScores = averageByTask(baselineResults);
  let bestScore = mean([...bestScores.values()]);
  let bestResults = worstPerTask(baselineResults);
  let winnerIteration = 0;
  const baselineScore = bestScore;
  const blockedAtBaseline = baselineResults.some((result) => result.status === 'BLOCKED');

  await finish({
    iteration: 0,
    decision: blockedAtBaseline ? 'stopped' : 'baseline',
    reason: blockedAtBaseline
      ? 'stopped: the campaign budget refused to start the baseline runs'
      : `baseline: mean ${bestScore.toFixed(3)} over ${repeats} run${repeats === 1 ? '' : 's'} of ${settings.slice.length} tasks; `
        + `run-to-run noise ${noise.toFixed(3)} sets the keep margin at ${margin.toFixed(3)}`,
    summary: 'baseline',
    config: settings.baseline,
    diff: '',
    score: bestScore,
    bestScore,
    comparison: null,
    results: baselineResults,
    proposerTurnId: null,
    startedAt: baselineStarted,
  }, baselineResults);

  let stopReason: StopReason = blockedAtBaseline ? 'budget-blocked' : 'iteration-cap';
  let invalidInARow = 0;
  const projectNextCost = (): number => {
    const tried = iterations.filter((record) => record.decision === 'keep' || record.decision === 'discard');
    if (tried.length > 0) return PROJECTION_HEADROOM * Math.max(...tried.map((record) => record.receipt.costUsd));
    const perRun = (iterations[0]?.receipt.costUsd ?? 0) / repeats;
    const lastProposer = [...iterations].reverse().find((record) => record.decision === 'invalid')?.receipt.costUsd;
    return PROJECTION_HEADROOM * (perRun + (lastProposer ?? settings.proposerEstimateUsd));
  };

  for (let iteration = 1; iteration <= settings.maxIterations && !blockedAtBaseline; iteration += 1) {
    const projected = projectNextCost();
    if (spent + projected > settings.budgetUsd) {
      stopReason = 'budget';
      deps.log(`[${campaignId}] stopping: the next iteration would cost about $${projected.toFixed(4)} `
        + `and the campaign has $${Math.max(0, settings.budgetUsd - spent).toFixed(4)} left`);
      break;
    }
    const startedAt = new Date().toISOString();
    const proposer: ProposerRun = await deps.propose(buildProposerPrompt({
      agentName: settings.agentName,
      best: bestConfig,
      bestScore,
      bestResults,
      tasks: settings.slice,
      history: iterations,
      space: settings.searchSpace,
    }), context(iteration, 'proposer'));
    const proposerRun = { turnId: proposer.turnId, usage: proposer.usage };
    const base = {
      iteration,
      config: bestConfig,
      diff: '',
      score: null,
      bestScore,
      comparison: null,
      results: [],
      proposerTurnId: proposer.turnId,
      startedAt,
    };

    if (proposer.status === 'BLOCKED') {
      await finish({ ...base, decision: 'stopped', reason: 'stopped: the campaign budget refused to start the proposer', summary: '(not run)' }, [proposerRun]);
      stopReason = 'budget-blocked';
      break;
    }
    const proposal = proposer.status === 'COMPLETED'
      ? parseProposal(proposer.text, bestConfig, settings.searchSpace, answerKey)
      : { ok: false as const, reason: `the proposer run ended with ${proposer.status}${proposer.error ? `: ${proposer.error}` : ''}`, summary: '(no proposal)' };
    if (!proposal.ok) {
      invalidInARow += 1;
      await finish({ ...base, decision: 'invalid', reason: `invalid: ${proposal.reason}`, summary: proposal.summary }, [proposerRun]);
      if (invalidInARow >= settings.maxInvalidInARow) {
        stopReason = 'proposer-failing';
        break;
      }
      continue;
    }
    invalidInARow = 0;

    await deps.applyCandidate(proposal.config);
    const runs = await deps.runTasks(settings.slice, context(iteration, 'candidate'));
    const results = grade(runs, 0);
    const diff = diffConfigs(bestConfig, proposal.config);
    const score = mean(results.map((result) => result.score));
    if (results.some((result) => result.status === 'BLOCKED')) {
      await finish({
        ...base,
        decision: 'stopped',
        reason: 'stopped: the campaign budget refused to start some task runs, so this iteration is not compared',
        summary: proposal.summary,
        config: proposal.config,
        diff,
        score,
        results,
      }, [proposerRun, ...results]);
      stopReason = 'budget-blocked';
      break;
    }

    const verdict = decide(bestScores, new Map(results.map((result) => [result.taskId, result.score])), margin);
    const decision: Decision = verdict.keep ? 'keep' : 'discard';
    if (verdict.keep) {
      bestConfig = proposal.config;
      bestScores = new Map(results.map((result) => [result.taskId, result.score]));
      bestScore = score;
      bestResults = results;
      winnerIteration = iteration;
    }
    await finish({
      ...base,
      decision,
      reason: verdict.reason,
      summary: proposal.summary,
      config: proposal.config,
      diff,
      score,
      bestScore,
      comparison: verdict.comparison,
      results,
    }, [proposerRun, ...results]);

    if (bestScore >= 1 - 1e-9) {
      stopReason = 'solved';
      deps.log(`[${campaignId}] stopping: the best configuration answers every slice task fully`);
      break;
    }
  }

  // Selection and measurement in separate runs: re-measure baseline and winner
  // on tasks the proposer never saw before anyone is asked to promote.
  let holdout: HoldoutCheck | null = null;
  let holdoutNote: string | null = null;
  if (winnerIteration === 0) {
    holdoutNote = 'no change beat the baseline, so there is nothing to promote';
  } else if (settings.holdout.length === 0) {
    holdoutNote = 'no held-out tasks configured';
  } else {
    const perTask = (iterations[0]?.receipt.costUsd ?? 0) / Math.max(1, repeats * settings.slice.length);
    const projected = PROJECTION_HEADROOM * perTask * settings.holdout.length * 2;
    if (spent + projected > settings.budgetUsd) {
      holdoutNote = `skipped: the held-out check would cost about $${projected.toFixed(4)} and the campaign has $${Math.max(0, settings.budgetUsd - spent).toFixed(4)} left`;
    } else {
      await deps.applyCandidate(settings.baseline);
      const baselineHeld = grade(await deps.runTasks(settings.holdout, context(settings.maxIterations + 1, 'holdout-baseline')), 0);
      await deps.applyCandidate(bestConfig);
      const winnerHeld = grade(await deps.runTasks(settings.holdout, context(settings.maxIterations + 1, 'holdout-winner')), 1);
      const all = [...baselineHeld, ...winnerHeld];
      holdout = {
        taskIds: settings.holdout.map((task) => task.id),
        baselineScore: mean(baselineHeld.map((result) => result.score)),
        winnerScore: mean(winnerHeld.map((result) => result.score)),
        receipt: receiptOf(all),
        results: all,
      };
      spent += holdout.receipt.costUsd;
      deps.log(`[${campaignId}] held-out check on ${settings.holdout.length} unseen tasks: baseline ${holdout.baselineScore.toFixed(3)}, `
        + `winner ${holdout.winnerScore.toFixed(3)}, $${holdout.receipt.costUsd.toFixed(4)}`);
    }
  }
  // Leave the candidate agent on the best configuration, not the last one tried.
  if (!holdout && !blockedAtBaseline) await deps.applyCandidate(bestConfig);

  return {
    campaignId,
    agentName: settings.agentName,
    sliceTaskIds: settings.slice.map((task) => task.id),
    baseline: settings.baseline,
    baselineScore,
    winner: bestConfig,
    winnerScore: bestScore,
    winnerIteration,
    margin,
    iterations,
    holdout,
    holdoutNote,
    stopReason,
    spentUsd: spent,
    budgetUsd: settings.budgetUsd,
  };
}
