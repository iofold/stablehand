/**
 * Lifecycle-boundary delegation guard.
 *
 * ADR 005 establishes that sandbox-session status mutations must flow through
 * `SessionLifecycleService` / `SessionStatusCoordinator`. This test asserts
 * that no Fastify route handler under `packages/ctxmill/src/orchestrator/routes`
 * calls `db.updateSandboxSessionStatus` directly. If a future change adds a
 * direct mutation, this test fails and the regression is caught at PR time.
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROUTES_DIR = path.resolve(__dirname, '../../routes');

async function listFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const resolved = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(resolved)));
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      files.push(resolved);
    }
  }
  return files;
}

describe('routes/* never bypass SessionLifecycleService', () => {
  it('contains no direct calls to db.updateSandboxSessionStatus', async () => {
    const files = await listFiles(ROUTES_DIR);
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of files) {
      const text = await fs.readFile(file, 'utf-8');
      if (/\bupdateSandboxSessionStatus\b/.test(text)) {
        offenders.push(path.relative(ROUTES_DIR, file));
      }
    }

    expect(offenders).toEqual([]);
  });

  it('contains no direct calls to db.deleteSandboxSession', async () => {
    const files = await listFiles(ROUTES_DIR);
    const offenders: string[] = [];
    for (const file of files) {
      const text = await fs.readFile(file, 'utf-8');
      if (/\bdeleteSandboxSession\b/.test(text)) {
        offenders.push(path.relative(ROUTES_DIR, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});
