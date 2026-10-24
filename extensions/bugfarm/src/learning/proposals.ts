import { z } from 'zod';
import { RULE_KINDS, type RuleKind } from '../playbook.js';
import { describePredicate, evaluatePredicate, predicateProblems, type CandidateFeatures, type Predicate } from '../shared/predicate.js';

/**
 * The Teacher's `propose_rules` submissions: validated against the batch it learned from, and
 * dry-run there, so every rule that goes on trial is well-formed, targets a reason that actually
 * happened and, for a Scout filter, would have caught at least one of those rejects.
 */

export const MAX_RULES_PER_BATCH = 3;

export const ProposalSchema = z.object({
  kind: z.enum(RULE_KINDS),
  text: z.string().trim().min(10).max(600),
  skip_if: z.unknown().optional().nullable(),
  targets: z.string().trim().regex(/^[a-z][a-z0-9_]{1,60}$/, 'targets: a rejection reason such as no_fail_to_pass'),
  expected_effect: z.string().trim().min(5).max(500),
});

export const ProposeRulesSchema = z.object({
  summary: z.string().trim().max(2000).nullish(),
  rules: z.array(z.unknown()).max(MAX_RULES_PER_BATCH, `at most ${MAX_RULES_PER_BATCH} rule changes per batch`),
});

export interface Proposal {
  kind: RuleKind;
  text: string;
  skip_if?: Predicate;
  targets: string;
  expected_effect: string;
}

export interface ProposalCard {
  key: string;
  pr?: number | null;
  /** Passed the campaign's gate. */
  accepted: boolean;
  /** Rejection reason when it was rejected (at the gate). */
  reason: string | null;
  features: CandidateFeatures;
}

export interface ExistingRule {
  id: string;
  kind?: string;
  text: string;
  status?: string;
  skip_if?: Predicate | null;
}

export interface DryRun {
  /** Cards in the batch the filter would have dropped. */
  would_skip: number;
  /** Of those, rejected for the target reason. */
  target_rejects_caught: number;
  target_rejects: number;
  /** Of those, cards that were accepted. */
  accepted_lost: number;
  /** Cards it could not judge (a feature was missing). */
  unknown: number;
  skipped: Array<{ pr: number | null; outcome: string }>;
}

