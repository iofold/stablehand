import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContainerManager } from '../container-manager.js';

// ── Mock factories ──────────────────────────────────────────

function createMockContainer(overrides: Record<string, unknown> = {}) {
  return {
    id: overrides.id ?? 'sha256-abc123',
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    inspect: vi.fn().mockResolvedValue({
      State: { Status: 'exited', ExitCode: 0 },
    }),
    putArchive: vi.fn().mockResolvedValue(undefined),
    getArchive: vi.fn().mockResolvedValue(
      (async function* () {
        yield Buffer.from('fake-tar-data');
      })(),
    ),
    logs: vi.fn().mockResolvedValue(Buffer.from('line1\nline2\nline3')),
    pause: vi.fn().mockResolvedValue(undefined),
    unpause: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function createMockNetwork(overrides: Record<string, unknown> = {}) {
  return {
    inspect: vi.fn().mockResolvedValue({ Name: 'ctxmill-agents' }),
    ...overrides,
  };
}

let containerIdCounter = 0;

function createMockDocker(overrides: Record<string, unknown> = {}) {
  const mockContainer = createMockContainer();

  const docker = {
    createContainer: vi.fn().mockImplementation(() => {
      containerIdCounter++;
      return Promise.resolve(
        createMockContainer({ id: `sha256-container-${containerIdCounter}` }),
      );
    }),
    getContainer: vi.fn().mockReturnValue(mockContainer),
    listContainers: vi.fn().mockResolvedValue([]),
    getNetwork: vi.fn().mockReturnValue(createMockNetwork()),
    createNetwork: vi.fn().mockResolvedValue({}),
    _mockContainer: mockContainer,
    ...overrides,
  };
  return docker;
}

// ── Tests ───────────────────────────────────────────────────

describe('ContainerManager — metrics', () => {
  let docker: ReturnType<typeof createMockDocker>;
  let manager: ContainerManager;

  beforeEach(() => {
    containerIdCounter = 0;
    docker = createMockDocker();
    manager = new ContainerManager(
      { maxGlobalContainers: 20, queueTimeoutMs: 5000 },
      docker as any,
    );
  });

  it('tracks create/remove lifecycle with per-harness breakdown and peak', async () => {
    const info1 = await manager.createContainer({
      sessionId: 'run-1',
      agentId: 'agent-1',
      harnessName: 'langgraph',
    });
    await manager.createContainer({
      sessionId: 'run-2',
      agentId: 'agent-2',
      harnessName: 'claude-agents',
    });
    await manager.createContainer({
      sessionId: 'run-3',
      agentId: 'agent-3',
      harnessName: 'langgraph',
    });

    let metrics = manager.getMetrics();
    expect(metrics.active).toBe(3);
    expect(metrics.totalCreated).toBe(3);
    expect(metrics.peak).toBe(3);
    expect(metrics.byHarness).toEqual({ langgraph: 2, 'claude-agents': 1 });

    await manager.removeContainer(info1.containerId);

    metrics = manager.getMetrics();
    expect(metrics.active).toBe(2);
    expect(metrics.peak).toBe(3);
    expect(metrics.totalCreated).toBe(3);
    expect(metrics.byHarness).toEqual({ langgraph: 1, 'claude-agents': 1 });
  });

  it('handles 404 (already removed) gracefully during removal', async () => {
    const info = await manager.createContainer({
      sessionId: 'run-1',
      agentId: 'agent-1',
      harnessName: 'langgraph',
    });

    docker._mockContainer.remove.mockRejectedValue({
      statusCode: 404,
      message: 'not found',
    });
    docker.getContainer.mockReturnValue(docker._mockContainer);

    await manager.removeContainer(info.containerId);

    const metrics = manager.getMetrics();
    expect(metrics.active).toBe(0);
  });

  it('computes averageLifetimeMs after container completion', async () => {
    const info = await manager.createContainer({
      sessionId: 'run-1',
      agentId: 'agent-1',
      harnessName: 'langgraph',
    });
    await new Promise((r) => setTimeout(r, 15));
    await manager.removeContainer(info.containerId);

    const metrics = manager.getMetrics();
    expect(metrics.averageLifetimeMs).toBeGreaterThan(0);
  });

  it('returns snapshot isolation — getMetrics() is not a live reference', async () => {
    const m1 = manager.getMetrics();
    await manager.createContainer({
      sessionId: 'run-1',
      agentId: 'agent-1',
      harnessName: 'langgraph',
    });
    const m2 = manager.getMetrics();

    expect(m1.active).toBe(0);
    expect(m2.active).toBe(1);
  });
});
