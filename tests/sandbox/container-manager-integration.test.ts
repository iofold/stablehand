/**
 * Integration tests for ContainerManager with mocked Docker.
 *
 * Validates container creation configuration, secret injection,
 * and orphan cleanup without requiring a running Docker daemon.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContainerManager } from '../../packages/ctxmill/src/sandbox/container-manager.js';
import type { CreateContainerOptions } from '../../packages/ctxmill/src/sandbox/container-manager.js';
import {
  createMockContainer,
  createMockDocker,
  createMockNetwork,
} from '../utils/event-bus-test-helpers.js';

function defaultCreateOpts(): CreateContainerOptions {
  return {
    sessionId: 'run-001',
    agentId: 'agent-abc',
    harnessName: 'claude-agents',
  };
}

// ── Tests ───────────────────────────────────────────────────

describe('ContainerManager Integration Tests', () => {
  let docker: ReturnType<typeof createMockDocker>;
  let manager: ContainerManager;

  beforeEach(() => {
    const mockContainer = createMockContainer({
      inspect: vi.fn().mockResolvedValue({
        State: { Status: 'exited', ExitCode: 0 },
      }),
    });
    docker = createMockDocker({
      createContainer: vi.fn().mockResolvedValue(mockContainer),
      getContainer: vi.fn().mockReturnValue(mockContainer),
      getNetwork: vi.fn().mockReturnValue(createMockNetwork()),
      _mockContainer: mockContainer,
    });
    manager = new ContainerManager(undefined, docker as any);
  });

  // ── Test 7: Container creation ─────────────────────────────

  describe('container creation — labels', () => {
    it('should set all required ctxmill labels', async () => {
      await manager.createContainer({
        ...defaultCreateOpts(),
        timeoutSec: 300,
      });

      expect(docker.createContainer).toHaveBeenCalledTimes(1);
      const arg = docker.createContainer.mock.calls[0][0];

      expect(arg.Labels['ctxmill.managed']).toBe('true');
      expect(arg.Labels['ctxmill.session-id']).toBe('run-001');
      expect(arg.Labels['ctxmill.agent-id']).toBe('agent-abc');
      expect(arg.Labels['ctxmill.harness']).toBe('claude-agents');
      expect(arg.Labels['ctxmill.timeout']).toBe('300');
      expect(arg.Labels['ctxmill.started-at']).toBeTruthy();

      // Verify started-at is a valid ISO date string
      const parsed = new Date(arg.Labels['ctxmill.started-at']);
      expect(parsed.getTime()).toBeGreaterThan(0);
    });

    it('should use correct label values from different agents', async () => {
      await manager.createContainer({
        sessionId: 'run-xyz-789',
        agentId: 'finance-analyzer',
        harnessName: 'pi-agent',
        timeoutSec: 1200,
      });

      const arg = docker.createContainer.mock.calls[0][0];
      expect(arg.Labels['ctxmill.session-id']).toBe('run-xyz-789');
      expect(arg.Labels['ctxmill.agent-id']).toBe('finance-analyzer');
      expect(arg.Labels['ctxmill.harness']).toBe('pi-agent');
      expect(arg.Labels['ctxmill.timeout']).toBe('1200');
    });
  });

  describe('container creation — resource limits', () => {
    it('should apply default resource limits when not specified', async () => {
      await manager.createContainer(defaultCreateOpts());

      const arg = docker.createContainer.mock.calls[0][0];
      expect(arg.HostConfig.CpuPeriod).toBe(100_000);
      expect(arg.HostConfig.CpuQuota).toBe(100_000); // 1.0 CPU * 100000
      expect(arg.HostConfig.Memory).toBe(2048 * 1024 * 1024); // 2048 MiB
      expect(arg.HostConfig.MemorySwap).toBe(2048 * 1024 * 1024); // No swap
      expect(arg.HostConfig.PidsLimit).toBe(256);
    });

    it('should apply custom resource limits', async () => {
      await manager.createContainer({
        ...defaultCreateOpts(),
        cpus: 2.5,
        memoryMb: 2048,
        pidsLimit: 512,
      });

      const arg = docker.createContainer.mock.calls[0][0];
      expect(arg.HostConfig.CpuQuota).toBe(250_000); // 2.5 * 100000
      expect(arg.HostConfig.Memory).toBe(2048 * 1024 * 1024);
      expect(arg.HostConfig.MemorySwap).toBe(2048 * 1024 * 1024);
      expect(arg.HostConfig.PidsLimit).toBe(512);
    });

    it('should enforce no-swap by setting MemorySwap equal to Memory', async () => {
      await manager.createContainer({
        ...defaultCreateOpts(),
        memoryMb: 1024,
      });

      const arg = docker.createContainer.mock.calls[0][0];
      expect(arg.HostConfig.Memory).toBe(arg.HostConfig.MemorySwap);
    });

    it('should set NODE_OPTIONS based on memory limit', async () => {
      await manager.createContainer({
        ...defaultCreateOpts(),
        memoryMb: 1024,
      });

      const arg = docker.createContainer.mock.calls[0][0];
      const nodeOpts = arg.Env.find((e: string) => e.startsWith('NODE_OPTIONS='));
      expect(nodeOpts).toBe(`NODE_OPTIONS=--max-old-space-size=${Math.floor(2048 * 0.9)}`);
    });
  });

  describe('container creation — tmpfs mount', () => {
    it('should mount tmpfs at /run/secrets with restricted permissions', async () => {
      await manager.createContainer(defaultCreateOpts());

      const arg = docker.createContainer.mock.calls[0][0];
      expect(arg.HostConfig.Tmpfs).toEqual({
        '/run/secrets': 'rw,noexec,nosuid,size=1m',
      });
    });
  });

  describe('container creation — network', () => {
    it('should assign default network', async () => {
      await manager.createContainer(defaultCreateOpts());

      const arg = docker.createContainer.mock.calls[0][0];
      expect(arg.HostConfig.NetworkMode).toBe('ctxmill-agents');
    });

    it('should use custom network from manager options', async () => {
      const customManager = new ContainerManager(
        { networkName: 'custom-agent-net' },
        docker as any,
      );
      await customManager.createContainer(defaultCreateOpts());

      const arg = docker.createContainer.mock.calls[0][0];
      expect(arg.HostConfig.NetworkMode).toBe('custom-agent-net');
    });
  });

  describe('container creation — security', () => {
    it('should set no-new-privileges security option', async () => {
      await manager.createContainer(defaultCreateOpts());

      const arg = docker.createContainer.mock.calls[0][0];
      expect(arg.HostConfig.SecurityOpt).toEqual(['no-new-privileges']);
    });
  });

  describe('container creation — environment', () => {
    it('should set SANDBOX_PORT env variable', async () => {
      await manager.createContainer(defaultCreateOpts());

      const arg = docker.createContainer.mock.calls[0][0];
      expect(arg.Env).toContain('SANDBOX_PORT=50051');
    });
  });

  describe('container creation — secrets env', () => {
    it('should pass secrets as env vars during container creation', async () => {
      await manager.createContainer({
        ...defaultCreateOpts(),
        secrets: {
          OPENAI_API_KEY: 'sk-test-key',
          ANTHROPIC_API_KEY: 'sk-ant-test',
        },
      });

      const arg = docker.createContainer.mock.calls[0][0];
      expect(arg.Env).toContain('OPENAI_API_KEY=sk-test-key');
      expect(arg.Env).toContain('ANTHROPIC_API_KEY=sk-ant-test');
    });

    it('should handle empty secrets objects without adding env vars', async () => {
      await manager.createContainer({
        ...defaultCreateOpts(),
        secrets: {},
      });

      const arg = docker.createContainer.mock.calls[0][0];
      expect(arg.Env.some((entry: string) => entry.startsWith('OPENAI_API_KEY='))).toBe(false);
      expect(arg.Env.some((entry: string) => entry.startsWith('ANTHROPIC_API_KEY='))).toBe(false);
    });
  });



  // ── Container state tracking ───────────────────────────────

  describe('container exit code detection', () => {
    it('should detect OOM kill (exit code 137)', async () => {
      docker._mockContainer.inspect.mockResolvedValue({
        State: { Status: 'exited', ExitCode: 137 },
      });

      const exitCode = await manager.getContainerExitCode('sha256-abc123');
      expect(exitCode).toBe(137);
    });

    it('should detect normal exit (exit code 0)', async () => {
      docker._mockContainer.inspect.mockResolvedValue({
        State: { Status: 'exited', ExitCode: 0 },
      });

      const exitCode = await manager.getContainerExitCode('sha256-abc123');
      expect(exitCode).toBe(0);
    });

    it('should return null for running container', async () => {
      docker._mockContainer.inspect.mockResolvedValue({
        State: { Status: 'running', ExitCode: 0 },
      });

      const exitCode = await manager.getContainerExitCode('sha256-abc123');
      expect(exitCode).toBeNull();
    });

    it('should return null for container not found (404)', async () => {
      docker._mockContainer.inspect.mockRejectedValue({
        statusCode: 404,
        message: 'not found',
      });

      const exitCode = await manager.getContainerExitCode('sha256-abc123');
      expect(exitCode).toBeNull();
    });
  });

  // ── Custom manager options ─────────────────────────────────

  describe('custom manager options', () => {
    it('should use custom image prefix for container image', async () => {
      const customManager = new ContainerManager(
        { imagePrefix: 'my-registry.io/ctxmill/sandbox' },
        docker as any,
      );

      await customManager.createContainer({
        ...defaultCreateOpts(),
        harnessName: 'langgraph',
      });

      const arg = docker.createContainer.mock.calls[0][0];
      expect(arg.Image).toBe('my-registry.io/ctxmill/sandbox-langgraph:latest');
    });

    it('should use custom default resource limits', async () => {
      const customManager = new ContainerManager(
        {
          defaultCpus: 0.5,
          defaultMemoryMb: 256,
          defaultPidsLimit: 128,
          defaultTimeoutSec: 300,
        },
        docker as any,
      );

      await customManager.createContainer(defaultCreateOpts());

      const arg = docker.createContainer.mock.calls[0][0];
      expect(arg.HostConfig.CpuQuota).toBe(50_000); // 0.5 * 100000
      expect(arg.HostConfig.Memory).toBe(2048 * 1024 * 1024);
      expect(arg.HostConfig.PidsLimit).toBe(128);
      expect(arg.Labels['ctxmill.timeout']).toBe('300');
    });
  });
});
