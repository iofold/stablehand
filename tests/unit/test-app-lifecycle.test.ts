import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppContainer } from '../../packages/ctxmill/src/config/container.js';

const mocks = vi.hoisted(() => ({
  createContainer: vi.fn(),
  createServer: vi.fn(),
}));

vi.mock('../../packages/ctxmill/src/config/container.js', () => ({
  createContainer: mocks.createContainer,
}));

vi.mock('../../packages/ctxmill/src/orchestrator/server.js', () => ({
  createServer: mocks.createServer,
}));

vi.mock('../utils/test-db.js', () => ({
  resolveTestDatabaseUrl: () => 'postgres://test.invalid/ctxmill_test',
}));

import { createTestApp } from '../utils/test-app.js';

function createFixture() {
  const scopedContainers = [
    {
      containerId: 'container-running',
      containerName: 'ctxmill-sandbox-running',
      sessionId: 'running',
      agentId: 'agent-1',
      harnessName: 'langgraph',
      status: 'running',
    },
    {
      containerId: 'container-created',
      containerName: 'ctxmill-sandbox-created',
      sessionId: 'created',
      agentId: 'agent-1',
      harnessName: 'langgraph',
      status: 'created',
    },
  ];
  const containerManager = {
    listManagedContainers: vi.fn()
      .mockResolvedValueOnce(scopedContainers)
      .mockResolvedValue([]),
    removeContainer: vi.fn().mockResolvedValue(undefined),
    getActiveCount: vi.fn().mockReturnValue(0),
    getQueuedCount: vi.fn().mockReturnValue(0),
  };
  const container = {
    containerManager,
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as AppContainer;
  const app = {
    ready: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };

  mocks.createContainer.mockResolvedValue(container);
  mocks.createServer.mockResolvedValue(app);

  return { app, container, containerManager };
}

describe('test app sandbox lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('injects a unique test-owned scope into the application container', async () => {
    createFixture();
    const testApp = await createTestApp();

    try {
      expect(mocks.createContainer).toHaveBeenCalledWith(
        expect.any(Object),
        testApp.dataDir,
        { containerScopeIdentity: `test:${testApp.dataDir}` },
      );
    } finally {
      await testApp.close();
    }
  });

  it('force-removes every container in its exact scope before closing', async () => {
    const { app, container, containerManager } = createFixture();
    const testApp = await createTestApp();

    await testApp.close();

    expect(containerManager.listManagedContainers).toHaveBeenCalledTimes(2);
    expect(containerManager.removeContainer.mock.calls).toEqual([
      ['container-running', true],
      ['container-created', true],
    ]);
    expect(app.close).toHaveBeenCalledOnce();
    expect(container.close).toHaveBeenCalledOnce();
  });

  it('attempts every scoped removal and surfaces teardown failures after closing', async () => {
    const { container, containerManager } = createFixture();
    containerManager.removeContainer.mockImplementation(async (containerId: string) => {
      if (containerId === 'container-running') {
        throw new Error('forced removal failed');
      }
    });
    const testApp = await createTestApp();

    await expect(testApp.close()).rejects.toThrow(/container-running.*forced removal failed/);
    expect(containerManager.removeContainer).toHaveBeenCalledTimes(2);
    expect(container.close).toHaveBeenCalledOnce();
  });

  it('waits for an in-flight create and removes the container that appears after teardown starts', async () => {
    const { containerManager } = createFixture();
    containerManager.listManagedContainers
      .mockReset()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        containerId: 'container-late',
        containerName: 'ctxmill-sandbox-late',
        sessionId: 'late',
        agentId: 'agent-late',
        harnessName: 'langgraph',
        status: 'running',
      }])
      .mockResolvedValue([]);
    containerManager.getActiveCount
      .mockReturnValueOnce(1)
      .mockReturnValue(0);
    const testApp = await createTestApp();

    await testApp.close();

    expect(containerManager.removeContainer).toHaveBeenCalledWith('container-late', true);
    expect(containerManager.listManagedContainers).toHaveBeenCalledTimes(3);
  });
});
