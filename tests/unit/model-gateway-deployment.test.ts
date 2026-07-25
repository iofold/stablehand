import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

interface ModelGatewayConfig {
  model_list?: Array<{
    model_name?: string;
    litellm_params?: {
      model?: string;
      api_key?: string;
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

describe('model gateway deployment', () => {
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
});
