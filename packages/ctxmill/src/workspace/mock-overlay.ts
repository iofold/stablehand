// packages/ctxmill/src/workspace/mock-overlay.ts

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  mkdirSync, existsSync, readdirSync, statSync,
  readFileSync, writeFileSync, unlinkSync, cpSync, rmSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import type {
  ExecutionEnvironment, ExecOptions, ExecResult,
  FileDiff, PromoteResult, EnvironmentFactory,
} from './types.js';

const execFileAsync = promisify(execFile);

/**
 * MockOverlayEnvironment — simulates overlay semantics using plain directories.
 *
 * On setup():
 *   - Copies base -> merged (full copy, not a real overlay)
 *   - Snapshots base file hashes for diff computation
 *
 * On exec():
 *   - Runs command with cwd = merged directory
 *
 * On diff():
 *   - Compares merged vs base snapshot
 *
 * On promote():
 *   - Copies changed/added files from merged -> base
 *   - Deletes from base any files deleted in merged
 *
 * On teardown():
 *   - Removes merged directory
 *
 * This is NOT a real overlay — it copies the full base on setup.
 * Use only for testing and development. For production, use FuseOverlayEnvironment.
 */
export class MockOverlayEnvironment implements ExecutionEnvironment {
  readonly sessionId: string;
  readonly basePath: string;
  readonly workspacePath: string;

  private _isActive = false;
  private baseSnapshot: Map<string, string> = new Map(); // relPath -> content hash

  constructor(basePath: string, sessionId: string, sessionRoot: string) {
    this.basePath = basePath;
    this.sessionId = sessionId;
    this.workspacePath = join(sessionRoot, sessionId, 'merged');
  }

  get isActive(): boolean {
    return this._isActive;
  }

  async setup(): Promise<void> {
    if (this._isActive) return;

    // If merged dir already exists (from a previous session), reuse it
    // rather than re-copying base (which would wipe session changes).
    if (!existsSync(this.workspacePath)) {
      mkdirSync(this.workspacePath, { recursive: true });
      if (existsSync(this.basePath)) {
        cpSync(this.basePath, this.workspacePath, { recursive: true });
      }
    }

    // Snapshot base for diff computation
    this.baseSnapshot = this.hashDir(this.basePath);
    this._isActive = true;
  }

  async exec(command: string, opts?: ExecOptions): Promise<ExecResult> {
    if (!this._isActive) throw new Error('Environment not active. Call setup() first.');

    const cwd = opts?.cwd
      ? join(this.workspacePath, opts.cwd)
      : this.workspacePath;

    try {
      const { stdout, stderr } = await execFileAsync('bash', ['-c', command], {
        cwd,
        timeout: opts?.timeout ?? 30_000,
        env: { ...process.env, ...opts?.env },
        maxBuffer: 10 * 1024 * 1024, // 10MB
      });
      return { stdout, stderr, exitCode: 0 };
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; code?: number };
      return {
        stdout: e.stdout ?? '',
        stderr: e.stderr ?? '',
        exitCode: typeof e.code === 'number' ? e.code : 1,
      };
    }
  }

  async diff(): Promise<FileDiff[]> {
    if (!this._isActive) return [];

    const diffs: FileDiff[] = [];
    const currentFiles = this.hashDir(this.workspacePath);

    // Check for added and modified
    for (const [path, hash] of currentFiles) {
      const baseHash = this.baseSnapshot.get(path);
      if (baseHash === undefined) {
        diffs.push({ path, type: 'added' });
      } else if (baseHash !== hash) {
        diffs.push({ path, type: 'modified' });
      }
    }

    // Check for deleted
    for (const path of this.baseSnapshot.keys()) {
      if (!currentFiles.has(path)) {
        diffs.push({ path, type: 'deleted' });
      }
    }

    return diffs;
  }

  async promote(): Promise<PromoteResult> {
    if (!this._isActive) throw new Error('Environment not active.');

    const changes = await this.diff();
    let added = 0, modified = 0, deleted = 0;

    for (const change of changes) {
      const src = join(this.workspacePath, change.path);
      const dst = join(this.basePath, change.path);

      if (change.type === 'deleted') {
        if (existsSync(dst)) { unlinkSync(dst); deleted++; }
      } else {
        const dir = dst.substring(0, dst.lastIndexOf('/'));
        if (dir) mkdirSync(dir, { recursive: true });
        cpSync(src, dst);
        if (change.type === 'added') added++;
        else modified++;
      }
    }

    // Update snapshot after promote
    this.baseSnapshot = this.hashDir(this.basePath);
    return { added, modified, deleted };
  }

  async fork(targetBaseDir: string): Promise<void> {
    if (!this._isActive) throw new Error('Environment not active.');
    mkdirSync(targetBaseDir, { recursive: true });
    cpSync(this.workspacePath, targetBaseDir, { recursive: true });
  }

  async teardown(): Promise<void> {
    if (!this._isActive) return;
    this._isActive = false;
    try {
      rmSync(this.workspacePath, { recursive: true, force: true });
    } catch { /* ignore cleanup errors */ }
  }

  /* ---- internal helpers ---- */

  private hashDir(dir: string): Map<string, string> {
    const result = new Map<string, string>();
    if (!existsSync(dir)) return result;
    this.walkDir(dir, dir, result);
    return result;
  }

  private walkDir(root: string, current: string, out: Map<string, string>): void {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        this.walkDir(root, full, out);
      } else if (entry.isFile()) {
        const rel = relative(root, full);
        // Simple hash: use file size + first 1KB as fingerprint
        const stat = statSync(full);
        const content = readFileSync(full, 'utf-8').slice(0, 1024);
        out.set(rel, `${stat.size}:${content}`);
      }
    }
  }
}

/* ---- Factory ---- */

export class MockOverlayFactory implements EnvironmentFactory {
  readonly name = 'mock';

  create(basePath: string, sessionId: string, sessionRoot: string): ExecutionEnvironment {
    return new MockOverlayEnvironment(basePath, sessionId, sessionRoot);
  }

  async isAvailable(): Promise<boolean> {
    return true; // Always available
  }
}
