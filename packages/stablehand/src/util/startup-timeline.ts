import { performance } from 'node:perf_hooks';

/** Records consecutive startup phases; each mark closes the phase that just ended. */
export interface StartupPhaseRecorder {
  mark(phase: string, detail?: string): void;
}

export interface StartupPhase {
  phase: string;
  durationMs: number;
  detail?: string;
}

/**
 * Boot timeline measured from process start (ctx-new8). Phases are
 * sequential, so their durations add up to the time until the last mark;
 * the first mark covers module loading before any startup code ran.
 */
export class StartupTimeline implements StartupPhaseRecorder {
  private readonly phases: StartupPhase[] = [];
  private lastMarkMs = 0;

  constructor(private readonly now: () => number = () => performance.now()) {}

  mark(phase: string, detail?: string): void {
    const at = this.now();
    this.phases.push({
      phase,
      durationMs: Math.max(0, at - this.lastMarkMs),
      ...(detail ? { detail } : {}),
    });
    this.lastMarkMs = at;
  }

  /** Milliseconds from process start to the latest mark. */
  get elapsedMs(): number {
    return this.lastMarkMs;
  }

  list(): readonly StartupPhase[] {
    return this.phases;
  }

  summary(): string {
    const phases = this.phases
      .map(({ phase, durationMs, detail }) =>
        `${phase} ${Math.round(durationMs)} ms${detail ? ` (${detail})` : ''}`)
      .join(', ');
    return `[startup] ready ${Math.round(this.elapsedMs)} ms after process start: ${phases}`;
  }
}
