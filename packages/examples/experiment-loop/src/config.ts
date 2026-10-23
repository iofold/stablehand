import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AgentManifest } from '@stablehand/manifest';
import { loadManifestProject } from '@stablehand/manifest/node';

import type { CandidateConfig, NativeTools, Reasoning, SearchSpace } from './types.js';

export interface LoopConfig {
  /** Value of the `campaign` tag on every run; the tag budget selects on it. */
  campaign: string;
  agents: { production: string; proposer: string; reviewer: string };
  tasks: string;
  slice: string[];
  holdout: string[];
  maxIterations: number;
  baselineRepeats: number;
  minGain: number;
  campaignBudgetUsd: number;
  tagBudget: { window: 'rolling-1h' | 'rolling-24h' | 'rolling-7d' | 'rolling-30d' | 'month-to-date'; usd: number; runs: number };
  searchSpace: SearchSpace;
  concurrency: number;
  turnTimeoutSec: number;
  approvalWaitMinutes: number;
  proposerEstimateUsd: number;
  maxInvalidInARow: number;
}

/** The example's directory, from source (tests) or from dist/ (scripts). */
export function findPackageDir(fromUrl: string): string {
  let dir = dirname(fileURLToPath(fromUrl));
  for (let depth = 0; depth < 4; depth += 1) {
    if (existsSync(join(dir, 'loop.config.json'))) return dir;
    dir = dirname(dir);
  }
  throw new Error('could not find loop.config.json above the running script');
}

export async function loadLoopConfig(path: string): Promise<LoopConfig> {
  const config = JSON.parse(await readFile(path, 'utf8')) as LoopConfig;
  const problems: string[] = [];
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(config.campaign ?? '')) problems.push('campaign must be lowercase letters, digits and dashes');
  if (!Array.isArray(config.slice) || config.slice.length === 0) problems.push('slice needs at least one task id');
  if (config.slice?.some((id) => config.holdout?.includes(id))) problems.push('a task cannot be in both slice and holdout');
  if (!(config.maxIterations >= 1)) problems.push('maxIterations must be at least 1');
  if (!(config.campaignBudgetUsd > 0)) problems.push('campaignBudgetUsd must be positive');
  if (!(config.searchSpace?.models?.length > 0)) problems.push('searchSpace.models needs at least the baseline model');
  if (problems.length > 0) throw new Error(`invalid ${path}: ${problems.join('; ')}`);
  return config;
}

export function resolveFromPackage(packageDir: string, path: string): string {
  return resolve(packageDir, path);
}

export interface LoadedManifest {
  manifest: AgentManifest;
  instructions: string;
}

export async function loadManifest(path: string): Promise<LoadedManifest> {
  const project = await loadManifestProject(path);
  if (project.workspace.fileCount > 0) {
    throw new Error(`${path}: agents with workspace files are not supported by the experiment loop yet`);
  }
  const manifest = structuredClone(project.manifest);
  manifest.spec.instructions = project.resolvedInstructions;
  return { manifest, instructions: project.resolvedInstructions };
}

type HarnessConfigRecord = Record<string, unknown>;

function harnessConfigOf(manifest: AgentManifest): HarnessConfigRecord {
  return manifest.spec.harnessConfig as unknown as HarnessConfigRecord;
}

/** The loop's settings as they stand in a manifest: the baseline. */
export function configFromManifest(manifest: AgentManifest): CandidateConfig {
  const harnessConfig = harnessConfigOf(manifest);
  const config: CandidateConfig = {
    instructions: manifest.spec.instructions,
    model: String(harnessConfig.model),
  };
  if (manifest.spec.harness === 'langgraph') {
    if (typeof harnessConfig.reasoning === 'string') config.reasoning = harnessConfig.reasoning as Reasoning;
    if (typeof harnessConfig.maxTokens === 'number') config.maxTokens = harnessConfig.maxTokens;
  }
  const policy = manifest.spec.nativeToolPolicy?.policy;
  if (policy === 'all' || policy === 'none') config.nativeTools = policy as NativeTools;
  return config;
}

/** Write the loop's settings into a copy of a manifest; everything else stays. */
export function applyConfig(manifest: AgentManifest, config: CandidateConfig): AgentManifest {
  const next = structuredClone(manifest);
  next.spec.instructions = config.instructions;
  const harnessConfig = harnessConfigOf(next);
  harnessConfig.model = config.model;
  if (next.spec.harness === 'langgraph') {
    if (config.reasoning === undefined) delete harnessConfig.reasoning;
    else harnessConfig.reasoning = config.reasoning;
    if (config.maxTokens === undefined) delete harnessConfig.maxTokens;
    else harnessConfig.maxTokens = config.maxTokens;
  }
  if (config.nativeTools !== undefined) next.spec.nativeToolPolicy = { policy: config.nativeTools };
  return next;
}

/**
 * The agent the loop runs: the production manifest with the candidate's
 * settings, its own name, and the campaign tag on every run.
 */
export function candidateManifest(production: AgentManifest, config: CandidateConfig, campaign: string): AgentManifest {
  const next = applyConfig(production, config);
  next.metadata.name = candidateName(production.metadata.name);
  next.metadata.displayName = `${production.metadata.displayName ?? production.metadata.name} (experiment candidate)`;
  next.metadata.description = `Candidate configurations for ${production.metadata.name}, run by the experiment loop. Not for production traffic.`;
  next.spec.defaultTags = { ...(next.spec.defaultTags ?? {}), campaign };
  next.spec.mode = 'background';
  return next;
}

export function candidateName(productionName: string): string {
  return `${productionName}-candidate`;
}

/** Settings the harness cannot take are dropped from the search space. */
export function effectiveSearchSpace(space: SearchSpace, production: AgentManifest): SearchSpace {
  if (production.spec.harness === 'langgraph') return space;
  return { ...space, reasoning: [], maxTokens: null };
}
