/**
 * Execution Phase Tracker — tracks harness execution phases for safe suspend points.
 *
 * The sandbox daemon runs harness code and streams events to the orchestrator.
 * The orchestrator can send a Suspend RPC at any time, but state is only fully
 * serializable at certain "safe points" in the execution loop.
 *
 * This module provides a phase tracker that:
 * - Tracks the current execution phase
 * - Determines if the current phase is safe for suspension
 * - Provides cooperative suspend via a promise that resolves at the next safe point
 */

export type ExecutionPhase =
  | 'idle'
  | 'before_llm'
  | 'llm_call_in_flight'
  | 'after_llm'
  | 'before_tool'
  | 'tool_execution'
  | 'after_tool'
  | 'hitl_wait'
  | 'session_opening'
  | 'session_closing';

/**
 * Phases where it is safe to suspend and checkpoint state.
 * At these points, there is no in-flight async work that would be lost.
 */
export const SAFE_SUSPEND_PHASES: ReadonlySet<ExecutionPhase> = new Set([
  'idle',
  'before_llm',
  'after_llm',
  'after_tool',
  'hitl_wait',
]);

/**
 * Tracks the current execution phase of the harness loop and provides
 * cooperative suspend coordination.
 *
 * Suspend is cooperative: the runner checks at safe points whether a suspend
 * has been requested. If so, it breaks out of the event loop and allows the
 * daemon to capture a checkpoint.
 */
export class ExecutionPhaseTracker {
  private phase: ExecutionPhase = 'idle';
  /**
   * Branch-aware activity accounting (ctx-5abv). The scalar phase follows the
   * LAST event, so under parallel tools or subagent branches one branch's
   * safe-looking event (a committed parent message) can mask a sibling whose
   * tool is still mid-flight. Every open tool span — parent or subagent —
   * must close before a suspend decision may treat a safe phase as safe.
   */
  private readonly activeToolSpans = new Set<string>();
  private suspendRequested = false;
  private suspendResolve?: (value: void) => void;
  private suspendPromise?: Promise<void>;
  private currentTurnId?: string;
  private turnCount = 0;

  /** Get the current execution phase. */
  getPhase(): ExecutionPhase {
    return this.phase;
  }

  /**
   * Set the current execution phase.
   *
   * If entering a safe phase and a suspend was previously requested,
   * the pending suspend promise is resolved automatically.
   */
  setPhase(phase: ExecutionPhase): void {
    this.phase = phase;

    // If entering a quiescent safe state and suspend was requested, resolve.
    if (this.suspendRequested && this.isSuspendSafe()) {
      this.resolvePendingSuspend();
    }
  }

  /**
   * Record an opened tool span (parent or subagent branch). Span ids are the
   * tool-call ids, unique across branches.
   */
  noteToolSpanStart(id: string): void {
    this.activeToolSpans.add(id);
  }

  /** Close a tool span; may unblock a pending suspend at a safe phase. */
  noteToolSpanEnd(id: string): void {
    this.activeToolSpans.delete(id);
    if (this.suspendRequested && this.isSuspendSafe()) {
      this.resolvePendingSuspend();
    }
  }

  /** Number of tool spans currently open across all branches. */
  getActiveToolSpanCount(): number {
    return this.activeToolSpans.size;
  }

  /**
   * Check if suspension is currently safe: the scalar phase must be a safe
   * point AND every branch's tool span must have closed. Approval waits do
   * not block suspension — durable interrupts exist to suspend across them.
   */
  isSuspendSafe(): boolean {
    return SAFE_SUSPEND_PHASES.has(this.phase) && this.activeToolSpans.size === 0;
  }

  /**
   * Request suspension.
   *
   * - If currently at a safe point, resolves immediately.
   * - If at an unsafe point, sets a flag and returns a promise that resolves
   *   when the next safe point is reached.
   * - If a suspend is already requested, returns the existing pending promise.
   */
  requestSuspend(): Promise<void> {
    // If already requested, return the existing promise (or resolve immediately
    // if we've since reached a safe point)
    if (this.suspendRequested) {
      return this.suspendPromise ?? Promise.resolve();
    }

    this.suspendRequested = true;

    // If we're at a quiescent safe point right now, resolve immediately
    if (this.isSuspendSafe()) {
      this.suspendPromise = Promise.resolve();
      return this.suspendPromise;
    }

    // At an unsafe point — create a promise that resolves at the next safe point
    this.suspendPromise = new Promise<void>((resolve) => {
      this.suspendResolve = resolve;
    });

    return this.suspendPromise;
  }

  /**
   * Called when entering a safe phase to check if suspend was requested.
   * If suspend was requested, resolves the pending promise and returns true.
   * The runner should break out of the event loop when this returns true.
   */
  checkSuspendAtSafePoint(): boolean {
    if (!this.suspendRequested) return false;

    if (this.isSuspendSafe()) {
      this.resolvePendingSuspend();
      return true;
    }

    return false;
  }

  /**
   * Begin tracking a new turn. Sets phase to 'before_llm' and records the turn ID.
   */
  startTurn(turnId: string): void {
    this.currentTurnId = turnId;
    this.turnCount++;
    // A crashed branch can leave its span open forever; each turn's stream is
    // authoritative, so stale spans must not block every future suspend.
    this.activeToolSpans.clear();
    this.setPhase('before_llm');
  }

  /**
   * End the current turn. Clears the turn ID and sets phase back to 'idle'.
   */
  endTurn(): void {
    this.currentTurnId = undefined;
    this.activeToolSpans.clear();
    this.setPhase('idle');
  }

  /** Get the ID of the currently active turn, if any. */
  getCurrentTurnId(): string | undefined {
    return this.currentTurnId;
  }

  /** Get the total number of turns started on this tracker. */
  getTurnCount(): number {
    return this.turnCount;
  }

  /** Cancel a pending suspend request. */
  cancelSuspend(): void {
    this.suspendRequested = false;
    this.suspendResolve = undefined;
    this.suspendPromise = undefined;
  }

  /** Whether a suspend has been requested (pending or active). */
  isSuspendRequested(): boolean {
    return this.suspendRequested;
  }

  /** Resolve the pending suspend promise and clear the resolver. */
  private resolvePendingSuspend(): void {
    if (this.suspendResolve) {
      this.suspendResolve();
      this.suspendResolve = undefined;
    }
  }
}
