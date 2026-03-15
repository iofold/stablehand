// packages/ctxmill/src/workspace/types.ts

/**
 * ExecutionEnvironment — the OS-level boundary where tools run.
 *
 * Tools inside see a normal filesystem via native syscalls.
 * The environment handles isolation transparently.
 *
 * Implementations:
 *   - MockOverlayEnvironment  (plain dirs, always available, for tests)
 *   - FuseOverlayEnvironment  (fuse-overlayfs, Level 1)
 *   - DockerEnvironment       (Docker overlay2, Level 2)
 *   - FirecrackerEnvironment  (Firecracker + kernel overlayfs, Level 3)
 */
export interface ExecutionEnvironment {
  /** Unique session/run identifier. */
  readonly sessionId: string;

  /** Absolute path to the merged workspace (what tools see). */
  readonly workspacePath: string;

  /** Absolute path to the base workspace (read-only reference). */
  readonly basePath: string;

  /** Whether setup() has been called and teardown() has NOT. */
  readonly isActive: boolean;

  /** Set up the isolation boundary (mount overlay / start container / boot VM). */
  setup(): Promise<void>;

  /**
   * Execute a command inside the boundary.
   * The command's CWD is `workspacePath`. Standard syscalls hit the overlay.
   */
  exec(command: string, opts?: ExecOptions): Promise<ExecResult>;

  /** List files changed in this session vs base. */
  diff(): Promise<FileDiff[]>;

  /** Merge session changes into the base workspace. */
  promote(): Promise<PromoteResult>;

  /** Copy session state into a new base directory (for forking agents). */
  fork(targetBaseDir: string): Promise<void>;

  /** Tear down the boundary (unmount / destroy container). Does NOT promote. */
  teardown(): Promise<void>;
}

export interface ExecOptions {
  /** Override CWD (relative to workspacePath). Default: workspacePath root. */
  cwd?: string;
  /** Timeout in ms. Default: 30_000. */
  timeout?: number;
  /** Environment variables to set. */
  env?: Record<string, string>;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface FileDiff {
  /** Relative path from workspace root. */
  path: string;
  type: 'added' | 'modified' | 'deleted';
}

export interface PromoteResult {
  /** Number of files added to base. */
  added: number;
  /** Number of files modified in base. */
  modified: number;
  /** Number of files deleted from base. */
  deleted: number;
}

/**
 * Factory that creates an ExecutionEnvironment for a given session.
 * Injected via DI container based on configured isolation level.
 */
export interface EnvironmentFactory {
  /**
   * Create an environment for a run.
   * @param basePath - Absolute path to the agent's base workspace.
   * @param sessionId - Unique run/session ID.
   * @param sessionRoot - Parent directory for session storage (upper/work/merged dirs live here).
   */
  create(basePath: string, sessionId: string, sessionRoot: string): ExecutionEnvironment;

  /** Human-readable name (e.g. 'mock', 'fuse-overlayfs', 'docker'). */
  readonly name: string;

  /** Check whether this factory's backend is available on this host. */
  isAvailable(): Promise<boolean>;
}
