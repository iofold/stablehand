import { createHash } from 'node:crypto';
import { z } from 'zod';

import type { ModelGatewayCostState } from '../database/schema-pg.js';

const OPAQUE_CORRELATION_PATTERN = /^ct_[a-f0-9]{32}$/;

const OptionalTokenSchema = z.number().int().nonnegative().nullish();
const SpendRowSchema = z.object({
  request_id: z.string().min(1),
  spend: z.number().finite().nonnegative(),
  prompt_tokens: OptionalTokenSchema,
  completion_tokens: OptionalTokenSchema,
  total_tokens: OptionalTokenSchema,
  startTime: z.string().datetime({ offset: true }),
  endTime: z.string().datetime({ offset: true }),
  model: z.string().nullish(),
  model_group: z.string().nullish(),
  custom_llm_provider: z.string().nullish(),
  session_id: z.string().nullish(),
  status: z.string().min(1),
  metadata: z.object({
    usage_object: z.object({
      cache_read_input_tokens: OptionalTokenSchema,
      cache_creation_input_tokens: OptionalTokenSchema,
      prompt_tokens_details: z.object({
        cached_tokens: OptionalTokenSchema,
        cache_creation_tokens: OptionalTokenSchema,
      }).passthrough().nullish(),
      completion_tokens_details: z.object({
        reasoning_tokens: OptionalTokenSchema,
      }).passthrough().nullish(),
    }).passthrough().nullish(),
    spend_logs_metadata: z.object({
      ctxmill_turn_correlation: z.string().nullish(),
    }).passthrough().nullish(),
  }).passthrough().nullish(),
}).passthrough();

const SpendPageSchema = z.object({
  data: z.array(z.unknown()),
  page: z.number().int().positive(),
  page_size: z.number().int().positive(),
  total: z.number().int().nonnegative(),
  total_pages: z.number().int().nonnegative(),
  total_is_capped: z.boolean().optional(),
}).passthrough();

export interface LiteLLMSpendRecord {
  transactionId: string;
  correlationId: string;
  requestedModel?: string;
  resolvedModel?: string;
  provider?: string;
  status: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheCreateTokens?: number;
  reasoningTokens?: number;
  costUsd?: number;
  costState: ModelGatewayCostState;
  startedAt: number;
  endedAt: number;
}

export interface InvalidLiteLLMSpendRecord {
  transactionId: string;
  correlationId?: string;
  reason:
    | 'invalid_payload'
    | 'missing_correlation'
    | 'invalid_correlation'
    | 'correlation_mismatch';
  safeFields: {
    model?: string;
    modelGroup?: string;
    provider?: string;
    status?: string;
  };
}

interface LiteLLMSpendClientOptions {
  baseUrl: string;
  meteringKey: string;
  pageSize?: number;
  maxPages?: number;
  explicitFreeModels?: readonly string[];
  fetchImpl?: typeof fetch;
}

function dateOnly(timestampMs: number): string {
  return new Date(timestampMs).toISOString().slice(0, 10);
}

function exclusiveDateAfter(timestampMs: number): string {
  const date = new Date(timestampMs);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function safeFields(raw: unknown): InvalidLiteLLMSpendRecord['safeFields'] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return {};
  }
  const record = raw as Record<string, unknown>;
  return {
    ...(optionalString(record, 'model') ? { model: optionalString(record, 'model') } : {}),
    ...(optionalString(record, 'model_group')
      ? { modelGroup: optionalString(record, 'model_group') }
      : {}),
    ...(optionalString(record, 'custom_llm_provider')
      ? { provider: optionalString(record, 'custom_llm_provider') }
      : {}),
    ...(optionalString(record, 'status') ? { status: optionalString(record, 'status') } : {}),
  };
}

function fallbackTransactionId(raw: unknown): string {
  const digest = createHash('sha256')
    .update(JSON.stringify(safeFields(raw)))
    .digest('hex')
    .slice(0, 32);
  return `invalid_${digest}`;
}

function readRawCorrelation(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  return optionalString(raw as Record<string, unknown>, 'session_id');
}

export class LiteLLMSpendClient {
  private readonly fetchImpl: typeof fetch;
  private readonly pageSize: number;
  private readonly maxPages: number;
  private readonly explicitFreeModels: ReadonlySet<string>;

  constructor(private readonly options: LiteLLMSpendClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.pageSize = options.pageSize ?? 100;
    this.maxPages = options.maxPages ?? 100;
    this.explicitFreeModels = new Set(options.explicitFreeModels ?? []);
  }

