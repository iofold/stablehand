import { describe, expect, it, vi } from 'vitest';

import { createIssuedGatewayKeys } from './issued-gateway-keys.js';
import { liteLLMKeyHash } from './litellm-key-client.js';
import { LiteLLMSpendClient } from './litellm-spend-client.js';

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('LiteLLMSpendClient', () => {
  it('uses the next UTC date because LiteLLM treats end_date as exclusive', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({
      data: [],
      page: 1,
      page_size: 100,
      total: 0,
      total_pages: 0,
    }));
    const client = new LiteLLMSpendClient({
      baseUrl: 'http://litellm:4000',
      meteringKey: 'metering-key',
      fetchImpl,
    });

    await client.listSpend({
      startMs: Date.parse('2026-07-23T15:00:00.000Z'),
      endMs: Date.parse('2026-07-23T15:01:00.000Z'),
    });

    const url = new URL(String(fetchImpl.mock.calls[0]?.[0]));
    expect(url.searchParams.get('start_date')).toBe('2026-07-23');
    expect(url.searchParams.get('end_date')).toBe('2026-07-24');
  });

  it('filters the exact reconciliation window by finalized time for long calls', async () => {
    const row = (
      requestId: string,
      correlationId: string,
      startTime: string,
      endTime: string,
    ) => ({
      request_id: requestId,
      spend: 0.001,
      prompt_tokens: 10,
      completion_tokens: 1,
      total_tokens: 11,
      startTime,
      endTime,
      model: 'cloudflare/@cf/zai-org/glm-5.2',
      model_group: 'cf-glm-5.2',
      custom_llm_provider: 'cloudflare',
      session_id: correlationId,
      status: 'success',
    });
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({
      data: [
        row(
          'tx-finished-before',
          'ct_00000000000000000000000000000000',
          '2026-07-23T09:58:00.000Z',
          '2026-07-23T09:59:59.999Z',
        ),
        row(
          'tx-long-call',
          'ct_11111111111111111111111111111111',
          '2026-07-23T09:58:30.000Z',
          '2026-07-23T10:00:30.000Z',
        ),
        row(
          'tx-not-finalized-yet',
          'ct_22222222222222222222222222222222',
          '2026-07-23T10:00:30.000Z',
          '2026-07-23T10:01:00.001Z',
        ),
      ],
      page: 1,
      page_size: 100,
      total: 3,
      total_pages: 1,
      total_is_capped: false,
    }));
    const client = new LiteLLMSpendClient({
      baseUrl: 'http://litellm:4000',
      meteringKey: 'metering-key',
      fetchImpl,
    });

    const result = await client.listSpend({
      startMs: Date.parse('2026-07-23T10:00:00.000Z'),
      endMs: Date.parse('2026-07-23T10:01:00.000Z'),
    });

    expect(result.records.map((record) => record.transactionId)).toEqual([
      'tx-long-call',
    ]);
  });

  it('paginates, normalizes safe fields, and never returns vendor credentials or payloads', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        data: [{
          request_id: 'tx-1',
          spend: 0.002,
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
          startTime: '2026-07-23T10:00:00.000Z',
          endTime: '2026-07-23T10:00:01.000Z',
          model: 'openai/gpt-5.4-mini',
          model_group: 'gpt-5.4-mini',
          custom_llm_provider: 'openai',
          session_id: 'ct_0123456789abcdef0123456789abcdef',
          status: 'success',
          api_key: 'hashed-secret',
          messages: [{ role: 'user', content: 'private' }],
          response: { private: true },
          metadata: {
            proxy_server_request: { private: true },
            usage_object: {
              prompt_tokens_details: { cached_tokens: 3 },
              completion_tokens_details: { reasoning_tokens: 2 },
            },
            spend_logs_metadata: {
              stablehand_turn_correlation: 'ct_0123456789abcdef0123456789abcdef',
            },
          },
        }],
        page: 1,
        page_size: 1,
        total: 2,
        total_pages: 2,
        total_is_capped: false,
      }))
      .mockResolvedValueOnce(jsonResponse({
        data: [{
          request_id: 'tx-2',
          spend: 0,
          prompt_tokens: 4,
          completion_tokens: 1,
          total_tokens: 5,
          startTime: '2026-07-23T10:01:00.000Z',
          endTime: '2026-07-23T10:01:01.000Z',
          model: 'openai/free-eval',
          model_group: 'free-eval',
          custom_llm_provider: 'openai',
          session_id: 'ct_fedcba9876543210fedcba9876543210',
          status: 'success',
          metadata: {
            usage_object: {},
            spend_logs_metadata: {
              stablehand_turn_correlation: 'ct_fedcba9876543210fedcba9876543210',
            },
          },
        }],
        page: 2,
        page_size: 1,
        total: 2,
        total_pages: 2,
        total_is_capped: false,
      }));

    const client = new LiteLLMSpendClient({
      baseUrl: 'http://litellm:4000',
      meteringKey: 'metering-key',
      pageSize: 1,
      explicitFreeModels: ['free-eval'],
      fetchImpl,
    });
    const result = await client.listSpend({
      startMs: Date.parse('2026-07-23T00:00:00.000Z'),
      endMs: Date.parse('2026-07-24T00:00:00.000Z'),
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0]?.[0]).toContain('/spend/logs/v2?');
    expect(fetchImpl.mock.calls[0]?.[1]).toEqual({
      headers: { authorization: 'Bearer metering-key' },
      signal: undefined,
    });
    expect(result.invalid).toEqual([]);
    expect(result.records).toEqual([
      {
        transactionId: 'tx-1',
        correlationId: 'ct_0123456789abcdef0123456789abcdef',
        requestedModel: 'gpt-5.4-mini',
        resolvedModel: 'openai/gpt-5.4-mini',
        provider: 'openai',
        status: 'success',
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        cacheReadTokens: 3,
        reasoningTokens: 2,
        costUsd: 0.002,
        costState: 'priced',
        startedAt: Date.parse('2026-07-23T10:00:00.000Z'),
        endedAt: Date.parse('2026-07-23T10:00:01.000Z'),
      },
      {
        transactionId: 'tx-2',
        correlationId: 'ct_fedcba9876543210fedcba9876543210',
        requestedModel: 'free-eval',
        resolvedModel: 'openai/free-eval',
        provider: 'openai',
        status: 'success',
        inputTokens: 4,
        outputTokens: 1,
        totalTokens: 5,
        costUsd: 0,
        costState: 'explicit_free',
        startedAt: Date.parse('2026-07-23T10:01:00.000Z'),
        endedAt: Date.parse('2026-07-23T10:01:01.000Z'),
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('hashed-secret');
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it('marks zero cost with positive usage unpriced unless the alias is explicitly free', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({
      data: [{
        request_id: 'tx-zero',
        spend: 0,
        prompt_tokens: 2,
        completion_tokens: 1,
        total_tokens: 3,
        startTime: '2026-07-23T10:00:00.000Z',
        endTime: '2026-07-23T10:00:01.000Z',
        model: 'custom/unknown',
        model_group: 'unknown',
        custom_llm_provider: 'custom',
        session_id: 'ct_0123456789abcdef0123456789abcdef',
        status: 'success',
      }],
      page: 1,
      page_size: 100,
      total: 1,
      total_pages: 1,
      total_is_capped: false,
    }));
    const client = new LiteLLMSpendClient({
      baseUrl: 'http://litellm:4000',
      meteringKey: 'metering-key',
      fetchImpl,
    });

    const result = await client.listSpend({
      startMs: Date.parse('2026-07-23T00:00:00.000Z'),
      endMs: Date.parse('2026-07-24T00:00:00.000Z'),
    });

    expect(result.records[0]?.costState).toBe('unpriced');
    expect(result.records[0]?.costUsd).toBeUndefined();
  });

  it('quarantines correlation mismatches without exposing the original row', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({
      data: [{
        request_id: 'tx-mismatch',
        spend: 0.1,
        prompt_tokens: 2,
        completion_tokens: 1,
        total_tokens: 3,
        startTime: '2026-07-23T10:00:00.000Z',
        endTime: '2026-07-23T10:00:01.000Z',
        model: 'openai/gpt-5.4-mini',
        model_group: 'gpt-5.4-mini',
        custom_llm_provider: 'openai',
        session_id: 'ct_0123456789abcdef0123456789abcdef',
        status: 'success',
        metadata: {
          spend_logs_metadata: {
            stablehand_turn_correlation: 'ct_fedcba9876543210fedcba9876543210',
          },
        },
        api_key: 'must-not-leak',
      }],
      page: 1,
      page_size: 100,
      total: 1,
      total_pages: 1,
      total_is_capped: false,
    }));
    const client = new LiteLLMSpendClient({
      baseUrl: 'http://litellm:4000',
      meteringKey: 'metering-key',
      fetchImpl,
    });

    const result = await client.listSpend({
      startMs: Date.parse('2026-07-23T00:00:00.000Z'),
      endMs: Date.parse('2026-07-24T00:00:00.000Z'),
    });

    expect(result.records).toEqual([]);
    expect(result.invalid).toEqual([{
      transactionId: 'tx-mismatch',
      correlationId: 'ct_0123456789abcdef0123456789abcdef',
      reason: 'correlation_mismatch',
      safeFields: {
        model: 'openai/gpt-5.4-mini',
        modelGroup: 'gpt-5.4-mini',
        provider: 'openai',
        status: 'success',
      },
    }]);
    expect(JSON.stringify(result)).not.toContain('must-not-leak');
  });

  it('returns partial progress with a safe boundary when pagination truncates', async () => {
    const row = (requestId: string, correlationId: string, startTime: string, endTime: string) => ({
      request_id: requestId,
      spend: 0.001,
      prompt_tokens: 10,
      completion_tokens: 1,
      total_tokens: 11,
      startTime,
      endTime,
      model: 'openai/gpt-5.4-mini',
      model_group: 'gpt-5.4-mini',
      custom_llm_provider: 'openai',
      session_id: correlationId,
      status: 'success',
    });
    const pages = [
      [row('tx-1', 'ct_00000000000000000000000000000000', '2026-07-23T10:00:00.000Z', '2026-07-23T10:00:01.000Z')],
      [row('tx-2', 'ct_11111111111111111111111111111111', '2026-07-23T10:05:00.000Z', '2026-07-23T10:05:01.000Z')],
    ];
    const fetchImpl = vi.fn().mockImplementation((input: string) => {
      const page = Number(new URL(String(input)).searchParams.get('page'));
      return Promise.resolve(jsonResponse({
        data: pages[page - 1] ?? [],
        page,
        page_size: 1,
        total: 5,
        total_pages: 5,
      }));
    });
    const client = new LiteLLMSpendClient({
      baseUrl: 'http://litellm:4000',
      meteringKey: 'metering-key',
      pageSize: 1,
      maxPages: 2,
      fetchImpl,
    });

    const result = await client.listSpend({
      startMs: Date.parse('2026-07-23T09:00:00.000Z'),
      endMs: Date.parse('2026-07-23T11:00:00.000Z'),
    });

    // Both fetched rows are ingested; the boundary is the last row's start
    // time, so every row that ENDED before it has provably been observed.
    expect(result.records.map((record) => record.transactionId)).toEqual(['tx-1', 'tx-2']);
    expect(result.truncatedAtMs).toBe(Date.parse('2026-07-23T10:05:00.000Z'));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('holds the boundary at the window start when truncation observes no parseable rows', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({
      data: [{ garbage: true }],
      page: 1,
      page_size: 1,
      total: 5,
      total_pages: 5,
    }));
    const client = new LiteLLMSpendClient({
      baseUrl: 'http://litellm:4000',
      meteringKey: 'metering-key',
      pageSize: 1,
      maxPages: 1,
      fetchImpl,
    });

    const startMs = Date.parse('2026-07-23T09:00:00.000Z');
    const result = await client.listSpend({
      startMs,
      endMs: Date.parse('2026-07-23T11:00:00.000Z'),
    });
    expect(result.truncatedAtMs).toBe(startMs);
    expect(result.invalid).toHaveLength(1);
  });

  it('fails the poll when the spend endpoint or envelope is invalid', async () => {
    const denied = new LiteLLMSpendClient({
      baseUrl: 'http://litellm:4000',
      meteringKey: 'bad-key',
      fetchImpl: vi.fn().mockResolvedValue(jsonResponse({ error: 'denied' }, 401)),
    });
    await expect(denied.listSpend({
      startMs: 0,
      endMs: Date.now(),
    })).rejects.toThrow(/401/);

    const malformed = new LiteLLMSpendClient({
      baseUrl: 'http://litellm:4000',
      meteringKey: 'metering-key',
      fetchImpl: vi.fn().mockResolvedValue(jsonResponse({ data: 'wrong' })),
    });
    await expect(malformed.listSpend({
      startMs: 0,
      endMs: Date.now(),
    })).rejects.toThrow(/envelope/);
  });

  describe('issued keys (ctx-gfp8)', () => {
    const RUNTIME_KEY = 'sk-runtime-secret';
    const RUNTIME_HASH = liteLLMKeyHash(RUNTIME_KEY);
    const SESSION_HASH = 'a'.repeat(64);
    const FOREIGN_HASH = 'f'.repeat(64);
    const CAMPAIGN_HASH = 'c'.repeat(64);

    const spendRow = (input: {
      requestId: string;
      keyHash: string;
      alias?: string;
      correlationId?: string;
      startTime?: string;
      spend?: number;
    }) => ({
      request_id: input.requestId,
      spend: input.spend ?? 0.01,
      prompt_tokens: 10,
      completion_tokens: 2,
      total_tokens: 12,
      startTime: input.startTime ?? '2026-10-23T10:00:00.000Z',
      endTime: '2026-10-23T10:00:01.000Z',
      model: 'openai/gpt-5.4-mini',
      model_group: 'gpt-5.4-mini',
      custom_llm_provider: 'openai',
      ...(input.correlationId ? { session_id: input.correlationId } : {}),
      status: 'success',
      api_key: input.keyHash,
      metadata: input.alias ? { user_api_key_alias: input.alias } : {},
    });

    /** A /spend/logs/v2 fake that honours LiteLLM 1.93's api_key and key_alias filters. */
    function fakeSpendLogs(rows: Array<ReturnType<typeof spendRow>>) {
      return vi.fn().mockImplementation((input: string) => {
        const params = new URL(String(input)).searchParams;
        const apiKey = params.get('api_key');
        const keyAlias = params.get('key_alias');
        const matched = rows.filter((row) => (
          (apiKey === null || row.api_key === apiKey)
          && (keyAlias === null || String(
            (row.metadata as { user_api_key_alias?: string }).user_api_key_alias ?? '',
          ).includes(keyAlias))
        ));
        return Promise.resolve(jsonResponse({
          data: matched,
          page: 1,
          page_size: 100,
          total: matched.length,
          total_pages: matched.length > 0 ? 1 : 0,
        }));
      });
    }

    const window = {
      startMs: Date.parse('2026-10-23T09:00:00.000Z'),
      endMs: Date.parse('2026-10-23T11:00:00.000Z'),
    };

    it('asks LiteLLM only for issued keys and counts foreign rows instead of quarantining them', async () => {
      const fetchImpl = fakeSpendLogs([
        spendRow({ requestId: 'tx-runtime', keyHash: RUNTIME_HASH, alias: 'ops-runtime', correlationId: 'ct_00000000000000000000000000000000' }),
        spendRow({ requestId: 'tx-runtime-uncorrelated', keyHash: RUNTIME_HASH, alias: 'ops-runtime' }),
        spendRow({ requestId: 'tx-session', keyHash: SESSION_HASH, alias: 'stablehand-session-s1', correlationId: 'ct_11111111111111111111111111111111' }),
        // Another workload sharing the gateway. Never requested by a filter.
        spendRow({ requestId: 'tx-other-workload', keyHash: FOREIGN_HASH, alias: 'research-lane' }),
        // Matched by the substring alias filter but not one of ours.
        spendRow({ requestId: 'tx-lookalike', keyHash: FOREIGN_HASH, alias: 'copy-of-stablehand-session-x' }),
      ]);
      const client = new LiteLLMSpendClient({
        baseUrl: 'http://litellm:4000',
        meteringKey: 'metering-key',
        fetchImpl,
      });

      const result = await client.listSpend({
        ...window,
        issuedKeys: createIssuedGatewayKeys({ runtimeKey: RUNTIME_KEY }),
      });

      const requested = fetchImpl.mock.calls.map(([url]) => {
        const params = new URL(String(url)).searchParams;
        return { apiKey: params.get('api_key'), keyAlias: params.get('key_alias') };
      });
      expect(requested).toEqual([
        { apiKey: RUNTIME_HASH, keyAlias: null },
        { apiKey: null, keyAlias: 'stablehand-session-' },
        { apiKey: null, keyAlias: 'stablehand-campaign-' },
      ]);
      expect(result.records.map((record) => record.transactionId)).toEqual(['tx-runtime', 'tx-session']);
      // Uncorrelated spend on Stablehand's own key is still quarantined.
      expect(result.invalid).toEqual([expect.objectContaining({
        transactionId: 'tx-runtime-uncorrelated',
        reason: 'missing_correlation',
      })]);
      expect(result.skippedForeign).toBe(1);
      expect(JSON.stringify(result)).not.toContain('tx-other-workload');
      expect(JSON.stringify(result)).not.toContain('tx-lookalike');
      // Key hashes and aliases are classification inputs only.
      expect(JSON.stringify(result)).not.toContain(RUNTIME_HASH);
      expect(JSON.stringify(result)).not.toContain('stablehand-session-s1');
    });

    it('attributes campaign-key rows to the campaign without needing a turn correlation', async () => {
      const fetchImpl = fakeSpendLogs([
        spendRow({ requestId: 'tx-campaign', keyHash: CAMPAIGN_HASH, alias: 'stablehand-campaign-gck_1', spend: 0.25 }),
        // A campaign-shaped alias Stablehand has no record of: minted elsewhere.
        spendRow({ requestId: 'tx-unknown-campaign', keyHash: FOREIGN_HASH, alias: 'stablehand-campaign-gck_other' }),
      ]);
      const client = new LiteLLMSpendClient({
        baseUrl: 'http://litellm:4000',
        meteringKey: 'metering-key',
        fetchImpl,
      });

      const result = await client.listSpend({
        ...window,
        issuedKeys: createIssuedGatewayKeys({
          runtimeKey: RUNTIME_KEY,
          campaignKeys: [{ id: 'gck_1', keyHash: CAMPAIGN_HASH }],
        }),
      });

      expect(result.records).toEqual([]);
      expect(result.invalid).toEqual([]);
      expect(result.campaignRecords).toEqual([{
        transactionId: 'tx-campaign',
        campaignKeyId: 'gck_1',
        requestedModel: 'gpt-5.4-mini',
        resolvedModel: 'openai/gpt-5.4-mini',
        provider: 'openai',
        status: 'success',
        inputTokens: 10,
        outputTokens: 2,
        totalTokens: 12,
        costUsd: 0.25,
        costState: 'priced',
        startedAt: Date.parse('2026-10-23T10:00:00.000Z'),
        endedAt: Date.parse('2026-10-23T10:00:01.000Z'),
      }]);
      expect(result.skippedForeign).toBe(1);
    });

    it('lists a transaction once when two filters both return it', async () => {
      // A runtime key whose alias happens to carry the session prefix.
      const fetchImpl = fakeSpendLogs([
        spendRow({
          requestId: 'tx-both',
          keyHash: RUNTIME_HASH,
          alias: 'stablehand-session-runtime',
          correlationId: 'ct_00000000000000000000000000000000',
        }),
      ]);
      const client = new LiteLLMSpendClient({
        baseUrl: 'http://litellm:4000',
        meteringKey: 'metering-key',
        fetchImpl,
      });

      const result = await client.listSpend({
        ...window,
        issuedKeys: createIssuedGatewayKeys({ runtimeKey: RUNTIME_KEY }),
      });

      expect(result.records.map((record) => record.transactionId)).toEqual(['tx-both']);
    });

    it('reports the earliest boundary when one filter stream truncates', async () => {
      const fetchImpl = vi.fn().mockImplementation((input: string) => {
        const params = new URL(String(input)).searchParams;
        const page = Number(params.get('page'));
        if (params.get('api_key') === RUNTIME_HASH) {
          return Promise.resolve(jsonResponse({
            data: [spendRow({
              requestId: `tx-runtime-${page}`,
              keyHash: RUNTIME_HASH,
              correlationId: 'ct_00000000000000000000000000000000',
              startTime: page === 1 ? '2026-10-23T09:10:00.000Z' : '2026-10-23T09:20:00.000Z',
            })],
            page,
            page_size: 1,
            total: 9,
            total_pages: 9,
          }));
        }
        return Promise.resolve(jsonResponse({
          data: [], page: 1, page_size: 1, total: 0, total_pages: 0,
        }));
      });
      const client = new LiteLLMSpendClient({
        baseUrl: 'http://litellm:4000',
        meteringKey: 'metering-key',
        pageSize: 1,
        maxPages: 2,
        fetchImpl,
      });

      const result = await client.listSpend({
        ...window,
        issuedKeys: createIssuedGatewayKeys({ runtimeKey: RUNTIME_KEY }),
      });

      expect(result.truncatedAtMs).toBe(Date.parse('2026-10-23T09:20:00.000Z'));
      // Two pages from the runtime stream, one each from the alias streams.
      expect(fetchImpl).toHaveBeenCalledTimes(4);
    });
  });
});
