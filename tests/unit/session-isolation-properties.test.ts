// tests/unit/session-isolation-properties.test.ts

import { describe, it, expect, afterAll } from 'vitest';
import fc from 'fast-check';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MockOverlayEnvironment } from '../../packages/ctxmill/src/workspace/mock-overlay.js';

const tempDirs: string[] = [];
function makeTmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), `ctxmill-prop-${prefix}-`));
  tempDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of tempDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* */ }
  }
});

// Safe filename generator: alphanumeric + underscore, 1-20 chars
const safeFilename = fc.stringMatching(/^[a-z][a-z0-9_]{0,19}\.txt$/);
const safeContent = fc.string({ minLength: 0, maxLength: 500 });

describe('Session isolation properties (fast-check)', () => {
  it('P1: writes in session A are NOT visible in session B', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.tuple(safeFilename, safeContent), { minLength: 1, maxLength: 5 }),
        async (files) => {
          const baseDir = makeTmp('p1-base');
          const sessRoot = makeTmp('p1-sess');
          const envA = new MockOverlayEnvironment(baseDir, 'a', sessRoot);
          const envB = new MockOverlayEnvironment(baseDir, 'b', sessRoot);
          await envA.setup();
          await envB.setup();

          for (const [name, content] of files) {
            await envA.exec(`printf '%s' '${content.replace(/'/g, "'\\''")}' > ${name}`);
          }

          for (const [name] of files) {
            const r = await envB.exec(`test -f ${name} && echo EXISTS || echo MISSING`);
            expect(r.stdout.trim()).toBe('MISSING');
          }

          await envA.teardown();
          await envB.teardown();
        },
      ),
      { numRuns: 20 },
    );
  });

  it('P2: base is immutable during session (writes do not change base)', async () => {
    await fc.assert(
      fc.asyncProperty(safeFilename, safeContent, async (name, content) => {
        const baseDir = makeTmp('p2-base');
        const sessRoot = makeTmp('p2-sess');
        writeFileSync(join(baseDir, 'original.txt'), 'untouched');

        const env = new MockOverlayEnvironment(baseDir, 's', sessRoot);
        await env.setup();
        await env.exec(`echo '${content}' > ${name}`);
        await env.exec(`echo overwritten > original.txt`);

        // Base unchanged
        expect(readFileSync(join(baseDir, 'original.txt'), 'utf-8')).toBe('untouched');
        expect(existsSync(join(baseDir, name))).toBe(false);

        await env.teardown();
      }),
      { numRuns: 20 },
    );
  });

  it('P4: after promote, session changes are in base', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.tuple(safeFilename, safeContent), { minLength: 1, maxLength: 5 }),
        async (files) => {
          const baseDir = makeTmp('p4-base');
          const sessRoot = makeTmp('p4-sess');
          const env = new MockOverlayEnvironment(baseDir, 's', sessRoot);
          await env.setup();

          for (const [name, content] of files) {
            await env.exec(`printf '%s' '${content.replace(/'/g, "'\\''")}' > ${name}`);
          }

          await env.promote();

          for (const [name] of files) {
            expect(existsSync(join(baseDir, name))).toBe(true);
          }

          await env.teardown();
        },
      ),
      { numRuns: 20 },
    );
  });

  it('P5: after teardown without promote, base is unchanged', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.tuple(safeFilename, safeContent), { minLength: 1, maxLength: 5 }),
        async (files) => {
          const baseDir = makeTmp('p5-base');
          const sessRoot = makeTmp('p5-sess');
          writeFileSync(join(baseDir, 'marker.txt'), 'present');

          const env = new MockOverlayEnvironment(baseDir, 's', sessRoot);
          await env.setup();

          for (const [name, content] of files) {
            await env.exec(`printf '%s' '${content.replace(/'/g, "'\\''")}' > ${name}`);
          }

          await env.teardown(); // NO promote

          // Only marker.txt should exist
          const entries = readdirSync(baseDir);
          expect(entries).toEqual(['marker.txt']);
        },
      ),
      { numRuns: 20 },
    );
  });
});
