export interface ExecutionTrace {
  id: string;
  agentId: string;
  runId: string;
  taskDescription: string;
  steps: TraceStep[];
  startedAt: Date;
  completedAt: Date;
  outcome: 'success' | 'failure' | 'partial' | 'unknown';
  metadata: Record<string, unknown>;
}

export interface TraceStep {
  ordinal: number;
  type:
    | 'llm_call'
    | 'tool_call'
    | 'tool_result'
    | 'reasoning'
    | 'error'
    | 'checkpoint';
  content: string;
  durationMs: number;
  metadata: Record<string, unknown>;
}

export interface FeedbackSignal {
  id: string;
  traceId: string;
  agentId: string;
  source: 'human' | 'environment' | 'automated';
  type: 'thumbs' | 'rating' | 'correction' | 'comparison';
  value: unknown;
  createdAt: Date;
}

export interface Insight {
  content: string;
  category: string;
  confidence: number;
}

export interface LearningPipeline {
  process(
    trace: ExecutionTrace,
    feedback?: FeedbackSignal[],
  ): Promise<Insight[]>;
  getKnowledge(agentId: string): Promise<string>;
}
