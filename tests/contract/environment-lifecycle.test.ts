/**
 * Environment Lifecycle Contract Suite
 *
 * Runs the same session lifecycle spec against both MockOverlay and FuseOverlay backends.
 * FuseOverlay tests are skipped if fuse-overlayfs is not available on the host.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync, writeFileSync, readFileSync, existsSync,
  mkdirSync, rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MockOverlayFactory } from '../../packages/ctxmill/src/workspace/mock-overlay.js';
import { FuseOverlayFactory } from '../../packages/ctxmill/src/workspace/fuse-overlay.js';
import type { EnvironmentFactory, ExecutionEnvironment } from '../../packages/ctxmill/src/workspace/types.js';

const backends: Array<{
  name: string;
  factory: EnvironmentFactory;
  available: () => Promise<boolean>;
}> = [
  {
    name: 'MockOverlay',
    factory: new MockOverlayFactory(),
    available: async () => true,
  },
  {
    name: 'FuseOverlay',
    factory: new FuseOverlayFactory(),
    available: () => new FuseOverlayFactory().isAvailable(),
  },
];

for (const backend of backends) {
  describe(`[${backend.name}] environment lifecycle contract`, () => {
    let skip = false;
    let tmpDir: string;
    let baseDir: string;
    let sessionsDir: string;
    let env: ExecutionEnvironment;

    // We track active envs for cleanup
    const activeEnvs: ExecutionEnvironment[] = [];

    beforeEach(async () => {
      const available = await backend.available();
      if (!available) {
        skip = true;
        return;
      }
      skip = false;

      tmpDir = mkdtempSync(join(tmpdir(), 'env-contract-'));
      baseDir = join(tmpDir, 'base');
      sessionsDir = join(tmpDir, 'sessions');
      mkdirSync(baseDir, { recursive: true });
      mkdirSync(sessionsDir, { recursive: true });

      // Seed base with some files
      writeFileSync(join(baseDir, 'readme.txt'), 'hello world');
      writeFileSync(join(baseDir, 'config.json'), '{"key": "value"}');
    });

    afterEach(async () => {
      if (skip) return;

      // Teardown all tracked envs before removing tmpDir
      for (const e of activeEnvs) {
        try {
          await e.teardown();
        } catch { /* ignore */ }
      }
      activeEnvs.length = 0;

      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch { /* ignore */ }
    });

    function createEnv(sessionId = 'test-session'): ExecutionEnvironment {
      const e = backend.factory.create(baseDir, sessionId, sessionsDir);
      activeEnvs.push(e);
      return e;
    }

    // ── setup/teardown basics ──────────────────────────────────

    describe('setup/teardown basics', () => {
      it('setup() creates the merged workspace directory', async (ctx) => {
        if (skip) return ctx.skip();
        env = createEnv();
        await env.setup();
        expect(existsSync(env.workspacePath)).toBe(true);
      });

      it('setup() copies base files to merged', async (ctx) => {
        if (skip) return ctx.skip();
        env = createEnv();
        await env.setup();
        expect(readFileSync(join(env.workspacePath, 'readme.txt'), 'utf-8')).toBe('hello world');
        expect(readFileSync(join(env.workspacePath, 'config.json'), 'utf-8')).toBe('{"key": "value"}');
      });

      it('isActive is true after setup', async (ctx) => {
        if (skip) return ctx.skip();
        env = createEnv();
        expect(env.isActive).toBe(false);
        await env.setup();
        expect(env.isActive).toBe(true);
      });

      it('teardown() sets isActive to false', async (ctx) => {
        if (skip) return ctx.skip();
        env = createEnv();
        await env.setup();
        await env.teardown();
        expect(env.isActive).toBe(false);
      });

      it('teardown() is idempotent', async (ctx) => {
        if (skip) return ctx.skip();
        env = createEnv();
        await env.setup();
        await env.teardown();
        // Second teardown should not throw
        await expect(env.teardown()).resolves.toBeUndefined();
      });

      it('setup() after teardown() re-creates the environment', async (ctx) => {
        if (skip) return ctx.skip();
        env = createEnv();
        await env.setup();
        await env.teardown();

        // Create a fresh env with the same session id (simulating re-create)
        const env2 = createEnv();
        await env2.setup();
        expect(env2.isActive).toBe(true);
        expect(existsSync(env2.workspacePath)).toBe(true);
        // Base files should be available again
        expect(readFileSync(join(env2.workspacePath, 'readme.txt'), 'utf-8')).toBe('hello world');
      });
    });

    // ── diff ───────────────────────────────────────────────────

    describe('diff', () => {
      it('returns empty array when no changes', async (ctx) => {
        if (skip) return ctx.skip();
        env = createEnv();
        await env.setup();
        const diffs = await env.diff();
        expect(diffs).toEqual([]);
      });

      it('detects added files', async (ctx) => {
        if (skip) return ctx.skip();
        env = createEnv();
        await env.setup();

        writeFileSync(join(env.workspacePath, 'newfile.txt'), 'new content');
        const diffs = await env.diff();

        expect(diffs).toContainEqual({ path: 'newfile.txt', type: 'added' });
      });

      it('detects modified files', async (ctx) => {
        if (skip) return ctx.skip();
        env = createEnv();
        await env.setup();

        writeFileSync(join(env.workspacePath, 'readme.txt'), 'modified content');
        const diffs = await env.diff();

        expect(diffs).toContainEqual({ path: 'readme.txt', type: 'modified' });
      });

      it('detects deleted files', async (ctx) => {
        if (skip) return ctx.skip();
        env = createEnv();
        await env.setup();

        // Delete a file that exists in base via rm in the merged dir
        const result = await env.exec(`rm "${join(env.workspacePath, 'readme.txt')}"`);
        expect(result.exitCode).toBe(0);

        const diffs = await env.diff();
        expect(diffs).toContainEqual({ path: 'readme.txt', type: 'deleted' });
      });
    });

    // ── promote ────────────────────────────────────────────────

    describe('promote', () => {
      it('copies added files to base', async (ctx) => {
        if (skip) return ctx.skip();
        env = createEnv();
        await env.setup();

        writeFileSync(join(env.workspacePath, 'promoted.txt'), 'promoted content');
        await env.promote();

        expect(readFileSync(join(baseDir, 'promoted.txt'), 'utf-8')).toBe('promoted content');
      });

      it('copies modified files to base', async (ctx) => {
        if (skip) return ctx.skip();
        env = createEnv();
        await env.setup();

        writeFileSync(join(env.workspacePath, 'readme.txt'), 'updated');
        await env.promote();

        expect(readFileSync(join(baseDir, 'readme.txt'), 'utf-8')).toBe('updated');
      });

      it('result has correct counts', async (ctx) => {
        if (skip) return ctx.skip();
        env = createEnv();
        await env.setup();

        writeFileSync(join(env.workspacePath, 'newfile.txt'), 'added');
        writeFileSync(join(env.workspacePath, 'readme.txt'), 'changed');

        const result = await env.promote();
        expect(result.added).toBe(1);
        expect(result.modified).toBe(1);
        expect(result.deleted).toBe(0);
      });

      it('base workspace reflects promoted changes', async (ctx) => {
        if (skip) return ctx.skip();
        env = createEnv();
        await env.setup();

        writeFileSync(join(env.workspacePath, 'newfile.txt'), 'added');
        writeFileSync(join(env.workspacePath, 'readme.txt'), 'changed');
        await env.promote();

        // Verify base has the promoted files
        expect(readFileSync(join(baseDir, 'newfile.txt'), 'utf-8')).toBe('added');
        expect(readFileSync(join(baseDir, 'readme.txt'), 'utf-8')).toBe('changed');
        // Untouched file should remain
        expect(readFileSync(join(baseDir, 'config.json'), 'utf-8')).toBe('{"key": "value"}');
      });
    });

    // ── fork ───────────────────────────────────────────────────

    describe('fork', () => {
      it('copies merged workspace to target directory', async (ctx) => {
        if (skip) return ctx.skip();
        env = createEnv();
        await env.setup();

        writeFileSync(join(env.workspacePath, 'extra.txt'), 'forked');

        const forkDir = join(tmpDir, 'forked-base');
        await env.fork(forkDir);

        expect(existsSync(forkDir)).toBe(true);
        expect(readFileSync(join(forkDir, 'extra.txt'), 'utf-8')).toBe('forked');
      });

      it('target directory contains all files (base + session changes)', async (ctx) => {
        if (skip) return ctx.skip();
        env = createEnv();
        await env.setup();

        writeFileSync(join(env.workspacePath, 'extra.txt'), 'forked');

        const forkDir = join(tmpDir, 'forked-base');
        await env.fork(forkDir);

        // Should have base files + new file
        expect(readFileSync(join(forkDir, 'readme.txt'), 'utf-8')).toBe('hello world');
        expect(readFileSync(join(forkDir, 'config.json'), 'utf-8')).toBe('{"key": "value"}');
        expect(readFileSync(join(forkDir, 'extra.txt'), 'utf-8')).toBe('forked');
      });

      it('fork does not affect the original base', async (ctx) => {
        if (skip) return ctx.skip();
        env = createEnv();
        await env.setup();

        writeFileSync(join(env.workspacePath, 'extra.txt'), 'forked');

        const forkDir = join(tmpDir, 'forked-base');
        await env.fork(forkDir);

        // Base should NOT have the extra file
        expect(existsSync(join(baseDir, 'extra.txt'))).toBe(false);
      });
    });

    // ── reuse/reopen ───────────────────────────────────────────

    describe('reuse/reopen', () => {
      it('new env with same sessionId preserves session changes', async (ctx) => {
        if (skip) return ctx.skip();

        // First env: setup and write files
        const env1 = createEnv('reuse-session');
        await env1.setup();
        writeFileSync(join(env1.workspacePath, 'session-file.txt'), 'session data');

        // For MockOverlay: leave merged dir intact (don't teardown)
        // For FuseOverlay: the overlay mount stays

        // Create a NEW env instance with the same sessionId
        const env2 = createEnv('reuse-session');
        await env2.setup();

        // The session file should still exist — setup() must NOT overwrite
        expect(existsSync(join(env2.workspacePath, 'session-file.txt'))).toBe(true);
        expect(readFileSync(join(env2.workspacePath, 'session-file.txt'), 'utf-8')).toBe('session data');
      });

      it('new env can diff changes made by the first env', async (ctx) => {
        if (skip) return ctx.skip();

        const env1 = createEnv('reuse-session-diff');
        await env1.setup();
        writeFileSync(join(env1.workspacePath, 'session-file.txt'), 'session data');

        const env2 = createEnv('reuse-session-diff');
        await env2.setup();

        const diffs = await env2.diff();
        expect(diffs).toContainEqual({ path: 'session-file.txt', type: 'added' });
      });

      it('new env can promote changes made by the first env', async (ctx) => {
        if (skip) return ctx.skip();

        const env1 = createEnv('reuse-session-promote');
        await env1.setup();
        writeFileSync(join(env1.workspacePath, 'session-file.txt'), 'promote me');

        const env2 = createEnv('reuse-session-promote');
        await env2.setup();

        const result = await env2.promote();
        expect(result.added).toBe(1);
        expect(readFileSync(join(baseDir, 'session-file.txt'), 'utf-8')).toBe('promote me');
      });
    });

    // ── exec ───────────────────────────────────────────────────

    describe('exec', () => {
      it('runs a command in the merged workspace', async (ctx) => {
        if (skip) return ctx.skip();
        env = createEnv();
        await env.setup();

        const result = await env.exec('pwd');
        expect(result.exitCode).toBe(0);
        // The resolved path may differ due to symlinks, so check it ends with expected suffix
        expect(result.stdout.trim()).toContain('merged');
      });

      it('returns stdout, stderr, exitCode', async (ctx) => {
        if (skip) return ctx.skip();
        env = createEnv();
        await env.setup();

        const result = await env.exec('echo hello && echo err >&2');
        expect(result.stdout).toContain('hello');
        expect(result.stderr).toContain('err');
        expect(result.exitCode).toBe(0);
      });

      it('returns non-zero exitCode on failure', async (ctx) => {
        if (skip) return ctx.skip();
        env = createEnv();
        await env.setup();

        const result = await env.exec('exit 42');
        expect(result.exitCode).not.toBe(0);
      });

      it('can read base files from merged workspace', async (ctx) => {
        if (skip) return ctx.skip();
        env = createEnv();
        await env.setup();

        const result = await env.exec('cat readme.txt');
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe('hello world');
      });

      it('can write and read back files', async (ctx) => {
        if (skip) return ctx.skip();
        env = createEnv();
        await env.setup();

        await env.exec('echo "exec-written" > exec-file.txt');
        const result = await env.exec('cat exec-file.txt');
        expect(result.stdout.trim()).toBe('exec-written');
      });
    });
  });
}
