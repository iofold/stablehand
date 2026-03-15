// packages/ctxmill/src/workspace/fuse-overlay.ts

import { execFile, exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import {
  mkdirSync, existsSync, readdirSync, statSync,
  readFileSync, cpSync, rmSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import type {
  ExecutionEnvironment, ExecOptions, ExecResult,
  FileDiff, PromoteResult, EnvironmentFactory,
} from './types.js';

const execFileAsync = promisify(execFile);
const execAsync = promisify(execCb);

/**
 * FuseOverlayEnvironment — uses fuse-overlayfs for real overlay semantics.
 *
 * Requires `fuse-overlayfs` and `fusermount` binaries.
 * No root privileges needed (FUSE runs in userspace).
 *
 * Directory layout:
 *   {sessionRoot}/{sessionId}/upper/   ← session writes (copy-on-write)
 *   {sessionRoot}/{sessionId}/work/    ← overlayfs workdir
 *   {sessionRoot}/{sessionId}/merged/  ← what tools see (overlay mount point)
 */
export class FuseOverlayEnvironment implements ExecutionEnvironment {
  readonly sessionId: string;
  readonly basePath: string;
  readonly workspacePath: string;

  private readonly upperDir: string;
  private readonly workDir: string;
  private _isActive = false;

  constructor(basePath: string, sessionId: string, sessionRoot: string) {
    this.basePath = basePath;
    this.sessionId = sessionId;
    const sessionDir = join(sessionRoot, sessionId);
    this.upperDir = join(sessionDir, 'upper');
    this.workDir = join(sessionDir, 'work');
    this.workspacePath = join(sessionDir, 'merged');
  }

  get isActive(): boolean {
    return this._isActive;
  }

  async setup(): Promise<void> {
    if (this._isActive) return;

    // Check if already mounted by another instance (e.g., the run harness)
    if (existsSync(this.workspacePath) && await this.isMounted()) {
      this._isActive = true;
      return;
    }

    // Ensure base exists (may be empty for new agents)
    mkdirSync(this.basePath, { recursive: true });
    mkdirSync(this.upperDir, { recursive: true });
    mkdirSync(this.workDir, { recursive: true });
    mkdirSync(this.workspacePath, { recursive: true });

    // Mount fuse-overlayfs
    await execFileAsync('fuse-overlayfs', [
      '-o', `lowerdir=${this.basePath},upperdir=${this.upperDir},workdir=${this.workDir}`,
      this.workspacePath,
    ]);

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
        maxBuffer: 10 * 1024 * 1024,
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
    this.scanUpper(this.upperDir, '', diffs);
    return diffs;
  }

  async promote(): Promise<PromoteResult> {
    if (!this._isActive) throw new Error('Environment not active.');

    const changes = await this.diff();
    let added = 0, modified = 0, deleted = 0;

    // Use rsync for reliable copy (handles permissions, timestamps)
    if (changes.length > 0) {
      // Copy upper → base (only changed files)
      for (const change of changes) {
        const src = join(this.upperDir, change.path);
        const dst = join(this.basePath, change.path);

        if (change.type === 'deleted') {
          if (existsSync(dst)) {
            rmSync(dst, { force: true });
            deleted++;
          }
        } else {
          const dir = dst.substring(0, dst.lastIndexOf('/'));
          if (dir) mkdirSync(dir, { recursive: true });
          cpSync(src, dst);
          if (change.type === 'added') added++;
          else modified++;
        }
      }
    }

    return { added, modified, deleted };
  }

  async fork(targetBaseDir: string): Promise<void> {
    if (!this._isActive) throw new Error('Environment not active.');
    // Copy the merged view (base + session changes) to the target
    mkdirSync(targetBaseDir, { recursive: true });
    cpSync(this.workspacePath, targetBaseDir, { recursive: true });
  }

  async teardown(): Promise<void> {
    if (!this._isActive) return;
    this._isActive = false;

    // Unmount fuse-overlayfs
    try {
      await execAsync(`fusermount -u "${this.workspacePath}"`);
    } catch {
      // If fusermount fails, try lazy unmount
      try {
        await execAsync(`fusermount -uz "${this.workspacePath}"`);
      } catch { /* ignore — mount may already be gone */ }
    }

    // Clean up session directories
    const sessionDir = join(this.workspacePath, '..');
    try {
      rmSync(sessionDir, { recursive: true, force: true });
    } catch { /* ignore cleanup errors */ }
  }

  private async isMounted(): Promise<boolean> {
    try {
      const { stdout } = await execAsync(`mountpoint -q "${this.workspacePath}" && echo yes || echo no`);
      return stdout.trim() === 'yes';
    } catch {
      return false;
    }
  }

  /* ---- internal ---- */

  /**
   * Scan the upper directory to find what changed.
   * In overlayfs, the upper dir contains ONLY files that were modified/added.
   * Whiteout files (character device 0/0 or .wh.* prefixed) indicate deletions.
   */
  private scanUpper(dir: string, relDir: string, out: FileDiff[]): void {
    if (!existsSync(dir)) return;

    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;

      // fuse-overlayfs whiteout: character device 0,0 (keeps original name)
      // OR traditional .wh.<filename> prefix (used by some overlayfs implementations)
      if (entry.isCharacterDevice()) {
        out.push({ path: relPath, type: 'deleted' });
        continue;
      }
      if (entry.name.startsWith('.wh.')) {
        const deletedName = entry.name.slice(4); // remove .wh. prefix
        const deletedRel = relDir ? `${relDir}/${deletedName}` : deletedName;
        out.push({ path: deletedRel, type: 'deleted' });
        continue;
      }

      if (entry.isDirectory()) {
        this.scanUpper(join(dir, entry.name), relPath, out);
      } else if (entry.isFile()) {
        // Check if it existed in base
        const inBase = existsSync(join(this.basePath, relPath));
        out.push({ path: relPath, type: inBase ? 'modified' : 'added' });
      }
    }
  }
}

/* ---- Factory ---- */

export class FuseOverlayFactory implements EnvironmentFactory {
  readonly name = 'fuse-overlayfs';

  create(basePath: string, sessionId: string, sessionRoot: string): ExecutionEnvironment {
    return new FuseOverlayEnvironment(basePath, sessionId, sessionRoot);
  }

  async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync('fuse-overlayfs', ['--version']);
      // Also check /dev/fuse
      return existsSync('/dev/fuse');
    } catch {
      return false;
    }
  }
}
