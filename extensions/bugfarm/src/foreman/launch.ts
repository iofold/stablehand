import { z } from 'zod';
import { PROFILES } from '../../pipeline/lib/repos.ts';
import { DEFAULT_CONFIG, type CampaignConfig } from './foreman.js';

/** `POST /internal/v1/campaigns` body. Everything but the repo has a default. */
export const LaunchBodySchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'id: lowercase letters, digits and dashes').optional(),
  repo: z.string().refine((repo) => repo in PROFILES, `repo must be one of: ${Object.keys(PROFILES).join(', ')}`),
  batch_size: z.number().int().min(1).max(50).optional(),
  batches: z.number().int().min(1).max(20).optional(),
  cap_usd: z.number().positive().max(10_000).optional(),
  budget_tag: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/).optional(),
  since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  writer_concurrency: z.number().int().min(1).max(10).optional(),
  turn_timeout_min: z.number().int().min(5).max(180).optional(),
  rebuild_env: z.boolean().optional(),
  calibration_usd: z.number().nonnegative().max(1_000).optional(),
  learning: z.boolean().optional(),
  learning_gate: z.enum(['auto', 'controls', 'calibration']).optional(),
});

function stamp(now: Date): string {
  return now.toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
}

export function campaignConfigFrom(body: unknown, now = new Date()): { id: string; config: CampaignConfig } {
  const parsed = LaunchBodySchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw Object.assign(new Error(`invalid campaign: ${issue?.path.join('.') ?? ''} ${issue?.message ?? ''}`.trim()), { status: 400 });
  }
  const input = parsed.data;
  const slug = PROFILES[input.repo].slug;
  const id = input.id ?? `${slug}-${stamp(now)}`;
  return {
    id,
    config: {
      ...DEFAULT_CONFIG,
      ...Object.fromEntries(Object.entries(input).filter(([key, value]) => key !== 'id' && value !== undefined)),
      repo: input.repo,
      budget_tag: input.budget_tag ?? id,
    } as CampaignConfig,
  };
}