export interface ProposalReport {
  index: number;
  ok: boolean;
  errors: string[];
  warnings: string[];
  rule?: Proposal;
  predicate?: string;
  dry_run?: DryRun;
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function dryRun(pred: Predicate, cards: ProposalCard[], target: string): DryRun {
  const out: DryRun = { would_skip: 0, target_rejects_caught: 0, target_rejects: 0, accepted_lost: 0, unknown: 0, skipped: [] };
  for (const card of cards) {
    const hitTarget = !card.accepted && card.reason === target;
    if (hitTarget) out.target_rejects++;
    const verdict = evaluatePredicate(pred, card.features);
    if (verdict === null) {
      out.unknown++;
      continue;
    }
    if (!verdict) continue;
    out.would_skip++;
    if (hitTarget) out.target_rejects_caught++;
    if (card.accepted) out.accepted_lost++;
    out.skipped.push({ pr: card.pr ?? null, outcome: card.accepted ? 'accepted' : `rejected: ${card.reason ?? 'unknown'}` });
  }
  return out;
}

/**
 * Check every proposed rule. Returns one report per entry; a rule is `ok` only with no errors.
 * `reasons` are the batch's rejection reasons at the campaign's gate.
 */
export function reviewProposals(opts: {
  rules: unknown[];
  batch: number;
  reasons: Record<string, number>;
  cards: ProposalCard[];
  existing: ExistingRule[];
  /**
   * Env recipes reach only the Env builder, which runs when a repo's environment is built. Set
   * when the campaign's environment is built and every later batch reuses it, so a recipe could
   * not change the next batch and its trial would measure noise.
   */
  envBuilt?: string | null;
}): ProposalReport[] {
  const seenText = new Map<string, ExistingRule>();
  const seenPredicate = new Map<string, ExistingRule>();
  for (const rule of opts.existing) {
    seenText.set(normalize(rule.text), rule);
    if (rule.skip_if) seenPredicate.set(JSON.stringify(rule.skip_if), rule);
  }
  const reasonList = Object.entries(opts.reasons).filter(([, n]) => n > 0).map(([reason, n]) => `${reason} (${n})`).join(', ') || 'none';
  return opts.rules.map((raw, index) => {
    const report: ProposalReport = { index, ok: false, errors: [], warnings: [] };
    const parsed = ProposalSchema.safeParse(raw);
    if (!parsed.success) {
      report.errors.push(...parsed.error.issues.slice(0, 4).map((issue) => `${issue.path.join('.') || '(rule)'}: ${issue.message}`));
      return report;
    }
    const input = parsed.data;
    const rule: Proposal = { kind: input.kind, text: input.text, targets: input.targets, expected_effect: input.expected_effect };
    if (input.kind === 'env_recipe' && opts.envBuilt) {
      report.errors.push(`kind: an env_recipe only reaches the Env builder, and this campaign's environment (${opts.envBuilt}) is already built and reused by every later batch, so it cannot change the next batch. Propose a scout_filter or a writer_rule instead, or nothing.`);
    }
    if ((opts.reasons[input.targets] ?? 0) === 0) {
      report.errors.push(`targets: no card in batch ${opts.batch} was rejected for ${input.targets}. Target one that was: ${reasonList}.`);
    }
    const dupText = seenText.get(normalize(input.text));
    if (dupText) report.errors.push(`text: the playbook already has this rule (${dupText.id}, ${dupText.status ?? 'kept'})${dupText.status === 'reverted' ? '; it was reverted on measurement, so do not propose it again' : ''}.`);
    if (input.skip_if !== undefined && input.skip_if !== null) {
      if (input.kind !== 'scout_filter') {
        report.errors.push('skip_if: only scout_filter rules take a predicate');
      } else {
        const problems = predicateProblems(input.skip_if);
        if (problems.length > 0) report.errors.push(...problems);
        else {
          const pred = input.skip_if as Predicate;
          rule.skip_if = pred;
          report.predicate = describePredicate(pred);
          const dupPred = seenPredicate.get(JSON.stringify(pred));
          if (dupPred) {
            report.errors.push(dupPred.status === 'proposed'
              ? `skip_if: ${dupPred.id} in this submission has the same predicate; one filter drops a candidate once, so give it one rule with the target it catches most.`
              : `skip_if: rule ${dupPred.id} (${dupPred.status ?? 'kept'}) already has this predicate.`);
          } else {
            seenPredicate.set(JSON.stringify(pred), { id: `rule ${index}`, text: input.text, status: 'proposed', skip_if: pred });
          }
          const run = dryRun(pred, opts.cards, input.targets);
          report.dry_run = run;
          if (run.target_rejects > 0 && run.target_rejects_caught === 0) {
            report.errors.push(`skip_if: it would not have dropped any of the ${run.target_rejects} card(s) rejected for ${input.targets} in batch ${opts.batch}; a filter has to catch the failure it targets.`);
          }
          if (run.accepted_lost > run.target_rejects_caught) {
            report.errors.push(`skip_if: it would have dropped ${run.accepted_lost} accepted card(s) to catch ${run.target_rejects_caught} reject(s); narrow it.`);
          } else if (run.accepted_lost > 0) {
            report.warnings.push(`it would also have dropped ${run.accepted_lost} accepted card(s)`);
          }
          if (run.unknown > 0) report.warnings.push(`${run.unknown} card(s) lack a feature it uses; it never drops those`);
        }
      }
    } else if (input.kind === 'scout_filter') {
      report.warnings.push('no skip_if: this filter is prose the Scout may or may not follow; a predicate is code the worker applies');
    }
    report.rule = rule;
    report.ok = report.errors.length === 0;
    return report;
  });
}
