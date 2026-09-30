import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse, parseAllDocuments } from 'yaml';

interface ModelGatewayConfig {
  model_list?: Array<{
    model_name?: string;
    litellm_params?: {
      model?: string;
      api_key?: string;
      allowed_openai_params?: string[];
      chat_template_kwargs?: Record<string, unknown>;
    };
  }>;
}

interface ModelGatewayCompose {
  services?: {
    litellm?: {
      environment?: Record<string, string>;
      labels?: string[];
      networks?: string[];
      ports?: string[];
    };
  };
}

function readYaml<T>(path: string): T {
  return parse(readFileSync(resolve(process.cwd(), path), 'utf8')) as T;
}

interface KubernetesResource {
  kind?: string;
  metadata?: {
    name?: string;
    annotations?: Record<string, string>;
  };
  spec?: Record<string, unknown>;
  rules?: Array<Record<string, unknown>>;
}

function readYamlDocuments(path: string): KubernetesResource[] {
  return parseAllDocuments(
    readFileSync(resolve(process.cwd(), path), 'utf8'),
  ).map((document) => document.toJS() as KubernetesResource);
}

function findResource(
  resources: readonly KubernetesResource[],
  kind: string,
  name: string,
): KubernetesResource {
  const resource = resources.find((candidate) =>
    candidate.kind === kind && candidate.metadata?.name === name);
  expect(resource, `missing ${kind}/${name}`).toBeDefined();
  return resource!;
}

