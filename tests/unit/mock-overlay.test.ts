// tests/unit/mock-overlay.test.ts

import { describe } from 'vitest';
import { runEnvironmentCompliance } from '../compliance/execution-environment.compliance.js';
import { MockOverlayEnvironment } from '../../packages/ctxmill/src/workspace/mock-overlay.js';

describe('MockOverlayEnvironment', () => {
  runEnvironmentCompliance(
    'MockOverlay',
    (baseDir, sessionId, sessionRoot) =>
      new MockOverlayEnvironment(baseDir, sessionId, sessionRoot),
  );
});
