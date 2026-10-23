import { createHash } from 'node:crypto';
import { z } from 'zod';

import type { ModelGatewayCostState } from '../database/schema-pg.js';
import type {
  GatewayKeyIdentity,
  IssuedGatewayKeys,
  SpendKeyFilter,
} from './issued-gateway-keys.js';

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
      stablehand_turn_correlation: z.string().nullish(),
    }).passthrough().nullish(),
  }).passthrough().nullish(),
}).passthrough();

type SpendRow = z.infer<typeof SpendRowSchema>;

const SpendPageSchema = z.object({
  data: z.array(z.unknown()),
  page: z.number().int().positive(),
  page_size: z.number().int().positive(),
  total: z.number().int().nonnegative(),
  total_pages: z.number().int().nonnegative(),
  total_is_capped: z.boolean().optional(),
}).passthrough();

/** Usage and cost of one gateway transaction, without its attribution. */
export interface LiteLLMSpendUsage {
  transactionId: string;
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

/** A transaction from a turn key (runtime or per-session), correlated to a turn. */
export interface LiteLLMSpendRecord extends LiteLLMSpendUsage {
  correlationId: string;
}

/** A transaction from a campaign key: attributed to the campaign, not a turn. */
export interface LiteLLMCampaignSpendRecord extends LiteLLMSpendUsage {
  campaignKeyId: string;
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

export interface LiteLLMSpendListing {
  /** Turn-key transactions with a valid turn correlation. */
  records: LiteLLMSpendRecord[];
  /** Campaign-key transactions. Empty unless `issuedKeys` was given. */
  campaignRecords: LiteLLMCampaignSpendRecord[];
  /** Transactions from Stablehand's own keys that cannot be attributed. */
  invalid: InvalidLiteLLMSpendRecord[];
  /**
   * Rows from keys Stablehand did not issue that reached the listing anyway.
   * Counted, never returned. Zero unless `issuedKeys` was given.
   */
  skippedForeign: number;
  /**
   * Set when pagination stopped at the safety limit before covering endMs.
   * Pages are sorted by startTime ascending, so every row that ENDED at or
   * before the last fetched row's startTime has been observed — the caller
   * may advance its watermark to this boundary but no further. Undefined
   * when the window was fully covered.
   */
  truncatedAtMs?: number;
}

interface LiteLLMSpendClientOptions {
  baseUrl: string;
  meteringKey: string;
  pageSize?: number;
  /** Page limit per filter stream (one stream when no key filter is used). */
  maxPages?: number;
  explicitFreeModels?: readonly string[];
  fetchImpl?: typeof fetch;
}

interface ListSpendInput {
  startMs: number;
  endMs: number;
  signal?: AbortSignal;
  /**
   * The keys Stablehand issued. With it, LiteLLM is asked only for those
   * keys' rows and any other key's row is counted and dropped.
   */
  issuedKeys?: IssuedGatewayKeys;
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

function asRecord(raw: unknown): Record<string, unknown> | undefined {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : undefined;
}

function safeFields(raw: unknown): InvalidLiteLLMSpendRecord['safeFields'] {
  const record = asRecord(raw);
  if (!record) {
    return {};
  }
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
  const record = asRecord(raw);
  return record ? optionalString(record, 'session_id') : undefined;
}

/** The calling key as LiteLLM recorded it: token hash and alias. Never logged or returned. */
function readKeyIdentity(raw: unknown): GatewayKeyIdentity {
  const record = asRecord(raw);
  if (!record) {
    return {};
  }
  const metadata = asRecord(record.metadata);
  const alias = metadata ? optionalString(metadata, 'user_api_key_alias') : undefined;
  const hash = optionalString(record, 'api_key');
  return {
    ...(hash ? { hash } : {}),
    ...(alias ? { alias } : {}),
  };
}

function byStartTime(left: LiteLLMSpendUsage, right: LiteLLMSpendUsage): number {
  return left.startedAt - right.startedAt
    || left.transactionId.localeCompare(right.transactionId);
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

  /**
   * Spend rows whose call finished inside [startMs, endMs].
   *
   * With `issuedKeys`, each of its filters is paged as its own stream, so
   * another workload sharing the gateway cannot fill the fetch window with
   * its rows (ctx-gfp8). Without it, every row is read and treated as
   * Stablehand's, the behaviour before key classification existed.
   */
  async listSpend(input: ListSpendInput): Promise<LiteLLMSpendListing> {
    const listing: LiteLLMSpendListing = {
      records: [],
      campaignRecords: [],
      invalid: [],
      skippedForeign: 0,
    };
    const seen = new Set<string>();
    const filters: ReadonlyArray<SpendKeyFilter | undefined> = input.issuedKeys
      ? input.issuedKeys.filters
      : [undefined];
    let truncatedAtMs: number | undefined;
    for (const filter of filters) {
      const streamTruncatedAtMs = await this.readStream(input, filter, listing, seen);
      if (streamTruncatedAtMs !== undefined) {
        // Rows past the earliest truncated boundary may still be returned
        // from other streams; ingesting them early is harmless (idempotent
        // by transaction id), but the watermark must not pass the boundary.
        truncatedAtMs = truncatedAtMs === undefined
          ? streamTruncatedAtMs
          : Math.min(truncatedAtMs, streamTruncatedAtMs);
      }
    }

    listing.records.sort(byStartTime);
    listing.campaignRecords.sort(byStartTime);
    return truncatedAtMs === undefined ? listing : { ...listing, truncatedAtMs };
  }

  /**
   * Page one filter's rows into `listing`. Returns the stream's safe
   * boundary when pagination truncated, otherwise undefined.
   */
  private async readStream(
    input: ListSpendInput,
    filter: SpendKeyFilter | undefined,
    listing: LiteLLMSpendListing,
    seen: Set<string>,
  ): Promise<number | undefined> {
    let totalPages = 1;
    let truncated = false;
    let maxObservedStartMs: number | undefined;

    for (let page = 1; page <= totalPages; page++) {
      if (page > this.maxPages) {
        // A backlog larger than one fetch window is ingestion lag, not a
        // permanent failure: commit the safe prefix instead of throwing,
        // which used to pin the watermark forever (ctx-wpln b).
        truncated = true;
        break;
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
      if (filter && 'apiKey' in filter) {
        query.set('api_key', filter.apiKey);
      } else if (filter) {
        query.set('key_alias', filter.keyAlias);
      }
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
        if (parsed.success) {
          // Every parseable row bounds what this sorted stream has observed,
          // whatever its key or correlation turns out to be.
          const startedAt = Date.parse(parsed.data.startTime);
          if (Number.isFinite(startedAt)) {
            maxObservedStartMs = maxObservedStartMs === undefined
              ? startedAt
              : Math.max(maxObservedStartMs, startedAt);
          }
        }
        const transactionId = optionalString(asRecord(raw) ?? {}, 'request_id')
          ?? fallbackTransactionId(raw);
        // Filters can overlap (a runtime key whose alias carries an issued
        // prefix); each transaction is listed once.
        if (seen.has(transactionId)) continue;
        seen.add(transactionId);

        const keyClass = input.issuedKeys
          ? input.issuedKeys.classify(readKeyIdentity(raw))
          : { kind: 'turn' as const };
        if (keyClass.kind === 'foreign') {
          listing.skippedForeign += 1;
          continue;
        }

        if (!parsed.success) {
          const correlationId = readRawCorrelation(raw);
          listing.invalid.push({
            transactionId,
            ...(correlationId ? { correlationId } : {}),
            reason: 'invalid_payload',
            safeFields: safeFields(raw),
          });
          continue;
        }

        const row = parsed.data;
        if (keyClass.kind === 'campaign') {
          // Campaign keys are used outside Stablehand turns, so their rows
          // carry no turn correlation and need none.
          const usage = this.usageInWindow(row, input);
          if (usage) {
            listing.campaignRecords.push({ ...usage, campaignKeyId: keyClass.campaignKeyId });
          }
          continue;
        }

        const headerCorrelation = row.session_id ?? undefined;
        const metadataCorrelation =
          row.metadata?.spend_logs_metadata?.stablehand_turn_correlation ?? undefined;
        const correlationId = headerCorrelation ?? metadataCorrelation;
        if (
          headerCorrelation
          && metadataCorrelation
          && headerCorrelation !== metadataCorrelation
        ) {
          listing.invalid.push({
            transactionId: row.request_id,
            correlationId: headerCorrelation,
            reason: 'correlation_mismatch',
            safeFields: safeFields(row),
          });
          continue;
        }
        if (!correlationId) {
          listing.invalid.push({
            transactionId: row.request_id,
            reason: 'missing_correlation',
            safeFields: safeFields(row),
          });
          continue;
        }
        if (!OPAQUE_CORRELATION_PATTERN.test(correlationId)) {
          listing.invalid.push({
            transactionId: row.request_id,
            correlationId,
            reason: 'invalid_correlation',
            safeFields: safeFields(row),
          });
          continue;
        }
        const usage = this.usageInWindow(row, input);
        if (usage) {
          listing.records.push({ ...usage, correlationId });
        }
      }
    }

    if (!truncated) {
      return undefined;
    }
    // No parseable boundary (e.g. every row invalid) means no safe progress:
    // report the window start so the watermark holds still and the lag is
    // visible to the stall detector rather than silently skipped past.
    return Math.min(
      Math.max(maxObservedStartMs ?? input.startMs, input.startMs),
      input.endMs,
    );
  }

  /** Normalized usage, or undefined when the call did not finish inside the window. */
  private usageInWindow(
    row: SpendRow,
    window: { startMs: number; endMs: number },
  ): LiteLLMSpendUsage | undefined {
    const startedAt = Date.parse(row.startTime);
    const endedAt = Date.parse(row.endTime);
    // A spend row becomes durable only after the provider call finishes.
    // Cursor on that finalized boundary so a call that lasts longer than
    // the reconciler overlap cannot start before the window and disappear
    // before STABLEHAND ever observes it.
    if (endedAt < window.startMs || endedAt > window.endMs) {
      return undefined;
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

    return {
      transactionId: row.request_id,
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
    };
  }
}
