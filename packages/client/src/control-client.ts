import {
  AgentCreateInputSchema,
  ArtifactDownloadUrlResponseSchema,
  ArtifactListResponseSchema,
  ArtifactSchema,
  ArtifactUploadUrlInputSchema,
  ArtifactUploadUrlResponseSchema,
  AgentBudgetStatusListResponseSchema,
  AgentListResponseSchema,
  AgentPatchInputSchema,
  AgentSchema,
  AgentStreamEventSchema,
  AnalyticsOverviewSchema,
  AnalyticsWindowSchema,
  BackgroundTurnStartInputSchema,
  BackgroundTurnStartResponseSchema,
  BudgetPolicyCreateInputSchema,
  BudgetPolicyListResponseSchema,
  BudgetPolicyPatchInputSchema,
  BudgetPolicySchema,
  BudgetSpendResponseSchema,
  ConfigResponseSchema,
  ConversationListResponseSchema,
  ConversationSnapshotResponseSchema,
  ConversationSummaryListResponseSchema,
  ConversationTurnStartInputSchema,
  ConversationTurnStartResponseSchema,
  CustomEventEmitInputSchema,
  CustomEventEmitResponseSchema,
  EventCursorSchema,
  EventListInputSchema,
  EventListResponseSchema,
  FileListResponseSchema,
  FileReadResponseSchema,
  FileWriteInputSchema,
  FileWriteResponseSchema,
  HealthResponseSchema,
  InterruptListResponseSchema,
  InterruptRecordDetailSchema,
  InterruptRecordListInputSchema,
  InterruptRecordListResponseSchema,
  InterruptResolveInputSchema,
  InterruptResolveResponseSchema,
  ModelGatewayStatusSchema,
  SandboxSessionActionResponseSchema,
  SandboxSessionListResponseSchema,
  ScheduleCreateInputSchema,
  ScheduleListResponseSchema,
  SchedulePatchInputSchema,
  ScheduleSchema,
  SecretListResponseSchema,
  SecretPutInputSchema,
  SecretPutResponseSchema,
  TurnCancelResponseSchema,
  TurnDetailResponseSchema,
  TurnListResponseSchema,
  TurnLookupResponseSchema,
  TurnSearchInputSchema,
  TurnSearchResponseSchema,
  WebhookCreateInputSchema,
  WebhookListResponseSchema,
  WebhookPatchInputSchema,
  WebhookSchema,
  WorkspaceReplaceResponseSchema,
  WorkspaceRevisionResponseSchema,
  type Agent,
  type AgentCreateInput,
  type Artifact,
  type ArtifactUploadUrlInput,
  type AgentPatchInput,
  type AgentStreamEvent,
  type AnalyticsOverview,
  type AnalyticsWindow,
  type BackgroundTurnStartInput,
  type BudgetPolicy,
  type BudgetPolicyCreateInput,
  type BudgetPolicyPatchInput,
  type BudgetSpendResponse,
  type Conversation,
  type ConversationSnapshot,
  type ConversationSummary,
  type ConversationTurnStartInput,
  type CustomEventEmitInput,
  type EventListInput,
  type EventListResponse,
  type FileWriteInput,
  type Interrupt,
  type InterruptRecord,
  type InterruptRecordDetail,
  type InterruptRecordListInput,
  type InterruptResolveInput,
  type Message,
  type SandboxSession,
  type Schedule,
  type ScheduleCreateInput,
  type SchedulePatchInput,
  type Turn,
  type TurnSearchInput,
  type TurnSearchResponse,
  type Webhook,
  type WebhookCreateInput,
  type WebhookPatchInput,
} from '@stablehand/contracts';
import { z } from 'zod';

import {
  StablehandApiError,
  StablehandContractError,
  StablehandTimeoutError,
} from './errors.js';
import { parseServerSentEvents } from './sse.js';
import {
  StablehandTransport,
  type StablehandClientOptions,
  type StablehandRequestOptions,
} from './transport.js';

const VoidResponseSchema = z.undefined();

function segment(value: string, name: string): string {
  const parsed = z.string().trim().min(1).safeParse(value);
  if (!parsed.success) {
    throw new StablehandContractError({
      direction: 'request',
      method: 'PARAM',
      path: name,
      issues: parsed.error.issues,
    });
  }
  return encodeURIComponent(parsed.data);
}

function queryPath(
  path: string,
  query: Record<string, string | undefined>,
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) search.set(key, value);
  }
  const suffix = search.toString();
  return suffix ? `${path}?${suffix}` : path;
}

function streamCursor(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const parsed = EventCursorSchema.safeParse(value);
  if (!parsed.success) {
    throw new StablehandContractError({
      direction: 'request',
      method: 'GET',
      path: 'cursor',
      issues: parsed.error.issues,
    });
  }
  return parsed.data;
}

