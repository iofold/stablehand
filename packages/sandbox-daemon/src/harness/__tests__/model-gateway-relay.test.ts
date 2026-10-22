import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChatAnthropic } from '@langchain/anthropic';
import { ChatOpenAI } from '@langchain/openai';
import { isRetryableAssistantError } from '@earendil-works/pi-ai';

import {
  GATEWAY_BUDGET_REFUSAL_MESSAGE,
  ModelGatewayRelay,
  parseLiteLLMBudgetRefusal,
  registerModelGatewayRelay,
  startModelGatewayRelayFromEnv,
  stopModelGatewayRelay,
} from '../model-gateway-relay.js';
import {
  createGatewayCorrelationHeaders,
  resolveHarnessModelConnection,
  takeGatewayBudgetStop,
  toOpaqueTurnCorrelation,
} from '../model-gateway.js';

// Exact refusal LiteLLM 1.93.0 returned on dev1 (2026-10-22) for
// /v1/chat/completions, /v1/messages and /v1/responses alike.
const LITELLM_BUDGET_REFUSAL = {
  error: {
    message: 'Budget has been exceeded! Key=stablehand-session-s1 (sk-...Bvbw) Current cost: 2.4000000000000004e-05, Max budget: 1e-07',
    type: 'budget_exceeded',
    param: null,
    code: '429',
  },
};

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

interface RecordedRequest {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingMessage['headers'];
  body: string;
}

