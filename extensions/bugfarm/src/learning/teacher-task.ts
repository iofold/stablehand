import { FEATURE_FIELDS, OPS_BY_TYPE, type CandidateFeatures } from '../shared/predicate.js';
import { GATE_LABELS, type BatchLearning } from '../shared/learning.js';
import { MAX_RULES_PER_BATCH } from './proposals.js';

/**
 * The Teacher's task text: one batch's cards as data, the playbook it ran with and what earlier
 * rules did. Rendered from stored rows only, so a restarted foreman renders the same text.
 */

export interface TeacherCard {
  pr: number | null;
  title: string;
  outcome: 'accepted' | 'rejected' | 'pending';
  reason: string | null;
  detail: string | null;
  features: CandidateFeatures;
  /**
   * What the Writer's turns submitted and what the leak check said about the last submission of
   * each: more than one draft submission means the check flagged an earlier draft.
   */
  writer: { draft_submissions: number; draft_clean: boolean | null; review_submissions: number; final_clean: boolean | null; leaks: string[] } | null;
  buggy_base: string | null;
  fail_to_pass: number | null;
  cost_usd: number | null;
}

export interface TeacherRule {
  id: string;
  kind: string;
  status: string;
  text: string;
  skip_if?: unknown;
  targets?: string | null;
  batch_introduced: number;
  effect?: string | null;
}

export interface TeacherTaskInput {
  repo: string;
  campaign: string;
  batch: number;
  learning: BatchLearning;
  history: BatchLearning[];
  cards: TeacherCard[];
  rules: TeacherRule[];
  /** Candidates a skip_if filter dropped before they became cards, with the rule that dropped them. */
  filtered: Array<{ pr: number | null; title: string; rule: string }>;
}

function fence(lang: string, body: string): string {
  const ticks = body.includes('```') ? '````' : '```';
  return `${ticks}${lang}\n${body.trimEnd()}\n${ticks}`;
}

function curveLine(b: BatchLearning): string {
  const share = b.share === null ? '—' : `${Math.round(b.share * 100)}%`;
  const per = b.usd_per_accepted === null ? '—' : `$${b.usd_per_accepted.toFixed(2)}`;
  const reasons = Object.entries(b.reasons).map(([r, n]) => `${r} ${n}`).join(', ') || 'none';
  return `- batch ${b.batch}: ${b.accepted}/${b.decided} accepted (${share}), $${b.cost_usd.toFixed(2)} spent, ${per} per accepted; rejects: ${reasons}${b.filtered ? `; ${b.filtered} dropped by filters` : ''}`;
}

export function teacherTask(input: TeacherTaskInput): string {
  const { learning } = input;
  const features = Object.entries(FEATURE_FIELDS)
    .map(([name, field]) => `- ${name} (${field.type}; ops ${OPS_BY_TYPE[field.type].join(' ')}): ${field.description}`)
    .join('\n');
  return [
    `Learn from Bugfarm batch ${input.batch} of campaign ${input.campaign} on ${input.repo}, and propose at most ${MAX_RULES_PER_BATCH} rule changes for batch ${input.batch + 1}.`,
    '',
    `Accepted means ${GATE_LABELS[learning.gate]}. Batch ${input.batch}: ${learning.candidates} candidates, ${learning.accepted} of ${learning.decided} decided accepted, $${learning.cost_usd.toFixed(2)} spent${learning.usd_per_accepted === null ? '' : ` ($${learning.usd_per_accepted.toFixed(2)} per accepted task)`}.`,
    '',
    'The curve so far:',
    [...input.history, learning].map(curveLine).join('\n'),
    '',
    `The cards of batch ${input.batch} (features are what a skip_if predicate can test):`,
    fence('json', JSON.stringify(input.cards, null, 1)),
    input.filtered.length > 0 ? `\nCandidates the playbook's filters dropped before they became cards:\n${fence('json', JSON.stringify(input.filtered, null, 1))}` : '',
    '',
    'The playbook this batch ran with, plus rules already measured (do not propose a reverted rule again):',
    fence('json', JSON.stringify(input.rules, null, 1)),
    '',
    'Features a skip_if predicate may test:',
    features,
    '',
    'Predicate shape: a condition {"field": ..., "op": ..., "value": ...}, or {"all": [...]}, {"any": [...]}, {"not": {...}}; at most 8 conditions. Regex ops (matches, any_matches, all_match, none_match) are case-insensitive. Example:',
    fence('json', JSON.stringify({ all: [{ field: 'age_days', op: '>', value: 300 }, { field: 'title', op: 'matches', value: '\\bv1\\b' }] })),
    '',
    `Call propose_rules once with {"summary": "...", "rules": [...]}. It checks each rule against batch ${input.batch} and tells you what a filter would have dropped; fix what it rejects and call it again with the full list (the last call counts). Submit an empty list if nothing in this batch is worth a rule.`,
  ].join('\n');
}
