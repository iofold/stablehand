import { describe, it, expect } from 'vitest';
import { resolveBaseDir, validateSandboxPath } from '../../packages/ctxmill/src/orchestrator/routes/agent-helpers.js';

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

  it('allows exact hidden diagnostics files that are not sensitive patterns', () => {
    expect(validateSandboxPath(baseDir, '.claude/settings.json')).toBeNull();
    expect(validateSandboxPath(baseDir, '.hook-trace.log')).toBeNull();
  });
});

describe('resolveBaseDir', () => {
  it('uses conversation workspace when a conversation id and data dir are available', () => {
    expect(resolveBaseDir(
      { id: 'agent-1', workspaceDir: '/workspace/agent-1' },
      { dataDir: '/var/lib/ctxmill', conversationId: 'conversation-1' },
    )).toBe('/var/lib/ctxmill/agents/agent-1/conversations/conversation-1/workspace');
  });

  it('does not resolve a legacy sandbox session workspace without a conversation id', () => {
    expect(resolveBaseDir(
      { id: 'agent-1', workspaceDir: '/workspace/agent-1' },
      { dataDir: '/var/lib/ctxmill' },
    )).toBe('/workspace/agent-1');
  });

});
