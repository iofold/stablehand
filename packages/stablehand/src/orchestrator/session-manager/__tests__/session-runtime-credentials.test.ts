import { describe, expect, it, vi } from 'vitest';

import { SessionRuntimeFactory } from '../session-runtime-factory.js';

describe('SessionRuntimeFactory per-session credentials', () => {
  it('builds secrets for the new session id and releases them when the start fails', async () => {
    const buildSandboxSecrets = vi.fn().mockResolvedValue({
      STABLEHAND_MODEL_GATEWAY_RUNTIME_KEY: 'sk-session-key',
    });
    const releaseSandboxCredentials = vi.fn().mockResolvedValue(undefined);
    const createContainer = vi.fn().mockResolvedValue({
      containerId: 'container-1',
      containerName: 'sandbox-1',
    });
    const factory = new SessionRuntimeFactory({
      containerManager: {
        createContainer,
        startContainer: vi.fn().mockRejectedValue(new Error('docker start failed')),
        stopContainer: vi.fn().mockResolvedValue(undefined),
        removeContainer: vi.fn().mockResolvedValue(undefined),
      },
      db: { createSandboxSession: vi.fn() },
      buildSandboxSecrets,
      releaseSandboxCredentials,
      resolveToolsForAgent: vi.fn().mockReturnValue([]),
      checkConcurrencyLimit: vi.fn(),
      resolveRuntimeDefinitionHash: vi.fn().mockResolvedValue('definition-hash'),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    });

    await expect(factory.createFreshSession(
      'conversation-1',
      { name: 'agent-1', harness: 'langgraph', harnessConfig: {}, systemPrompt: 'test', tools: [] },
      'agent-1',
    )).rejects.toThrow('docker start failed');

    const sessionId = (buildSandboxSecrets.mock.calls[0]?.[1] as { sessionId: string }).sessionId;
    expect(buildSandboxSecrets).toHaveBeenCalledWith('agent-1', { sessionId: expect.any(String) });
    expect(createContainer).toHaveBeenCalledWith(expect.objectContaining({
      sessionId,
      secrets: expect.objectContaining({ STABLEHAND_MODEL_GATEWAY_RUNTIME_KEY: 'sk-session-key' }),
    }));
    expect(releaseSandboxCredentials).toHaveBeenCalledWith(sessionId);
  });
});
