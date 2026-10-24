import type { BoardRow, RulePayload } from './shared/board.js';
import type { Predicate } from './shared/predicate.js';
import type { UpsertInput } from './store/validate.js';

/**
 * The playbook: `rule` rows in the board store that the floor agents read at the start of every
 * turn, rendered as `rules.json`. Three kinds:
 *
 * - `scout_filter`: what the Scout should skip or prefer;
 * - `writer_rule`: how the Writer phrases an instruction;
 * - `env_recipe`: what the Env builder knows about building a repo's environment.
 *
 * Rules come from `bugfarm seed` (starters), `bugfarm rule add` (by hand) and the Teacher, which
 * proposes them after each batch (src/learning/). A new rule is on `trial` for one batch and is
 * then kept or reverted on measurement. A rule with status `reverted` is kept for the record and
 * never served. A Scout filter with `skip_if` is code: the worker drops the candidates it matches.
 */

export const RULE_KINDS = ['scout_filter', 'writer_rule', 'env_recipe'] as const;
export type RuleKind = (typeof RULE_KINDS)[number];

export interface PlaybookRule {
  id: string;
  kind: RuleKind;
  text: string;
  /** Limits the rule to one repository (`owner/name`). */
  repo?: string;
  /** `trial` while it is being measured, `kept` once it earned its place. */
  status?: 'trial' | 'kept';
  /** Scout filters: candidates matching this predicate are dropped by the worker. */
  skip_if?: Predicate;
}

export interface RulesJson {
  scout_filters: PlaybookRule[];
  writer_rules: PlaybookRule[];
  env_recipes: PlaybookRule[];
}

export interface PlaybookStore {
  currentOfKind(kind: 'rule'): Promise<BoardRow<'rule'>[]>;
}

function isRuleKind(value: unknown): value is RuleKind {
  return typeof value === 'string' && (RULE_KINDS as readonly string[]).includes(value);
}

export async function loadPlaybook(store: PlaybookStore, repo?: string): Promise<RulesJson> {
  const rules: RulesJson = { scout_filters: [], writer_rules: [], env_recipes: [] };
  for (const row of await store.currentOfKind('rule')) {
    const payload = row.payload as RulePayload & { repo?: string };
    if (payload.simulated || payload.status === 'reverted' || !isRuleKind(payload.kind)) continue;
    if (repo && payload.repo && payload.repo !== repo) continue;
    const rule: PlaybookRule = {
      id: row.key,
      kind: payload.kind,
      text: payload.text,
      ...(payload.repo ? { repo: payload.repo } : {}),
      ...(payload.status === 'trial' || payload.status === 'kept' ? { status: payload.status } : {}),
      ...(payload.kind === 'scout_filter' && payload.skip_if ? { skip_if: payload.skip_if } : {}),
    };
    if (payload.kind === 'scout_filter') rules.scout_filters.push(rule);
    else if (payload.kind === 'writer_rule') rules.writer_rules.push(rule);
    else rules.env_recipes.push(rule);
  }
  return rules;
}

/** The slice of rules.json one agent needs, as pretty JSON for its task. */
export function rulesFor(rules: RulesJson, role: 'scout' | 'env_builder' | 'writer'): string {
  const pick = role === 'scout'
    ? { scout_filters: rules.scout_filters }
    : role === 'writer' ? { writer_rules: rules.writer_rules } : { env_recipes: rules.env_recipes };
  return JSON.stringify(pick, (key, value: unknown) => (key === 'kind' ? undefined : value), 2);
}

/** Rules every new board starts with. Written once by `bugfarm seed`; edit or revert them freely. */
export const STARTER_RULES: Array<{ id: string; kind: RuleKind; text: string; repo?: string }> = [
  { id: 'scout-skip-non-fixes', kind: 'scout_filter', text: 'Skip pull requests that only change docs, translations, typing, CI or dependency pins, even when the title says "fix".' },
  { id: 'scout-prefer-issues', kind: 'scout_filter', text: 'Prefer pull requests that close an issue with a reproduction: the issue text becomes the best instruction.' },
  { id: 'scout-prefer-behavior', kind: 'scout_filter', text: 'Prefer fixes whose tests assert user-visible behaviour (a response, a value, an exception) over refactors and warnings.' },
  { id: 'writer-symptom', kind: 'writer_rule', text: 'Describe the symptom as a user would report it: what they ran, what they expected and what happened instead. Never say where the bug is or how to fix it.' },
  { id: 'writer-repro', kind: 'writer_rule', text: 'Include a minimal reproduction that uses only the public API, written fresh; never paste the hidden test.' },
  { id: 'writer-no-internals', kind: 'writer_rule', text: 'Do not name source files, private helpers or the functions the fix edits, and do not quote any line of the diff.' },
  {
    id: 'env-fastapi',
    kind: 'env_recipe',
    repo: 'fastapi/fastapi',
    text: 'fastapi installs with `pip install -e ".[all]" --group tests` (pip 25.1+ for dependency groups). Uninstall pytest-sugar and pytest-codspeed afterwards: they rewrite pytest output.',
  },
  {
    id: 'env-python-base',
    kind: 'env_recipe',
    text: 'Start FROM python:3.12-slim, install git and patch with apt, set PIP_NO_CACHE_DIR=1, copy the tree to /app, install the package in editable mode with its test dependencies, and create /logs/verifier, /logs/agent and /logs/artifacts.',
  },
];

export function starterRuleRows(): UpsertInput[] {
  return STARTER_RULES.map((rule) => ({
    kind: 'rule',
    key: rule.id,
    payload: { text: rule.text, kind: rule.kind, batch_introduced: 0, status: 'kept', ...(rule.repo ? { repo: rule.repo } : {}), source: 'starter' },
  }));
}
