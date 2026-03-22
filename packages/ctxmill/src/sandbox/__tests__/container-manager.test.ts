import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContainerManager } from '../container-manager.js';
import type { CreateContainerOptions, ContainerManagerOptions } from '../container-manager.js';

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
    ...overrides,
  };
}

function createMockNetwork(overrides: Record<string, unknown> = {}) {
  return {
    inspect: vi.fn().mockResolvedValue({ Name: 'ctxmill-agents' }),
    ...overrides,
  };
}

function createMockDocker(overrides: Record<string, unknown> = {}) {
  const mockContainer = createMockContainer();

  const docker = {
    createContainer: vi.fn().mockResolvedValue(mockContainer),
    getContainer: vi.fn().mockReturnValue(mockContainer),
    listContainers: vi.fn().mockResolvedValue([]),
    getNetwork: vi.fn().mockReturnValue(createMockNetwork()),
    createNetwork: vi.fn().mockResolvedValue({}),
    _mockContainer: mockContainer,
    ...overrides,
  };
  return docker;
}

function defaultCreateOpts(): CreateContainerOptions {
  return {
    runId: 'run-001',
    agentId: 'agent-abc',
    harnessName: 'claude-agents',
  };
}

// ── Tests ───────────────────────────────────────────────────

describe('ContainerManager', () => {
  let docker: ReturnType<typeof createMockDocker>;
  let manager: ContainerManager;

  beforeEach(() => {
    docker = createMockDocker();
    manager = new ContainerManager(undefined, docker as any);
  });

  // ── createContainer ─────────────────────────────────────

  describe('createContainer', () => {
    it('produces correct config with labels, resource limits, network, and tmpfs', async () => {
      const info = await manager.createContainer(defaultCreateOpts());

      expect(docker.createContainer).toHaveBeenCalledTimes(1);
      const arg = docker.createContainer.mock.calls[0][0];

      // Image
      expect(arg.Image).toBe('ctxmill/harness-claude-agents:latest');

      // Labels
      expect(arg.Labels['ctxmill.managed']).toBe('true');
      expect(arg.Labels['ctxmill.run-id']).toBe('run-001');
      expect(arg.Labels['ctxmill.agent-id']).toBe('agent-abc');
      expect(arg.Labels['ctxmill.harness']).toBe('claude-agents');
      expect(arg.Labels['ctxmill.timeout']).toBe('600');
      expect(arg.Labels['ctxmill.started-at']).toBeTruthy();

      // Resource limits (defaults)
      expect(arg.HostConfig.CpuPeriod).toBe(100_000);
      expect(arg.HostConfig.CpuQuota).toBe(100_000); // 1.0 * 100000
      expect(arg.HostConfig.Memory).toBe(512 * 1024 * 1024);
      expect(arg.HostConfig.MemorySwap).toBe(512 * 1024 * 1024);
      expect(arg.HostConfig.PidsLimit).toBe(256);

      // Network
      expect(arg.HostConfig.NetworkMode).toBe('ctxmill-agents');

      // Security
      expect(arg.HostConfig.SecurityOpt).toEqual(['no-new-privileges']);

      // tmpfs for secrets
      expect(arg.HostConfig.Tmpfs).toEqual({ '/run/secrets': 'rw,noexec,nosuid,size=1m' });

      // Env
      expect(arg.Env).toContain('SANDBOX_PORT=50051');
      expect(arg.Env).toContain(`NODE_OPTIONS=--max-old-space-size=${Math.floor(512 * 0.9)}`);

      // Return info
      expect(info.containerId).toBe('sha256-abc123');
      expect(info.containerName).toBe('ctxmill-run-run-001');
      expect(info.status).toBe('created');
    });

    it('uses ctxmill-run-{runId} naming convention', async () => {
      const info = await manager.createContainer({
        ...defaultCreateOpts(),
        runId: 'my-special-run',
      });

      const arg = docker.createContainer.mock.calls[0][0];
      expect(arg.name).toBe('ctxmill-run-my-special-run');
      expect(info.containerName).toBe('ctxmill-run-my-special-run');
    });

    it('applies default resource limits when not specified', async () => {
      await manager.createContainer(defaultCreateOpts());

      const arg = docker.createContainer.mock.calls[0][0];
      expect(arg.HostConfig.CpuQuota).toBe(100_000); // 1.0 CPU
      expect(arg.HostConfig.Memory).toBe(512 * 1024 * 1024); // 512 MiB
      expect(arg.HostConfig.PidsLimit).toBe(256);
    });

    it('applies custom resource limits when specified', async () => {
      await manager.createContainer({
        ...defaultCreateOpts(),
        cpus: 2.5,
        memoryMb: 1024,
        pidsLimit: 512,
        timeoutSec: 1200,
      });

      const arg = docker.createContainer.mock.calls[0][0];
      expect(arg.HostConfig.CpuQuota).toBe(250_000); // 2.5 * 100000
      expect(arg.HostConfig.Memory).toBe(1024 * 1024 * 1024);
      expect(arg.HostConfig.PidsLimit).toBe(512);
      expect(arg.Labels['ctxmill.timeout']).toBe('1200');
      expect(arg.Env).toContain(`NODE_OPTIONS=--max-old-space-size=${Math.floor(1024 * 0.9)}`);
    });

    it('mounts workspace directory when provided', async () => {
      await manager.createContainer({
        ...defaultCreateOpts(),
        workspaceDir: '/tmp/workspaces/run-001',
      });

      const arg = docker.createContainer.mock.calls[0][0];
      expect(arg.HostConfig.Binds).toEqual(['/tmp/workspaces/run-001:/workspace:rw']);
    });

    it('omits workspace bind when not provided', async () => {
      await manager.createContainer(defaultCreateOpts());

      const arg = docker.createContainer.mock.calls[0][0];
      expect(arg.HostConfig.Binds).toBeUndefined();
    });

    it('uses custom manager options for defaults', async () => {
      const opts: ContainerManagerOptions = {
        networkName: 'custom-net',
        imagePrefix: 'my-registry/agent',
        defaultCpus: 0.5,
        defaultMemoryMb: 256,
        defaultPidsLimit: 128,
        defaultTimeoutSec: 300,
      };
      const customManager = new ContainerManager(opts, docker as any);
      await customManager.createContainer(defaultCreateOpts());

      const arg = docker.createContainer.mock.calls[0][0];
      expect(arg.Image).toBe('my-registry/agent-claude-agents:latest');
      expect(arg.HostConfig.NetworkMode).toBe('custom-net');
      expect(arg.HostConfig.CpuQuota).toBe(50_000); // 0.5 * 100000
      expect(arg.HostConfig.Memory).toBe(256 * 1024 * 1024);
      expect(arg.HostConfig.PidsLimit).toBe(128);
      expect(arg.Labels['ctxmill.timeout']).toBe('300');
    });
  });

  // ── startContainer ──────────────────────────────────────

  describe('startContainer', () => {
    it('calls docker start on the container', async () => {
      await manager.startContainer('sha256-abc123');

      expect(docker.getContainer).toHaveBeenCalledWith('sha256-abc123');
      expect(docker._mockContainer.start).toHaveBeenCalledTimes(1);
    });
  });

  // ── stopContainer ───────────────────────────────────────

  describe('stopContainer', () => {
    it('calls docker stop with default timeout', async () => {
      await manager.stopContainer('sha256-abc123');

      expect(docker.getContainer).toHaveBeenCalledWith('sha256-abc123');
      expect(docker._mockContainer.stop).toHaveBeenCalledWith({ t: 10 });
    });

    it('calls docker stop with custom timeout', async () => {
      await manager.stopContainer('sha256-abc123', 30);

      expect(docker._mockContainer.stop).toHaveBeenCalledWith({ t: 30 });
    });

    it('ignores 304 (already stopped) error', async () => {
      docker._mockContainer.stop.mockRejectedValue({ statusCode: 304, message: 'already stopped' });

      await expect(manager.stopContainer('sha256-abc123')).resolves.toBeUndefined();
    });

    it('re-throws non-304 errors', async () => {
      docker._mockContainer.stop.mockRejectedValue({ statusCode: 500, message: 'server error' });

      await expect(manager.stopContainer('sha256-abc123')).rejects.toEqual({
        statusCode: 500,
        message: 'server error',
      });
    });
  });

  // ── removeContainer ─────────────────────────────────────

  describe('removeContainer', () => {
    it('calls docker remove with force=false by default', async () => {
      await manager.removeContainer('sha256-abc123');

      expect(docker.getContainer).toHaveBeenCalledWith('sha256-abc123');
      expect(docker._mockContainer.remove).toHaveBeenCalledWith({ force: false });
    });

    it('calls docker remove with force=true when specified', async () => {
      await manager.removeContainer('sha256-abc123', true);

      expect(docker._mockContainer.remove).toHaveBeenCalledWith({ force: true });
    });

    it('ignores 404 (not found) error', async () => {
      docker._mockContainer.remove.mockRejectedValue({ statusCode: 404, message: 'not found' });

      await expect(manager.removeContainer('sha256-abc123')).resolves.toBeUndefined();
    });

    it('re-throws non-404 errors', async () => {
      docker._mockContainer.remove.mockRejectedValue({ statusCode: 409, message: 'conflict' });

      await expect(manager.removeContainer('sha256-abc123')).rejects.toEqual({
        statusCode: 409,
        message: 'conflict',
      });
    });
  });

  // ── injectSecrets ───────────────────────────────────────

  describe('injectSecrets', () => {
    it('creates tar archive and calls putArchive', async () => {
      const secrets = { OPENAI_API_KEY: 'sk-test123', DB_PASSWORD: 'secret' };
      await manager.injectSecrets('sha256-abc123', secrets);

      expect(docker.getContainer).toHaveBeenCalledWith('sha256-abc123');
      expect(docker._mockContainer.putArchive).toHaveBeenCalledTimes(1);

      const [archive, opts] = docker._mockContainer.putArchive.mock.calls[0];
      expect(opts).toEqual({ path: '/run/secrets' });
      // Archive should be a readable stream (tar-stream pack)
      expect(archive).toBeTruthy();
      expect(typeof archive.pipe === 'function' || typeof archive.read === 'function').toBe(true);
    });
  });

  // ── extractWorkspaceDiff ────────────────────────────────

  describe('extractWorkspaceDiff', () => {
    it('returns buffer from container archive', async () => {
      const result = await manager.extractWorkspaceDiff('sha256-abc123');

      expect(docker.getContainer).toHaveBeenCalledWith('sha256-abc123');
      expect(docker._mockContainer.getArchive).toHaveBeenCalledWith({ path: '/workspace' });
      expect(result).toBeInstanceOf(Buffer);
      expect(result!.toString()).toBe('fake-tar-data');
    });

    it('returns null when workspace path does not exist (404)', async () => {
      docker._mockContainer.getArchive.mockRejectedValue({ statusCode: 404, message: 'not found' });

      const result = await manager.extractWorkspaceDiff('sha256-abc123');
      expect(result).toBeNull();
    });
  });

  // ── extractLogs ─────────────────────────────────────────

  describe('extractLogs', () => {
    it('returns log output as a string', async () => {
      const logs = await manager.extractLogs('sha256-abc123');

      expect(logs).toBe('line1\nline2\nline3');
      expect(docker._mockContainer.logs).toHaveBeenCalledWith({
        stdout: true,
        stderr: true,
        tail: 1000,
      });
    });

    it('passes custom tail value', async () => {
      await manager.extractLogs('sha256-abc123', 50);

      expect(docker._mockContainer.logs).toHaveBeenCalledWith({
        stdout: true,
        stderr: true,
        tail: 50,
      });
    });

    it('handles string return from logs', async () => {
      docker._mockContainer.logs.mockResolvedValue('string-log-output');

      const logs = await manager.extractLogs('sha256-abc123');
      expect(logs).toBe('string-log-output');
    });
  });

  // ── getContainer ────────────────────────────────────────

  describe('getContainer', () => {
    it('returns null for unknown runId', async () => {
      docker.listContainers.mockResolvedValue([]);

      const info = await manager.getContainer('unknown-run');
      expect(info).toBeNull();
    });

    it('returns container info for known runId', async () => {
      docker.listContainers.mockResolvedValue([
        {
          Id: 'sha256-found',
          Names: ['/ctxmill-run-run-001'],
          State: 'running',
          Labels: {
            'ctxmill.managed': 'true',
            'ctxmill.run-id': 'run-001',
            'ctxmill.agent-id': 'agent-abc',
            'ctxmill.harness': 'claude-agents',
            'ctxmill.started-at': '2026-03-17T10:00:00.000Z',
          },
          NetworkSettings: {
            Networks: {
              'ctxmill-agents': { IPAddress: '172.18.0.5' },
            },
          },
        },
      ]);

      const info = await manager.getContainer('run-001');
      expect(info).not.toBeNull();
      expect(info!.containerId).toBe('sha256-found');
      expect(info!.containerName).toBe('ctxmill-run-run-001');
      expect(info!.runId).toBe('run-001');
      expect(info!.agentId).toBe('agent-abc');
      expect(info!.harnessName).toBe('claude-agents');
      expect(info!.status).toBe('running');
      expect(info!.startedAt).toEqual(new Date('2026-03-17T10:00:00.000Z'));
      expect(info!.networkIp).toBe('172.18.0.5');
    });

    it('filters by ctxmill.run-id label', async () => {
      await manager.getContainer('run-xyz');

      expect(docker.listContainers).toHaveBeenCalledWith({
        all: true,
        filters: {
          label: ['ctxmill.managed=true', 'ctxmill.run-id=run-xyz'],
        },
      });
    });
  });

  // ── listManagedContainers ───────────────────────────────

  describe('listManagedContainers', () => {
    it('filters by ctxmill.managed label', async () => {
      docker.listContainers.mockResolvedValue([]);

      await manager.listManagedContainers();

      expect(docker.listContainers).toHaveBeenCalledWith({
        all: true,
        filters: { label: ['ctxmill.managed=true'] },
      });
    });

    it('returns all managed containers', async () => {
      docker.listContainers.mockResolvedValue([
        {
          Id: 'c1',
          Names: ['/ctxmill-run-r1'],
          State: 'running',
          Labels: {
            'ctxmill.managed': 'true',
            'ctxmill.run-id': 'r1',
            'ctxmill.agent-id': 'a1',
            'ctxmill.harness': 'langgraph',
          },
          NetworkSettings: { Networks: {} },
        },
        {
          Id: 'c2',
          Names: ['/ctxmill-run-r2'],
          State: 'exited',
          Labels: {
            'ctxmill.managed': 'true',
            'ctxmill.run-id': 'r2',
            'ctxmill.agent-id': 'a2',
            'ctxmill.harness': 'pi-agent',
          },
          NetworkSettings: { Networks: {} },
        },
      ]);

      const result = await manager.listManagedContainers();
      expect(result).toHaveLength(2);
      expect(result[0].runId).toBe('r1');
      expect(result[0].status).toBe('running');
      expect(result[1].runId).toBe('r2');
      expect(result[1].status).toBe('stopped');
    });
  });

  // ── getContainerExitCode ────────────────────────────────

  describe('getContainerExitCode', () => {
    it('returns exit code for exited container', async () => {
      docker._mockContainer.inspect.mockResolvedValue({
        State: { Status: 'exited', ExitCode: 137 },
      });

      const code = await manager.getContainerExitCode('sha256-abc123');
      expect(code).toBe(137);
    });

    it('returns null for running container', async () => {
      docker._mockContainer.inspect.mockResolvedValue({
        State: { Status: 'running', ExitCode: 0 },
      });

      const code = await manager.getContainerExitCode('sha256-abc123');
      expect(code).toBeNull();
    });

    it('returns null for 404 (container not found)', async () => {
      docker._mockContainer.inspect.mockRejectedValue({ statusCode: 404, message: 'not found' });

      const code = await manager.getContainerExitCode('sha256-abc123');
      expect(code).toBeNull();
    });
  });

  // ── ensureNetwork ───────────────────────────────────────

  describe('ensureNetwork', () => {
    it('does not create network if it already exists', async () => {
      // Default mock: getNetwork().inspect() resolves
      await manager.ensureNetwork();

      expect(docker.getNetwork).toHaveBeenCalledWith('ctxmill-agents');
      expect(docker.createNetwork).not.toHaveBeenCalled();
    });

    it('creates network if it does not exist', async () => {
      docker.getNetwork.mockReturnValue({
        inspect: vi.fn().mockRejectedValue({ statusCode: 404, message: 'not found' }),
      });

      await manager.ensureNetwork();

      expect(docker.createNetwork).toHaveBeenCalledWith({
        Name: 'ctxmill-agents',
        Driver: 'bridge',
        Internal: false,
      });
    });

    it('uses custom network name from options', async () => {
      const customManager = new ContainerManager({ networkName: 'my-net' }, docker as any);
      docker.getNetwork.mockReturnValue({
        inspect: vi.fn().mockRejectedValue({ statusCode: 404 }),
      });

      await customManager.ensureNetwork();

      expect(docker.getNetwork).toHaveBeenCalledWith('my-net');
      expect(docker.createNetwork).toHaveBeenCalledWith(
        expect.objectContaining({ Name: 'my-net' }),
      );
    });
  });

  // ── cleanupOrphans ──────────────────────────────────────

  describe('cleanupOrphans', () => {
    it('removes containers not in activeRunIds set', async () => {
      const mockOrphanContainer = createMockContainer({ id: 'orphan-container' });
      docker.getContainer.mockReturnValue(mockOrphanContainer);

      docker.listContainers.mockResolvedValue([
        {
          Id: 'orphan-container',
          Names: ['/ctxmill-run-orphan'],
          State: 'running',
          Labels: {
            'ctxmill.managed': 'true',
            'ctxmill.run-id': 'orphan-run',
            'ctxmill.agent-id': 'a1',
            'ctxmill.harness': 'claude-agents',
            'ctxmill.started-at': new Date().toISOString(),
            'ctxmill.timeout': '600',
          },
        },
      ]);

      const cleaned = await manager.cleanupOrphans(new Set(['active-run']));
      expect(cleaned).toBe(1);
    });

    it('removes expired containers regardless of DB state', async () => {
      const mockExpiredContainer = createMockContainer({ id: 'expired-container' });
      docker.getContainer.mockReturnValue(mockExpiredContainer);

      // Container started 700 seconds ago with 600s timeout
      const startedAt = new Date(Date.now() - 700_000).toISOString();
      docker.listContainers.mockResolvedValue([
        {
          Id: 'expired-container',
          Names: ['/ctxmill-run-expired'],
          State: 'running',
          Labels: {
            'ctxmill.managed': 'true',
            'ctxmill.run-id': 'expired-run',
            'ctxmill.agent-id': 'a1',
            'ctxmill.harness': 'claude-agents',
            'ctxmill.started-at': startedAt,
            'ctxmill.timeout': '600',
          },
        },
      ]);

      // Even though the run is "active", it should be cleaned up because it expired
      const cleaned = await manager.cleanupOrphans(new Set(['expired-run']));
      expect(cleaned).toBe(1);
    });

    it('skips active non-expired containers', async () => {
      docker.listContainers.mockResolvedValue([
        {
          Id: 'active-container',
          Names: ['/ctxmill-run-active'],
          State: 'running',
          Labels: {
            'ctxmill.managed': 'true',
            'ctxmill.run-id': 'active-run',
            'ctxmill.agent-id': 'a1',
            'ctxmill.harness': 'claude-agents',
            'ctxmill.started-at': new Date().toISOString(),
            'ctxmill.timeout': '600',
          },
        },
      ]);

      const cleaned = await manager.cleanupOrphans(new Set(['active-run']));
      expect(cleaned).toBe(0);
    });

    it('returns 0 when no managed containers exist', async () => {
      docker.listContainers.mockResolvedValue([]);

      const cleaned = await manager.cleanupOrphans(new Set());
      expect(cleaned).toBe(0);
    });

    it('handles mixed active and orphan containers', async () => {
      const mockContainer = createMockContainer();
      docker.getContainer.mockReturnValue(mockContainer);

      docker.listContainers.mockResolvedValue([
        {
          Id: 'c-active',
          Names: ['/ctxmill-run-active'],
          State: 'running',
          Labels: {
            'ctxmill.managed': 'true',
            'ctxmill.run-id': 'active-run',
            'ctxmill.agent-id': 'a1',
            'ctxmill.harness': 'claude-agents',
            'ctxmill.started-at': new Date().toISOString(),
            'ctxmill.timeout': '600',
          },
        },
        {
          Id: 'c-orphan1',
          Names: ['/ctxmill-run-orphan1'],
          State: 'running',
          Labels: {
            'ctxmill.managed': 'true',
            'ctxmill.run-id': 'orphan1',
            'ctxmill.agent-id': 'a2',
            'ctxmill.harness': 'langgraph',
            'ctxmill.started-at': new Date().toISOString(),
            'ctxmill.timeout': '600',
          },
        },
        {
          Id: 'c-orphan2',
          Names: ['/ctxmill-run-orphan2'],
          State: 'exited',
          Labels: {
            'ctxmill.managed': 'true',
            'ctxmill.run-id': 'orphan2',
            'ctxmill.agent-id': 'a3',
            'ctxmill.harness': 'pi-agent',
            'ctxmill.started-at': new Date().toISOString(),
            'ctxmill.timeout': '600',
          },
        },
      ]);

      const cleaned = await manager.cleanupOrphans(new Set(['active-run']));
      expect(cleaned).toBe(2);
    });
  });

  // ── Docker state mapping ────────────────────────────────

  describe('container state mapping', () => {
    it.each([
      ['created', 'created'],
      ['running', 'running'],
      ['paused', 'paused'],
      ['exited', 'stopped'],
      ['dead', 'stopped'],
      ['removing', 'removed'],
      ['restarting', 'stopped'],
    ])('maps Docker state "%s" to status "%s"', async (dockerState, expectedStatus) => {
      docker.listContainers.mockResolvedValue([
        {
          Id: `c-${dockerState}`,
          Names: [`/ctxmill-run-r-${dockerState}`],
          State: dockerState,
          Labels: {
            'ctxmill.managed': 'true',
            'ctxmill.run-id': `r-${dockerState}`,
            'ctxmill.agent-id': 'a1',
            'ctxmill.harness': 'claude-agents',
          },
          NetworkSettings: { Networks: {} },
        },
      ]);

      const containers = await manager.listManagedContainers();
      expect(containers[0].status).toBe(expectedStatus);
    });
  });
});
