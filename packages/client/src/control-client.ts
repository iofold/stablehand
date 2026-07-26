import {
  AgentCreateInputSchema,
  ArtifactDeleteResponseSchema,
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
  EventCursorSchema,
  FileListResponseSchema,
  FileReadResponseSchema,
  FileWriteInputSchema,
  FileWriteResponseSchema,
  HealthResponseSchema,
  InterruptListResponseSchema,
  InterruptRecordListInputSchema,
  InterruptRecordListResponseSchema,
  InterruptResolveInputSchema,
  InterruptResolveResponseSchema,
  ModelGatewayStatusSchema,
  SandboxSessionActionResponseSchema,
  SandboxSessionListResponseSchema,
  SecretListResponseSchema,
  SecretPutInputSchema,
  SecretPutResponseSchema,
  TurnCancelResponseSchema,
  TurnDetailResponseSchema,
  TurnListResponseSchema,
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
  type FileWriteInput,
  type Interrupt,
  type InterruptRecord,
  type InterruptRecordListInput,
  type InterruptResolveInput,
  type Message,
  type SandboxSession,
  type Turn,
  type Webhook,
  type WebhookCreateInput,
  type WebhookPatchInput,
} from '@ctxmill/contracts';
import { z } from 'zod';

import { CtxmillContractError } from './errors.js';
import { parseServerSentEvents } from './sse.js';
import {
  CtxmillTransport,
  type CtxmillClientOptions,
  type CtxmillRequestOptions,
} from './transport.js';

const VoidResponseSchema = z.undefined();

