import { renderConfig } from './diff.js';
import { describeFailures, extractJsonObject } from './grader.js';
import { renderTaskPrompt, type Task } from './tasks.js';
import type { CandidateConfig, IterationRecord, NativeTools, Reasoning, SearchSpace, TaskResult } from './types.js';

const clip = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max)}\n[... ${text.length - max} more characters]`);

function describeSpace(space: SearchSpace): string[] {
  const lines = [`- instructions: the complete new text, at most ${space.maxInstructionChars} characters`];
  if (space.models.length > 1) lines.push(`- model: one of ${space.models.join(', ')}`);
  if (space.reasoning.length > 0) lines.push(`- reasoning: one of ${space.reasoning.join(', ')}`);
  if (space.maxTokens) lines.push(`- maxTokens: a whole number from ${space.maxTokens.min} to ${space.maxTokens.max}`);
  if (space.nativeTools.length > 1) lines.push(`- nativeTools: one of ${space.nativeTools.join(', ')} (all gives the agent a shell and files in its sandbox)`);
  return lines;
}

export interface ProposerInput {
  agentName: string;
  best: CandidateConfig;
  bestScore: number;
  /** The best configuration's own results on the slice. */
  bestResults: TaskResult[];
  tasks: Task[];
  history: IterationRecord[];
  space: SearchSpace;
}

/** The task text the proposer agent receives. */
export function buildProposerPrompt(input: ProposerInput): string {
  const tasksById = new Map(input.tasks.map((task) => [task.id, task]));
  const failures = input.bestResults.filter((result) => result.score < 1);
  const failureBlocks = failures.map((result) => {
    const task = tasksById.get(result.taskId);
    return [
      `### ${result.taskId} (score ${result.score.toFixed(2)})${task ? `: ${task.title}` : ''}`,
      'Task given to the agent:',
      '"""',
      task ? clip(renderTaskPrompt(task), 1600) : '(unknown task)',
      '"""',
      'Agent\'s answer:',
      '"""',
      result.status === 'COMPLETED' ? clip(result.answer.trim() || '(empty)', 700) : `(the run ended with ${result.status}${result.error ? `: ${result.error}` : ''})`,
      '"""',
      'Grader:',
      ...describeFailures(result.grade).map((line) => `- ${line}`),
    ].join('\n');
  });
  const tried = input.history
    .filter((record) => record.decision !== 'baseline')
    .map((record) => `- iteration ${record.iteration}, ${record.decision}${record.comparison ? ` (${record.comparison.meanGain >= 0 ? '+' : ''}${record.comparison.meanGain.toFixed(3)})` : ''}: ${record.summary}${record.decision === 'invalid' ? ` [${record.reason}]` : ''}`);

  return [
    `Improve the configuration of the agent "${input.agentName}" so it scores higher on the tasks below.`,
    '',
    `Current best configuration (mean score ${input.bestScore.toFixed(3)} on ${input.tasks.length} tasks):`,
    '"""',
    renderConfig(input.best),
    '"""',
    '',
    'Settings you may change:',
    ...describeSpace(input.space),
    '',
    `Tasks the current configuration did not get fully right (${failures.length} of ${input.tasks.length}):`,
    '',
    failureBlocks.length > 0 ? failureBlocks.join('\n\n') : '(none)',
    '',
    'Changes tried so far:',
    ...(tried.length > 0 ? tried : ['(none yet)']),
    '',
    'Reply with one JSON object and nothing else:',
    '{"summary": "<one sentence: what you changed and which failures it fixes>", "instructions": "<the complete new instructions>"}',
    'Add "model", "reasoning", "maxTokens" or "nativeTools" only when you change them and they are listed above.',
  ].join('\n');
}

/**
 * Values from the answer key that must not show up in proposed instructions.
 * Short values, and words the task request itself uses, are left out so a
 * general rule ("answer refund, replacement or store_credit") is not flagged.
 */
