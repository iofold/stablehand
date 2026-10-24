// One campaign budget for a bench: a cost-blocking budget policy on the `campaign` tag (which caps
// every StablehandAgent turn, at admission and mid-run) and a campaign gateway key under it (which
// the terminus-2 cells call models with). The key's spend counts against the same policy.
import { existsSync } from 'node:fs';
import { mintCampaignKey, readCampaignKey } from '../../pipeline/calibrate-gateway.ts';
import type { CampaignKeyFile } from '../../pipeline/calibrate-gateway.ts';
import { api, findBudgetPolicy } from './spend.ts';
import type { Api } from './spend.ts';

export interface CampaignSetup {
  policy: { id: string; name: string; state: 'created' | 'existing'; cap_usd: number | null };
  key: { id: string; alias: string; state: 'created' | 'existing'; max_budget_usd: number | null; models: string[]; file: string } | null;
}

export async function ensureCampaign(a: Api, opts: { campaign: string; capUsd: number; models: string[]; keyFile: string; name?: string }): Promise<CampaignSetup> {
  let state: CampaignSetup['policy']['state'] = 'existing';
  let policy = await findBudgetPolicy(a, opts.campaign);
  if (!policy) {
    policy = await api<NonNullable<typeof policy>>(a, 'POST', '/api/budgets', {
      name: opts.name ?? `campaign ${opts.campaign}`,
      enabled: true,
      doc: {
        selector: { campaign: opts.campaign },
        window: 'rolling-30d',
        limits: { costUsd: opts.capUsd },
        actions: [
          { threshold: 0.5, action: 'warn' },
          { threshold: 0.85, action: 'warn' },
          { threshold: 1, action: 'block' },
        ],
      },
    });
    state = 'created';
  } else if ((policy.doc?.limits?.costUsd ?? 0) !== opts.capUsd) {
    throw new Error(`campaign ${opts.campaign} already has a budget (${policy.name}) capped at $${policy.doc?.limits?.costUsd}; change it in Stablehand, or use a new campaign tag`);
  }
  let key: CampaignSetup['key'] = null;
  if (opts.models.length) {
    let k: CampaignKeyFile;
    let keyState: 'created' | 'existing' = 'existing';
    if (existsSync(opts.keyFile)) k = readCampaignKey(opts.keyFile);
    else {
      k = await mintCampaignKey({ url: a.url, token: a.token }, { name: `${opts.campaign} bench`, tags: { campaign: opts.campaign }, models: opts.models, maxBudgetUsd: opts.capUsd, keyFile: opts.keyFile });
      keyState = 'created';
    }
    key = { id: k.id, alias: k.key_alias, state: keyState, max_budget_usd: k.max_budget_usd, models: k.models, file: opts.keyFile };
  }
  return { policy: { id: policy.id, name: policy.name, state, cap_usd: policy.doc?.limits?.costUsd ?? null }, key };
}