  async listSpend(input: {
    startMs: number;
    endMs: number;
    signal?: AbortSignal;
  }): Promise<{
    records: LiteLLMSpendRecord[];
    invalid: InvalidLiteLLMSpendRecord[];
  }> {
    const records: LiteLLMSpendRecord[] = [];
    const invalid: InvalidLiteLLMSpendRecord[] = [];
    let totalPages = 1;

    for (let page = 1; page <= totalPages; page++) {
      if (page > this.maxPages) {
        throw new Error(
          `LiteLLM spend pagination exceeded the configured ${this.maxPages}-page safety limit`,
        );
      }
      const query = new URLSearchParams({
        start_date: dateOnly(input.startMs),
        // LiteLLM's spend API treats end_date as exclusive. Request through
        // the following UTC date, then enforce the exact millisecond window
        // below so same-day polls cannot silently return an empty page.
        end_date: exclusiveDateAfter(input.endMs),
        page: String(page),
        page_size: String(this.pageSize),
        sort_by: 'startTime',
        sort_order: 'asc',
      });
      const response = await this.fetchImpl(
        `${this.options.baseUrl.replace(/\/+$/, '')}/spend/logs/v2?${query}`,
        {
          headers: { authorization: `Bearer ${this.options.meteringKey}` },
          signal: input.signal,
        },
      );
      if (!response.ok) {
        throw new Error(`LiteLLM spend endpoint returned HTTP ${response.status}`);
      }
      const parsedPage = SpendPageSchema.safeParse(await response.json());
      if (!parsedPage.success) {
        throw new Error('LiteLLM spend endpoint returned an invalid page envelope');
      }
      totalPages = parsedPage.data.total_pages;

      for (const raw of parsedPage.data.data) {
        const parsed = SpendRowSchema.safeParse(raw);
        if (!parsed.success) {
          const rawRecord = typeof raw === 'object' && raw !== null && !Array.isArray(raw)
            ? raw as Record<string, unknown>
            : {};
          invalid.push({
            transactionId: optionalString(rawRecord, 'request_id')
              ?? fallbackTransactionId(raw),
            ...(readRawCorrelation(raw)
              ? { correlationId: readRawCorrelation(raw) }
              : {}),
            reason: 'invalid_payload',
            safeFields: safeFields(raw),
          });
          continue;
        }

        const row = parsed.data;
        const headerCorrelation = row.session_id ?? undefined;
        const metadataCorrelation =
          row.metadata?.spend_logs_metadata?.ctxmill_turn_correlation ?? undefined;
        const correlationId = headerCorrelation ?? metadataCorrelation;
        if (
          headerCorrelation
          && metadataCorrelation
          && headerCorrelation !== metadataCorrelation
        ) {
          invalid.push({
            transactionId: row.request_id,
            correlationId: headerCorrelation,
            reason: 'correlation_mismatch',
            safeFields: safeFields(row),
          });
          continue;
        }
        if (!correlationId) {
          invalid.push({
            transactionId: row.request_id,
            reason: 'missing_correlation',
            safeFields: safeFields(row),
          });
          continue;
        }
        if (!OPAQUE_CORRELATION_PATTERN.test(correlationId)) {
          invalid.push({
            transactionId: row.request_id,
            correlationId,
            reason: 'invalid_correlation',
            safeFields: safeFields(row),
          });
          continue;
        }

        const startedAt = Date.parse(row.startTime);
        const endedAt = Date.parse(row.endTime);
        if (startedAt < input.startMs || startedAt > input.endMs) {
          continue;
        }
        const inputTokens = row.prompt_tokens ?? undefined;
        const outputTokens = row.completion_tokens ?? undefined;
        const totalTokens = row.total_tokens ?? (
          inputTokens !== undefined && outputTokens !== undefined
            ? inputTokens + outputTokens
            : undefined
        );
        const usageObject = row.metadata?.usage_object;
        const cacheReadTokens = usageObject?.cache_read_input_tokens
          ?? usageObject?.prompt_tokens_details?.cached_tokens
          ?? undefined;
        const cacheCreateTokens = usageObject?.cache_creation_input_tokens
          ?? usageObject?.prompt_tokens_details?.cache_creation_tokens
          ?? undefined;
        const reasoningTokens =
          usageObject?.completion_tokens_details?.reasoning_tokens ?? undefined;
        const explicitlyFree = (
          row.model_group != null && this.explicitFreeModels.has(row.model_group)
        ) || (
          row.model != null && this.explicitFreeModels.has(row.model)
        );
        const costState: ModelGatewayCostState = row.spend > 0
          ? 'priced'
          : explicitlyFree
            ? 'explicit_free'
            : totalTokens === 0
              ? 'priced'
              : 'unpriced';

        records.push({
          transactionId: row.request_id,
          correlationId,
          ...(row.model_group ? { requestedModel: row.model_group } : {}),
          ...(row.model ? { resolvedModel: row.model } : {}),
          ...(row.custom_llm_provider ? { provider: row.custom_llm_provider } : {}),
          status: row.status,
          ...(inputTokens !== undefined ? { inputTokens } : {}),
          ...(outputTokens !== undefined ? { outputTokens } : {}),
          ...(totalTokens !== undefined ? { totalTokens } : {}),
          ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
          ...(cacheCreateTokens !== undefined ? { cacheCreateTokens } : {}),
          ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
          ...(costState !== 'unpriced' ? { costUsd: row.spend } : {}),
          costState,
          startedAt,
          endedAt,
        });
      }
    }

    records.sort((left, right) => (
      left.startedAt - right.startedAt
      || left.transactionId.localeCompare(right.transactionId)
    ));
    return { records, invalid };
  }
}
