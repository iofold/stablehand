/**
 * Mid-run spend cap, end to end against a fake LiteLLM (ctx-ycek).
 *
 * The fake implements the slice of LiteLLM 1.93 the feature relies on, with
 * the semantics observed live on dev1 (2026-10-22): per-key `max_budget`
 * checked before each call (`spend >= max_budget` refuses with a headerless
 * 429 `budget_exceeded`), `/key/update` with `spend` resetting the counter,
 * unique aliases, and deletion by alias. A key therefore overshoots its cap by
 * at most the one call that crossed it.
 */
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LiteLLMKeyClient } from '../../packages/stablehand/src/cost-control/litellm-key-client.js';
import {
  SessionGatewayKeyManager,
  budgetStopReason,
} from '../../packages/stablehand/src/cost-control/session-gateway-keys.js';
import { readGatewayBudgetRefusal } from '../../packages/stablehand/src/orchestrator/agent-turn-service.js';
import {
  ModelGatewayRelay,
  registerModelGatewayRelay,
} from '../../packages/sandbox-daemon/src/harness/model-gateway-relay.js';
import {
  createGatewayCorrelationHeaders,
  takeGatewayBudgetStop,
} from '../../packages/sandbox-daemon/src/harness/model-gateway.js';
import {
  agentEventToSessionEvent,
  protoAgentEventToAGUI,
} from '../../packages/sandbox-daemon/src/sandbox/proto-convert.js';
import { turnStopReasonMessage } from '@stablehand/contracts';

const ADMIN_KEY = 'admin-key';
const RUNTIME_KEY = 'sk-shared-runtime';
const CALL_COST_USD = 0.02;

interface FakeKey {
  secret: string;
  token: string;
  alias: string | null;
  models: string[];
  maxBudget: number | null;
  spend: number;
}

class FakeLiteLLM {
  readonly keys = new Map<string, FakeKey>();
  inferenceCalls = 0;
  private server: Server | undefined;
  private counter = 0;

