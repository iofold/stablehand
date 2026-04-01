import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PassThrough } from 'node:stream';
import type { Writable } from 'node:stream';
import { ContainerManager } from '../container-manager.js';
import type { CreateContainerOptions, ContainerManagerOptions } from '../container-manager.js';

// ── Mock factories ──────────────────────────────────────────

function createMockContainer(overrides: Record<string, unknown> = {}) {
  const execStream = new PassThrough();
  const mockExec = {
    start: vi.fn().mockResolvedValue(execStream),
    inspect: vi.fn().mockResolvedValue({ ExitCode: 0 }),
  };

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
    changes: vi.fn().mockResolvedValue([
      { Path: '/workspace/file.txt', Kind: 0 },
    ]),
    exec: vi.fn().mockResolvedValue(mockExec),
    logs: vi.fn().mockResolvedValue(Buffer.from('line1\nline2\nline3')),
    _mockExec: mockExec,
    _mockExecStream: execStream,
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
    modem: {
      demuxStream: vi.fn((_stream: unknown, stdout: Writable, _stderr: Writable) => {
        stdout.write(Buffer.from('fake-diff-tar-data'));
      }),
    },
    _mockContainer: mockContainer,
    ...overrides,
  };
  return docker;
}

function defaultCreateOpts(): CreateContainerOptions {
  return {
    sessionId: 'run-001',
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
      expect(arg.Labels['ctxmill.session-id']).toBe('run-001');
      expect(arg.Labels['ctxmill.agent-id']).toBe('agent-abc');
      expect(arg.Labels['ctxmill.harness']).toBe('claude-agents');
      expect(arg.Labels['ctxmill.timeout']).toBe('600');
      expect(arg.Labels['ctxmill.started-at']).toBeTruthy();

      // Resource limits (defaults — claude-agents has 2048 MiB floor)
      expect(arg.HostConfig.CpuPeriod).toBe(100_000);
      expect(arg.HostConfig.CpuQuota).toBe(100_000); // 1.0 * 100000
      expect(arg.HostConfig.Memory).toBe(2048 * 1024 * 1024);
      expect(arg.HostConfig.MemorySwap).toBe(2048 * 1024 * 1024);
      expect(arg.HostConfig.PidsLimit).toBe(256);

      // Network
      expect(arg.HostConfig.NetworkMode).toBe('ctxmill-agents');

      // Security
      expect(arg.HostConfig.SecurityOpt).toEqual(['no-new-privileges']);

      // tmpfs for secrets
      expect(arg.HostConfig.Tmpfs).toEqual({ '/run/secrets': 'rw,noexec,nosuid,size=1m' });

      // Env
      expect(arg.Env).toContain('SANDBOX_PORT=50051');
      expect(arg.Env).toContain(`NODE_OPTIONS=--max-old-space-size=${Math.floor(2048 * 0.9)}`);

      // Return info
      expect(info.containerId).toBe('sha256-abc123');
      expect(info.containerName).toBe('ctxmill-run-run-001');
      expect(info.status).toBe('created');
    });

    it('uses ctxmill-run-{sessionId} naming convention', async () => {
      const info = await manager.createContainer({
        ...defaultCreateOpts(),
        sessionId: 'my-special-run',
      });

      const arg = docker.createContainer.mock.calls[0][0];
      expect(arg.name).toBe('ctxmill-run-my-special-run');
      expect(info.containerName).toBe('ctxmill-run-my-special-run');
    });

    it('applies default resource limits when not specified', async () => {
      await manager.createContainer(defaultCreateOpts());

      const arg = docker.createContainer.mock.calls[0][0];
      expect(arg.HostConfig.CpuQuota).toBe(100_000); // 1.0 CPU
      expect(arg.HostConfig.Memory).toBe(2048 * 1024 * 1024); // claude-agents floor
      expect(arg.HostConfig.PidsLimit).toBe(256);
    });

    it('applies custom resource limits when specified', async () => {
      await manager.createContainer({
        ...defaultCreateOpts(),
        cpus: 2.5,
        memoryMb: 4096,
        pidsLimit: 512,
        timeoutSec: 1200,
      });

      const arg = docker.createContainer.mock.calls[0][0];
      expect(arg.HostConfig.CpuQuota).toBe(250_000); // 2.5 * 100000
      expect(arg.HostConfig.Memory).toBe(4096 * 1024 * 1024);
      expect(arg.HostConfig.PidsLimit).toBe(512);
      expect(arg.Labels['ctxmill.timeout']).toBe('1200');
      expect(arg.Env).toContain(`NODE_OPTIONS=--max-old-space-size=${Math.floor(4096 * 0.9)}`);
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
      await customManager.createContainer({
        ...defaultCreateOpts(),
        harnessName: 'langgraph', // use non-claude harness to test raw defaults (claude has a memory floor)
      });

      const arg = docker.createContainer.mock.calls[0][0];
      expect(arg.Image).toBe('my-registry/agent-langgraph:latest');
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
      expect(docker._mockContainer.changes).toHaveBeenCalledTimes(1);
      expect(docker._mockContainer.exec).toHaveBeenCalledWith({
        Cmd: ['tar', 'cf', '-', '--no-recursion', '--ignore-failed-read', '-T', '-'],
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: true,
      });
      expect(result).toBeInstanceOf(Buffer);
      expect(result!.toString()).toBe('fake-diff-tar-data');
    });

    it('returns null when there are no meaningful changes', async () => {
      docker._mockContainer.changes.mockResolvedValue([
        { Path: '/tmp/cache-file', Kind: 1 },
        { Path: '/workspace/deleted.txt', Kind: 2 },
      ]);

      const result = await manager.extractWorkspaceDiff('sha256-abc123');
      expect(result).toBeNull();
    });
  });

  describe('extractContainerDiff', () => {
    it('filters diff paths and tars only meaningful added and modified paths', async () => {
      const writtenChunks: Buffer[] = [];
      docker._mockContainer._mockExecStream.on('data', (chunk: Buffer | string) => {
        writtenChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      docker._mockContainer.changes.mockResolvedValue([
        { Path: '/workspace/file.txt', Kind: 0 },
        { Path: '/workspace/new-dir', Kind: 1 },
        { Path: '/workspace/node_modules/pkg/index.js', Kind: 1 },
        { Path: '/home/ctxmill/.cache/tool/cache.bin', Kind: 1 },
        { Path: '/etc/hosts', Kind: 0 },
        { Path: '/workspace/deleted.txt', Kind: 2 },
        { Path: '/home/ctxmill/.claude/settings.json', Kind: 1 },
      ]);

      const result = await manager.extractContainerDiff('sha256-abc123');

      expect(result?.toString()).toBe('fake-diff-tar-data');
      expect(docker.modem.demuxStream).toHaveBeenCalledTimes(1);
      expect(Buffer.concat(writtenChunks).toString('utf-8')).toBe([
        '/workspace/file.txt',
        '/workspace/new-dir',
        '/home/ctxmill/.claude/settings.json',
        '',
      ].join('\n'));
    });

    it('throws when tar exits non-zero', async () => {
      docker._mockContainer._mockExec.inspect.mockResolvedValue({ ExitCode: 1 });
      docker.modem.demuxStream.mockImplementation((_stream: unknown, _stdout: Writable, stderr: Writable) => {
        stderr.write(Buffer.from('tar failed'));
      });

      await expect(manager.extractContainerDiff('sha256-abc123')).rejects.toThrow(
        'Failed to extract container diff: tar failed',
      );
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
    it('returns null for unknown sessionId', async () => {
      docker.listContainers.mockResolvedValue([]);

      const info = await manager.getContainer('unknown-run');
      expect(info).toBeNull();
    });

    it('returns container info for known sessionId', async () => {
      docker.listContainers.mockResolvedValue([
        {
          Id: 'sha256-found',
          Names: ['/ctxmill-run-run-001'],
          State: 'running',
          Labels: {
            'ctxmill.managed': 'true',
            'ctxmill.session-id': 'run-001',
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
       expect(info!.sessionId).toBe('run-001');
       expect(info!.agentId).toBe('agent-abc');
       expect(info!.harnessName).toBe('claude-agents');
       expect(info!.status).toBe('running');
       expect(info!.startedAt).toEqual(new Date('2026-03-17T10:00:00.000Z'));
       expect(info!.networkIp).toBe('172.18.0.5');
     });

    it('filters by ctxmill.session-id label', async () => {
      await manager.getContainer('run-xyz');

      expect(docker.listContainers).toHaveBeenCalledWith({
        all: true,
        filters: {
          label: ['ctxmill.managed=true', 'ctxmill.session-id=run-xyz'],
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
            'ctxmill.session-id': 'r1',
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
            'ctxmill.session-id': 'r2',
            'ctxmill.agent-id': 'a2',
            'ctxmill.harness': 'pi-agent',
          },
          NetworkSettings: { Networks: {} },
        },
      ]);

       const result = await manager.listManagedContainers();
       expect(result).toHaveLength(2);
       expect(result[0].sessionId).toBe('r1');
       expect(result[0].status).toBe('running');
       expect(result[1].sessionId).toBe('r2');
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
            'ctxmill.session-id': `r-${dockerState}`,
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

describe('semaphore slot release (FIX-4)', () => {
  it('releases semaphore when Docker createContainer throws', async () => {
    const docker = createMockDocker({
      createContainer: vi.fn().mockRejectedValue(new Error('docker create failed')),
    });
    const manager = new ContainerManager({ maxGlobalContainers: 1 }, docker as any);

    await expect(manager.createContainer(defaultCreateOpts())).rejects.toThrow('docker create failed');
    expect(manager.getMetrics().active).toBe(0);
  });

  it('does NOT release semaphore on successful container creation', async () => {
    const docker = createMockDocker();
    const manager = new ContainerManager({ maxGlobalContainers: 1 }, docker as any);

    const info = await manager.createContainer(defaultCreateOpts());

    expect(manager.getMetrics().active).toBe(1);

    await manager.removeContainer(info.containerId);
    expect(manager.getMetrics().active).toBe(0);
  });

  it('releases semaphore when post-Docker metrics code throws', async () => {
    const docker = createMockDocker();
    const manager = new ContainerManager({ maxGlobalContainers: 1 }, docker as any);
    const activeByHarness = (manager as any).activeByHarness as Map<string, number>;
    const setSpy = vi.spyOn(activeByHarness, 'set').mockImplementation(() => {
      throw new Error('metrics failed');
    });

    await expect(manager.createContainer(defaultCreateOpts())).rejects.toThrow('metrics failed');
    expect(manager.getMetrics().active).toBe(0);

    setSpy.mockRestore();
  });

  it('releases session semaphore when Docker createContainer throws', async () => {
    const docker = createMockDocker({
      createContainer: vi.fn().mockRejectedValue(new Error('session create failed')),
    });
    const manager = new ContainerManager({ maxGlobalContainers: 1 }, docker as any);

    await expect(
      manager.createSessionContainer({
        conversationId: 'conv-001',
        sessionId: 'session-001',
        agentId: 'agent-abc',
        harnessName: 'claude-agents',
      }),
    ).rejects.toThrow('session create failed');

    expect(manager.getMetrics().active).toBe(0);
  });
});
