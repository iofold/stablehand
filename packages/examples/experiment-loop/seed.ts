/**
 * Seed the experiment loop against a running Stablehand: the production agent
 * (only if it does not exist yet), its candidate twin, the proposer and the
 * reviewer, one tag budget for the campaign, and a scoped key for the loop.
 * Safe to re-run: it updates what exists and never resets production.
 *
 * Environment:
 *   API_URL               Stablehand API (default http://localhost:3002)
 *   STABLEHAND_API_TOKEN  master token; the seed creates budgets and keys
 *   LOOP_CONFIG           config file (default ./loop.config.json)
 *   RESET_PRODUCTION=1    put the production agent back to its manifest
 */

import { existsSync } from 'node:fs';
import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { AgentManifest } from '@stablehand/manifest';
import { manifestToAgentCreateInput, manifestToAgentPatchInput } from '@stablehand/manifest';

import { StablehandApi } from './src/api.js';
import {
  candidateManifest,
  configFromManifest,
  findPackageDir,
  loadLoopConfig,
  loadManifest,
  resolveFromPackage,
} from './src/config.js';

export const LOOP_KEY_CAPABILITIES = [
  'agents:read',
  'agents:write',
  'conversations:write',
  'events:read',
  'artifacts:read',
  'artifacts:write',
  'triggers:emit:custom.experiment.*',
] as const;

export interface SeedOptions {
  apiUrl: string;
  token?: string;
  packageDir: string;
  configPath?: string;
  resetProduction?: boolean;
  /** Where to save the loop's scoped key (default <packageDir>/.loop-key). */
  keyFile?: string;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
}

export interface SeedResult {
  agents: Record<'production' | 'candidate' | 'proposer' | 'reviewer', string>;
  budgetPolicy: string;
  keyFile: string | null;
}

function withCampaignTag(manifest: AgentManifest, campaign: string): AgentManifest {
  const next = structuredClone(manifest);
  next.spec.defaultTags = { ...(next.spec.defaultTags ?? {}), campaign };
  return next;
}

export async function seed(options: SeedOptions): Promise<SeedResult> {
  const log = options.log ?? ((line: string) => console.log(line));
  const api = new StablehandApi({
    baseUrl: options.apiUrl,
    ...(options.token ? { token: options.token } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  const config = await loadLoopConfig(options.configPath ?? join(options.packageDir, 'loop.config.json'));
  const fromPackage = (path: string): string => resolveFromPackage(options.packageDir, path);
  const production = (await loadManifest(fromPackage(config.agents.production))).manifest;
  const proposer = withCampaignTag((await loadManifest(fromPackage(config.agents.proposer))).manifest, config.campaign);
  const reviewer = withCampaignTag((await loadManifest(fromPackage(config.agents.reviewer))).manifest, config.campaign);
  const candidate = candidateManifest(production, configFromManifest(production), config.campaign);

  log(`\nSeeding the experiment loop against ${options.apiUrl}\n\nAgents`);
  const listed = await api.get<Array<{ id: string; name: string }>>('/api/agents');
  const existing = new Map(listed.map((agent) => [agent.name, agent.id]));
  const upsert = async (manifest: AgentManifest, keepExisting = false): Promise<string> => {
    const id = existing.get(manifest.metadata.name);
    if (id && keepExisting) {
      log(`  kept ${manifest.metadata.name} as it is (RESET_PRODUCTION=1 puts it back to the manifest)`);
      return id;
    }
    if (id) {
      await api.patch(`/api/agents/${id}`, manifestToAgentPatchInput(manifest));
      log(`  updated ${manifest.metadata.name}`);
      return id;
    }
    const created = await api.post<{ id: string }>('/api/agents', manifestToAgentCreateInput(manifest));
    log(`  created ${manifest.metadata.name}`);
    return created.id;
  };
  const agents = {
    production: await upsert(production, !options.resetProduction),
    candidate: await upsert(candidate),
    proposer: await upsert(proposer),
    reviewer: await upsert(reviewer),
  };

  log('\nBudget');
  const budgetName = `${config.campaign} tag budget`;
  const doc = {
    selector: { campaign: config.campaign },
    window: config.tagBudget.window,
    limits: { costUsd: config.tagBudget.usd, turns: config.tagBudget.runs },
    actions: [
      { threshold: 0.5, action: 'warn' },
      { threshold: 1, action: 'block' },
    ],
  };
  const { policies } = await api.get<{ policies: Array<{ id: string; name: string }> }>('/api/budgets');
  const policy = policies.find((entry) => entry.name === budgetName);
  const budgetPolicy = policy
    ? (await api.patch<{ id: string }>(`/api/budgets/${policy.id}`, { doc, enabled: true })).id ?? policy.id
    : (await api.post<{ id: string }>('/api/budgets', { name: budgetName, enabled: true, doc })).id;
  log(`  ${budgetName}: $${config.tagBudget.usd} and ${config.tagBudget.runs} runs per ${config.tagBudget.window} `
    + `for every run tagged campaign=${config.campaign}; warns at 50%, blocks new runs at 100%`);

  log('\nAccess key');
  const keyName = `${config.campaign}-loop`;
  const keyFile = options.keyFile ?? join(options.packageDir, '.loop-key');
  const { keys } = await api.get<{ keys: Array<{ id: string; name: string; status: string }> }>('/api/keys');
  const activeKey = keys.find((key) => key.name === keyName && key.status === 'active');
  let savedKeyFile: string | null = null;
  if (activeKey && existsSync(keyFile)) {
    log(`  ${keyName} exists; the loop reads it from ${keyFile}`);
    savedKeyFile = keyFile;
  } else if (activeKey) {
    log(`  ${keyName} exists but ${keyFile} is missing. Revoke the key under Settings, Access keys and re-run the seed,`);
    log('  or pass the key to the loop as STABLEHAND_LOOP_KEY.');
  } else {
    const created = await api.post<{ token: string }>('/api/keys', {
      name: keyName,
      capabilities: [...LOOP_KEY_CAPABILITIES],
      note: 'Experiment loop (packages/examples/experiment-loop): runs candidates, reads receipts, writes artifacts',
    });
    await writeFile(keyFile, `${created.token}\n`, { mode: 0o600 });
    await chmod(keyFile, 0o600);
    savedKeyFile = keyFile;
    log(`  created ${keyName} with ${LOOP_KEY_CAPABILITIES.join(', ')}`);
    log(`  saved it to ${keyFile} (mode 600); it is not printed`);
  }

  log('\nSeed complete. Start a campaign with:');
  log('  pnpm -C packages/examples/experiment-loop loop');
  return { agents, budgetPolicy, keyFile: savedKeyFile };
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const packageDir = findPackageDir(import.meta.url);
  seed({
    apiUrl: process.env.API_URL ?? 'http://localhost:3002',
    ...(process.env.STABLEHAND_API_TOKEN ? { token: process.env.STABLEHAND_API_TOKEN } : {}),
    packageDir,
    ...(process.env.LOOP_CONFIG ? { configPath: resolveFromPackage(process.cwd(), process.env.LOOP_CONFIG) } : {}),
    resetProduction: process.env.RESET_PRODUCTION === '1',
  }).catch((error: unknown) => {
    console.error('Seed failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
