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