class FakeGateway {
  readonly requests: RecordedRequest[] = [];
  private server: Server | undefined;
  handler: (req: IncomingMessage, res: ServerResponse, body: string) => void = (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  };

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        this.requests.push({ method: req.method, url: req.url, headers: req.headers, body });
        this.handler(req, res, body);
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function refuseForBudget(res: ServerResponse): void {
  res.writeHead(429, { 'content-type': 'application/json' });
  res.end(JSON.stringify(LITELLM_BUDGET_REFUSAL));
}

describe('parseLiteLLMBudgetRefusal', () => {
  it('reads spend and cap from the LiteLLM key budget refusal', () => {
    expect(parseLiteLLMBudgetRefusal(429, LITELLM_BUDGET_REFUSAL)).toEqual({
      spentUsd: 2.4000000000000004e-05,
      capUsd: 1e-07,
    });
  });

  it('accepts the older 400 status and an untyped message', () => {
    expect(parseLiteLLMBudgetRefusal(400, {
      error: { message: 'Budget has been exceeded! Current cost: 0.051, Max budget: 0.05' },
    })).toEqual({ spentUsd: 0.051, capUsd: 0.05 });
  });

  it('ignores ordinary rate limits and other errors', () => {
    expect(parseLiteLLMBudgetRefusal(429, {
      error: { message: 'Rate limit reached for gpt-5.4-mini', type: 'rate_limit_error' },
    })).toBeNull();
    expect(parseLiteLLMBudgetRefusal(500, LITELLM_BUDGET_REFUSAL)).toBeNull();
    expect(parseLiteLLMBudgetRefusal(429, 'Budget has been exceeded!')).toBeNull();
  });
});

describe('ModelGatewayRelay', () => {
  let gateway: FakeGateway;
  let relay: ModelGatewayRelay;
  let relayUrl: string;

  beforeEach(async () => {
    gateway = new FakeGateway();
    const upstreamUrl = await gateway.start();
    relay = new ModelGatewayRelay({ upstreamUrl, logger: silentLogger, now: () => 1_000 });
    relayUrl = await relay.start();
  });

  afterEach(async () => {
    registerModelGatewayRelay(undefined);
    await relay.stop();
    await gateway.stop();
  });

  it('passes requests and streamed responses through unchanged', async () => {
    gateway.handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'x-litellm-response-cost': '0.0001' });
      res.write('data: {"delta":"he"}\n\n');
      res.end('data: [DONE]\n\n');
    };

    const response = await fetch(`${relayUrl}/v1/chat/completions?x=1`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer session-key',
        'content-type': 'application/json',
        ...createGatewayCorrelationHeaders('turn-1'),
      },
      body: JSON.stringify({ model: 'gpt-5.4-mini', stream: true }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('x-litellm-response-cost')).toBe('0.0001');
    expect(await response.text()).toBe('data: {"delta":"he"}\n\ndata: [DONE]\n\n');
    expect(gateway.requests).toHaveLength(1);
    expect(gateway.requests[0]).toMatchObject({
      method: 'POST',
      url: '/v1/chat/completions?x=1',
      body: JSON.stringify({ model: 'gpt-5.4-mini', stream: true }),
    });
    expect(gateway.requests[0]?.headers.authorization).toBe('Bearer session-key');
    expect(gateway.requests[0]?.headers['x-litellm-trace-id']).toBe(toOpaqueTurnCorrelation('turn-1'));
  });

  it('turns a budget refusal into a terminal 400 and records it by turn correlation', async () => {
    gateway.handler = (_req, res) => refuseForBudget(res);

    const response = await fetch(`${relayUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...createGatewayCorrelationHeaders('turn-7') },
      body: '{}',
    });

    expect(response.status).toBe(400);
    expect(response.headers.get('x-should-retry')).toBe('false');
    const body = await response.json() as { error: { type: string; message: string } };
    expect(body.error.type).toBe('budget_exceeded');
    expect(body.error.message).toBe(GATEWAY_BUDGET_REFUSAL_MESSAGE);
    // Retry classifiers key on status digits; the relayed text has none.
    expect(body.error.message).not.toMatch(/\d/);

    expect(relay.hasBudgetRefusal(toOpaqueTurnCorrelation('turn-7'))).toBe(true);
    expect(relay.takeBudgetRefusal(toOpaqueTurnCorrelation('turn-7'))).toEqual({
      correlationId: toOpaqueTurnCorrelation('turn-7'),
      spentUsd: 2.4000000000000004e-05,
      capUsd: 1e-07,
      observedAt: 1_000,
    });
    expect(relay.takeBudgetRefusal(toOpaqueTurnCorrelation('turn-7'))).toBeUndefined();
  });

  it('makes an uncorrelated refusal terminal without attributing it to any run', async () => {
    gateway.handler = (_req, res) => refuseForBudget(res);

    const response = await fetch(`${relayUrl}/v1/chat/completions`, { method: 'POST', body: '{}' });

    expect(response.status).toBe(400);
    expect(response.headers.get('x-should-retry')).toBe('false');
    expect(relay.takeBudgetRefusal(toOpaqueTurnCorrelation('any-turn'))).toBeUndefined();
  });

  it('leaves ordinary rate limits and gateway errors untouched', async () => {
    gateway.handler = (_req, res) => {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '2' });
      res.end(JSON.stringify({ error: { type: 'rate_limit_error', message: 'slow down' } }));
    };

    const response = await fetch(`${relayUrl}/v1/chat/completions`, { method: 'POST', body: '{}' });

    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('2');
    expect(await response.json()).toEqual({ error: { type: 'rate_limit_error', message: 'slow down' } });
    expect(relay.hasBudgetRefusal('ct_none')).toBe(false);
  });

  it('relays a large non-budget error body byte for byte', async () => {
    const big = JSON.stringify({ error: { type: 'invalid_request_error', message: 'x'.repeat(200_000) } });
    gateway.handler = (_req, res) => {
      res.writeHead(400, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(big) });
      res.end(big);
    };

    const response = await fetch(`${relayUrl}/v1/messages`, { method: 'POST', body: '{}' });

    expect(response.status).toBe(400);
    expect(await response.text()).toBe(big);
  });

  it('asks the gateway for identity encoding so error bodies stay readable', async () => {
    await fetch(`${relayUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'accept-encoding': 'gzip, deflate, br' },
      body: '{}',
    });

    expect(gateway.requests[0]?.headers['accept-encoding']).toBeUndefined();
  });

  it('answers 502 with a typed body when the gateway is unreachable', async () => {
    await gateway.stop();

    const response = await fetch(`${relayUrl}/v1/chat/completions`, { method: 'POST', body: '{}' });

    expect(response.status).toBe(502);
    const body = await response.json() as { error: { type: string } };
    expect(body.error.type).toBe('model_gateway_unavailable');
  });

  it('routes gateway connections through the registered relay', () => {
    registerModelGatewayRelay(relay);
    const secrets = {
      STABLEHAND_MODEL_GATEWAY_ENABLED: 'true',
      STABLEHAND_MODEL_GATEWAY_URL: 'http://litellm:4000',
      STABLEHAND_MODEL_GATEWAY_RUNTIME_KEY: 'session-key',
      STABLEHAND_MODEL_GATEWAY_REVISION: 'rev-1',
    };

    expect(resolveHarnessModelConnection({ provider: 'openai', secrets })).toMatchObject({
      mode: 'gateway',
      baseUrl: `${relayUrl}/v1`,
      apiKey: 'session-key',
    });
    expect(resolveHarnessModelConnection({ provider: 'anthropic', secrets })).toMatchObject({
      mode: 'gateway',
      baseUrl: relayUrl,
    });
    expect(resolveHarnessModelConnection({ provider: 'anthropic', secrets, relayUrl: null })).toMatchObject({
      baseUrl: 'http://litellm:4000',
    });
  });

  it('gives harnesses the typed budget stop with the gateway numbers', async () => {
    registerModelGatewayRelay(relay);
    gateway.handler = (_req, res) => refuseForBudget(res);
    await fetch(`${relayUrl}/v1/responses`, {
      method: 'POST',
      headers: createGatewayCorrelationHeaders('turn-9'),
      body: '{}',
    });

    expect(takeGatewayBudgetStop('turn-other')).toBeUndefined();
    expect(takeGatewayBudgetStop('turn-9')).toEqual({
      type: 'error',
      error: expect.stringContaining('reached its spend cap'),
      code: 'model_gateway_budget_exceeded',
      details: { spentUsd: 2.4000000000000004e-05, capUsd: 1e-07 },
    });
  });

  it('stops a LangChain OpenAI client on the first refusal instead of retrying', async () => {
    gateway.handler = (_req, res) => refuseForBudget(res);
    const model = new ChatOpenAI({
      model: 'gpt-5.4-mini',
      apiKey: 'session-key',
      configuration: { baseURL: `${relayUrl}/v1` },
    });

    const started = Date.now();
    await expect(model.invoke('hello')).rejects.toThrow(/out of budget/);
    expect(gateway.requests).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('stops a LangChain Anthropic client on the first refusal instead of retrying', async () => {
    gateway.handler = (_req, res) => refuseForBudget(res);
    const model = new ChatAnthropic({
      model: 'claude-haiku-4-5',
      apiKey: 'session-key',
      anthropicApiUrl: relayUrl,
    });

    await expect(model.invoke('hello')).rejects.toThrow(/out of budget/);
    expect(gateway.requests).toHaveLength(1);
  });

  it('is terminal for the PI retry classifier', () => {
    const relayed = `400 ${JSON.stringify({ type: 'error', error: { type: 'budget_exceeded', message: GATEWAY_BUDGET_REFUSAL_MESSAGE } })}`;
    expect(isRetryableAssistantError({ stopReason: 'error', errorMessage: relayed } as Parameters<typeof isRetryableAssistantError>[0])).toBe(false);
    // The raw LiteLLM refusal, by contrast, would be retried.
    expect(isRetryableAssistantError({
      stopReason: 'error',
      errorMessage: `429 ${JSON.stringify(LITELLM_BUDGET_REFUSAL)}`,
    } as Parameters<typeof isRetryableAssistantError>[0])).toBe(true);
  });
});

describe('startModelGatewayRelayFromEnv', () => {
  afterEach(async () => {
    await stopModelGatewayRelay();
  });

  it('does nothing outside gateway mode', async () => {
    expect(await startModelGatewayRelayFromEnv({}, silentLogger)).toBeUndefined();
    expect(await startModelGatewayRelayFromEnv({
      STABLEHAND_MODEL_GATEWAY_ENABLED: 'false',
      STABLEHAND_MODEL_GATEWAY_URL: 'http://litellm:4000',
    }, silentLogger)).toBeUndefined();
  });

  it('starts and registers a loopback relay in gateway mode', async () => {
    const relay = await startModelGatewayRelayFromEnv({
      STABLEHAND_MODEL_GATEWAY_ENABLED: 'true',
      STABLEHAND_MODEL_GATEWAY_URL: 'http://litellm:4000',
    }, silentLogger);
    expect(relay?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });
});
