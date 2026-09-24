import { describe, expect, it } from 'vitest';
import { CONTAINER_SCOPE_LABEL } from '../../container-scope.js';
import {
  buildDockerContainerSpec,
  buildKubernetesJobSpec,
  buildSandboxOtelEnv,
  resolveSandboxRuntimeDefaults,
  runtimeLabelsToContainerInfo,
  sanitizeKubernetesName,
} from '../spec.js';

const createOptions = {
  sessionId: 'run-001',
  conversationId: 'conversation-1',
  agentId: 'agent-abc',
  harnessName: 'claude-agents',
  cpus: 2,
  memoryMb: 1024,
  pidsLimit: 512,
  timeoutSec: 1200,
  workspaceDir: '/tmp/workspaces/run-001',
  secrets: {
    OPENAI_API_KEY: 'sk-test',
  },
};

const defaults = {
  cpus: 1,
  memoryMb: 512,
  pidsLimit: 256,
  timeoutSec: 600,
};

describe('sandbox runtime spec builders', () => {
  it('correlates sandbox telemetry to its durable runtime identity', () => {
    const env = buildSandboxOtelEnv('langgraph', {
      sessionId: 'session-1',
      agentId: 'agent-1',
      conversationId: 'conversation-1',
    });

    expect(env).toContain(
      'OTEL_RESOURCE_ATTRIBUTES=deployment.environment=local,'
      + 'service.namespace=stablehand,ctxmill.component=sandbox,'
      + 'stablehand.harness=langgraph,stablehand.session.id=session-1,'
      + 'stablehand.agent.id=agent-1,stablehand.conversation.id=conversation-1',
    );
  });

  it('resolves shared driver defaults with explicit overrides', () => {
    expect(resolveSandboxRuntimeDefaults()).toEqual({
      cpus: 1,
      memoryMb: 1024,
      pidsLimit: 256,
      timeoutSec: 600,
    });
    expect(resolveSandboxRuntimeDefaults({ defaultMemoryMb: 4096, defaultTimeoutSec: 30 })).toEqual({
      cpus: 1,
      memoryMb: 4096,
      pidsLimit: 256,
      timeoutSec: 30,
    });
  });

  it('projects runtime labels into container info', () => {
    expect(runtimeLabelsToContainerInfo({
      containerId: 'container-1',
      containerName: 'stablehand-sandbox-1',
      labels: {
        'stablehand.sandbox-session-id': 'session-1',
        'stablehand.agent-id': 'agent-1',
        'stablehand.harness': 'langgraph',
      },
      status: 'running',
      startedAt: '2026-07-08T15:00:00.000Z',
      networkIp: '10.0.0.2',
    })).toEqual({
      containerId: 'container-1',
      containerName: 'stablehand-sandbox-1',
      sessionId: 'session-1',
      agentId: 'agent-1',
      harnessName: 'langgraph',
      status: 'running',
      startedAt: new Date('2026-07-08T15:00:00.000Z'),
      networkIp: '10.0.0.2',
    });
  });

  it('builds the Docker create spec from shared runtime inputs', () => {
    const spec = buildDockerContainerSpec({
      options: createOptions,
      imagePrefix: 'stablehand/harness',
      scopeId: 'scope-1',
      networkName: 'stablehand-agents',
      defaults,
      startupGraceMs: 90_000,
      startedAtIso: '2026-07-08T15:00:00.000Z',
      orchestratorUrl: 'http://orchestrator:3001',
      sandboxOtelEnv: ['OTEL_SERVICE_NAME=stablehand-sandbox-claude-agents'],
    });

    expect(spec.containerName).toBe('stablehand-sandbox-run-001');
    expect(spec.resources).toEqual({
      cpus: 2,
      memoryMb: 2048,
      pidsLimit: 512,
      timeoutSec: 1200,
    });
    expect(spec.createOptions).toMatchObject({
      Image: 'stablehand/harness-claude-agents:latest',
      name: 'stablehand-sandbox-run-001',
      Labels: {
        'stablehand.managed': 'true',
        [CONTAINER_SCOPE_LABEL]: 'scope-1',
        'stablehand.sandbox-session-id': 'run-001',
        'stablehand.conversation-id': 'conversation-1',
        'stablehand.agent-id': 'agent-abc',
        'stablehand.harness': 'claude-agents',
        'stablehand.started-at': '2026-07-08T15:00:00.000Z',
        'stablehand.timeout': '1200',
        'stablehand.startup-grace-ms': '90000',
      },
      HostConfig: {
        CpuPeriod: 100_000,
        CpuQuota: 200_000,
        Memory: 2048 * 1024 * 1024,
        MemorySwap: 2048 * 1024 * 1024,
        PidsLimit: 512,
        NetworkMode: 'stablehand-agents',
        Binds: ['/tmp/workspaces/run-001:/workspace:rw'],
      },
      Env: [
        `NODE_OPTIONS=--max-old-space-size=${Math.floor(2048 * 0.9)}`,
        'OTEL_SERVICE_NAME=stablehand-sandbox-claude-agents',
        'SANDBOX_PORT=50051',
        'STABLEHAND_HARNESS=claude-agents',
        'ORCHESTRATOR_URL=http://orchestrator:3001',
        'OPENAI_API_KEY=sk-test',
      ],
    });
  });

  it('builds the Kubernetes Job manifest from shared runtime inputs', () => {
    const spec = buildKubernetesJobSpec({
      options: createOptions,
      namespace: 'stablehand',
      imagePrefix: 'stablehand/harness',
      scopeId: 'scope-1',
      defaults,
      startupGraceMs: 90_000,
      startedAtIso: '2026-07-08T15:00:00.000Z',
      orchestratorUrl: 'http://orchestrator:3001',
      dataHostPathRoot: '/var/lib/stablehand/data',
      sandboxOtelEnv: ['OTEL_SERVICE_NAME=stablehand-sandbox-claude-agents'],
    });

    expect(spec.jobName).toBe('stablehand-sandbox-run-001');
    expect(spec.workspaceHostPath).toBe('/tmp/workspaces/run-001');
    expect(spec.resources).toEqual({
      cpus: 2,
      memoryMb: 2048,
      pidsLimit: 512,
      timeoutSec: 1200,
    });
    expect(spec.manifest).toMatchObject({
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: {
        name: 'stablehand-sandbox-run-001',
        namespace: 'stablehand',
        labels: {
          'app.kubernetes.io/name': 'stablehand-sandbox',
          'app.kubernetes.io/part-of': 'stablehand',
          'stablehand.managed': 'true',
          [CONTAINER_SCOPE_LABEL]: 'scope-1',
          'stablehand.sandbox-session-id': 'run-001',
          'stablehand.conversation-id': 'conversation-1',
          'stablehand.agent-id': 'agent-abc',
          'stablehand.harness': 'claude-agents',
        },
        annotations: {
          'stablehand.started-at': '2026-07-08T15:00:00.000Z',
          'stablehand.timeout': '1200',
          'stablehand.startup-grace-ms': '90000',
        },
      },
    });
    expect(spec.manifest.spec.template.spec.containers[0]).toMatchObject({
      name: 'sandbox',
      image: 'stablehand/harness-claude-agents:latest',
      imagePullPolicy: 'IfNotPresent',
      resources: {
        requests: { cpu: '2000m', memory: '2048Mi' },
        limits: { cpu: '2000m', memory: '2048Mi' },
      },
      env: [
        { name: 'NODE_OPTIONS', value: `--max-old-space-size=${Math.floor(2048 * 0.9)}` },
        { name: 'OTEL_SERVICE_NAME', value: 'stablehand-sandbox-claude-agents' },
        { name: 'SANDBOX_PORT', value: '50051' },
        { name: 'STABLEHAND_HARNESS', value: 'claude-agents' },
        { name: 'ORCHESTRATOR_URL', value: 'http://orchestrator:3001' },
      ],
      envFrom: [{ secretRef: { name: 'stablehand-sandbox-run-001-env' } }],
      volumeMounts: [{ name: 'workspace', mountPath: '/workspace' }],
    });
    expect(JSON.stringify(spec.manifest)).not.toContain('sk-test');
    expect((spec as unknown as {
      secretManifest?: {
        metadata: { name: string; namespace: string };
        stringData: Record<string, string>;
      };
    }).secretManifest).toEqual(expect.objectContaining({
      metadata: expect.objectContaining({
        name: 'stablehand-sandbox-run-001-env',
        namespace: 'stablehand',
      }),
      stringData: {
        OPENAI_API_KEY: 'sk-test',
      },
    }));
    expect(spec.manifest.spec.template.spec.volumes).toEqual([{
      name: 'workspace',
      hostPath: {
        path: '/tmp/workspaces/run-001',
        type: 'DirectoryOrCreate',
      },
    }]);
  });

  it('sanitizes Kubernetes names with the current truncation policy', () => {
    expect(sanitizeKubernetesName('Session With Spaces And CAPS')).toBe('session-with-spaces-and-caps');
    expect(sanitizeKubernetesName(`x${'a'.repeat(80)}`)).toHaveLength(52);
  });

  it('uses the deployment-selected Kubernetes image pull policy', () => {
    const spec = buildKubernetesJobSpec({
      options: createOptions,
      namespace: 'stablehand',
      imagePrefix: 'stablehand/harness',
      scopeId: 'scope-1',
      defaults,
      startupGraceMs: 90_000,
      startedAtIso: '2026-07-08T15:00:00.000Z',
      orchestratorUrl: 'http://orchestrator:3001',
      dataHostPathRoot: '/var/lib/stablehand/data',
      imagePullPolicy: 'Never',
    } as Parameters<typeof buildKubernetesJobSpec>[0] & { imagePullPolicy: 'Never' });

    expect(spec.manifest.spec.template.spec.containers[0]?.imagePullPolicy).toBe('Never');
  });
});
