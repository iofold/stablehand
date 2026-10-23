import type { Grade } from '../src/grader.js';
import type { ExtractionTask, Task } from '../src/tasks.js';
import type {
  CandidateConfig,
  IterationRecord,
  LoopDeps,
  LoopSettings,
  ProposerRun,
  RunContext,
  TaskRun,
  Usage,
} from '../src/types.js';

export function fakeTask(id: string, expected = 'pass'): ExtractionTask {
  return { id, kind: 'extraction', title: `Task ${id}`, fields: { answer: 'the answer' }, document: `Document for ${id}`, expected: { answer: expected } };
}

/** Decides what the agent under test answers: "pass", "half" or "fail". */
export type Behaviour = (config: CandidateConfig, taskId: string, context: RunContext) => 'pass' | 'half' | 'fail' | 'blocked';

export interface FakeOptions {
  behaviour: Behaviour;
  /** Proposer replies, one per call; the last one repeats. */
  proposals: Array<string | ((call: number) => string)>;
  taskCostUsd?: number;
  proposerCostUsd?: number;
}

const usage = (costUsd: number): Usage => ({ costUsd, costComplete: true, inputTokens: 100, outputTokens: 20, totalTokens: 120 });

/** A stand-in for Stablehand: answers come from `behaviour`, proposals from a script. */
export class FakeStablehand implements LoopDeps {
  applied: CandidateConfig[] = [];
  records: IterationRecord[] = [];
  prompts: string[] = [];
  runs: Array<{ context: RunContext; taskIds: string[] }> = [];
  lines: string[] = [];
  private turn = 0;

  constructor(private readonly options: FakeOptions) {}

  private get current(): CandidateConfig {
    const config = this.applied.at(-1);
    if (!config) throw new Error('runTasks before applyCandidate');
    return config;
  }

  async applyCandidate(config: CandidateConfig): Promise<void> {
    this.applied.push(config);
  }

  async runTasks(tasks: Task[], context: RunContext): Promise<TaskRun[]> {
    this.runs.push({ context, taskIds: tasks.map((task) => task.id) });
    return tasks.map((task) => {
      const answer = this.options.behaviour(this.current, task.id, context);
      if (answer === 'blocked') {
        return { taskId: task.id, turnId: null, status: 'BLOCKED', answer: '', error: 'budget exhausted', usage: usage(0) };
      }
      this.turn += 1;
      return { taskId: task.id, turnId: `turn-${this.turn}`, status: 'COMPLETED', answer, usage: usage(this.options.taskCostUsd ?? 0.01) };
    });
  }

  async propose(prompt: string, _context: RunContext): Promise<ProposerRun> {
    this.prompts.push(prompt);
    const script = this.options.proposals[Math.min(this.prompts.length - 1, this.options.proposals.length - 1)];
    const text = typeof script === 'function' ? script(this.prompts.length) : script ?? '';
    this.turn += 1;
    return { turnId: `turn-${this.turn}`, status: 'COMPLETED', text, usage: usage(this.options.proposerCostUsd ?? 0.005) };
  }

  /** The fake grader: "pass" scores 1, "half" 0.5, anything else 0. */
  grade(task: Task, answer: string): Grade {
    const score = answer === 'pass' ? 1 : answer === 'half' ? 0.5 : 0;
    return {
      taskId: task.id,
      score,
      checks: [{ name: 'answer', ok: score === 1, expected: 'pass', got: answer }],
    };
  }

  async record(record: IterationRecord): Promise<void> {
    this.records.push(record);
  }

  log(line: string): void {
    this.lines.push(line);
  }
}

export const proposal = (instructions: string, summary = 'a change'): string => JSON.stringify({ summary, instructions });

export const BASELINE: CandidateConfig = {
  instructions: 'Base instructions for the fake agent.',
  model: 'model-small',
  maxTokens: 1000,
};

export function settings(overrides: Partial<LoopSettings> = {}): LoopSettings {
  return {
    campaignId: 'exp-test',
    agentName: 'fake-agent',
    baseline: BASELINE,
    slice: ['t1', 't2', 't3', 't4'].map((id) => fakeTask(id)),
    holdout: [],
    searchSpace: {
      models: ['model-small', 'model-large'],
      reasoning: [],
      maxTokens: { min: 500, max: 4000 },
      nativeTools: [],
      maxInstructionChars: 2000,
    },
    maxIterations: 6,
    baselineRepeats: 1,
    minGain: 0.05,
    budgetUsd: 10,
    proposerEstimateUsd: 0.02,
    maxInvalidInARow: 2,
    ...overrides,
  };
}
