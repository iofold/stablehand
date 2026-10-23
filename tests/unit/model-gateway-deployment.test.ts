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
      allowed_openai_params?: string[];
      chat_template_kwargs?: Record<string, unknown>;
    };
    model_info?: Record<string, unknown>;
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
  it('publishes current OpenAI and Anthropic families while retaining routed legacy aliases', () => {
    const config = readYaml<ModelGatewayConfig>(
      'deploy/compose/model-gateway/config.yaml',
    );

    expect(config.model_list).toEqual(expect.arrayContaining([
      {
        model_name: 'gpt-6.1-sol',
        litellm_params: {
          model: 'openai/gpt-6.1-sol',
          api_key: 'os.environ/OPENAI_API_KEY',
        },
      },
      {
        model_name: 'gpt-6-luna',
        litellm_params: {
          model: 'openai/gpt-6-luna',
          api_key: 'os.environ/OPENAI_API_KEY',
        },
      },
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
    // LiteLLM's together_ai adapter strips tools and tool_choice for any model
    // missing from its model map, and drop_params hides the removal, so every
    // Workers AI route must opt them back in (LiteLLM 1.93.0, 2026-10-23).
    // allowed_openai_params covers chat completions and /v1/messages;
    // model_info.supports_function_calling is what keeps tools on the
    // /v1/responses bridge the PI harness uses.
    const expectedAllowedParams: Record<string, string[]> = {
      'cf-gpt-oss-120b': ['tools', 'tool_choice'],
      'cf-kimi-k2.7-code': ['tools', 'tool_choice'],
      'cf-glm-5.2': ['tools', 'tool_choice'],
      'cf-glm-5.2-no-thinking': ['tools', 'tool_choice', 'chat_template_kwargs'],
      'cf-gemma-4-26b': ['tools', 'tool_choice'],
      'cf-qwen3-30b': ['tools', 'tool_choice'],
    };
    for (const entry of workersAiModels) {
      expect(entry.litellm_params?.allowed_openai_params).toEqual(
        expectedAllowedParams[entry.model_name as string],
      );
      expect(entry.model_info).toEqual({ supports_function_calling: true });
    }
    const noThinking = workersAiModels.find(
      (entry) => entry.model_name === 'cf-glm-5.2-no-thinking',
    );
    expect(noThinking?.litellm_params).toMatchObject({
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

  it('keeps the gateway overlay free of Traefik so a plain host can run it', () => {
    const compose = readYaml<ModelGatewayCompose & { networks?: Record<string, unknown> }>(
      'deploy/compose/model-gateway/docker-compose.yml',
    );
    const litellm = compose.services?.litellm;

    expect(litellm?.networks).toEqual(['default', 'stablehand-agents']);
    expect(litellm?.labels).toBeUndefined();
    expect(compose.networks?.web).toBeUndefined();
    expect(litellm?.ports).toContain(
      '127.0.0.1:${LITELLM_PORT:-4400}:4000',
    );
  });

  it('registers the runtime key before the orchestrator starts', () => {
    const compose = readYaml<{
      services?: Record<string, {
        image?: string;
        entrypoint?: string[];
        environment?: Record<string, string>;
        volumes?: string[];
        depends_on?: Record<string, { condition?: string }>;
      }>;
    }>('deploy/compose/model-gateway/docker-compose.yml');
    const init = compose.services?.['gateway-init'];

    expect(init?.image).toBe(compose.services?.litellm?.image);
    expect(init?.entrypoint).toEqual(['/app/.venv/bin/python', '/opt/stablehand/bootstrap_keys.py']);
    expect(init?.volumes).toContain(
      './deploy/compose/model-gateway/bootstrap_keys.py:/opt/stablehand/bootstrap_keys.py:ro',
    );
    expect(init?.depends_on?.litellm?.condition).toBe('service_healthy');
    expect(compose.services?.orchestrator?.depends_on?.['gateway-init']?.condition)
      .toBe('service_completed_successfully');
  });

  it('publishes the authenticated admin UI through the dev1 TLS router', () => {
    const compose = readYaml<ModelGatewayCompose>(
      'deploy/compose/model-gateway/traefik.yml',
    );
    const litellm = compose.services?.litellm;

    expect(litellm?.networks).toEqual([
      'default',
      'stablehand-agents',
      'web',
    ]);
    expect(litellm?.labels).toEqual(expect.arrayContaining([
      'traefik.enable=true',
      'traefik.docker.network=web',
      'traefik.http.routers.litellm.rule=Host(`${LITELLM_DOMAIN:-litellm.localhost}`)',
      'traefik.http.routers.litellm.entrypoints=websecure',
      'traefik.http.routers.litellm.tls.certresolver=letsencrypt',
      'traefik.http.services.litellm.loadbalancer.server.port=4000',
    ]));
  });
});