function segment(value: string, name: string): string {
  const parsed = z.string().trim().min(1).safeParse(value);
  if (!parsed.success) {
    throw new CtxmillContractError({
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
    throw new CtxmillContractError({
      direction: 'request',
      method: 'GET',
      path: 'cursor',
      issues: parsed.error.issues,
    });
  }
  return parsed.data;
}

export interface AgentEventStreamInput extends CtxmillRequestOptions {
  agentId: string;
  /** Initial replay boundary obtained from conversations.snapshot(). */
  cursor?: string;
  /** Browser/native SSE reconnect acknowledgement. */
  lastEventId?: string;
}

export type AgentEventStreamItem =
  | { id: string | null; event: AgentStreamEvent }
  | { id: string | null; event: null; heartbeat: string };

export class CtxmillControlClient {
  private readonly transport: CtxmillTransport;

  readonly health;
  readonly config;
  readonly agents;
  readonly turns;
  readonly conversations;
  readonly sandboxSessions;
  readonly interrupts;
  readonly artifacts;
  readonly files;
  readonly workspaces;
  readonly webhooks;
  readonly budgets;
  readonly analytics;
  readonly modelGateway;
  readonly agentEvents;

  constructor(options: CtxmillClientOptions = {}) {
    this.transport = new CtxmillTransport(options);

    this.health = {
      get: (requestOptions: CtxmillRequestOptions = {}) =>
        this.transport.request({
          method: 'GET',
          path: '/health',
          responseSchema: HealthResponseSchema,
          ...requestOptions,
        }),
    };

    this.config = {
      get: (requestOptions: CtxmillRequestOptions = {}) =>
        this.transport.request({
          method: 'GET',
          path: '/config',
          responseSchema: ConfigResponseSchema,
          ...requestOptions,
        }),
    };

    this.agents = {
      list: (requestOptions: CtxmillRequestOptions = {}): Promise<Agent[]> =>
        this.transport.request({
          method: 'GET',
          path: '/agents',
          responseSchema: AgentListResponseSchema,
          ...requestOptions,
        }),
      get: (agentId: string, requestOptions: CtxmillRequestOptions = {}): Promise<Agent> =>
        this.transport.request({
          method: 'GET',
          path: `/agents/${segment(agentId, 'agentId')}`,
          responseSchema: AgentSchema,
          ...requestOptions,
        }),
      create: (input: AgentCreateInput, requestOptions: CtxmillRequestOptions = {}): Promise<Agent> =>
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
        requestOptions: CtxmillRequestOptions = {},
      ): Promise<Agent> =>
        this.transport.request({
          method: 'PATCH',
          path: `/agents/${segment(agentId, 'agentId')}`,
          requestSchema: AgentPatchInputSchema,
          responseSchema: AgentSchema,
          json: input,
          ...requestOptions,
        }),
      delete: (agentId: string, requestOptions: CtxmillRequestOptions = {}): Promise<void> =>
        this.transport.request({
          method: 'DELETE',
          path: `/agents/${segment(agentId, 'agentId')}`,
          responseSchema: VoidResponseSchema,
          ...requestOptions,
        }),
      secrets: {
        listKeys: (agentId: string, requestOptions: CtxmillRequestOptions = {}) =>
          this.transport.request({
            method: 'GET',
            path: `/agents/${segment(agentId, 'agentId')}/secrets`,
            responseSchema: SecretListResponseSchema,
            ...requestOptions,
          }),
        put: (
          agentId: string,
          input: { key: string; value: string },
          requestOptions: CtxmillRequestOptions = {},
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
          requestOptions: CtxmillRequestOptions = {},
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
        requestOptions: CtxmillRequestOptions = {},
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
        requestOptions: CtxmillRequestOptions = {},
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
        requestOptions: CtxmillRequestOptions = {},
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
        requestOptions: CtxmillRequestOptions = {},
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
        requestOptions: CtxmillRequestOptions = {},
      ) =>
        this.transport.request({
          method: 'POST',
          path: `/agents/${segment(agentId, 'agentId')}/turns/${segment(turnId, 'turnId')}/cancel`,
          responseSchema: TurnCancelResponseSchema,
          ...requestOptions,
        }),
    };

    this.conversations = {
      list: (
        agentId: string,
        requestOptions: CtxmillRequestOptions = {},
      ): Promise<Conversation[]> =>
        this.transport.request({
          method: 'GET',
          path: `/agents/${segment(agentId, 'agentId')}/conversations`,
          responseSchema: ConversationListResponseSchema,
          ...requestOptions,
        }),
      summaries: (
        agentId: string,
        requestOptions: CtxmillRequestOptions = {},
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
        requestOptions: CtxmillRequestOptions = {},
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
        requestOptions: CtxmillRequestOptions = {},
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
        requestOptions: CtxmillRequestOptions = {},
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
        requestOptions: CtxmillRequestOptions & { background?: boolean } = {},
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
        requestOptions: CtxmillRequestOptions = {},
      ): Promise<void> =>
        this.transport.request({
          method: 'POST',
          path: `/agents/${segment(agentId, 'agentId')}/sandbox-sessions/${segment(sandboxSessionId, 'sandboxSessionId')}/kill`,
          responseSchema: VoidResponseSchema,
          ...requestOptions,
        }),
    };

    this.interrupts = {
      listAll: (
        input: InterruptRecordListInput = {},
        requestOptions: CtxmillRequestOptions = {},
      ): Promise<{ interrupts: InterruptRecord[]; nextBefore?: number }> => {
        const parsed = InterruptRecordListInputSchema.safeParse(input);
        if (!parsed.success) {
          throw new CtxmillContractError({
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
        requestOptions: CtxmillRequestOptions = {},
      ): Promise<{ interrupts: Interrupt[] }> =>
        this.transport.request({
          method: 'GET',
          path: queryPath(
            `/agents/${segment(agentId, 'agentId')}/interrupts`,
            { include_resolved: input.includeResolved ? 'true' : undefined },
          ),
          responseSchema: InterruptListResponseSchema,
          ...requestOptions,
        }),
      resolve: (
        agentId: string,
        input: InterruptResolveInput,
        requestOptions: CtxmillRequestOptions = {},
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

    this.artifacts = {
      list: (
        input: {
          agentId?: string;
          turnId?: string;
          limit?: number;
          offset?: number;
          search?: string;
        } = {},
        requestOptions: CtxmillRequestOptions = {},
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
        requestOptions: CtxmillRequestOptions = {},
      ): Promise<Artifact> =>
        this.transport.request({
          method: 'GET',
          path: `/artifacts/${segment(artifactId, 'artifactId')}`,
          responseSchema: ArtifactSchema,
          ...requestOptions,
        }),
      requestUploadUrl: (
        input: ArtifactUploadUrlInput,
        requestOptions: CtxmillRequestOptions = {},
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
        expiresIn?: number,
        requestOptions: CtxmillRequestOptions = {},
      ) =>
        this.transport.request({
          method: 'GET',
          path: queryPath(
            `/artifacts/${segment(artifactId, 'artifactId')}/download-url`,
            { expiresIn: expiresIn?.toString() },
          ),
          responseSchema: ArtifactDownloadUrlResponseSchema,
          ...requestOptions,
        }),
      delete: (
        artifactId: string,
        requestOptions: CtxmillRequestOptions = {},
      ) =>
        this.transport.request({
          method: 'DELETE',
          path: `/artifacts/${segment(artifactId, 'artifactId')}`,
          responseSchema: ArtifactDeleteResponseSchema,
          ...requestOptions,
        }),
    };

    this.files = {
      list: (
        agentId: string,
        input: { path?: string; conversationId?: string } = {},
        requestOptions: CtxmillRequestOptions = {},
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
        requestOptions: CtxmillRequestOptions = {},
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
        requestOptions: CtxmillRequestOptions = {},
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
        requestOptions: CtxmillRequestOptions = {},
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
        requestOptions: CtxmillRequestOptions = {},
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
        requestOptions: CtxmillRequestOptions = {},
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
        requestOptions: CtxmillRequestOptions = {},
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
        requestOptions: CtxmillRequestOptions = {},
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
        requestOptions: CtxmillRequestOptions = {},
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
        requestOptions: CtxmillRequestOptions = {},
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
        requestOptions: CtxmillRequestOptions = {},
      ): Promise<void> =>
        this.transport.request({
          method: 'DELETE',
          path: `/agents/${segment(agentId, 'agentId')}/webhooks/${segment(webhookId, 'webhookId')}`,
          responseSchema: VoidResponseSchema,
          ...requestOptions,
        }),
    };

    this.budgets = {
      list: (requestOptions: CtxmillRequestOptions = {}): Promise<{
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
        requestOptions: CtxmillRequestOptions = {},
      ): Promise<BudgetPolicy> =>
        this.transport.request({
          method: 'GET',
          path: `/budgets/${segment(policyId, 'policyId')}`,
          responseSchema: BudgetPolicySchema,
          ...requestOptions,
        }),
      create: (
        input: BudgetPolicyCreateInput,
        requestOptions: CtxmillRequestOptions = {},
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
        requestOptions: CtxmillRequestOptions = {},
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
        requestOptions: CtxmillRequestOptions = {},
      ): Promise<void> =>
        this.transport.request({
          method: 'DELETE',
          path: `/budgets/${segment(policyId, 'policyId')}`,
          responseSchema: VoidResponseSchema,
          ...requestOptions,
        }),
      spend: (
        policyId: string,
        requestOptions: CtxmillRequestOptions = {},
      ): Promise<BudgetSpendResponse> =>
        this.transport.request({
          method: 'GET',
          path: `/budgets/${segment(policyId, 'policyId')}/spend`,
          responseSchema: BudgetSpendResponseSchema,
          ...requestOptions,
        }),
      agentStatuses: (requestOptions: CtxmillRequestOptions = {}) =>
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
        requestOptions: CtxmillRequestOptions = {},
      ): Promise<AnalyticsOverview> => {
        const window = AnalyticsWindowSchema.safeParse(input.window);
        if (input.window !== undefined && !window.success) {
          throw new CtxmillContractError({
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
      status: (requestOptions: CtxmillRequestOptions = {}) =>
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
          throw new CtxmillContractError({
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
          throw new CtxmillContractError({
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

export function createCtxmillControlClient(
  options?: CtxmillClientOptions,
): CtxmillControlClient {
  return new CtxmillControlClient(options);
}
