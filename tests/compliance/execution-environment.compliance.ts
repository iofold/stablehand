// tests/compliance/execution-environment.compliance.ts

/**
 * ExecutionEnvironment Compliance Test Suite
 *
 * Validates that any implementation of ExecutionEnvironment satisfies:
 *   - setup() creates an active environment
 *   - exec() runs commands with CWD at workspacePath
 *   - Writes in session do NOT appear in basePath
 *   - Reads fall through to basePath for unmodified files
 *   - diff() reports added/modified/deleted files
 *   - promote() merges session changes into basePath
 *   - fork() copies session state to a new directory
 *   - teardown() cleans up and leaves basePath unchanged
 *   - Concurrent sessions on the same base are isolated
 *
 * Usage:
 *   import { runEnvironmentCompliance } from './execution-environment.compliance.js';
 *   runEnvironmentCompliance('MockOverlay', () => factory.create(baseDir, sessionId, sessionRoot));
 */

import { describe, it, expect, afterEach, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';
import type { ExecutionEnvironment } from '../../packages/ctxmill/src/workspace/types.js';

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function createTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `ctxmill-test-${prefix}-`));
}

function writeBase(baseDir: string, relPath: string, content: string): void {
  const full = join(baseDir, relPath);
  const dir = full.substring(0, full.lastIndexOf('/'));
  if (dir) mkdirSync(dir, { recursive: true });
  writeFileSync(full, content, 'utf-8');
}

function readBase(baseDir: string, relPath: string): string | null {
  const full = join(baseDir, relPath);
  try { return readFileSync(full, 'utf-8'); } catch { return null; }
}

function baseExists(baseDir: string, relPath: string): boolean {
  return existsSync(join(baseDir, relPath));
}

/* ------------------------------------------------------------------ */
/*  Compliance suite                                                   */
/* ------------------------------------------------------------------ */

