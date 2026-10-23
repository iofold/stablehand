import type { Grade } from './grader.js';
import type { Task } from './tasks.js';

export type Reasoning = 'off' | 'low' | 'medium' | 'high';
export type NativeTools = 'all' | 'none';

/**
 * The settings the loop may change on the agent under test. Everything else in
 * its manifest (name, tools, caps, tags) stays as written.
 */
export interface CandidateConfig {
  instructions: string;
  model: string;
  /** Unset means the harness default. */
  reasoning?: Reasoning;
  maxTokens?: number;
  nativeTools?: NativeTools;
}

/** What the proposer is allowed to change, and to which values. */
export interface SearchSpace {
  models: string[];
  reasoning: Reasoning[];
  maxTokens: { min: number; max: number } | null;
  nativeTools: NativeTools[];
  maxInstructionChars: number;
}

export interface Usage {
  costUsd: number;
  /** False while the gateway has not priced every model call yet. */
  costComplete: boolean;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export type RunStatus = 'COMPLETED' | 'ERROR' | 'CANCELLED' | 'TIMEOUT' | 'BLOCKED';

/** One task run on the agent under test. BLOCKED means the budget refused to start it. */
export interface TaskRun {
  taskId: string;
  turnId: string | null;
  status: RunStatus;
  answer: string;
  error?: string;
  usage: Usage;
}

export interface TaskResult extends TaskRun {
  repeat: number;
  score: number;
  grade: Grade;
}

export interface ProposerRun {
  turnId: string | null;
  status: RunStatus;
  text: string;
  error?: string;
  usage: Usage;
}

export type Role = 'baseline' | 'candidate' | 'proposer' | 'holdout-baseline' | 'holdout-winner' | 'reviewer';

export interface RunContext {
  campaignId: string;
  iteration: number;
  role: Role;
  repeat?: number;
}

export interface Comparison {
  pairs: number;
  meanGain: number;
  wins: number;
  losses: number;
  ties: number;
  margin: number;
}

export type Decision = 'baseline' | 'keep' | 'discard' | 'invalid' | 'stopped';

/** Cost and tokens of every run one iteration started, summed from the turn receipts. */
export interface Receipt {
  runs: number;
  turnIds: string[];
  costUsd: number;
  costComplete: boolean;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface IterationRecord {
  campaignId: string;
  iteration: number;
  decision: Decision;
  reason: string;
  /** The proposer's one-line summary, or "baseline". */
  summary: string;
  /** The configuration this iteration tested. */
  config: CandidateConfig;
  /** Diff against the configuration that was best before this iteration. */
  diff: string;
  /** Mean slice score of this iteration's run; null when nothing ran. */
  score: number | null;
  /** Best score after this iteration's decision. */
  bestScore: number;
  comparison: Comparison | null;
  results: TaskResult[];
  proposerTurnId: string | null;
  receipt: Receipt;
  /** Campaign spend after this iteration. */
  spentUsd: number;
  startedAt: string;
  finishedAt: string;
}

export type StopReason = 'iteration-cap' | 'budget' | 'budget-blocked' | 'solved' | 'proposer-failing';

export interface HoldoutCheck {
  taskIds: string[];
  baselineScore: number;
  winnerScore: number;
  receipt: Receipt;
  results: TaskResult[];
}

export interface CampaignResult {
  campaignId: string;
  agentName: string;
  sliceTaskIds: string[];
  baseline: CandidateConfig;
  baselineScore: number;
  winner: CandidateConfig;
  winnerScore: number;
  winnerIteration: number;
  margin: number;
  iterations: IterationRecord[];
  holdout: HoldoutCheck | null;
  holdoutNote: string | null;
  stopReason: StopReason;
  spentUsd: number;
  budgetUsd: number;
}

export interface LoopDeps {
  /** Point the agent under test at this configuration. */
  applyCandidate(config: CandidateConfig): Promise<void>;
  /** Run each task once on the agent under test. */
  runTasks(tasks: Task[], context: RunContext): Promise<TaskRun[]>;
  /** Ask the proposer agent for the next change. */
  propose(prompt: string, context: RunContext): Promise<ProposerRun>;
  grade(task: Task, answer: string): Grade;
  /** Leave the iteration's receipt and artifacts behind. */
  record(record: IterationRecord): Promise<void>;
  log(line: string): void;
}

export interface LoopSettings {
  campaignId: string;
  agentName: string;
  baseline: CandidateConfig;
  slice: Task[];
  holdout: Task[];
  searchSpace: SearchSpace;
  maxIterations: number;
  baselineRepeats: number;
  /** Smallest mean per-task gain worth keeping, before the measured noise. */
  minGain: number;
  budgetUsd: number;
  /** Used to project the first proposer call before one has run. */
  proposerEstimateUsd: number;
  maxInvalidInARow: number;
}
