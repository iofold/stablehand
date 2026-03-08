import { randomUUID } from 'node:crypto';
import type { ExecutionTrace, TraceStep } from './types.js';

export class TraceCollector {
  private steps: TraceStep[] = [];
  private startTime: number;
  private agentId: string;
  private runId: string;
  private taskDescription: string;

  constructor(agentId: string, runId: string, taskDescription: string) {
    this.agentId = agentId;
    this.runId = runId;
    this.taskDescription = taskDescription;
    this.startTime = Date.now();
  }

  addStep(
    type: TraceStep['type'],
    content: string,
    durationMs: number,
    metadata?: Record<string, unknown>,
  ): void {
    this.steps.push({
      ordinal: this.steps.length,
      type,
      content,
      durationMs,
      metadata: metadata ?? {},
    });
  }

  finalize(outcome: ExecutionTrace['outcome']): ExecutionTrace {
    return {
      id: randomUUID(),
      agentId: this.agentId,
      runId: this.runId,
      taskDescription: this.taskDescription,
      steps: [...this.steps],
      startedAt: new Date(this.startTime),
      completedAt: new Date(),
      outcome,
      metadata: {},
    };
  }
}