export function runEnvironmentCompliance(
  name: string,
  factory: (baseDir: string, sessionId: string, sessionRoot: string) => ExecutionEnvironment,
): void {
  const tempDirs: string[] = [];

  function makeDirs() {
    const baseDir = createTempDir('base');
    const sessionRoot = createTempDir('sessions');
    tempDirs.push(baseDir, sessionRoot);
    return { baseDir, sessionRoot };
  }

  afterEach(async () => {
    // Cleanup is handled per-test via teardown()
  });

  // Batch cleanup of temp dirs
  afterAll(() => {
    for (const d of tempDirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  /* ---------- setup / teardown ---------- */

  describe('setup / teardown', () => {
    it('setup() makes environment active', async () => {
      const { baseDir, sessionRoot } = makeDirs();
      const env = factory(baseDir, 'sess-1', sessionRoot);
      expect(env.isActive).toBe(false);
      await env.setup();
      expect(env.isActive).toBe(true);
      await env.teardown();
      expect(env.isActive).toBe(false);
    });

    it('teardown() is idempotent (calling twice does not throw)', async () => {
      const { baseDir, sessionRoot } = makeDirs();
      const env = factory(baseDir, 'sess-2', sessionRoot);
      await env.setup();
      await env.teardown();
      await env.teardown(); // second call should not throw
    });
  });

  /* ---------- exec ---------- */

  describe('exec', () => {
    it('runs a command and returns stdout', async () => {
      const { baseDir, sessionRoot } = makeDirs();
      const env = factory(baseDir, 'sess-exec-1', sessionRoot);
      await env.setup();
      const result = await env.exec('echo hello');
      expect(result.stdout.trim()).toBe('hello');
      expect(result.exitCode).toBe(0);
      await env.teardown();
    });

    it('returns non-zero exit code for failing commands', async () => {
      const { baseDir, sessionRoot } = makeDirs();
      const env = factory(baseDir, 'sess-exec-2', sessionRoot);
      await env.setup();
      const result = await env.exec('exit 42');
      expect(result.exitCode).toBe(42);
      await env.teardown();
    });

    it('captures stderr', async () => {
      const { baseDir, sessionRoot } = makeDirs();
      const env = factory(baseDir, 'sess-exec-3', sessionRoot);
      await env.setup();
      const result = await env.exec('echo oops >&2');
      expect(result.stderr.trim()).toBe('oops');
      await env.teardown();
    });
  });

  /* ---------- read-through to base ---------- */

  describe('read-through', () => {
    it('exec can read files that exist in base', async () => {
      const { baseDir, sessionRoot } = makeDirs();
      writeBase(baseDir, 'readme.txt', 'hello from base');
      const env = factory(baseDir, 'sess-read-1', sessionRoot);
      await env.setup();
      const result = await env.exec('cat readme.txt');
      expect(result.stdout.trim()).toBe('hello from base');
      await env.teardown();
    });

    it('exec can list files from base', async () => {
      const { baseDir, sessionRoot } = makeDirs();
      writeBase(baseDir, 'a.txt', 'a');
      writeBase(baseDir, 'b.txt', 'b');
      const env = factory(baseDir, 'sess-read-2', sessionRoot);
      await env.setup();
      const result = await env.exec('ls -1 | sort');
      expect(result.stdout.trim()).toBe('a.txt\nb.txt');
      await env.teardown();
    });
  });

  /* ---------- write isolation ---------- */

  describe('write isolation', () => {
    it('writes in session do NOT appear in base', async () => {
      const { baseDir, sessionRoot } = makeDirs();
      const env = factory(baseDir, 'sess-write-1', sessionRoot);
      await env.setup();
      await env.exec('echo session-only > newfile.txt');
      // Verify file is NOT in base
      expect(baseExists(baseDir, 'newfile.txt')).toBe(false);
      // But IS visible in session
      const result = await env.exec('cat newfile.txt');
      expect(result.stdout.trim()).toBe('session-only');
      await env.teardown();
    });

    it('modifying a base file does NOT change base', async () => {
      const { baseDir, sessionRoot } = makeDirs();
      writeBase(baseDir, 'config.txt', 'original');
      const env = factory(baseDir, 'sess-write-2', sessionRoot);
      await env.setup();
      await env.exec('echo modified > config.txt');
      // Session sees modified
      const sessResult = await env.exec('cat config.txt');
      expect(sessResult.stdout.trim()).toBe('modified');
      // Base is unchanged
      expect(readBase(baseDir, 'config.txt')).toBe('original');
      await env.teardown();
    });

    it('deleting a base file does NOT remove it from base', async () => {
      const { baseDir, sessionRoot } = makeDirs();
      writeBase(baseDir, 'delete-me.txt', 'still here');
      const env = factory(baseDir, 'sess-write-3', sessionRoot);
      await env.setup();
      await env.exec('rm delete-me.txt');
      // Session sees it as deleted
      const result = await env.exec('cat delete-me.txt 2>&1; echo $?');
      expect(result.stdout).toContain('1');
      // Base still has it
      expect(readBase(baseDir, 'delete-me.txt')).toBe('still here');
      await env.teardown();
    });
  });

  /* ---------- diff ---------- */

  describe('diff', () => {
    it('returns empty diff for clean session', async () => {
      const { baseDir, sessionRoot } = makeDirs();
      const env = factory(baseDir, 'sess-diff-1', sessionRoot);
      await env.setup();
      const d = await env.diff();
      expect(d).toEqual([]);
      await env.teardown();
    });

    it('reports added files', async () => {
      const { baseDir, sessionRoot } = makeDirs();
      const env = factory(baseDir, 'sess-diff-2', sessionRoot);
      await env.setup();
      await env.exec('echo new > added.txt');
      const d = await env.diff();
      expect(d).toContainEqual({ path: 'added.txt', type: 'added' });
      await env.teardown();
    });

    it('reports modified files', async () => {
      const { baseDir, sessionRoot } = makeDirs();
      writeBase(baseDir, 'existing.txt', 'v1');
      const env = factory(baseDir, 'sess-diff-3', sessionRoot);
      await env.setup();
      await env.exec('echo v2 > existing.txt');
      const d = await env.diff();
      expect(d).toContainEqual({ path: 'existing.txt', type: 'modified' });
      await env.teardown();
    });

    it('reports deleted files', async () => {
      const { baseDir, sessionRoot } = makeDirs();
      writeBase(baseDir, 'doomed.txt', 'bye');
      const env = factory(baseDir, 'sess-diff-4', sessionRoot);
      await env.setup();
      await env.exec('rm doomed.txt');
      const d = await env.diff();
      expect(d).toContainEqual({ path: 'doomed.txt', type: 'deleted' });
      await env.teardown();
    });
  });

  /* ---------- promote ---------- */

  describe('promote', () => {
    it('merges new files into base', async () => {
      const { baseDir, sessionRoot } = makeDirs();
      const env = factory(baseDir, 'sess-prom-1', sessionRoot);
      await env.setup();
      await env.exec('echo promoted > new.txt');
      const result = await env.promote();
      expect(result.added).toBe(1);
      expect(readBase(baseDir, 'new.txt')?.trim()).toBe('promoted');
      await env.teardown();
    });

    it('merges modifications into base', async () => {
      const { baseDir, sessionRoot } = makeDirs();
      writeBase(baseDir, 'data.txt', 'old');
      const env = factory(baseDir, 'sess-prom-2', sessionRoot);
      await env.setup();
      await env.exec('echo new > data.txt');
      const result = await env.promote();
      expect(result.modified).toBe(1);
      expect(readBase(baseDir, 'data.txt')?.trim()).toBe('new');
      await env.teardown();
    });

    it('merges deletions into base', async () => {
      const { baseDir, sessionRoot } = makeDirs();
      writeBase(baseDir, 'gone.txt', 'was here');
      const env = factory(baseDir, 'sess-prom-3', sessionRoot);
      await env.setup();
      await env.exec('rm gone.txt');
      const result = await env.promote();
      expect(result.deleted).toBe(1);
      expect(baseExists(baseDir, 'gone.txt')).toBe(false);
      await env.teardown();
    });

    it('does not touch unmodified base files', async () => {
      const { baseDir, sessionRoot } = makeDirs();
      writeBase(baseDir, 'untouched.txt', 'safe');
      writeBase(baseDir, 'changed.txt', 'v1');
      const env = factory(baseDir, 'sess-prom-4', sessionRoot);
      await env.setup();
      await env.exec('echo v2 > changed.txt');
      await env.promote();
      expect(readBase(baseDir, 'untouched.txt')).toBe('safe');
      await env.teardown();
    });
  });

  /* ---------- fork ---------- */

  describe('fork', () => {
    it('copies session state to a new directory', async () => {
      const { baseDir, sessionRoot } = makeDirs();
      writeBase(baseDir, 'base-file.txt', 'from base');
      const env = factory(baseDir, 'sess-fork-1', sessionRoot);
      await env.setup();
      await env.exec('echo session-file > new.txt');

      const forkTarget = createTempDir('fork-target');
      tempDirs.push(forkTarget);
      await env.fork(forkTarget);

      // Fork should have BOTH base file and session file
      expect(readBase(forkTarget, 'base-file.txt')?.trim()).toBe('from base');
      expect(readBase(forkTarget, 'new.txt')?.trim()).toBe('session-file');
      await env.teardown();
    });

    it('fork is independent — changing fork does not affect original session', async () => {
      const { baseDir, sessionRoot } = makeDirs();
      writeBase(baseDir, 'shared.txt', 'original');
      const env = factory(baseDir, 'sess-fork-2', sessionRoot);
      await env.setup();

      const forkTarget = createTempDir('fork-target-2');
      tempDirs.push(forkTarget);
      await env.fork(forkTarget);

      // Modify fork target directly
      writeFileSync(join(forkTarget, 'shared.txt'), 'modified in fork');

      // Original session still sees original
      const result = await env.exec('cat shared.txt');
      expect(result.stdout.trim()).toBe('original');
      await env.teardown();
    });
  });

  /* ---------- teardown leaves base clean ---------- */

  describe('teardown leaves base unchanged', () => {
    it('base is identical before and after session with writes', async () => {
      const { baseDir, sessionRoot } = makeDirs();
      writeBase(baseDir, 'stable.txt', 'immutable');
      const baseBefore = readBase(baseDir, 'stable.txt');

      const env = factory(baseDir, 'sess-tear-1', sessionRoot);
      await env.setup();
      await env.exec('echo danger > stable.txt');
      await env.exec('echo leak > newfile.txt');
      await env.teardown(); // discard, do NOT promote

      expect(readBase(baseDir, 'stable.txt')).toBe(baseBefore);
      expect(baseExists(baseDir, 'newfile.txt')).toBe(false);
    });
  });

  /* ---------- concurrent sessions ---------- */

  describe('concurrent sessions', () => {
    it('two sessions on the same base are isolated from each other', async () => {
      const { baseDir, sessionRoot } = makeDirs();
      writeBase(baseDir, 'shared.txt', 'base value');

      const envA = factory(baseDir, 'sess-conc-a', sessionRoot);
      const envB = factory(baseDir, 'sess-conc-b', sessionRoot);
      await envA.setup();
      await envB.setup();

      // A writes one thing
      await envA.exec('echo from-a > shared.txt');
      // B writes another
      await envB.exec('echo from-b > shared.txt');

      // Each sees their own version
      const rA = await envA.exec('cat shared.txt');
      const rB = await envB.exec('cat shared.txt');
      expect(rA.stdout.trim()).toBe('from-a');
      expect(rB.stdout.trim()).toBe('from-b');

      // Base is unchanged
      expect(readBase(baseDir, 'shared.txt')).toBe('base value');

      await envA.teardown();
      await envB.teardown();
    });

    it('file created in session A is NOT visible in session B', async () => {
      const { baseDir, sessionRoot } = makeDirs();
      const envA = factory(baseDir, 'sess-conc-c', sessionRoot);
      const envB = factory(baseDir, 'sess-conc-d', sessionRoot);
      await envA.setup();
      await envB.setup();

      await envA.exec('echo private > a-only.txt');
      const rB = await envB.exec('cat a-only.txt 2>&1; echo EXIT:$?');
      expect(rB.stdout).toContain('EXIT:1');

      await envA.teardown();
      await envB.teardown();
    });
  });
}
