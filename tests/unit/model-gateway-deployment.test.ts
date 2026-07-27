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
    const cloudflareModels = config.model_list?.filter(
      (entry) => entry.litellm_params?.model?.startsWith('cloudflare/'),
    );

    expect(cloudflareModels).toEqual([
      {
        model_name: 'cf-gpt-oss-120b',
        litellm_params: {
          model: 'cloudflare/@cf/openai/gpt-oss-120b',
          api_key: 'os.environ/CLOUDFLARE_API_KEY',
        },
      },
      {
        model_name: 'cf-kimi-k2.7-code',
        litellm_params: {
          model: 'cloudflare/@cf/moonshotai/kimi-k2.7-code',
          api_key: 'os.environ/CLOUDFLARE_API_KEY',
        },
      },
      {
        model_name: 'cf-glm-5.2',
        litellm_params: {
          model: 'cloudflare/@cf/zai-org/glm-5.2',
          api_key: 'os.environ/CLOUDFLARE_API_KEY',
        },
      },
      {
        model_name: 'cf-glm-5.2-no-thinking',
        litellm_params: {
          model: 'cloudflare/@cf/zai-org/glm-5.2',
          api_key: 'os.environ/CLOUDFLARE_API_KEY',
          allowed_openai_params: ['chat_template_kwargs'],
          chat_template_kwargs: {
            enable_thinking: false,
          },
        },
      },
      {
        model_name: 'cf-gemma-4-26b',
        litellm_params: {
          model: 'cloudflare/@cf/google/gemma-4-26b-a4b-it',
          api_key: 'os.environ/CLOUDFLARE_API_KEY',
        },
      },
      {
        model_name: 'cf-qwen3-30b',
        litellm_params: {
          model: 'cloudflare/@cf/qwen/qwen3-30b-a3b-fp8',
          api_key: 'os.environ/CLOUDFLARE_API_KEY',
        },
      },
    ]);
    expect(
      compose.services?.litellm?.environment?.CLOUDFLARE_ACCOUNT_ID,
    ).toBe('${CLOUDFLARE_ACCOUNT_ID:-}');
    expect(
      compose.services?.litellm?.environment?.CLOUDFLARE_API_KEY,
    ).toBe('${CLOUDFLARE_API_KEY:-}');
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
      'ctxmill-agents',
      'web',
    ]);
    expect(litellm?.ports).toContain(
      '127.0.0.1:${LITELLM_PORT:-4400}:4000',
    );
    expect(litellm?.labels).toEqual(expect.arrayContaining([
      'traefik.enable=true',
      'traefik.docker.network=web',
      'traefik.http.routers.litellm.rule=Host(`${LITELLM_DOMAIN:-litellm.dev.example.com}`)',
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
            image: 'ctxmill/litellm:dev2',
            imagePullPolicy: 'Never',
            envFrom: [
              { secretRef: { name: 'ctxmill-provider-secrets' } },
              { secretRef: { name: 'ctxmill-model-gateway-secrets' } },
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
    expect(deploy).toContain('ctxmill-model-gateway-config');
    expect(secrets).toContain('ctxmill-model-gateway-secrets');
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
    expect(manifests).toContain('CTXMILL_MODEL_GATEWAY_ENABLED');
    expect(manifests).toContain('http://litellm.ctxmill.svc.cluster.local:4000');
    expect(manifests).toContain('CTXMILL_MODEL_GATEWAY_RUNTIME_KEY');
    expect(manifests).toContain('CTXMILL_MODEL_GATEWAY_METERING_KEY');
  });

  it('allows per-sandbox Secrets and forbids registry pulls for imported harness images', () => {
    const resources = readYamlDocuments('deploy/k3s/dev2/manifests.yaml');
    const role = findResource(resources, 'Role', 'ctxmill-sandbox-runner');
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
              name: 'CTXMILL_K8S_IMAGE_PULL_POLICY',
              value: 'Never',
            }]),
          })],
        },
      },
    });
  });
});