describe('model gateway deployment', () => {
  it('publishes current OpenAI and Anthropic families while retaining routed legacy aliases', () => {
    const config = readYaml<ModelGatewayConfig>(
      'deploy/compose/model-gateway/config.yaml',
    );

    expect(config.model_list).toEqual(expect.arrayContaining([
      {
        model_name: 'gpt-5.6-sol',
        litellm_params: {
          model: 'openai/gpt-5.6-sol',
          api_key: 'os.environ/OPENAI_API_KEY',
        },
      },
      {
        model_name: 'gpt-5.6-terra',
        litellm_params: {
          model: 'openai/gpt-5.6-terra',
          api_key: 'os.environ/OPENAI_API_KEY',
        },
      },
      {
        model_name: 'gpt-5.6-luna',
        litellm_params: {
          model: 'openai/gpt-5.6-luna',
          api_key: 'os.environ/OPENAI_API_KEY',
        },
      },
      {
        model_name: 'claude-sonnet-5',
        litellm_params: {
          model: 'anthropic/claude-sonnet-5',
          api_key: 'os.environ/ANTHROPIC_API_KEY',
        },
      },
      {
        model_name: 'claude-opus-5',
        litellm_params: {
          model: 'anthropic/claude-opus-5',
          api_key: 'os.environ/ANTHROPIC_API_KEY',
        },
      },
      {
        model_name: 'claude-haiku-4-5',
        litellm_params: {
          model: 'anthropic/claude-haiku-4-5',
          api_key: 'os.environ/ANTHROPIC_API_KEY',
        },
      },
    ]));
    expect(config.model_list?.map((entry) => entry.model_name)).toEqual(
      expect.arrayContaining([
        'gpt-5.4',
        'gpt-5.4-mini',
        'claude-sonnet-4-6',
        'claude-opus-4-6',
      ]),
    );
  });

  it('routes current Google Gemini traffic with a deployment-owned key', () => {
    const config = readYaml<ModelGatewayConfig>(
      'deploy/compose/model-gateway/config.yaml',
    );
    const compose = readYaml<ModelGatewayCompose>(
      'deploy/compose/model-gateway/docker-compose.yml',
    );

    expect(config.model_list).toContainEqual({
      model_name: 'gemini-3.6-flash',
      litellm_params: {
        model: 'gemini/gemini-3.6-flash',
        api_key: 'os.environ/GOOGLE_API_KEY',
      },
    });
    expect(config.model_list).toContainEqual({
      model_name: 'gemini-3.5-flash-lite',
      litellm_params: {
        model: 'gemini/gemini-3.5-flash-lite',
        api_key: 'os.environ/GOOGLE_API_KEY',
      },
    });
    expect(
      compose.services?.litellm?.environment?.GOOGLE_API_KEY,
    ).toBe('${GOOGLE_API_KEY:-}');
  });

  it('publishes a curated Cloudflare Workers AI inventory with deployment-owned credentials', () => {
    const config = readYaml<ModelGatewayConfig>(
      'deploy/compose/model-gateway/config.yaml',
    );
    const compose = readYaml<ModelGatewayCompose>(
      'deploy/compose/model-gateway/docker-compose.yml',
    );
    const workersAiModels = config.model_list?.filter(
      (entry) => entry.litellm_params?.model?.startsWith('together_ai/workers-ai/'),
    ) ?? [];

    // The routing shape is load-bearing (dev2 endurance gauntlet, 2026-08-13):
    // together_ai/ keeps LiteLLM's /v1/responses bridge for the PI harness,
    // the compat api_base replaces the expiring api.cloudflare.com token,
    // explicit per-token costs price what the built-in map misses under this
    // prefix, and cf-aig-skip-cache preserves per-call billing evidence.
    const expectedModels: Record<string, string> = {
      'cf-gpt-oss-120b': 'together_ai/workers-ai/@cf/openai/gpt-oss-120b',
      'cf-kimi-k2.7-code': 'together_ai/workers-ai/@cf/moonshotai/kimi-k2.7-code',
      'cf-glm-5.2': 'together_ai/workers-ai/@cf/zai-org/glm-5.2',
      'cf-glm-5.2-no-thinking': 'together_ai/workers-ai/@cf/zai-org/glm-5.2',
      'cf-gemma-4-26b': 'together_ai/workers-ai/@cf/google/gemma-4-26b-a4b-it',
      'cf-qwen3-30b': 'together_ai/workers-ai/@cf/qwen/qwen3-30b-a3b-fp8',
    };
    expect(workersAiModels.map((entry) => entry.model_name)).toEqual(
      Object.keys(expectedModels),
    );
    for (const entry of workersAiModels) {
      const params = entry.litellm_params as Record<string, unknown>;
      expect(params.model).toBe(expectedModels[entry.model_name as string]);
      expect(params.api_base).toBe('os.environ/CLOUDFLARE_AI_GATEWAY_COMPAT_URL');
      expect(params.api_key).toBe('os.environ/CLOUDFLARE_API_KEY');
      expect(typeof params.input_cost_per_token).toBe('number');
      expect(typeof params.output_cost_per_token).toBe('number');
      expect(params.input_cost_per_token as number).toBeGreaterThan(0);
      expect(params.output_cost_per_token as number).toBeGreaterThan(0);
      expect(params.extra_headers).toEqual({ 'cf-aig-skip-cache': 'true' });
    }
    const noThinking = workersAiModels.find(
      (entry) => entry.model_name === 'cf-glm-5.2-no-thinking',
    );
    expect(noThinking?.litellm_params).toMatchObject({
      allowed_openai_params: ['chat_template_kwargs'],
      chat_template_kwargs: { enable_thinking: false },
    });
    // The native cloudflare/ provider must stay retired: its only credential
    // was a short-lived cfoat_ OAuth token that expired mid-flight.
    expect(config.model_list?.some(
      (entry) => entry.litellm_params?.model?.startsWith('cloudflare/'),
    )).toBe(false);

    expect(
      compose.services?.litellm?.environment?.CLOUDFLARE_ACCOUNT_ID,
    ).toBe('${CLOUDFLARE_ACCOUNT_ID:-}');
    expect(
      compose.services?.litellm?.environment?.CLOUDFLARE_API_KEY,
    ).toBe('${CLOUDFLARE_API_KEY:-}');
    expect(
      compose.services?.litellm?.environment?.CLOUDFLARE_AI_GATEWAY_COMPAT_URL,
    ).toBe('${CLOUDFLARE_AI_GATEWAY_COMPAT_URL:-}');
    expect(config.model_list).not.toContainEqual(expect.objectContaining({
      model_name: 'glm-5.2',
    }));
  });

  it('publishes the authenticated admin UI through the dev1 TLS router', () => {
    const compose = readYaml<ModelGatewayCompose>(
      'deploy/compose/model-gateway/docker-compose.yml',
    );
    const litellm = compose.services?.litellm;

    expect(litellm?.networks).toEqual([
      'default',
      'stablehand-agents',
      'web',
    ]);
    expect(litellm?.ports).toContain(
      '127.0.0.1:${LITELLM_PORT:-4400}:4000',
    );
    expect(litellm?.labels).toEqual(expect.arrayContaining([
      'traefik.enable=true',
      'traefik.docker.network=web',
      'traefik.http.routers.litellm.rule=Host(`${LITELLM_DOMAIN:-litellm.localhost}`)',
      'traefik.http.routers.litellm.entrypoints=websecure',
      'traefik.http.routers.litellm.tls.certresolver=letsencrypt',
      'traefik.http.services.litellm.loadbalancer.server.port=4000',
    ]));
  });

  it('ships an isolated LiteLLM control plane for dev2', () => {
    const resources = readYamlDocuments('deploy/k3s/dev2/model-gateway.yaml');
    const database = findResource(resources, 'Deployment', 'litellm-db');
    const gateway = findResource(resources, 'Deployment', 'litellm');

    expect(findResource(resources, 'PersistentVolumeClaim', 'litellm-data')).toBeDefined();
    expect(findResource(resources, 'Service', 'litellm-db')).toBeDefined();
    expect(findResource(resources, 'Service', 'litellm')).toBeDefined();
    expect(database.spec).toMatchObject({ strategy: { type: 'Recreate' } });
    expect(gateway.spec).toMatchObject({
      template: {
        spec: {
          containers: [{
            name: 'litellm',
            image: 'stablehand/litellm:dev2',
            imagePullPolicy: 'Never',
            envFrom: [
              { secretRef: { name: 'stablehand-provider-secrets' } },
              { secretRef: { name: 'stablehand-model-gateway-secrets' } },
            ],
            readinessProbe: {
              httpGet: { path: '/health/readiness', port: 'http' },
            },
          }],
        },
      },
    });
  });

  it('publishes the authenticated LiteLLM admin UI through the dev2 TLS ingress', () => {
    const resources = readYamlDocuments('deploy/k3s/dev2/model-gateway.yaml');
    const ingress = findResource(resources, 'Ingress', 'litellm');

    expect(ingress.metadata?.annotations).toMatchObject({
      'nginx.ingress.kubernetes.io/force-ssl-redirect': 'true',
    });
    expect(ingress.spec).toMatchObject({
      ingressClassName: 'nginx-tailnet',
      rules: [{
        host: 'litellm.staging.example.com',
        http: {
          paths: [{
            path: '/',
            pathType: 'Prefix',
            backend: {
              service: {
                name: 'litellm',
                port: { number: 4000 },
              },
            },
          }],
        },
      }],
    });
  });

  it('deploys and bootstraps dev2 LiteLLM before enabling orchestrator routing', () => {
    const deploy = readFileSync(
      resolve(process.cwd(), 'deploy/k3s/dev2/deploy-dev2.sh'),
      'utf8',
    );
    const secrets = readFileSync(
      resolve(process.cwd(), 'deploy/k3s/dev2/sync-secrets.sh'),
      'utf8',
    );
    const manifests = readFileSync(
      resolve(process.cwd(), 'deploy/k3s/dev2/manifests.yaml'),
      'utf8',
    );
    const bootstrap = readFileSync(
      resolve(process.cwd(), 'deploy/k3s/dev2/bootstrap-model-gateway.sh'),
      'utf8',
    );

    expect(deploy).toContain('deploy/compose/model-gateway/Dockerfile');
    expect(deploy).toContain('model-gateway.yaml');
    expect(deploy).toContain('bootstrap-model-gateway.sh');
    expect(deploy).toContain('stablehand-model-gateway-config');
    expect(secrets).toContain('stablehand-model-gateway-secrets');
    expect(secrets).toContain('CLOUDFLARE_ACCOUNT_ID');
    expect(secrets).toContain('CLOUDFLARE_API_KEY');
    expect(secrets).toContain('LITELLM_RUNTIME_MAX_BUDGET_USD');
    expect(bootstrap).toContain('"max_budget"');
    expect(bootstrap).toContain('"budget_duration": "1d"');
    expect(bootstrap).toContain('"http://127.0.0.1:4000/key/update"');
    expect(bootstrap).toContain("if ! printf '%s' \"$runtime_key\"");
    expect(bootstrap).toContain('for attempt in range(20)');
    expect(bootstrap).toContain('time.sleep(0.5)');
    expect(bootstrap).toContain('LiteLLM runtime key inventory reconciled');
    expect(bootstrap).not.toContain('\\${');
    expect(manifests).toContain('STABLEHAND_MODEL_GATEWAY_ENABLED');
    expect(manifests).toContain('http://litellm.stablehand.svc.cluster.local:4000');
    expect(manifests).toContain('STABLEHAND_MODEL_GATEWAY_RUNTIME_KEY');
    expect(manifests).toContain('STABLEHAND_MODEL_GATEWAY_METERING_KEY');
  });

  it('allows per-sandbox Secrets and forbids registry pulls for imported harness images', () => {
    const resources = readYamlDocuments('deploy/k3s/dev2/manifests.yaml');
    const role = findResource(resources, 'Role', 'stablehand-sandbox-runner');
    const orchestrator = findResource(resources, 'Deployment', 'orchestrator');

    expect(role.rules).toEqual(
      expect.arrayContaining([expect.objectContaining({
        apiGroups: [''],
        resources: ['secrets'],
        verbs: expect.arrayContaining(['create', 'get', 'delete']),
      })]),
    );
    expect(orchestrator.spec).toMatchObject({
      template: {
        spec: {
          containers: [expect.objectContaining({
            name: 'orchestrator',
            env: expect.arrayContaining([{
              name: 'STABLEHAND_K8S_IMAGE_PULL_POLICY',
              value: 'Never',
            }]),
          })],
        },
      },
    });
  });
});
