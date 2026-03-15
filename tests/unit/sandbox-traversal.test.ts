import { describe, it, expect } from 'vitest';
import { validateSandboxPath } from '../../packages/ctxmill/src/orchestrator/routes/agent-helpers.js';

describe('validateSandboxPath – prefix traversal fix', () => {
  const baseDir = '/workspace/agent-1';

  it('allows normal paths inside the workspace', () => {
    expect(validateSandboxPath(baseDir, 'src/index.ts')).toBeNull();
    expect(validateSandboxPath(baseDir, 'nested/deep/file.txt')).toBeNull();
  });

  it('rejects ../sibling-with-same-prefix (prefix traversal)', () => {
    const result = validateSandboxPath(baseDir, '../agent-1-evil/payload.sh');
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
  });

  it('rejects ../../outside (general traversal)', () => {
    const result = validateSandboxPath(baseDir, '../../outside/secret');
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
  });

  it('allows exact baseDir match (filePath is empty or ".")', () => {
    expect(validateSandboxPath(baseDir, '.')).toBeNull();
    expect(validateSandboxPath(baseDir, '')).toBeNull();
  });
});
