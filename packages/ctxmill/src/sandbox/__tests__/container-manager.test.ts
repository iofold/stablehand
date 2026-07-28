import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';
import type { Writable } from 'node:stream';
import type Dockerode from 'dockerode';
import * as tar from 'tar-stream';
import { ContainerManager } from '../container-manager.js';
import type { CreateContainerOptions, ContainerManagerOptions } from '../container-manager.js';
import { CONTAINER_SCOPE_LABEL, resolveContainerScopeId } from '../container-scope.js';

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

function createSequencedDocker(containerIds: string[]) {
  const containers = new Map<string, ReturnType<typeof createMockContainer>>();
  let nextContainerIndex = 0;

  const docker = createMockDocker({
    createContainer: vi.fn().mockImplementation(() => {
      const id = containerIds[nextContainerIndex] ?? `sha256-container-${nextContainerIndex + 1}`;
      nextContainerIndex++;
      const container = createMockContainer({ id });
      containers.set(id, container);
      return Promise.resolve(container);
    }),
    getContainer: vi.fn().mockImplementation((containerId: string) => (
      containers.get(containerId) ?? createMockContainer({ id: containerId })
    )),
  });

  return docker;
}

function defaultCreateOpts(): CreateContainerOptions {
  return {
    sessionId: 'run-001',
    agentId: 'agent-abc',
    harnessName: 'claude-agents',
  };
}

async function createTarArchive(entries: Array<{ name: string; data: string | Buffer }>): Promise<Buffer> {
  const pack = tar.pack();
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    pack.on('data', (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    pack.on('end', () => resolve(Buffer.concat(chunks)));
    pack.on('error', reject);
  });

  for (const entry of entries) {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    pack.entry({ name: entry.name, size: data.length, type: 'file' }, data);
  }

  pack.finalize();
  return done;
}

// ── Tests ───────────────────────────────────────────────────

