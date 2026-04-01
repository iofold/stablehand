import type { ExecutionTrace } from './types.js';

/**
 * DB row shape expected by DatabaseRepository.saveTrace().
 * Dates are epoch milliseconds, steps are passed as-is (Drizzle JSON column).
 */
export interface TraceDbRow {
  id: string;
  agentId: string;
  sessionId: string;
  taskDescription: string;
  steps: unknown[];
  startedAt: number;
  completedAt: number;
  outcome: string;
}

/**
 * Convert an ExecutionTrace (domain object with Date fields) into the flat
 * row format expected by the database layer.
 *
 * - Date fields are converted to epoch milliseconds
 * - outcome defaults to 'unknown' if missing
 * - steps are passed through (Drizzle handles JSON serialisation)
 */
export function traceToDbRow(trace: ExecutionTrace): TraceDbRow {
  return {
    id: trace.id,
    agentId: trace.agentId,
    sessionId: trace.turnId,
    taskDescription: trace.taskDescription,
    steps: trace.steps,
    startedAt: trace.startedAt.getTime(),
    completedAt: trace.completedAt.getTime(),
    outcome: trace.outcome ?? 'unknown',
  };
}

/**
 * Convert a DB trace row back into an ExecutionTrace domain object.
 * Handles missing/null fields gracefully.
 */
export function dbRowToTrace(row: {
  id: string;
  agentId: string;
  sessionId: string;
  taskDescription: string;
  steps: unknown;
  startedAt: number;
  completedAt: number | null;
  outcome: string | null;
}): ExecutionTrace {
  return {
    id: row.id,
    agentId: row.agentId,
    turnId: row.sessionId,
    taskDescription: row.taskDescription,
    steps: (Array.isArray(row.steps) ? row.steps : []) as ExecutionTrace['steps'],
    startedAt: new Date(row.startedAt),
    completedAt: new Date(row.completedAt ?? Date.now()),
    outcome: (row.outcome as ExecutionTrace['outcome']) ?? 'unknown',
    metadata: {},
  };
}
