/**
 * Run one experiment campaign: baseline, then propose / run / keep-or-discard
 * until the iteration cap or the campaign budget, then a held-out check and
 * an approval card that gates promotion to the production agent.
 *
 *   pnpm -C packages/examples/experiment-loop loop [-- options]
 *
 * Options:
 *   --iterations N     iteration cap (default from loop.config.json)
 *   --budget USD       campaign budget (default from loop.config.json)
 *   --slice a,b,c      task ids to optimize on
 *   --no-holdout       skip the held-out check
 *   --no-review        stop after the results page; no approval card
 *   --await ID         resume waiting on campaign ID's approval card
 *
 * Environment:
 *   API_URL               Stablehand API (default http://localhost:3002)
 *   STABLEHAND_LOOP_KEY   scoped key; defaults to the .loop-key the seed wrote
 *   LOOP_CONFIG           config file (default ./loop.config.json)
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { StablehandApi } from './src/api.js';
import {
  candidateName,
  configFromManifest,
  effectiveSearchSpace,
  findPackageDir,
  loadLoopConfig,
  loadManifest,
  resolveFromPackage,
} from './src/config.js';
import { runCampaign } from './src/loop.js';
import { stopText, usd } from './src/report.js';
import {
  awaitReview,
  createStablehandDeps,
  emitEvent,
  EVENT_PREFIX,
  loadSavedCampaign,
  promote,
  publishCampaign,
  requireAgent,
  type ReviewDecision,
} from './src/stablehand.js';
import { loadTaskSet, pickTasks } from './src/tasks.js';

interface Args {
  iterations?: number;
  budget?: number;
  slice?: string[];
  holdout: boolean;
  review: boolean;
  awaitCampaign?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { holdout: true, review: true };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = (): string => {
      const next = argv[i + 1];
      if (next === undefined) throw new Error(`${flag} needs a value`);
      i += 1;
      return next;
    };
    if (flag === '--') continue;
    else if (flag === '--iterations') args.iterations = Number(value());
    else if (flag === '--budget') args.budget = Number(value());
    else if (flag === '--slice') args.slice = value().split(',').map((id) => id.trim()).filter(Boolean);
    else if (flag === '--no-holdout') args.holdout = false;
    else if (flag === '--no-review') args.review = false;
    else if (flag === '--await') args.awaitCampaign = value();
    else throw new Error(`unknown option ${flag}`);
  }
  return args;
}

function loopToken(packageDir: string): string {
  if (process.env.STABLEHAND_LOOP_KEY) return process.env.STABLEHAND_LOOP_KEY.trim();
  const keyFile = join(packageDir, '.loop-key');
  if (existsSync(keyFile)) return readFileSync(keyFile, 'utf8').trim();
  if (process.env.STABLEHAND_API_TOKEN) {
    console.warn('No scoped key found (.loop-key or STABLEHAND_LOOP_KEY); using the master token.');
    return process.env.STABLEHAND_API_TOKEN;
  }
  throw new Error('no API key: run the seed first, or set STABLEHAND_LOOP_KEY');
}

function campaignIdNow(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 13);
  return `exp-${stamp}-${randomBytes(2).toString('hex')}`;
}

async function finishReview(
  api: StablehandApi,
  decision: ReviewDecision,
  context: { campaignId: string; productionAgentId: string; productionName: string; promoteWinner: () => Promise<void>; reviewTurnId: string },
): Promise<void> {
  if (decision === 'approve') {
    await context.promoteWinner();
    await emitEvent(api, `${EVENT_PREFIX}.promoted`, {
      campaign: context.campaignId,
      productionAgentId: context.productionAgentId,
      reviewTurnId: context.reviewTurnId,
    });
    console.log(`Approved. ${context.productionName} now runs the winning configuration.`);
  } else if (decision === 'reject') {
    console.log(`Rejected. ${context.productionName} is unchanged.`);
  } else if (decision === 'no-decision') {
    console.log('The reviewer run ended without an approval card being resolved; nothing was promoted.');
  } else {
    console.log('Still waiting on the approval card. After you decide, run:');
    console.log(`  pnpm -C packages/examples/experiment-loop loop -- --await ${context.campaignId}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const packageDir = findPackageDir(import.meta.url);
  const configPath = process.env.LOOP_CONFIG ? resolveFromPackage(process.cwd(), process.env.LOOP_CONFIG) : join(packageDir, 'loop.config.json');
  const config = await loadLoopConfig(configPath);
  const fromPackage = (path: string): string => resolveFromPackage(packageDir, path);
  const api = new StablehandApi({ baseUrl: process.env.API_URL ?? 'http://localhost:3002', token: loopToken(packageDir) });
  const production = (await loadManifest(fromPackage(config.agents.production))).manifest;
  const productionName = production.metadata.name;
  const productionAgent = await requireAgent(api, productionName);
  const candidateAgent = await requireAgent(api, candidateName(productionName));
  const turn = { timeoutSec: config.turnTimeoutSec };
  const promoteWinner = (winner: Parameters<typeof promote>[1]['winner']) => (): Promise<void> => promote(api, {
    productionAgentId: productionAgent.id,
    winner,
    fallbackManifest: production,
  });

  if (args.awaitCampaign) {
    const saved = await loadSavedCampaign(api, candidateAgent.id, args.awaitCampaign);
    if (!saved.reviewTurnId || !saved.reviewerAgentId) {
      console.log(`Campaign ${args.awaitCampaign} has no approval card to wait on.`);
      return;
    }
    const decision = await awaitReview(api, saved.reviewerAgentId, saved.reviewTurnId, {
      timeoutMs: config.approvalWaitMinutes * 60_000,
      log: (line) => console.log(line),
    });
    await finishReview(api, decision, {
      campaignId: args.awaitCampaign,
      productionAgentId: saved.productionAgentId,
      productionName,
      promoteWinner: promoteWinner(saved.result.winner),
      reviewTurnId: saved.reviewTurnId,
    });
    return;
  }

  const proposerAgent = await requireAgent(api, (await loadManifest(fromPackage(config.agents.proposer))).manifest.metadata.name);
  const reviewerAgent = args.review
    ? await requireAgent(api, (await loadManifest(fromPackage(config.agents.reviewer))).manifest.metadata.name)
    : null;
  const taskSet = await loadTaskSet(fromPackage(config.tasks));
  const sliceIds = args.slice ?? config.slice;
  const slice = pickTasks(taskSet, sliceIds);
  const holdout = args.holdout ? pickTasks(taskSet, config.holdout.filter((id) => !sliceIds.includes(id))) : [];
  const campaignId = campaignIdNow();

  console.log(`Campaign ${campaignId}: ${productionName}, ${slice.length}-task slice, `
    + `up to ${args.iterations ?? config.maxIterations} iterations, budget ${usd(args.budget ?? config.campaignBudgetUsd)}\n`);
  const result = await runCampaign({
    campaignId,
    agentName: productionName,
    baseline: configFromManifest(production),
    slice,
    holdout,
    searchSpace: effectiveSearchSpace(config.searchSpace, production),
    maxIterations: args.iterations ?? config.maxIterations,
    baselineRepeats: config.baselineRepeats,
    minGain: config.minGain,
    budgetUsd: args.budget ?? config.campaignBudgetUsd,
    proposerEstimateUsd: config.proposerEstimateUsd,
    maxInvalidInARow: config.maxInvalidInARow,
  }, createStablehandDeps({
    api,
    campaignId,
    campaignTag: config.campaign,
    productionManifest: production,
    candidateAgentId: candidateAgent.id,
    proposerAgentId: proposerAgent.id,
    concurrency: config.concurrency,
    turn,
    log: (line) => console.log(line),
  }));

  const published = await publishCampaign(api, {
    result,
    candidateAgentId: candidateAgent.id,
    productionAgentId: productionAgent.id,
    productionName,
    reviewerAgentId: reviewerAgent?.id ?? null,
    campaignTag: config.campaign,
  });

  console.log(`\nBaseline ${result.baselineScore.toFixed(3)}, best ${result.winnerScore.toFixed(3)} `
    + `(iteration ${result.winnerIteration}). Spent ${usd(result.spentUsd)} of ${usd(result.budgetUsd)}. `
    + `Stopped because ${stopText(result.stopReason)}.`);
  if (result.holdout) {
    console.log(`Held-out tasks: baseline ${result.holdout.baselineScore.toFixed(3)}, winner ${result.holdout.winnerScore.toFixed(3)}.`);
  } else if (result.holdoutNote) {
    console.log(`Held-out check: ${result.holdoutNote}.`);
  }
  console.log(`Results page: artifact ${published.resultsArtifactId} on ${candidateAgent.name} (Artifacts page, kind experiment-results).`);

  if (!published.reviewTurnId || !reviewerAgent) {
    console.log(result.winnerIteration > 0 ? 'Review is off; nothing was promoted.' : 'Nothing beat the baseline; nothing to promote.');
    return;
  }
  console.log(`\nWaiting up to ${config.approvalWaitMinutes} minutes for the approval card on ${reviewerAgent.name}.`);
  const decision = await awaitReview(api, reviewerAgent.id, published.reviewTurnId, {
    timeoutMs: config.approvalWaitMinutes * 60_000,
    log: (line) => console.log(line),
  });
  await finishReview(api, decision, {
    campaignId,
    productionAgentId: productionAgent.id,
    productionName,
    promoteWinner: promoteWinner(result.winner),
    reviewTurnId: published.reviewTurnId,
  });
}

main().catch((error: unknown) => {
  console.error('Experiment loop failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
