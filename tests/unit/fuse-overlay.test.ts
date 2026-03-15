// tests/unit/fuse-overlay.test.ts

import { describe, it } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { runEnvironmentCompliance } from '../compliance/execution-environment.compliance.js';
import { FuseOverlayEnvironment } from '../../packages/ctxmill/src/workspace/fuse-overlay.js';

function canUseFuse(): boolean {
  try {
    execSync('fuse-overlayfs --version', { stdio: 'pipe' });
    return existsSync('/dev/fuse');
  } catch { return false; }
}

const hasFuse = canUseFuse();

describe.skipIf(!hasFuse)('FuseOverlayEnvironment', () => {
  runEnvironmentCompliance(
    'FuseOverlay',
    (baseDir, sessionId, sessionRoot) =>
      new FuseOverlayEnvironment(baseDir, sessionId, sessionRoot),
  );
});