export interface AgentEventStreamInput extends StablehandRequestOptions {
  agentId: string;
  /** Initial replay boundary obtained from conversations.snapshot(). */
  cursor?: string;
  /** Browser/native SSE reconnect acknowledgement. */
  lastEventId?: string;
}

export type AgentEventStreamItem =
  | { id: string | null; event: AgentStreamEvent }
  | { id: string | null; event: null; heartbeat: string };

export interface WaitForTurnOptions {
  /** Give up after this long and throw StablehandTimeoutError. Default 10 minutes. */
  timeoutMs?: number;
  /** Abort the wait; the promise rejects with the signal's reason. */
  signal?: AbortSignal;
  /** First delay between checks. Default 500 ms; grows 1.5x per check. */
  pollIntervalMs?: number;
  /** Longest delay between checks. Default 10 s. */
  maxPollIntervalMs?: number;
  /**
   * Also listen on the agent's event stream so the wait ends as soon as the
   * turn does, instead of at the next check. Default true; checks continue
   * either way, so a stream that cannot open only makes the wait slower.
   */
  useStream?: boolean;
}

const TERMINAL_TURN_STATUSES: ReadonlySet<Turn['status']> = new Set(['COMPLETED', 'ERROR', 'CANCELLED']);
const DEFAULT_WAIT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_MAX_POLL_INTERVAL_MS = 10_000;
const POLL_BACKOFF = 1.5;
const DEFAULT_LOOKUP_TIMEOUT_MS = 30_000;

/** Errors worth another check while waiting: network blips, timeouts, 5xx, 408 and 429. */
function isTransientWaitError(error: unknown): boolean {
  if (error instanceof StablehandApiError) {
    return error.status >= 500 || error.status === 408 || error.status === 429;
  }
  if (error instanceof StablehandContractError) return false;
  return error instanceof StablehandTimeoutError || error instanceof TypeError;
}

function isTurnEndFrame(event: AgentStreamEvent, turnId: string): boolean {
  return (event.type === 'RUN_FINISHED' || event.type === 'RUN_ERROR')
    && 'runId' in event
    && event.runId === turnId;
}

export class StablehandControlClient {
  private readonly transport: StablehandTransport;

  readonly health;
  readonly config;
  readonly agents;
  readonly turns;
  readonly conversations;
  readonly sandboxSessions;
  readonly schedules;
  readonly interrupts;
  readonly events;
  readonly artifacts;
  readonly files;
  readonly workspaces;
  readonly webhooks;
  readonly budgets;
  readonly analytics;
  readonly modelGateway;
  readonly agentEvents;

