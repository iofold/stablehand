import { describe, expect, it } from 'vitest';
import { CONTAINER_SCOPE_LABEL } from '../../container-scope.js';
import {
  buildDockerContainerSpec,
  buildKubernetesJobSpec,
  buildSandboxOtelEnv,
  buildSandboxEgressEnv,
  SANDBOX_EGRESS_DEFAULT_NO_PROXY,
  sandboxProxyUrl,
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
      + 'service.namespace=stablehand,stablehand.component=sandbox,'
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

  it('routes sandbox egress through the proxy and mounts its CA when configured', () => {
    const previous = {
      url: process.env.STABLEHAND_SANDBOX_EGRESS_PROXY_URL,
      noProxy: process.env.STABLEHAND_SANDBOX_NO_PROXY,
    };
    process.env.STABLEHAND_SANDBOX_EGRESS_PROXY_URL = 'http://egress:8080';
    delete process.env.STABLEHAND_SANDBOX_NO_PROXY;
    try {
      const spec = buildDockerContainerSpec({
        options: createOptions,
        imagePrefix: 'stablehand/harness',
        scopeId: 'scope-1',
        networkName: 'stablehand-agents',
        defaults,
        startupGraceMs: 90_000,
        startedAtIso: '2026-07-08T15:00:00.000Z',
        orchestratorUrl: 'http://orchestrator:3001',
        sandboxOtelEnv: [],
        egressCaVolume: 'stablehand_egress-ca-public',
      });

      expect(spec.createOptions.Env).toEqual([
        `NODE_OPTIONS=--max-old-space-size=${Math.floor(2048 * 0.9)}`,
        'SANDBOX_PORT=50051',
        'STABLEHAND_HARNESS=claude-agents',
        'ORCHESTRATOR_URL=http://orchestrator:3001',
        'HTTP_PROXY=http://egress:8080',
        'HTTPS_PROXY=http://egress:8080',
        'http_proxy=http://egress:8080',
        'https_proxy=http://egress:8080',
        `NO_PROXY=${SANDBOX_EGRESS_DEFAULT_NO_PROXY}`,
        `no_proxy=${SANDBOX_EGRESS_DEFAULT_NO_PROXY}`,
        'NODE_USE_ENV_PROXY=1',
        'STABLEHAND_EGRESS_CA=/etc/stablehand/egress-ca/egress-ca.pem',
        'NODE_EXTRA_CA_CERTS=/etc/stablehand/egress-ca/egress-ca.pem',
        'SSL_CERT_FILE=/etc/stablehand/egress-ca/egress-ca.pem',
        'REQUESTS_CA_BUNDLE=/etc/stablehand/egress-ca/egress-ca.pem',
        'CURL_CA_BUNDLE=/etc/stablehand/egress-ca/egress-ca.pem',
        'GIT_SSL_CAINFO=/etc/stablehand/egress-ca/egress-ca.pem',
        'OPENAI_API_KEY=sk-test',
      ]);
      expect(spec.createOptions.HostConfig.Mounts).toEqual([
        {
          Type: 'volume',
          Source: 'stablehand_egress-ca-public',
          Target: '/etc/stablehand/egress-ca',
          ReadOnly: true,
        },
      ]);
      expect(spec.createOptions.HostConfig.DnsOptions).toEqual(['timeout:2', 'attempts:1']);
    } finally {
      if (previous.url === undefined) delete process.env.STABLEHAND_SANDBOX_EGRESS_PROXY_URL;
      else process.env.STABLEHAND_SANDBOX_EGRESS_PROXY_URL = previous.url;
      if (previous.noProxy !== undefined) process.env.STABLEHAND_SANDBOX_NO_PROXY = previous.noProxy;
    }
  });

  it('puts the session lease in the proxy URL (ctx-3aef)', () => {
    expect(sandboxProxyUrl('http://egress:8081', { sessionId: 'run-001', token: 'YWdlbnQ.c2ln-_' }))
      .toBe('http://run-001:YWdlbnQ.c2ln-_@egress:8081');
    expect(sandboxProxyUrl('http://egress:8081')).toBe('http://egress:8081');
    expect(sandboxProxyUrl('http://old:creds@egress:8081/', { sessionId: 's', token: 't' }))
      .toBe('http://s:t@egress:8081');
    expect(sandboxProxyUrl('egress:8081', { sessionId: 's', token: 't' })).toBe('egress:8081');
    expect(buildSandboxEgressEnv({ STABLEHAND_SANDBOX_EGRESS_PROXY_URL: 'http://egress:8081' }, {
      sessionId: 'run-001',
      token: 'tok',
    }).slice(0, 4)).toEqual([
      'HTTP_PROXY=http://run-001:tok@egress:8081',
      'HTTPS_PROXY=http://run-001:tok@egress:8081',
      'http_proxy=http://run-001:tok@egress:8081',
      'https_proxy=http://run-001:tok@egress:8081',
    ]);
  });

  it('gives each Docker sandbox its lease and keeps it out of Kubernetes Job env', () => {
    const previous = process.env.STABLEHAND_SANDBOX_EGRESS_PROXY_URL;
    process.env.STABLEHAND_SANDBOX_EGRESS_PROXY_URL = 'http://egress:8081';
    try {
      const options = { ...createOptions, egressLeaseToken: 'lease-token' };
      const docker = buildDockerContainerSpec({
        options,
        imagePrefix: 'stablehand/harness',
        scopeId: 'scope-1',
        networkName: 'stablehand-agents',
        defaults,
        startupGraceMs: 90_000,
        startedAtIso: '2026-07-08T15:00:00.000Z',
        orchestratorUrl: 'http://orchestrator:3001',
        sandboxOtelEnv: [],
      });
      expect(docker.createOptions.Env).toContain('HTTPS_PROXY=http://run-001:lease-token@egress:8081');
      expect(docker.createOptions.Env).toContain('NO_PROXY=' + SANDBOX_EGRESS_DEFAULT_NO_PROXY);

      const kubernetes = buildKubernetesJobSpec({
        options,
        namespace: 'stablehand',
        imagePrefix: 'stablehand/harness',
        scopeId: 'scope-1',
        defaults,
        startupGraceMs: 90_000,
        startedAtIso: '2026-07-08T15:00:00.000Z',
        orchestratorUrl: 'http://orchestrator:3001',
        dataHostPathRoot: '/var/lib/stablehand/data',
        sandboxOtelEnv: [],
      });
      const jobEnv = kubernetes.manifest.spec.template.spec.containers[0]?.env ?? [];
      expect(JSON.stringify(jobEnv)).not.toContain('lease-token');
      expect(jobEnv.map((entry) => entry.name)).toContain('NO_PROXY');
      expect(jobEnv.map((entry) => entry.name)).not.toContain('HTTPS_PROXY');
      expect(kubernetes.secretManifest?.stringData).toMatchObject({
        OPENAI_API_KEY: 'sk-test',
        HTTP_PROXY: 'http://run-001:lease-token@egress:8081',
        HTTPS_PROXY: 'http://run-001:lease-token@egress:8081',
        http_proxy: 'http://run-001:lease-token@egress:8081',
        https_proxy: 'http://run-001:lease-token@egress:8081',
      });

      const unleased = buildKubernetesJobSpec({
        options: createOptions,
        namespace: 'stablehand',
        imagePrefix: 'stablehand/harness',
        scopeId: 'scope-1',
        defaults,
        startupGraceMs: 90_000,
        startedAtIso: '2026-07-08T15:00:00.000Z',
        orchestratorUrl: 'http://orchestrator:3001',
        dataHostPathRoot: '/var/lib/stablehand/data',
        sandboxOtelEnv: [],
      });
      expect(unleased.manifest.spec.template.spec.containers[0]?.env)
        .toContainEqual({ name: 'HTTPS_PROXY', value: 'http://egress:8081' });
      expect(unleased.secretManifest?.stringData).toEqual({ OPENAI_API_KEY: 'sk-test' });
    } finally {
      if (previous === undefined) delete process.env.STABLEHAND_SANDBOX_EGRESS_PROXY_URL;
      else process.env.STABLEHAND_SANDBOX_EGRESS_PROXY_URL = previous;
    }
  });

  it('leaves sandbox egress untouched when no proxy is configured', () => {
    expect(buildSandboxEgressEnv({})).toEqual([]);
    expect(buildSandboxEgressEnv({ STABLEHAND_SANDBOX_EGRESS_PROXY_URL: '   ' })).toEqual([]);
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
