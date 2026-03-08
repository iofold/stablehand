/**
 * Every pluggable module implements this lifecycle contract.
 * The container calls initialize() at startup, healthy() for readiness,
 * and shutdown() on graceful termination.
 */
export interface ServiceModule {
  readonly name: string;
  initialize?(): Promise<void>;
  healthy(): Promise<boolean>;
  shutdown(): Promise<void>;
}