  constructor() {
    const runtimeHash = createHash('sha256').update(RUNTIME_KEY).digest('hex');
    this.keys.set(runtimeHash, {
      secret: RUNTIME_KEY,
      token: runtimeHash,
      alias: 'stablehand-runtime',
      models: ['gpt-5.4-mini', 'claude-haiku-4-5'],
      maxBudget: null,
      spend: 0,
    });
  }

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => this.handle(req, res, chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}));
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve());
  }

  keyByAlias(alias: string): FakeKey | undefined {
    return [...this.keys.values()].find((key) => key.alias === alias);
  }

  private findKey(keyOrHash: string): FakeKey | undefined {
    const hash = keyOrHash.startsWith('sk-')
      ? createHash('sha256').update(keyOrHash).digest('hex')
      : keyOrHash;
    return this.keys.get(hash);
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  private handle(req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>): void {
    const url = new URL(req.url ?? '/', 'http://fake');
    const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    if (url.pathname.startsWith('/key/')) {
      if (bearer !== ADMIN_KEY) return this.json(res, 401, { error: { message: 'not an admin' } });
      return this.handleAdmin(url, res, body);
    }
    const key = this.findKey(bearer);
    if (!key) return this.json(res, 401, { error: { message: 'Authentication Error', type: 'token_not_found_in_db' } });
    if (key.maxBudget !== null && key.spend >= key.maxBudget) {
      return this.json(res, 429, {
        error: {
          message: `Budget has been exceeded! Key=${key.alias} (sk-...xxxx) Current cost: ${key.spend}, Max budget: ${key.maxBudget}`,
          type: 'budget_exceeded',
          param: null,
          code: '429',
        },
      });
    }
    this.inferenceCalls += 1;
    key.spend = Number((key.spend + CALL_COST_USD).toFixed(6));
    return this.json(res, 200, { choices: [{ message: { role: 'assistant', content: 'ok' } }] });
  }

  private handleAdmin(url: URL, res: ServerResponse, body: Record<string, unknown>): void {
    switch (url.pathname) {
      case '/key/generate': {
        const alias = typeof body.key_alias === 'string' ? body.key_alias : null;
        if (alias && this.keyByAlias(alias)) {
          return this.json(res, 400, { error: { message: `Key with alias '${alias}' already exists.` } });
        }
        this.counter += 1;
        const secret = `sk-session-${this.counter}`;
        const key: FakeKey = {
          secret,
          token: createHash('sha256').update(secret).digest('hex'),
          alias,
          models: Array.isArray(body.models) ? body.models as string[] : [],
          maxBudget: typeof body.max_budget === 'number' ? body.max_budget : null,
          spend: 0,
        };
        this.keys.set(key.token, key);
        return this.json(res, 200, { key: key.secret, token: key.token, key_alias: alias });
      }
      case '/key/update': {
        const key = this.findKey(String(body.key));
        if (!key) return this.json(res, 404, { error: { message: 'Key not found' } });
        key.maxBudget = typeof body.max_budget === 'number' ? body.max_budget : null;
        if (typeof body.spend === 'number') key.spend = body.spend;
        return this.json(res, 200, { key: key.token, max_budget: key.maxBudget, spend: key.spend });
      }
      case '/key/delete': {
        const aliases = Array.isArray(body.key_aliases) ? body.key_aliases as string[] : [];
        const deleted = aliases.filter((alias) => {
          const key = this.keyByAlias(alias);
          if (key) this.keys.delete(key.token);
          return Boolean(key);
        });
        if (deleted.length === 0) return this.json(res, 404, { error: { message: 'Key not found' } });
        return this.json(res, 200, { deleted_keys: deleted });
      }
      case '/key/info': {
        const key = this.findKey(url.searchParams.get('key') ?? '');
        if (!key) return this.json(res, 404, { error: { message: 'Key not found' } });
        return this.json(res, 200, { key: key.token, info: { models: key.models, key_alias: key.alias } });
      }
      case '/key/list': {
        const key = this.keyByAlias(url.searchParams.get('key_alias') ?? '');
        return this.json(res, 200, { keys: key ? [{ token: key.token, key_alias: key.alias }] : [] });
      }
      default:
        return this.json(res, 404, { error: { message: 'no route' } });
    }
  }
}

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

