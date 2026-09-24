import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * ctx-nh2 — Proto build wiring regression.
 *
 * Asserts that the root `pnpm -r build` invocation produces runtime JS
 * for `@stablehand/proto`. Without the proto runtime JS in `packages/proto/dist`,
 * any non-Dockerfile consumer of `@stablehand/proto/sandbox/v1` will fail to
 * resolve at runtime even though TypeScript source builds happen to pass.
 *
 * This test is intentionally a *consumer-import smoke check*: it does not
 * use the Vitest source-alias for `@stablehand/proto`. Instead, it spawns a
 * fresh Node process and resolves the package via Node's exports map, so
 * the `default: ./dist/.../sandbox_pb.js` entry actually has to exist.
 */

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), '..', '..');

const PROTO_PKG_DIR = resolve(REPO_ROOT, 'packages/proto');
const PROTO_DIST_JS = resolve(PROTO_PKG_DIR, 'dist/stablehand/sandbox/v1/sandbox_pb.js');
const PROTO_DIST_DTS = resolve(PROTO_PKG_DIR, 'dist/stablehand/sandbox/v1/sandbox_pb.d.ts');
const PROTO_PKG_JSON = resolve(PROTO_PKG_DIR, 'package.json');

describe('@stablehand/proto — build wiring (ctx-nh2)', () => {
  it('package.json declares a runtime JS path under dist for the sandbox/v1 export', () => {
    const pkg = JSON.parse(readFileSync(PROTO_PKG_JSON, 'utf8')) as {
      exports?: Record<string, { default?: string; types?: string }>;
    };
    const sandboxExport = pkg.exports?.['./sandbox/v1'];
    expect(sandboxExport, 'expected ./sandbox/v1 entry in exports').toBeDefined();
    expect(sandboxExport?.default ?? '').toMatch(/\/dist\/.*\.js$/);
  });

  it('package.json build script compiles runtime JS (buf generate + tsc)', () => {
    const pkg = JSON.parse(readFileSync(PROTO_PKG_JSON, 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const buildScript = pkg.scripts?.build ?? '';
    expect(buildScript).toContain('buf generate');
    expect(buildScript).toContain('tsc -p tsconfig.build.json');
  });

  it('the runtime JS file exists after a build (regression: dist was previously missing)', () => {
    expect(
      existsSync(PROTO_DIST_JS),
      `expected runtime JS at ${PROTO_DIST_JS} after pnpm -r build (run: pnpm --filter @stablehand/proto build)`,
    ).toBe(true);
    expect(existsSync(PROTO_DIST_DTS)).toBe(true);
    expect(statSync(PROTO_DIST_JS).size).toBeGreaterThan(0);
  });

  it(
    'a clean Node process can resolve and import @stablehand/proto/sandbox/v1 via package.json exports',
    { timeout: 20_000 },
    () => {
      // Run inside the proto package dir so workspace resolution finds the
      // package's own runtime entry, bypassing the Vitest source alias.
      const stdout = execFileSync(
        process.execPath,
        [
          '-e',
          // eslint-disable-next-line no-template-curly-in-string
          'import("@stablehand/proto/sandbox/v1").then((m) => { ' +
            'const keys = Object.keys(m); ' +
            'if (keys.length === 0) { console.error("EMPTY"); process.exit(1); } ' +
            'console.log(JSON.stringify({ ok: true, count: keys.length, sample: keys.slice(0, 3) })); ' +
          '}).catch((e) => { console.error("IMPORT-FAILED:", e.message); process.exit(1); });',
        ],
        { cwd: PROTO_PKG_DIR, encoding: 'utf8' },
      );
      const parsed = JSON.parse(stdout.trim()) as { ok: boolean; count: number };
      expect(parsed.ok).toBe(true);
      expect(parsed.count).toBeGreaterThan(0);
    },
  );
});