describe('ContainerManager', () => {
  let docker: ReturnType<typeof createMockDocker>;
  let manager: ContainerManager;

  beforeEach(() => {
    docker = createMockDocker();
    manager = new ContainerManager(undefined, docker as unknown as Dockerode);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // ── createContainer ─────────────────────────────────────

  describe('createContainer', () => {
    it('uses an explicitly injected scope identity for test isolation', async () => {
      vi.stubEnv('CTXMILL_CONTAINER_SCOPE', 'production-scope');
      const options = { scopeIdentity: 'test-run-123' } as ContainerManagerOptions;
      manager = new ContainerManager(options, docker as unknown as Dockerode);

      await manager.createContainer(defaultCreateOpts());

      const expectedScopeId = `s-${createHash('sha256')
        .update('test-run-123')
        .digest('hex')
        .slice(0, 24)}`;
      const createOptions = docker.createContainer.mock.calls[0][0];
      expect(createOptions.Labels[CONTAINER_SCOPE_LABEL]).toBe(expectedScopeId);

      await manager.listManagedContainers();
      expect(docker.listContainers).toHaveBeenCalledWith({
        all: true,
        filters: { label: ['ctxmill.managed=true', `${CONTAINER_SCOPE_LABEL}=${expectedScopeId}`] },
      });
    });

    it('produces correct config with labels, resource limits, network, and env', async () => {
      const info = await manager.createContainer(defaultCreateOpts());

      expect(docker.createContainer).toHaveBeenCalledTimes(1);
      const arg = docker.createContainer.mock.calls[0][0];

      // Image
      expect(arg.Image).toBe('ctxmill/harness-claude-agents:latest');

      // Labels
      expect(arg.Labels['ctxmill.managed']).toBe('true');
      expect(arg.Labels[CONTAINER_SCOPE_LABEL]).toBe(resolveContainerScopeId());
      expect(arg.Labels['ctxmill.sandbox-session-id']).toBe('run-001');
      expect(arg.Labels['ctxmill.agent-id']).toBe('agent-abc');
      expect(arg.Labels['ctxmill.harness']).toBe('claude-agents');
      expect(arg.Labels['ctxmill.timeout']).toBe('600');
      expect(arg.Labels['ctxmill.started-at']).toBeTruthy();
      expect(arg.Labels['ctxmill.startup-grace-ms']).toBe('90000');

      // Resource limits (defaults — claude-agents has 2048 MiB floor)
      expect(arg.HostConfig.CpuPeriod).toBe(100_000);
      expect(arg.HostConfig.CpuQuota).toBe(100_000); // 1.0 * 100000
      expect(arg.HostConfig.Memory).toBe(2048 * 1024 * 1024);
      expect(arg.HostConfig.MemorySwap).toBe(2048 * 1024 * 1024);
      expect(arg.HostConfig.PidsLimit).toBe(256);

      // Network
      expect(arg.HostConfig.NetworkMode).toBe('ctxmill-agents');
      expect(arg.HostConfig.ExtraHosts).toEqual(['host.docker.internal:host-gateway']);

      // Security
      expect(arg.HostConfig.SecurityOpt).toEqual(['no-new-privileges']);

      // Env
      expect(arg.Env).toContain('SANDBOX_PORT=50051');
      expect(arg.Env).toContain(`NODE_OPTIONS=--max-old-space-size=${Math.floor(2048 * 0.9)}`);
      expect(arg.Env).toContain('OTEL_SERVICE_NAME=ctxmill-sandbox-claude-agents');

      // Return info
      expect(info.containerId).toBe('sha256-abc123');
      expect(info.containerName).toBe('ctxmill-sandbox-run-001');
      expect(info.status).toBe('created');
    });

    it('uses ctxmill-sandbox-{sessionId} naming convention', async () => {
      const info = await manager.createContainer({
        ...defaultCreateOpts(),
        sessionId: 'my-special-run',
      });

      const arg = docker.createContainer.mock.calls[0][0];
      expect(arg.name).toBe('ctxmill-sandbox-my-special-run');
      expect(info.containerName).toBe('ctxmill-sandbox-my-special-run');
    });

    it('applies default resource limits when not specified', async () => {
      await manager.createContainer(defaultCreateOpts());

      const arg = docker.createContainer.mock.calls[0][0];
      expect(arg.HostConfig.CpuQuota).toBe(100_000); // 1.0 CPU
      expect(arg.HostConfig.Memory).toBe(2048 * 1024 * 1024); // claude-agents floor
      expect(arg.HostConfig.PidsLimit).toBe(256);
    });

    it('applies the PI agent memory floor when memory is not specified', async () => {
      await manager.createContainer({
        ...defaultCreateOpts(),
        harnessName: 'pi-agent',
      });

      const arg = docker.createContainer.mock.calls[0][0];
      expect(arg.HostConfig.Memory).toBe(2048 * 1024 * 1024);
      expect(arg.HostConfig.MemorySwap).toBe(2048 * 1024 * 1024);
      expect(arg.Env).toContain(`NODE_OPTIONS=--max-old-space-size=${Math.floor(2048 * 0.9)}`);
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
      expect(arg.HostConfig.MemorySwap).toBe(4096 * 1024 * 1024);
      expect(arg.HostConfig.PidsLimit).toBe(512);
      expect(arg.Labels['ctxmill.timeout']).toBe('1200');
      expect(arg.Env).toContain(`NODE_OPTIONS=--max-old-space-size=${Math.floor(4096 * 0.9)}`);
    });

    it('keeps swap disabled by matching MemorySwap to Memory', async () => {
      await manager.createContainer({
        ...defaultCreateOpts(),
        memoryMb: 1024,
      });

      const arg = docker.createContainer.mock.calls[0][0];
      expect(arg.HostConfig.MemorySwap).toBe(arg.HostConfig.Memory);
    });

    it('derives NODE_OPTIONS from the resolved memory limit', async () => {
      await manager.createContainer({
        ...defaultCreateOpts(),
        memoryMb: 1024,
      });

      const arg = docker.createContainer.mock.calls[0][0];
      const nodeOptions = arg.Env.find((entry: string) => entry.startsWith('NODE_OPTIONS='));
      expect(nodeOptions).toBe(`NODE_OPTIONS=--max-old-space-size=${Math.floor(2048 * 0.9)}`);
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
      const customManager = new ContainerManager(opts, docker as unknown as Dockerode);
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

    it('passes sandbox-specific OTEL configuration to run containers', async () => {
      vi.stubEnv('OTEL_TRACES_EXPORTER', 'otlp');
      vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', 'https://otlp-signoz.staging.example.com');
      vi.stubEnv('OTEL_RESOURCE_ATTRIBUTES', 'deployment.environment=local,service.namespace=ctxmill');

      await manager.createContainer({
        ...defaultCreateOpts(),
        harnessName: 'langgraph',
      });

      const arg = docker.createContainer.mock.calls[0][0];
      expect(arg.Env).toContain('OTEL_SERVICE_NAME=ctxmill-sandbox-langgraph');
      expect(arg.Env).toContain('OTEL_TRACES_EXPORTER=otlp');
      expect(arg.Env).toContain('OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp-signoz.staging.example.com');
      expect(arg.Env).toContain('OTEL_RESOURCE_ATTRIBUTES=deployment.environment=local,service.namespace=ctxmill,ctxmill.component=sandbox,ctxmill.harness=langgraph,ctxmill.session.id=run-001,ctxmill.agent.id=agent-abc');
      expect(arg.Env).not.toContain('OTEL_SERVICE_NAME=ctxmill-orchestrator');
    });
  });

  // ── startContainer ──────────────────────────────────────

  describe('startContainer', () => {
    it('calls docker start on the container and returns its network IP', async () => {
      docker._mockContainer.inspect.mockResolvedValueOnce({
        State: { Status: 'running', ExitCode: 0, Running: true },
        Name: '/ctxmill-sandbox-run-001',
        Config: {
          Labels: {
            'ctxmill.managed': 'true',
            'ctxmill.sandbox-session-id': 'run-001',
            'ctxmill.agent-id': 'agent-abc',
            'ctxmill.harness': 'claude-agents',
          },
        },
        NetworkSettings: {
          Networks: {
            'ctxmill-agents': { IPAddress: '172.18.0.5' },
          },
        },
      });

      const info = await manager.startContainer('sha256-abc123');

      expect(docker.getContainer).toHaveBeenCalledWith('sha256-abc123');
      expect(docker._mockContainer.start).toHaveBeenCalledTimes(1);
      expect(info).toMatchObject({
        containerId: 'sha256-abc123',
        containerName: 'ctxmill-sandbox-run-001',
        sessionId: 'run-001',
        networkIp: '172.18.0.5',
      });
    });

    it('passes secrets to the sandbox as Docker env vars', async () => {
      const containerInfo = await manager.createContainer({
        ...defaultCreateOpts(),
        secrets: {
          OPENAI_API_KEY: 'sk-test-key',
          ANTHROPIC_API_KEY: 'sk-ant-test',
        },
      });
      const createArg = docker.createContainer.mock.calls[0][0];
      expect(createArg.Env).toContain('OPENAI_API_KEY=sk-test-key');
      expect(createArg.Env).toContain('ANTHROPIC_API_KEY=sk-ant-test');
      expect(createArg.HostConfig.Tmpfs).toBeUndefined();

      await manager.startContainer(containerInfo.containerId);

      expect(docker._mockContainer.putArchive).not.toHaveBeenCalled();
    });
  });

  // ── stopContainer ───────────────────────────────────────

  describe('getRuntimeInstanceToken', () => {
    it('reads the exact token from the target Docker container environment', async () => {
      docker._mockContainer.inspect.mockResolvedValue({
        Config: {
          Env: [
            'OTHER_VALUE=before',
            'CTXMILL_RUNTIME_INSTANCE_TOKEN=runtime-token-1',
            'OTHER_VALUE_2=after',
          ],
        },
        State: { Status: 'running', ExitCode: 0 },
      });

      await expect(
        manager.getRuntimeInstanceToken('sha256-abc123'),
      ).resolves.toBe('runtime-token-1');
      expect(docker.getContainer).toHaveBeenCalledWith('sha256-abc123');
    });

    it('does not confuse a similarly prefixed environment variable for the token', async () => {
      docker._mockContainer.inspect.mockResolvedValue({
        Config: {
          Env: [
            'CTXMILL_RUNTIME_INSTANCE_TOKEN_SUFFIX=wrong-token',
          ],
        },
        State: { Status: 'running', ExitCode: 0 },
      });

      await expect(
        manager.getRuntimeInstanceToken('sha256-abc123'),
      ).resolves.toBeUndefined();
    });
  });

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

    it('ignores 404 (not found) error', async () => {
      docker._mockContainer.stop.mockRejectedValue({ statusCode: 404, message: 'not found' });

      await expect(manager.stopContainer('sha256-abc123')).resolves.toBeUndefined();
    });

    it('re-throws non-304/404 errors', async () => {
      docker._mockContainer.stop.mockRejectedValue({ statusCode: 500, message: 'server error' });

      await expect(manager.stopContainer('sha256-abc123')).rejects.toEqual({
        statusCode: 500,
        message: 'server error',
      });
    });

    it('releases an owned slot when stop succeeds', async () => {
      const info = await manager.createContainer(defaultCreateOpts());

      expect(manager.getMetrics().active).toBe(1);

      await manager.stopContainer(info.containerId);

      expect(manager.getMetrics().active).toBe(0);
      expect(manager.getMetrics().byHarness).toEqual({});
    });

    it('releases an owned slot when stop reports already stopped', async () => {
      const info = await manager.createContainer(defaultCreateOpts());
      docker._mockContainer.stop.mockRejectedValue({ statusCode: 304, message: 'already stopped' });

      await manager.stopContainer(info.containerId);

      expect(manager.getMetrics().active).toBe(0);
      expect(manager.getMetrics().byHarness).toEqual({});
    });

    it('releases an owned slot when stop reports the container is gone', async () => {
      const info = await manager.createContainer(defaultCreateOpts());
      docker._mockContainer.stop.mockRejectedValue({ statusCode: 404, message: 'not found' });

      await manager.stopContainer(info.containerId);

      expect(manager.getMetrics().active).toBe(0);
      expect(manager.getMetrics().byHarness).toEqual({});
    });

    it('does not double-release when remove follows stop', async () => {
      const docker = createSequencedDocker(['sha256-owned-1', 'sha256-owned-2']);
      const manager = new ContainerManager(
        { maxGlobalContainers: 1 },
        docker as unknown as Dockerode,
      );
      const first = await manager.createContainer(defaultCreateOpts());
      const secondPromise = manager.createContainer({
        ...defaultCreateOpts(),
        sessionId: 'run-002',
      });

      await manager.stopContainer(first.containerId);
      const second = await secondPromise;

      expect(second.containerId).toBe('sha256-owned-2');
      expect(manager.getMetrics().active).toBe(1);

      await manager.removeContainer(first.containerId);
      expect(manager.getMetrics().active).toBe(1);

      await manager.removeContainer(second.containerId);
      expect(manager.getMetrics().active).toBe(0);
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

    it('does not release a slot for a container this manager does not own', async () => {
      const info = await manager.createContainer(defaultCreateOpts());

      await manager.removeContainer('sha256-foreign');

      expect(manager.getMetrics().active).toBe(1);
      expect(manager.getMetrics().byHarness).toEqual({ 'claude-agents': 1 });

      await manager.removeContainer(info.containerId);
      expect(manager.getMetrics().active).toBe(0);
    });

    it('does not release a slot for an unowned container that Docker reports as missing', async () => {
      const info = await manager.createContainer(defaultCreateOpts());
      docker._mockContainer.remove
        .mockRejectedValueOnce({ statusCode: 404, message: 'not found' })
        .mockResolvedValueOnce(undefined);

      await manager.removeContainer('sha256-foreign');

      expect(manager.getMetrics().active).toBe(1);
      expect(manager.getMetrics().byHarness).toEqual({ 'claude-agents': 1 });

      await manager.removeContainer(info.containerId);
      expect(manager.getMetrics().active).toBe(0);
    });

    it('re-throws non-404 errors', async () => {
      docker._mockContainer.remove.mockRejectedValue({ statusCode: 409, message: 'conflict' });

      await expect(manager.removeContainer('sha256-abc123')).rejects.toEqual({
        statusCode: 409,
        message: 'conflict',
      });
    });
  });

  // ── extractWorkspaceDiff ────────────────────────────────

  describe('extractWorkspaceDiff', () => {
    it('returns workspace-scoped archive and tombstones from container changes', async () => {
      docker._mockContainer.changes.mockResolvedValue([
        { Path: '/workspace/file.txt', Kind: 0 },
        { Path: '/workspace/new-dir', Kind: 1 },
        { Path: '/workspace/deleted.txt', Kind: 2 },
        { Path: '/tmp/cache-file', Kind: 1 },
        { Path: '/home/ctxmill/.claude/settings.json', Kind: 1 },
      ]);

      const result = await manager.extractWorkspaceDiff('sha256-abc123');

      expect(docker.getContainer).toHaveBeenCalledWith('sha256-abc123');
      expect(docker._mockContainer.changes).toHaveBeenCalledTimes(1);
      expect(docker._mockContainer.exec).toHaveBeenCalledWith({
        Cmd: ['tar', '-C', '/workspace', 'cf', '-', '--no-recursion', '--ignore-failed-read', '-T', '-'],
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: true,
      });
      expect(result?.archive).toBeInstanceOf(Buffer);
      expect(result?.archive?.toString()).toBe('fake-diff-tar-data');
      expect(result?.deletedPaths).toEqual(['deleted.txt']);
    });

    it('returns null when there are no meaningful changes', async () => {
      docker._mockContainer.changes.mockResolvedValue([
        { Path: '/tmp/cache-file', Kind: 1 },
        { Path: '/workspace/node_modules/pkg/index.js', Kind: 2 },
      ]);

      const result = await manager.extractWorkspaceDiff('sha256-abc123');
      expect(result).toBeNull();
    });
  });

  describe('restoreArchive', () => {
    it('streams a tar archive into the container workspace', async () => {
      const archive = await createTarArchive([{ name: 'file.txt', data: 'workspace data' }]);

      await manager.restoreArchive('sha256-abc123', archive);

      expect(docker.getContainer).toHaveBeenCalledWith('sha256-abc123');
      expect(docker._mockContainer.putArchive).toHaveBeenCalledTimes(1);

      const [stream, opts] = docker._mockContainer.putArchive.mock.calls[0];
      expect(opts).toEqual({ path: '/workspace' });

      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }

      expect(Buffer.concat(chunks)).toEqual(archive);
    });

    it('applies deletion tombstones under /workspace before restoring archive', async () => {
      const deleteStream = new PassThrough();
      const mockExec = {
        start: vi.fn().mockImplementation(async () => {
          process.nextTick(() => deleteStream.end());
          return deleteStream;
        }),
        inspect: vi.fn().mockResolvedValue({ ExitCode: 0 }),
      };
      docker._mockContainer.exec.mockResolvedValueOnce(mockExec);

      await manager.restoreArchive('sha256-abc123', Buffer.alloc(0), {
        deletedPaths: ['deleted.txt', 'dir/removed.txt'],
      });

      expect(docker._mockContainer.exec).toHaveBeenCalledWith({
        Cmd: [
          'sh',
          '-c',
          'for target do rm -rf -- "/workspace/$target"; done',
          'sh',
          'deleted.txt',
          'dir/removed.txt',
        ],
        AttachStdout: true,
        AttachStderr: true,
      });
      expect(docker._mockContainer.putArchive).not.toHaveBeenCalled();
    });

    it('rejects unsafe deletion tombstones', async () => {
      await expect(manager.restoreArchive('sha256-abc123', Buffer.alloc(0), {
        deletedPaths: ['../outside.txt'],
      })).rejects.toThrow(/unsafe deleted path/);
    });

    it('rejects archives with entries that could escape /workspace', async () => {
      const archive = await createTarArchive([{ name: '../outside.txt', data: 'escape' }]);

      await expect(manager.restoreArchive('sha256-abc123', archive)).rejects.toThrow(
        /unsafe path/,
      );
      expect(docker._mockContainer.putArchive).not.toHaveBeenCalled();
    });
  });

  describe('extractWorkspaceDiff archive filtering', () => {
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

      const result = await manager.extractWorkspaceDiff('sha256-abc123');

      expect(result?.archive?.toString()).toBe('fake-diff-tar-data');
      expect(docker.modem.demuxStream).toHaveBeenCalledTimes(1);
      expect(Buffer.concat(writtenChunks).toString('utf-8')).toBe([
        'file.txt',
        'new-dir',
        '',
      ].join('\n'));
    });

    it('throws when tar exits non-zero', async () => {
      docker._mockContainer._mockExec.inspect.mockResolvedValue({ ExitCode: 1 });
      docker.modem.demuxStream.mockImplementation((_stream: unknown, _stdout: Writable, stderr: Writable) => {
        stderr.write(Buffer.from('tar failed'));
      });

      await expect(manager.extractWorkspaceDiff('sha256-abc123')).rejects.toThrow(
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
          Names: ['/ctxmill-sandbox-run-001'],
          State: 'running',
          Labels: {
            'ctxmill.managed': 'true',
            [CONTAINER_SCOPE_LABEL]: resolveContainerScopeId(),
            'ctxmill.sandbox-session-id': 'run-001',
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
       expect(info!.containerName).toBe('ctxmill-sandbox-run-001');
       expect(info!.sessionId).toBe('run-001');
       expect(info!.agentId).toBe('agent-abc');
       expect(info!.harnessName).toBe('claude-agents');
       expect(info!.status).toBe('running');
       expect(info!.startedAt).toEqual(new Date('2026-03-17T10:00:00.000Z'));
       expect(info!.networkIp).toBe('172.18.0.5');
     });

    it('falls back to another attached network when the configured network has no IP', async () => {
      docker.listContainers.mockResolvedValue([
        {
          Id: 'sha256-found',
          Names: ['/ctxmill-sandbox-run-001'],
          State: 'running',
          Labels: {
            [CONTAINER_SCOPE_LABEL]: resolveContainerScopeId(),
            'ctxmill.sandbox-session-id': 'run-001',
          },
          NetworkSettings: {
            Networks: {
              'ctxmill-agents': { IPAddress: '' },
              fallback: { IPAddress: '172.19.0.7' },
            },
          },
        },
      ]);

      const info = await manager.getContainer('run-001');

      expect(info?.networkIp).toBe('172.19.0.7');
    });

    it('filters by ctxmill.sandbox-session-id label', async () => {
      await manager.getContainer('run-xyz');

      expect(docker.listContainers).toHaveBeenCalledWith({
        all: true,
        filters: {
          label: [
            'ctxmill.managed=true',
            `${CONTAINER_SCOPE_LABEL}=${resolveContainerScopeId()}`,
            'ctxmill.sandbox-session-id=run-xyz',
          ],
        },
      });
    });

    it('prefers the current scoped container when several instances share a session label', async () => {
      vi.stubEnv('CTXMILL_CONTAINER_SCOPE', 'current-test-scope');
      manager = new ContainerManager(undefined, docker as unknown as Dockerode);
      const currentScopeId = resolveContainerScopeId();

      docker.listContainers.mockResolvedValue([
        {
          Id: 'foreign',
          Names: ['/ctxmill-sandbox-run-001'],
          State: 'running',
          Labels: {
            'ctxmill.managed': 'true',
            [CONTAINER_SCOPE_LABEL]: 's-foreign',
            'ctxmill.sandbox-session-id': 'run-001',
          },
          NetworkSettings: { Networks: {} },
        },
        {
          Id: 'current',
          Names: ['/ctxmill-sandbox-run-001'],
          State: 'running',
          Labels: {
            'ctxmill.managed': 'true',
            [CONTAINER_SCOPE_LABEL]: currentScopeId,
            'ctxmill.sandbox-session-id': 'run-001',
          },
          NetworkSettings: { Networks: {} },
        },
      ]);

      const info = await manager.getContainer('run-001');
      expect(info?.containerId).toBe('current');
    });
  });

  // ── listManagedContainers ───────────────────────────────

  describe('listManagedContainers', () => {
    it('filters by ctxmill.managed label', async () => {
      docker.listContainers.mockResolvedValue([]);

      await manager.listManagedContainers();

      expect(docker.listContainers).toHaveBeenCalledWith({
        all: true,
        filters: { label: ['ctxmill.managed=true', `${CONTAINER_SCOPE_LABEL}=${resolveContainerScopeId()}`] },
      });
    });

    it('returns all managed containers', async () => {
      const currentScopeId = resolveContainerScopeId();

      docker.listContainers.mockResolvedValue([
        {
          Id: 'c1',
          Names: ['/ctxmill-sandbox-r1'],
          State: 'running',
          Labels: {
            'ctxmill.managed': 'true',
            [CONTAINER_SCOPE_LABEL]: currentScopeId,
            'ctxmill.sandbox-session-id': 'r1',
            'ctxmill.agent-id': 'a1',
            'ctxmill.harness': 'langgraph',
          },
          NetworkSettings: { Networks: {} },
        },
        {
          Id: 'c2',
          Names: ['/ctxmill-sandbox-r2'],
          State: 'exited',
          Labels: {
            'ctxmill.managed': 'true',
            [CONTAINER_SCOPE_LABEL]: currentScopeId,
            'ctxmill.sandbox-session-id': 'r2',
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

    it('excludes foreign and unscoped ctxmill containers from broad lifecycle cleanup lists', async () => {
      const currentScopeId = resolveContainerScopeId();

      docker.listContainers.mockResolvedValue([
        {
          Id: 'current-scoped',
          Names: ['/ctxmill-sandbox-r1'],
          State: 'running',
          Labels: {
            'ctxmill.managed': 'true',
            [CONTAINER_SCOPE_LABEL]: currentScopeId,
            'ctxmill.sandbox-session-id': 'r1',
          },
          NetworkSettings: { Networks: {} },
        },
        {
          Id: 'foreign-scoped',
          Names: ['/ctxmill-sandbox-r2'],
          State: 'running',
          Labels: {
            'ctxmill.managed': 'true',
            [CONTAINER_SCOPE_LABEL]: 's-foreign',
            'ctxmill.sandbox-session-id': 'r2',
          },
          NetworkSettings: { Networks: {} },
        },
        {
          Id: 'unscoped-current-volume',
          Names: ['/ctxmill-sandbox-r3'],
          State: 'running',
          Labels: {
            'ctxmill.managed': 'true',
            'ctxmill.sandbox-session-id': 'r3',
          },
          Mounts: [
            { Name: 'ctxmill_ctxmill-data', Destination: '/workspace' },
          ],
          NetworkSettings: { Networks: {} },
        },
        {
          Id: 'unscoped-foreign-volume',
          Names: ['/ctxmill-sandbox-r4'],
          State: 'running',
          Labels: {
            'ctxmill.managed': 'true',
            'ctxmill.sandbox-session-id': 'r4',
          },
          Mounts: [
            { Name: 'pilot-app_ctxmill_data', Destination: '/workspace' },
          ],
          NetworkSettings: { Networks: {} },
        },
      ]);

      const result = await manager.listManagedContainers();
      expect(result.map((container) => container.containerId)).toEqual([
        'current-scoped',
      ]);
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
      const customManager = new ContainerManager({ networkName: 'my-net' }, docker as unknown as Dockerode);
      docker.getNetwork.mockReturnValue({
        inspect: vi.fn().mockRejectedValue({ statusCode: 404 }),
      });

      await customManager.ensureNetwork();

      expect(docker.getNetwork).toHaveBeenCalledWith('my-net');
      expect(docker.createNetwork).toHaveBeenCalledWith(
        expect.objectContaining({ Name: 'my-net' }),
      );
    });

    it('propagates non-404 inspect failures without creating the network', async () => {
      const failure = { statusCode: 500, message: 'docker unavailable' };
      docker.getNetwork.mockReturnValue({
        inspect: vi.fn().mockRejectedValue(failure),
      });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      try {
        await expect(manager.ensureNetwork()).rejects.toEqual(failure);
      } finally {
        warnSpy.mockRestore();
      }
      expect(docker.createNetwork).not.toHaveBeenCalled();
    });

    it('propagates permission-shaped inspect failures without creating the network', async () => {
      const failure = { statusCode: 403, message: 'permission denied' };
      docker.getNetwork.mockReturnValue({
        inspect: vi.fn().mockRejectedValue(failure),
      });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      try {
        await expect(manager.ensureNetwork()).rejects.toEqual(failure);
      } finally {
        warnSpy.mockRestore();
      }
      expect(docker.createNetwork).not.toHaveBeenCalled();
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
          Names: [`/ctxmill-sandbox-r-${dockerState}`],
          State: dockerState,
          Labels: {
            'ctxmill.managed': 'true',
            [CONTAINER_SCOPE_LABEL]: resolveContainerScopeId(),
            'ctxmill.sandbox-session-id': `r-${dockerState}`,
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
    const manager = new ContainerManager({ maxGlobalContainers: 1 }, docker as unknown as Dockerode);

    await expect(manager.createContainer(defaultCreateOpts())).rejects.toThrow('docker create failed');
    expect(manager.getMetrics().active).toBe(0);
  });

  it('does NOT release semaphore on successful container creation', async () => {
    const docker = createMockDocker();
    const manager = new ContainerManager({ maxGlobalContainers: 1 }, docker as unknown as Dockerode);

    const info = await manager.createContainer(defaultCreateOpts());

    expect(manager.getMetrics().active).toBe(1);

    await manager.removeContainer(info.containerId);
    expect(manager.getMetrics().active).toBe(0);
  });

  it('releases semaphore when post-Docker metrics code throws', async () => {
    const docker = createMockDocker();
    const manager = new ContainerManager({ maxGlobalContainers: 1 }, docker as unknown as Dockerode);
    const accounting = Reflect.get(manager, 'accounting') as { registerCreated: (id: string, harness: string) => void };
    const registerSpy = vi.spyOn(accounting, 'registerCreated').mockImplementation(() => {
      throw new Error('metrics failed');
    });

    await expect(manager.createContainer(defaultCreateOpts())).rejects.toThrow('metrics failed');
    expect(manager.getMetrics().active).toBe(0);

    registerSpy.mockRestore();
  });

  it('releases a slot only once when removeContainer is called repeatedly for the same container', async () => {
    const docker = createSequencedDocker(['sha256-owned-1', 'sha256-owned-2']);
    const manager = new ContainerManager(
      { maxGlobalContainers: 1 },
      docker as unknown as Dockerode,
    );
    const first = await manager.createContainer(defaultCreateOpts());
    const secondPromise = manager.createContainer({
      ...defaultCreateOpts(),
      sessionId: 'run-002',
    });

    expect(manager.getMetrics().active).toBe(1);
    expect(manager.getQueuedCount()).toBe(1);

    await manager.removeContainer(first.containerId);
    const second = await secondPromise;
    expect(second.containerId).toBe('sha256-owned-2');
    expect(manager.getMetrics().active).toBe(1);

    const firstContainer = docker.getContainer(first.containerId) as ReturnType<typeof createMockContainer>;
    firstContainer.remove.mockRejectedValueOnce({ statusCode: 404, message: 'not found' });

    await manager.removeContainer(first.containerId);

    expect(manager.getMetrics().active).toBe(1);
    expect(manager.getMetrics().byHarness).toEqual({ 'claude-agents': 1 });

    await manager.removeContainer(second.containerId);
    expect(manager.getMetrics().active).toBe(0);
  });
});