describe('mid-run spend cap through per-session gateway keys', () => {
  let litellm: FakeLiteLLM;
  let litellmUrl: string;
  let relay: ModelGatewayRelay;
  let relayUrl: string;
  let manager: SessionGatewayKeyManager;

  beforeEach(async () => {
    litellm = new FakeLiteLLM();
    litellmUrl = await litellm.start();
    relay = new ModelGatewayRelay({ upstreamUrl: litellmUrl, logger: silentLogger });
    relayUrl = await relay.start();
    registerModelGatewayRelay(relay);
    manager = new SessionGatewayKeyManager({
      client: new LiteLLMKeyClient({ baseUrl: litellmUrl, adminKey: ADMIN_KEY }),
      runtimeKey: RUNTIME_KEY,
      getTurnTags: async () => ({}),
      logger: silentLogger,
    });
  });

  afterEach(async () => {
    registerModelGatewayRelay(undefined);
    await relay.stop();
    await litellm.stop();
  });

  /** One model call from inside the sandbox, as a harness client makes it. */
  async function modelCall(sessionKey: string, turnId: string): Promise<number> {
    const response = await fetch(`${relayUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${sessionKey}`,
        'content-type': 'application/json',
        ...createGatewayCorrelationHeaders(turnId),
      },
      body: JSON.stringify({ model: 'gpt-5.4-mini', messages: [] }),
    });
    await response.text();
    return response.status;
  }

  /** A looping agent: call until the gateway says no. */
  async function loopUntilRefused(sessionKey: string, turnId: string): Promise<{ succeeded: number; finalStatus: number }> {
    let succeeded = 0;
    for (let i = 0; i < 50; i++) {
      const status = await modelCall(sessionKey, turnId);
      if (status !== 200) return { succeeded, finalStatus: status };
      succeeded += 1;
    }
    throw new Error('the loop was never stopped');
  }

  it('stops a looping run at its cap, reports spent vs cap, and lets the next run start fresh', async () => {
    const sessionKey = await manager.mintSessionKey({ sessionId: 's1', agentId: 'looper' });
    expect(sessionKey).toBe('sk-session-1');
    expect(litellm.keyByAlias('stablehand-session-s1')).toMatchObject({
      models: ['gpt-5.4-mini', 'claude-haiku-4-5'],
      maxBudget: null,
    });

    const cap = await manager.prepareTurn({
      sessionId: 's1',
      turnId: 'turn-1',
      harnessConfig: { model: 'gpt-5.4-mini', limits: { maxCostUsd: 0.05 } },
    });
    expect(cap).toEqual({ capUsd: 0.05, source: 'run_limit' });

    const run = await loopUntilRefused(sessionKey!, 'turn-1');
    // $0.00, $0.02 and $0.04 are under the cap; the call at $0.06 is refused.
    expect(run).toEqual({ succeeded: 3, finalStatus: 400 });

    // Sandbox side: the harness turns the refusal into a typed terminal error.
    const errorEvent = takeGatewayBudgetStop('turn-1');
    expect(errorEvent).toMatchObject({
      code: 'model_gateway_budget_exceeded',
      details: { spentUsd: 0.06, capUsd: 0.05 },
    });

    // Across the gRPC boundary into the orchestrator's RUN_ERROR handling.
    const payload = agentEventToSessionEvent(errorEvent!).payload;
    if (payload.case !== 'agentEvent') throw new Error('expected an agent event');
    const runError = protoAgentEventToAGUI(payload.value, 'turn-1');
    const refusal = readGatewayBudgetRefusal(runError as Record<string, unknown>);
    const stopReason = budgetStopReason(manager.capForTurn('turn-1'), refusal!);
    expect(stopReason).toEqual({
      code: 'budget_reached',
      source: 'run_limit',
      capUsd: 0.05,
      spentUsd: 0.06,
    });
    expect(turnStopReasonMessage(stopReason)).toBe(
      'Stopped: this run reached its $0.05 spend cap. It had spent $0.06. The cap is this agent\'s per-run spend limit.',
    );
    manager.settleTurn('turn-1');

    // The next run gets its own cap with the counter reset.
    await manager.prepareTurn({
      sessionId: 's1',
      turnId: 'turn-2',
      harnessConfig: { model: 'gpt-5.4-mini', limits: { maxCostUsd: 0.05 } },
    });
    expect(await modelCall(sessionKey!, 'turn-2')).toBe(200);

    // Closing the session revokes its key.
    await manager.revokeSessionKey('s1');
    expect(litellm.keyByAlias('stablehand-session-s1')).toBeUndefined();
    expect(await modelCall(sessionKey!, 'turn-2')).toBe(401);
  });

  it('replaces a stale key when a session is restored', async () => {
    const first = await manager.mintSessionKey({ sessionId: 's2', agentId: 'looper' });
    const second = await manager.mintSessionKey({ sessionId: 's2', agentId: 'looper' });

    expect(second).not.toBe(first);
    expect(await modelCall(first!, 'turn-x')).toBe(401);
    expect(await modelCall(second!, 'turn-x')).toBe(200);
  });

  it('runs uncapped when no limit applies', async () => {
    const sessionKey = await manager.mintSessionKey({ sessionId: 's3', agentId: 'free' });
    await manager.prepareTurn({ sessionId: 's3', turnId: 'turn-1', harnessConfig: { model: 'gpt-5.4-mini' } });

    for (let i = 0; i < 5; i++) {
      expect(await modelCall(sessionKey!, 'turn-1')).toBe(200);
    }
    expect(takeGatewayBudgetStop('turn-1')).toBeUndefined();
  });
});