  constructor(options: StablehandClientOptions = {}) {
    this.transport = new StablehandTransport(options);

    this.health = {
      get: (requestOptions: StablehandRequestOptions = {}) =>
        this.transport.request({
          method: 'GET',
          path: '/health',
          responseSchema: HealthResponseSchema,
          ...requestOptions,
        }),
    };

    this.config = {
      get: (requestOptions: StablehandRequestOptions = {}) =>
        this.transport.request({
          method: 'GET',
          path: '/config',
          responseSchema: ConfigResponseSchema,
          ...requestOptions,
        }),
    };

    this.agents = {
      list: (requestOptions: StablehandRequestOptions = {}): Promise<Agent[]> =>
        this.transport.request({
          method: 'GET',
          path: '/agents',
          responseSchema: AgentListResponseSchema,
          ...requestOptions,
        }),
      get: (agentId: string, requestOptions: StablehandRequestOptions = {}): Promise<Agent> =>
        this.transport.request({
          method: 'GET',
          path: `/agents/${segment(agentId, 'agentId')}`,
          responseSchema: AgentSchema,
          ...requestOptions,
        }),
      create: (input: AgentCreateInput, requestOptions: StablehandRequestOptions = {}): Promise<Agent> =>
        this.transport.request({
          method: 'POST',
          path: '/agents',
          requestSchema: AgentCreateInputSchema,
          responseSchema: AgentSchema,
          json: input,
          ...requestOptions,
        }),
      update: (
        agentId: string,
        input: AgentPatchInput,
        requestOptions: StablehandRequestOptions = {},
      ): Promise<Agent> =>
        this.transport.request({
          method: 'PATCH',
          path: `/agents/${segment(agentId, 'agentId')}`,
          requestSchema: AgentPatchInputSchema,
          responseSchema: AgentSchema,
          json: input,
          ...requestOptions,
        }),
      delete: (agentId: string, requestOptions: StablehandRequestOptions = {}): Promise<void> =>
        this.transport.request({
          method: 'DELETE',
          path: `/agents/${segment(agentId, 'agentId')}`,
          responseSchema: VoidResponseSchema,
          ...requestOptions,
        }),
      secrets: {
        listKeys: (agentId: string, requestOptions: StablehandRequestOptions = {}) =>
          this.transport.request({
            method: 'GET',
            path: `/agents/${segment(agentId, 'agentId')}/secrets`,
            responseSchema: SecretListResponseSchema,
            ...requestOptions,
          }),
        put: (
          agentId: string,
          input: { key: string; value: string },
          requestOptions: StablehandRequestOptions = {},
        ) =>
          this.transport.request({
            method: 'POST',
            path: `/agents/${segment(agentId, 'agentId')}/secrets`,
            requestSchema: SecretPutInputSchema,
            responseSchema: SecretPutResponseSchema,
            json: input,
            ...requestOptions,
          }),
        delete: (
          agentId: string,
          key: string,
          requestOptions: StablehandRequestOptions = {},
        ): Promise<void> =>
          this.transport.request({
            method: 'DELETE',
            path: `/agents/${segment(agentId, 'agentId')}/secrets/${segment(key, 'key')}`,
            responseSchema: VoidResponseSchema,
            ...requestOptions,
          }),
      },
    };

    this.turns = {
      startBackground: (
        agentId: string,
        input: BackgroundTurnStartInput,
        requestOptions: StablehandRequestOptions = {},
      ) =>
        this.transport.request({
          method: 'POST',
          path: `/agents/${segment(agentId, 'agentId')}/turns`,
          requestSchema: BackgroundTurnStartInputSchema,
          responseSchema: BackgroundTurnStartResponseSchema,
          json: input,
          ...requestOptions,
        }),
      startConversationTurn: (
        agentId: string,
        input: ConversationTurnStartInput,
        requestOptions: StablehandRequestOptions = {},
      ) =>
        this.transport.request({
          method: 'POST',
          path: `/agents/${segment(agentId, 'agentId')}/message`,
          requestSchema: ConversationTurnStartInputSchema,
          responseSchema: ConversationTurnStartResponseSchema,
          json: input,
          ...requestOptions,
        }),
      list: (
        agentId: string,
        requestOptions: StablehandRequestOptions = {},
      ): Promise<{ turns: Turn[] }> =>
        this.transport.request({
          method: 'GET',
          path: `/agents/${segment(agentId, 'agentId')}/turns`,
          responseSchema: TurnListResponseSchema,
          ...requestOptions,
        }),
      get: (
        agentId: string,
        turnId: string,
        requestOptions: StablehandRequestOptions = {},
      ): Promise<{ turn: Turn; messages: Message[] }> =>
        this.transport.request({
          method: 'GET',
          path: `/agents/${segment(agentId, 'agentId')}/turns/${segment(turnId, 'turnId')}`,
          responseSchema: TurnDetailResponseSchema,
          ...requestOptions,
        }),
      cancel: (
        agentId: string,
        turnId: string,
        requestOptions: StablehandRequestOptions = {},
      ) =>
        this.transport.request({
          method: 'POST',
          path: `/agents/${segment(agentId, 'agentId')}/turns/${segment(turnId, 'turnId')}/cancel`,
          responseSchema: TurnCancelResponseSchema,
          ...requestOptions,
        }),
      /**
       * Turns from every agent, newest first: all `tags` must match and
       * `status` matches any listed value. Pass `nextCursor` back as `cursor`.
       */
      search: (
        input: TurnSearchInput = {},
        requestOptions: StablehandRequestOptions = {},
      ): Promise<TurnSearchResponse> => {
        const parsed = TurnSearchInputSchema.safeParse(input);
        if (!parsed.success) {
          throw new StablehandContractError({
            direction: 'request',
            method: 'GET',
            path: '/turns',
            issues: parsed.error.issues,
          });
        }
        const search = new URLSearchParams();
        for (const [key, value] of Object.entries(parsed.data.tags ?? {})) {
          search.append('tag', `${key}:${value}`);
        }
        const statuses = parsed.data.status === undefined
          ? []
          : Array.isArray(parsed.data.status) ? parsed.data.status : [parsed.data.status];
        for (const status of statuses) search.append('status', status);
        if (parsed.data.agentId) search.set('agentId', parsed.data.agentId);
        if (parsed.data.limit !== undefined) search.set('limit', String(parsed.data.limit));
        if (parsed.data.cursor) search.set('cursor', parsed.data.cursor);
        const suffix = search.toString();
        return this.transport.request({
          method: 'GET',
          path: suffix ? `/turns?${suffix}` : '/turns',
          responseSchema: TurnSearchResponseSchema,
          ...requestOptions,
        });
      },
      /** One turn by id, without knowing its agent. */
      lookup: (
        turnId: string,
        requestOptions: StablehandRequestOptions = {},
      ): Promise<{ turn: Turn }> =>
        this.transport.request({
          method: 'GET',
          path: `/turns/${segment(turnId, 'turnId')}`,
          responseSchema: TurnLookupResponseSchema,
          ...requestOptions,
        }),
    };

    this.conversations = {
      list: (
        agentId: string,
        requestOptions: StablehandRequestOptions = {},
      ): Promise<Conversation[]> =>
        this.transport.request({
          method: 'GET',
          path: `/agents/${segment(agentId, 'agentId')}/conversations`,
          responseSchema: ConversationListResponseSchema,
          ...requestOptions,
        }),
      summaries: (
        agentId: string,
        requestOptions: StablehandRequestOptions = {},
      ): Promise<{ conversations: ConversationSummary[] }> =>
        this.transport.request({
          method: 'GET',
          path: `/agents/${segment(agentId, 'agentId')}/conversations/summary`,
          responseSchema: ConversationSummaryListResponseSchema,
          ...requestOptions,
        }),
      snapshot: (
        agentId: string,
        conversationId: string,
        requestOptions: StablehandRequestOptions = {},
      ): Promise<ConversationSnapshot> =>
        this.transport.request({
          method: 'GET',
          path: `/agents/${segment(agentId, 'agentId')}/conversations/${segment(conversationId, 'conversationId')}/snapshot`,
          responseSchema: ConversationSnapshotResponseSchema,
          ...requestOptions,
        }),
    };

    this.sandboxSessions = {
      list: (
        input: { status?: 'active' } = {},
        requestOptions: StablehandRequestOptions = {},
      ): Promise<SandboxSession[]> =>
        this.transport.request({
          method: 'GET',
          path: queryPath('/sandbox-sessions', { status: input.status }),
          responseSchema: SandboxSessionListResponseSchema,
          ...requestOptions,
        }),
      suspend: (
        agentId: string,
        sandboxSessionId: string,
        requestOptions: StablehandRequestOptions = {},
      ) =>
        this.transport.request({
          method: 'POST',
          path: `/agents/${segment(agentId, 'agentId')}/sandbox-sessions/${segment(sandboxSessionId, 'sandboxSessionId')}/suspend`,
          responseSchema: SandboxSessionActionResponseSchema,
          ...requestOptions,
        }),
      restore: (
        agentId: string,
        sandboxSessionId: string,
        requestOptions: StablehandRequestOptions & { background?: boolean } = {},
      ) => {
        const { background, ...rest } = requestOptions;
        return this.transport.request({
          method: 'POST',
          path: queryPath(
            `/agents/${segment(agentId, 'agentId')}/sandbox-sessions/${segment(sandboxSessionId, 'sandboxSessionId')}/restore`,
            { async: background ? 'true' : undefined },
          ),
          responseSchema: SandboxSessionActionResponseSchema,
          ...rest,
        });
      },
      kill: (
        agentId: string,
        sandboxSessionId: string,
        requestOptions: StablehandRequestOptions = {},
      ): Promise<void> =>
        this.transport.request({
          method: 'POST',
          path: `/agents/${segment(agentId, 'agentId')}/sandbox-sessions/${segment(sandboxSessionId, 'sandboxSessionId')}/kill`,
          responseSchema: VoidResponseSchema,
          ...requestOptions,
        }),
    };

    this.schedules = {
      list: (requestOptions: StablehandRequestOptions = {}): Promise<{ schedules: Schedule[] }> =>
        this.transport.request({
          method: 'GET',
          path: '/schedules',
          responseSchema: ScheduleListResponseSchema,
          ...requestOptions,
        }),
      get: (
        scheduleId: string,
        requestOptions: StablehandRequestOptions = {},
      ): Promise<Schedule> =>
        this.transport.request({
          method: 'GET',
          path: `/schedules/${segment(scheduleId, 'scheduleId')}`,
          responseSchema: ScheduleSchema,
          ...requestOptions,
        }),
      create: (
        input: ScheduleCreateInput,
        requestOptions: StablehandRequestOptions = {},
      ): Promise<Schedule> =>
        this.transport.request({
          method: 'POST',
          path: '/schedules',
          requestSchema: ScheduleCreateInputSchema,
          responseSchema: ScheduleSchema,
          json: input,
          ...requestOptions,
        }),
      update: (
        scheduleId: string,
        input: SchedulePatchInput,
        requestOptions: StablehandRequestOptions = {},
      ): Promise<Schedule> =>
        this.transport.request({
          method: 'PATCH',
          path: `/schedules/${segment(scheduleId, 'scheduleId')}`,
          requestSchema: SchedulePatchInputSchema,
          responseSchema: ScheduleSchema,
          json: input,
          ...requestOptions,
        }),
      delete: (
        scheduleId: string,
        requestOptions: StablehandRequestOptions = {},
      ): Promise<void> =>
        this.transport.request({
          method: 'DELETE',
          path: `/schedules/${segment(scheduleId, 'scheduleId')}`,
          responseSchema: VoidResponseSchema,
          ...requestOptions,
        }),
      /** Emit the schedule's event once now; returns the schedule with its new last fire. */
      fire: (
        scheduleId: string,
        requestOptions: StablehandRequestOptions = {},
      ): Promise<Schedule> =>
        this.transport.request({
          method: 'POST',
          path: `/schedules/${segment(scheduleId, 'scheduleId')}/fire`,
          responseSchema: ScheduleSchema,
          ...requestOptions,
        }),
    };

    this.interrupts = {
      listAll: (
        input: InterruptRecordListInput = {},
        requestOptions: StablehandRequestOptions = {},
      ): Promise<{ interrupts: InterruptRecord[]; nextBefore?: number }> => {
        const parsed = InterruptRecordListInputSchema.safeParse(input);
        if (!parsed.success) {
          throw new StablehandContractError({
            direction: 'request',
            method: 'GET',
            path: '/interrupts',
            issues: parsed.error.issues,
          });
        }
        return this.transport.request({
          method: 'GET',
          path: queryPath('/interrupts', {
            status: parsed.data.status,
            agentId: parsed.data.agentId,
            limit: parsed.data.limit?.toString(),
            before: parsed.data.before?.toString(),
          }),
          responseSchema: InterruptRecordListResponseSchema,
          ...requestOptions,
        });
      },
      list: (
        agentId: string,
        input: { includeResolved?: boolean } = {},
        requestOptions: StablehandRequestOptions = {},
      ): Promise<{ interrupts: Interrupt[] }> =>
        this.transport.request({
          method: 'GET',
          path: queryPath(
            `/agents/${segment(agentId, 'agentId')}/interrupts`,
            { includeResolved: input.includeResolved ? 'true' : undefined },
          ),
          responseSchema: InterruptListResponseSchema,
          ...requestOptions,
        }),
      /**
       * One interrupt, including who resolved it, why, and the `data` sent
       * with the resolution.
       */
      get: (
        interruptId: string,
        requestOptions: StablehandRequestOptions = {},
      ): Promise<InterruptRecordDetail> =>
        this.transport.request({
          method: 'GET',
          path: `/interrupts/${segment(interruptId, 'interruptId')}`,
          responseSchema: InterruptRecordDetailSchema,
          ...requestOptions,
        }),
      resolve: (
        agentId: string,
        input: InterruptResolveInput,
        requestOptions: StablehandRequestOptions = {},
      ) =>
        this.transport.request({
          method: 'POST',
          path: `/agents/${segment(agentId, 'agentId')}/interrupt`,
          requestSchema: InterruptResolveInputSchema,
          responseSchema: InterruptResolveResponseSchema,
          json: input,
          ...requestOptions,
        }),
    };

    this.events = {
      list: (
        input: EventListInput = {},
        requestOptions: StablehandRequestOptions = {},
      ): Promise<EventListResponse> => {
        const parsed = EventListInputSchema.safeParse(input);
        if (!parsed.success) {
          throw new StablehandContractError({
            direction: 'request',
            method: 'GET',
            path: '/events',
            issues: parsed.error.issues,
          });
        }
        return this.transport.request({
          method: 'GET',
          path: queryPath('/events', {
            cursor: parsed.data.cursor?.toString(),
            limit: parsed.data.limit?.toString(),
            type: parsed.data.type,
            agentId: parsed.data.agentId,
            turnId: parsed.data.turnId,
            conversationId: parsed.data.conversationId,
            since: parsed.data.since?.toString(),
          }),
          responseSchema: EventListResponseSchema,
          ...requestOptions,
        });
      },
      emitCustom: (
        input: CustomEventEmitInput,
        requestOptions: StablehandRequestOptions = {},
      ) => this.transport.request({
        method: 'POST',
        path: '/triggers/emit',
        requestSchema: CustomEventEmitInputSchema,
        responseSchema: CustomEventEmitResponseSchema,
        json: input,
        ...requestOptions,
      }),
    };

    this.artifacts = {
      list: (
        input: {
          agentId?: string;
          turnId?: string;
          limit?: number;
          offset?: number;
          search?: string;
        } = {},
        requestOptions: StablehandRequestOptions = {},
      ): Promise<{ artifacts: Artifact[]; total?: number }> =>
        this.transport.request({
          method: 'GET',
          path: queryPath('/artifacts', {
            agentId: input.agentId,
            turnId: input.turnId,
            limit: input.limit?.toString(),
            offset: input.offset?.toString(),
            search: input.search,
          }),
          responseSchema: ArtifactListResponseSchema,
          ...requestOptions,
        }),
      get: (
        artifactId: string,
        requestOptions: StablehandRequestOptions = {},
      ): Promise<Artifact> =>
        this.transport.request({
          method: 'GET',
          path: `/artifacts/${segment(artifactId, 'artifactId')}`,
          responseSchema: ArtifactSchema,
          ...requestOptions,
        }),
      requestUploadUrl: (
        input: ArtifactUploadUrlInput,
        requestOptions: StablehandRequestOptions = {},
      ) =>
        this.transport.request({
          method: 'POST',
          path: '/artifacts/upload-url',
          requestSchema: ArtifactUploadUrlInputSchema,
          responseSchema: ArtifactUploadUrlResponseSchema,
          json: input,
          ...requestOptions,
        }),
      downloadUrl: (
        artifactId: string,
        expiresInSec?: number,
        requestOptions: StablehandRequestOptions = {},
      ) =>
        this.transport.request({
          method: 'GET',
          path: queryPath(
            `/artifacts/${segment(artifactId, 'artifactId')}/download-url`,
            { expiresInSec: expiresInSec?.toString() },
          ),
          responseSchema: ArtifactDownloadUrlResponseSchema,
          ...requestOptions,
        }),
      delete: (
        artifactId: string,
        requestOptions: StablehandRequestOptions = {},
      ) =>
        this.transport.request({
          method: 'DELETE',
          path: `/artifacts/${segment(artifactId, 'artifactId')}`,
          // ctx-iqzy: DELETE returns 204 No Content.
          responseSchema: VoidResponseSchema,
          ...requestOptions,
        }),
    };

    this.files = {
      list: (
        agentId: string,
        input: { path?: string; conversationId?: string } = {},
        requestOptions: StablehandRequestOptions = {},
      ) =>
        this.transport.request({
          method: 'GET',
          path: queryPath(`/agents/${segment(agentId, 'agentId')}/files`, input),
          responseSchema: FileListResponseSchema,
          ...requestOptions,
        }),
      read: (
        agentId: string,
        input: { path: string; conversationId?: string },
        requestOptions: StablehandRequestOptions = {},
      ) =>
        this.transport.request({
          method: 'GET',
          path: queryPath(`/agents/${segment(agentId, 'agentId')}/files/read`, input),
          responseSchema: FileReadResponseSchema,
          ...requestOptions,
        }),
      create: (
        agentId: string,
        input: FileWriteInput,
        requestOptions: StablehandRequestOptions = {},
      ) => {
        const { conversationId, ...body } = input;
        return this.transport.request({
          method: 'POST',
          path: queryPath(`/agents/${segment(agentId, 'agentId')}/files`, { conversationId }),
          requestSchema: FileWriteInputSchema.omit({ conversationId: true }),
          responseSchema: FileWriteResponseSchema,
          json: body,
          ...requestOptions,
        });
      },
      update: (
        agentId: string,
        input: FileWriteInput,
        requestOptions: StablehandRequestOptions = {},
      ) => {
        const { conversationId, ...body } = input;
        return this.transport.request({
          method: 'PUT',
          path: queryPath(`/agents/${segment(agentId, 'agentId')}/files`, { conversationId }),
          requestSchema: FileWriteInputSchema.omit({ conversationId: true }),
          responseSchema: FileWriteResponseSchema,
          json: body,
          ...requestOptions,
        });
      },
      delete: (
        agentId: string,
        input: { path: string; conversationId?: string },
        requestOptions: StablehandRequestOptions = {},
      ): Promise<void> =>
        this.transport.request({
          method: 'DELETE',
          path: queryPath(`/agents/${segment(agentId, 'agentId')}/files`, input),
          responseSchema: VoidResponseSchema,
          ...requestOptions,
        }),
    };

    this.workspaces = {
      replace: (
        agentId: string,
        tarGzip: BodyInit,
        requestOptions: StablehandRequestOptions = {},
      ) =>
        this.transport.request({
          method: 'POST',
          path: `/agents/${segment(agentId, 'agentId')}/workspace`,
          rawBody: tarGzip,
          headers: { 'Content-Type': 'application/gzip' },
          responseSchema: WorkspaceReplaceResponseSchema,
          ...requestOptions,
        }),
      getRevision: (
        agentId: string,
        requestOptions: StablehandRequestOptions = {},
      ) =>
        this.transport.request({
          method: 'GET',
          path: `/agents/${segment(agentId, 'agentId')}/workspace`,
          responseSchema: WorkspaceRevisionResponseSchema,
          ...requestOptions,
        }),
    };

    this.webhooks = {
      list: (
        agentId: string,
        requestOptions: StablehandRequestOptions = {},
      ): Promise<Webhook[]> =>
        this.transport.request({
          method: 'GET',
          path: `/agents/${segment(agentId, 'agentId')}/webhooks`,
          responseSchema: WebhookListResponseSchema,
          ...requestOptions,
        }),
      create: (
        agentId: string,
        input: WebhookCreateInput,
        requestOptions: StablehandRequestOptions = {},
      ): Promise<Webhook> =>
        this.transport.request({
          method: 'POST',
          path: `/agents/${segment(agentId, 'agentId')}/webhooks`,
          requestSchema: WebhookCreateInputSchema,
          responseSchema: WebhookSchema,
          json: input,
          ...requestOptions,
        }),
      update: (
        agentId: string,
        webhookId: string,
        input: WebhookPatchInput,
        requestOptions: StablehandRequestOptions = {},
      ): Promise<Webhook> =>
        this.transport.request({
          method: 'PATCH',
          path: `/agents/${segment(agentId, 'agentId')}/webhooks/${segment(webhookId, 'webhookId')}`,
          requestSchema: WebhookPatchInputSchema,
          responseSchema: WebhookSchema,
          json: input,
          ...requestOptions,
        }),
      delete: (
        agentId: string,
        webhookId: string,
        requestOptions: StablehandRequestOptions = {},
      ): Promise<void> =>
        this.transport.request({
          method: 'DELETE',
          path: `/agents/${segment(agentId, 'agentId')}/webhooks/${segment(webhookId, 'webhookId')}`,
          responseSchema: VoidResponseSchema,
          ...requestOptions,
        }),
    };

    this.budgets = {
      list: (requestOptions: StablehandRequestOptions = {}): Promise<{
        policies: BudgetPolicy[];
      }> =>
        this.transport.request({
          method: 'GET',
          path: '/budgets',
          responseSchema: BudgetPolicyListResponseSchema,
          ...requestOptions,
        }),
      get: (
        policyId: string,
        requestOptions: StablehandRequestOptions = {},
      ): Promise<BudgetPolicy> =>
        this.transport.request({
          method: 'GET',
          path: `/budgets/${segment(policyId, 'policyId')}`,
          responseSchema: BudgetPolicySchema,
          ...requestOptions,
        }),
      create: (
        input: BudgetPolicyCreateInput,
        requestOptions: StablehandRequestOptions = {},
      ): Promise<BudgetPolicy> =>
        this.transport.request({
          method: 'POST',
          path: '/budgets',
          requestSchema: BudgetPolicyCreateInputSchema,
          responseSchema: BudgetPolicySchema,
          json: input,
          ...requestOptions,
        }),
      update: (
        policyId: string,
        input: BudgetPolicyPatchInput,
        requestOptions: StablehandRequestOptions = {},
      ): Promise<BudgetPolicy> =>
        this.transport.request({
          method: 'PATCH',
          path: `/budgets/${segment(policyId, 'policyId')}`,
          requestSchema: BudgetPolicyPatchInputSchema,
          responseSchema: BudgetPolicySchema,
          json: input,
          ...requestOptions,
        }),
      delete: (
        policyId: string,
        requestOptions: StablehandRequestOptions = {},
      ): Promise<void> =>
        this.transport.request({
          method: 'DELETE',
          path: `/budgets/${segment(policyId, 'policyId')}`,
          responseSchema: VoidResponseSchema,
          ...requestOptions,
        }),
      spend: (
        policyId: string,
        requestOptions: StablehandRequestOptions = {},
      ): Promise<BudgetSpendResponse> =>
        this.transport.request({
          method: 'GET',
          path: `/budgets/${segment(policyId, 'policyId')}/spend`,
          responseSchema: BudgetSpendResponseSchema,
          ...requestOptions,
        }),
      agentStatuses: (requestOptions: StablehandRequestOptions = {}) =>
        this.transport.request({
          method: 'GET',
          path: '/budgets/agents/status',
          responseSchema: AgentBudgetStatusListResponseSchema,
          ...requestOptions,
        }),
    };

    this.analytics = {
      overview: (
        input: { window?: AnalyticsWindow } = {},
        requestOptions: StablehandRequestOptions = {},
      ): Promise<AnalyticsOverview> => {
        const window = AnalyticsWindowSchema.safeParse(input.window);
        if (input.window !== undefined && !window.success) {
          throw new StablehandContractError({
            direction: 'request',
            method: 'GET',
            path: '/analytics/overview',
            issues: window.error.issues,
          });
        }
        return this.transport.request({
          method: 'GET',
          path: queryPath('/analytics/overview', {
            window: input.window,
          }),
          responseSchema: AnalyticsOverviewSchema,
          ...requestOptions,
        });
      },
    };

    this.modelGateway = {
      status: (requestOptions: StablehandRequestOptions = {}) =>
        this.transport.request({
          method: 'GET',
          path: '/model-gateway/status',
          responseSchema: ModelGatewayStatusSchema,
          ...requestOptions,
        }),
    };

    this.agentEvents = {
      stream: (input: AgentEventStreamInput): AsyncGenerator<AgentEventStreamItem> =>
        this.streamAgentEvents(input),
    };
  }

