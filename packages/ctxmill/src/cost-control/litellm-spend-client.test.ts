import { describe, expect, it, vi } from 'vitest';

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
              ctxmill_turn_correlation: 'ct_0123456789abcdef0123456789abcdef',
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
              ctxmill_turn_correlation: 'ct_fedcba9876543210fedcba9876543210',
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
            ctxmill_turn_correlation: 'ct_fedcba9876543210fedcba9876543210',
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
});