export function answerKeyValues(tasks: readonly Task[]): string[] {
  const values = new Set<string>();
  for (const task of tasks) {
    const requestText = (task.kind === 'extraction' ? Object.values(task.fields).join(' ') : task.question).toLowerCase();
    const expected = task.kind === 'extraction'
      ? Object.values(task.expected)
      : Array.isArray(task.expected) ? task.expected : [task.expected];
    for (const value of expected) {
      if (typeof value === 'string' && value.trim().length >= 5 && !requestText.includes(value.toLowerCase())) {
        values.add(value.trim());
      }
      if (typeof value === 'number' && String(Math.abs(value)).replace(/^0\.0*|\./g, '').length >= 4) {
        values.add(String(value));
      }
    }
  }
  return [...values];
}

function leakedValue(before: string, after: string, keys: readonly string[]): string | null {
  const lowerBefore = before.toLowerCase();
  const lowerAfter = after.toLowerCase();
  for (const key of keys) {
    const pattern = /^[\d.]+$/.test(key)
      ? new RegExp(`(^|[^\\d.])${key.replace(/\./g, '\\.')}($|[^\\d])`)
      : null;
    const inAfter = pattern ? pattern.test(lowerAfter) : lowerAfter.includes(key.toLowerCase());
    const inBefore = pattern ? pattern.test(lowerBefore) : lowerBefore.includes(key.toLowerCase());
    if (inAfter && !inBefore) return key;
  }
  return null;
}

export type ProposalResult =
  | { ok: true; config: CandidateConfig; summary: string }
  | { ok: false; reason: string; summary: string };

const REASONING: ReadonlySet<string> = new Set(['off', 'low', 'medium', 'high']);

export function parseProposal(
  text: string,
  best: CandidateConfig,
  space: SearchSpace,
  answerKey: readonly string[],
): ProposalResult {
  const object = extractJsonObject(text);
  if (!object) return { ok: false, reason: 'the proposer did not reply with a JSON object', summary: '(no proposal)' };
  const summary = typeof object.summary === 'string' && object.summary.trim() ? object.summary.trim().slice(0, 300) : '(no summary)';
  const fail = (reason: string): ProposalResult => ({ ok: false, reason, summary });
  const next: CandidateConfig = { ...best };

  if (object.instructions !== undefined) {
    if (typeof object.instructions !== 'string' || object.instructions.trim().length < 20) {
      return fail('instructions must be the complete new text');
    }
    if (object.instructions.length > space.maxInstructionChars) {
      return fail(`instructions are ${object.instructions.length} characters; the limit is ${space.maxInstructionChars}`);
    }
    next.instructions = object.instructions.trim();
  }
  if (object.model !== undefined) {
    if (typeof object.model !== 'string' || !space.models.includes(object.model)) return fail(`model ${String(object.model)} is not allowed`);
    next.model = object.model;
  }
  if (object.reasoning !== undefined) {
    if (typeof object.reasoning !== 'string' || !REASONING.has(object.reasoning) || !space.reasoning.includes(object.reasoning as Reasoning)) {
      return fail(`reasoning ${String(object.reasoning)} is not allowed`);
    }
    next.reasoning = object.reasoning as Reasoning;
  }
  if (object.maxTokens !== undefined) {
    const limits = space.maxTokens;
    if (!limits || typeof object.maxTokens !== 'number' || !Number.isInteger(object.maxTokens)
      || object.maxTokens < limits.min || object.maxTokens > limits.max) {
      return fail(`maxTokens ${String(object.maxTokens)} is not allowed`);
    }
    next.maxTokens = object.maxTokens;
  }
  if (object.nativeTools !== undefined) {
    if (typeof object.nativeTools !== 'string' || !space.nativeTools.includes(object.nativeTools as NativeTools)) {
      return fail(`nativeTools ${String(object.nativeTools)} is not allowed`);
    }
    next.nativeTools = object.nativeTools as NativeTools;
  }
  if (JSON.stringify(renderConfig(next)) === JSON.stringify(renderConfig(best))) {
    return fail('the proposal changes nothing');
  }
  const leaked = leakedValue(best.instructions, next.instructions, answerKey);
  if (leaked) return fail(`the instructions copy an expected answer (${leaked}) from the tasks`);
  return { ok: true, config: next, summary };
}