  /**
   * Resolve with the turn once it has finished (COMPLETED, ERROR or
   * CANCELLED); check `turn.status` for the outcome. Checks the turn with a
   * growing delay and, unless `useStream` is false, also listens on the
   * agent's event stream to return as soon as the turn ends. Brief outages
   * (network errors, 5xx, 429) are retried until the timeout; a missing turn
   * or a refused key fails at once.
   */
  async waitForTurn(turnId: string, options: WaitForTurnOptions = {}): Promise<Turn> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
    const maxPollIntervalMs = options.maxPollIntervalMs ?? DEFAULT_MAX_POLL_INTERVAL_MS;
    let delayMs = Math.min(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS, maxPollIntervalMs);
    const deadline = Date.now() + timeoutMs;
    const timedOut = () => new StablehandTimeoutError(
      timeoutMs,
      `Turn ${turnId} did not finish within ${timeoutMs}ms`,
    );

    const controller = new AbortController();
    const onCallerAbort = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) throw options.signal.reason;
    options.signal?.addEventListener('abort', onCallerAbort, { once: true });

    // The stream only shortens the wait; `ended` covers a frame that lands
    // while a check is in flight.
    let ended = false;
    let wake: (() => void) | undefined;
    const onTurnEnded = () => {
      ended = true;
      wake?.();
    };
    let streaming = false;

    try {
      for (;;) {
        controller.signal.throwIfAborted();
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw timedOut();

        let turn: Turn | undefined;
        try {
          ({ turn } = await this.turns.lookup(turnId, {
            signal: controller.signal,
            // Keep the client's own per-request timeout unless the wait ends sooner.
            ...(remaining < DEFAULT_LOOKUP_TIMEOUT_MS ? { timeoutMs: remaining } : {}),
          }));
        } catch (error) {
          if (controller.signal.aborted || !isTransientWaitError(error)) throw error;
        }
        if (turn && TERMINAL_TURN_STATUSES.has(turn.status)) return turn;

        if (turn && options.useStream !== false && !streaming) {
          streaming = true;
          void this.watchForTurnEnd(turn.agentId, turnId, controller.signal, onTurnEnded);
        }

        const sleepMs = Math.min(delayMs, deadline - Date.now());
        if (sleepMs <= 0) throw timedOut();
        if (!ended) {
          await new Promise<void>((resolve, reject) => {
            const finish = () => {
              clearTimeout(timer);
              controller.signal.removeEventListener('abort', onAbort);
              wake = undefined;
              resolve();
            };
            const onAbort = () => {
              clearTimeout(timer);
              wake = undefined;
              reject(controller.signal.reason);
            };
            const timer = setTimeout(finish, sleepMs);
            wake = finish;
            controller.signal.addEventListener('abort', onAbort, { once: true });
          });
        }
        ended = false;
        delayMs = Math.min(delayMs * POLL_BACKOFF, maxPollIntervalMs);
      }
    } finally {
      options.signal?.removeEventListener('abort', onCallerAbort);
      // Closes the event stream, if one was opened.
      controller.abort();
    }
  }

  private async watchForTurnEnd(
    agentId: string,
    turnId: string,
    signal: AbortSignal,
    onTurnEnded: () => void,
  ): Promise<void> {
    try {
      for await (const item of this.streamAgentEvents({ agentId, signal })) {
        if (item.event && isTurnEndFrame(item.event, turnId)) onTurnEnded();
      }
    } catch {
      // The stream only wakes the wait early; the checks carry on without it.
      return;
    }
  }

  private async *streamAgentEvents(
    input: AgentEventStreamInput,
  ): AsyncGenerator<AgentEventStreamItem> {
    const stream = await this.transport.openStream({
      method: 'GET',
      path: queryPath(
        `/agents/${segment(input.agentId, 'agentId')}/stream`,
        { cursor: streamCursor(input.cursor) },
      ),
      headers: input.lastEventId ? { 'Last-Event-ID': input.lastEventId } : undefined,
      signal: input.signal,
      timeoutMs: input.timeoutMs,
    });

    try {
      for await (const frame of parseServerSentEvents(stream.body)) {
        if (frame.data === null) {
          if (frame.comment !== null) {
            yield { id: frame.id, event: null, heartbeat: frame.comment };
          }
          continue;
        }

        let raw: unknown;
        try {
          raw = JSON.parse(frame.data) as unknown;
        } catch {
          throw new StablehandContractError({
            direction: 'stream',
            method: 'GET',
            path: `/agents/${segment(input.agentId, 'agentId')}/stream`,
            issues: [{
              code: 'custom',
              path: [],
              message: 'SSE data is not valid JSON',
              input: frame.data,
            }],
          });
        }
        const parsed = AgentStreamEventSchema.safeParse(raw);
        if (!parsed.success) {
          throw new StablehandContractError({
            direction: 'stream',
            method: 'GET',
            path: `/agents/${segment(input.agentId, 'agentId')}/stream`,
            issues: parsed.error.issues,
          });
        }
        yield { id: frame.id, event: parsed.data };
      }
    } finally {
      await stream.close();
    }
  }
}

export function createStablehandControlClient(
  options?: StablehandClientOptions,
): StablehandControlClient {
  return new StablehandControlClient(options);
}
