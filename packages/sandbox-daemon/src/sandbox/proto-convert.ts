import { create, type JsonObject } from '@bufbuild/protobuf';
import {
  type FreshBootstrap,
  type RestoreBootstrap,
  type DeliverTurnRequest,
  type SessionEvent as ProtoSessionEvent,
  SessionEventSchema,
  type SessionCheckpoint as ProtoSessionCheckpoint,
  SessionCheckpointSchema,
  type AgentEvent as ProtoAgentEvent,
  AgentEventSchema,
  MessageCommittedSchema,
  TextDeltaSchema,
  ToolCallStartSchema,
  ToolCallEndSchema,
  ApprovalNeededSchema,
  ApprovalResolvedSchema,
  CustomAgentEventSchema,
  ErrorEventSchema as ProtoErrorEventSchema,
  DoneEventSchema as ProtoDoneEventSchema,
  TokenUsageSchema as ProtoTokenUsageSchema,
  CursorSchema,
  RunnerStateSchema,
  PendingRequestSchema,
  WorkspaceRefSchema,
  ToolCallSchema,
  type ToolMetadata as ProtoToolMetadata,
  ToolLocation,
  NativeToolPolicy as ProtoNativeToolPolicy,
  type NativeToolPolicyConfig as ProtoNativeToolPolicyConfig,
  type Message as ProtoMessage,
} from '@stablehand/proto/sandbox/v1';
import {
  NativeToolPolicySchema,
  type NativeToolPolicy,
} from '@stablehand/contracts';

import type { AgentSessionEvent } from '@stablehand/shared';
import type {
  AgentEvent,
  HarnessSessionConfig,
  HarnessRestorePoint,
  HarnessTurnInput,
  ResolvedSecrets,
} from '../harness/types.js';
import type {
  SessionEvent as CustomSessionEvent,
  AGUISessionEvent,
  MessageCommittedSessionEvent,
  TurnFailedSessionEvent,
} from '../session-event.js';
import type { ToolDefinition } from '../tool/types.js';
import type { Message } from '../types.js';
import { jsonSchemaToZod } from '../tool/schema-convert.js';
import type { SessionCheckpoint } from './checkpoint.js';
import { stringifyJsonWithBigInts, toJsonCompatibleValue } from './json-serialization.js';
import {
  createToolProxy,
  type OrchestratorServiceClient,
  type ToolCallbackRoute,
} from './tool-proxy.js';

type ProtoAgentSessionEvent = ProtoSessionEvent & {
  payload: {
    case: 'agentEvent';
    value: ProtoAgentEvent;
  };
};

type ProtoCommittedSessionEvent = ProtoSessionEvent & {
  payload: {
    case: 'messageCommitted';
    value: NonNullable<ProtoSessionEvent['payload']['value']>;
  };
};

export function protoNativeToolPolicyToInternal(
  nativeToolPolicy: ProtoNativeToolPolicyConfig | undefined,
): NativeToolPolicy | undefined {
  if (!nativeToolPolicy) {
    return undefined;
  }
  if (nativeToolPolicy.policy === ProtoNativeToolPolicy.UNSPECIFIED) {
    throw new Error('Native tool policy is unspecified');
  }

  const names = [...nativeToolPolicy.names];
  switch (nativeToolPolicy.policy) {
    case ProtoNativeToolPolicy.ALL:
      return NativeToolPolicySchema.parse(
        names.length === 0 ? { policy: 'all' } : { policy: 'all', names },
      );
    case ProtoNativeToolPolicy.ALLOW:
      return NativeToolPolicySchema.parse({ policy: 'allow', names });
    case ProtoNativeToolPolicy.DENY:
      return NativeToolPolicySchema.parse({ policy: 'deny', names });
    case ProtoNativeToolPolicy.NONE:
      return NativeToolPolicySchema.parse(
        names.length === 0 ? { policy: 'none' } : { policy: 'none', names },
      );
    default:
      throw new Error(`Unknown native tool policy value: ${nativeToolPolicy.policy}`);
  }
}

/* -------------------------------------------------------------------------- */
/*  Proto → Internal: FreshBootstrap → HarnessSessionConfig                    */
/* -------------------------------------------------------------------------- */

export function protoFreshBootstrapToSessionConfig(
  fresh: FreshBootstrap,
  tools: ToolDefinition[],
  secrets: ResolvedSecrets,
): HarnessSessionConfig {
  return {
    agentId: fresh.agentId,
    conversationId: fresh.conversationId,
    systemPrompt: fresh.systemPrompt,
    tools,
    secrets,
    workspaceDir: fresh.workspaceDir || '/workspace',
    harnessConfigJson: fresh.harnessConfigJson,
    ...(fresh.nativeToolPolicy
      ? { nativeToolPolicy: protoNativeToolPolicyToInternal(fresh.nativeToolPolicy) }
      : {}),
  };
}

/* -------------------------------------------------------------------------- */
/*  Proto → Internal: RestoreBootstrap → HarnessRestorePoint                   */
/* -------------------------------------------------------------------------- */

export function protoRestoreBootstrapToRestorePoint(
  restore: RestoreBootstrap,
): HarnessRestorePoint {
  const checkpoint = restore.sessionCheckpoint;
  if (!checkpoint) {
    throw new Error('Restore bootstrap is missing session checkpoint');
  }
  if (checkpoint.checkpointVersion === undefined) {
    throw new Error('Restore bootstrap session checkpoint is missing checkpointVersion');
  }
  const harnessState: Record<string, unknown> = checkpoint?.harnessState
    ? (checkpoint.harnessState as Record<string, unknown>)
    : {};

  // The harnessState stored in the checkpoint is the full HarnessExportedState
  // shape: { stateVersion: string, payload: { transcript: [...], ... } }.
  // Unwrap it so that HarnessRestorePoint.payload maps directly to the
  // harness's inner payload (where 'transcript' lives), not the envelope.
  const innerPayload =
    typeof harnessState.payload === 'object' && harnessState.payload !== null
      ? (harnessState.payload as Record<string, unknown>)
      : harnessState;

  const stateVersion =
    typeof harnessState.stateVersion === 'string'
      ? harnessState.stateVersion
      : String(checkpoint.checkpointVersion);

  return {
    stateVersion,
    payload: innerPayload,
    messages: [],
  };
}

/* -------------------------------------------------------------------------- */
/*  Proto → Internal: DeliverTurnRequest → HarnessTurnInput                    */
/* -------------------------------------------------------------------------- */

export function protoDeliverTurnToInput(req: DeliverTurnRequest): HarnessTurnInput {
  return {
    messages: req.messages.map(protoMessageToInternal),
    turnId: req.turnId,
  };
}

/* -------------------------------------------------------------------------- */
/*  Internal → Proto: AgentEvent → SessionEvent (agentEvent variant)           */
/* -------------------------------------------------------------------------- */

export function agentEventToSessionEvent(
  event: AgentEvent,
): ProtoAgentSessionEvent {
  const payload: ProtoAgentSessionEvent['payload'] = {
    case: 'agentEvent',
    value: convertAgentEvent(event),
  };
  const sessionEvent = create(SessionEventSchema, { payload });
  return {
    ...sessionEvent,
    payload,
  };
}

/* -------------------------------------------------------------------------- */
/*  Internal → Proto: MessageCommitted → SessionEvent                          */
/* -------------------------------------------------------------------------- */

export function messageToCommittedEvent(
  msg: Extract<AgentEvent, { type: 'message_committed' }>,
  turnId: string,
  seq: number,
): ProtoCommittedSessionEvent {
  const rawToolCalls = (msg.toolCalls ?? []) as Array<{
    id: string;
    name: string;
    arguments: unknown;
  }>;

  const payload: ProtoCommittedSessionEvent['payload'] = {
    case: 'messageCommitted',
    value: create(MessageCommittedSchema, {
      role: msg.role,
      content: msg.content,
      toolCalls: rawToolCalls.map((tc) =>
        create(ToolCallSchema, {
          id: tc.id,
          name: tc.name,
          argumentsJson: stringifyProtoJsonPayload(tc.arguments),
        }),
      ),
      toolCallId: msg.toolCallId,
      turnId,
      messageSeq: BigInt(seq),
    }),
  };
  const sessionEvent = create(SessionEventSchema, { payload });
  return {
    ...sessionEvent,
    payload,
  };
}

/* -------------------------------------------------------------------------- */
/*  Internal → Proto: SessionCheckpoint                                        */
/* -------------------------------------------------------------------------- */

export function sessionCheckpointToProto(
  checkpoint: SessionCheckpoint,
): ProtoSessionCheckpoint {
  return create(SessionCheckpointSchema, {
    checkpointVersion: checkpoint.checkpointVersion,
    sessionId: checkpoint.sessionId,
    conversationId: checkpoint.conversationId,
    harnessName: checkpoint.harnessName,
    cursor: create(CursorSchema, {
      nextMessageSeq: BigInt(checkpoint.cursor.nextMessageSeq),
      lastCompletedTurnId: checkpoint.cursor.lastCompletedTurnId,
    }),
    runnerState: create(RunnerStateSchema, {
      status: checkpoint.runnerState.status,
      pendingRequests: (checkpoint.runnerState.pendingRequests ?? []).map((pr) =>
        create(PendingRequestSchema, {
          type: pr.type,
          id: pr.id,
          payloadJson: stringifyJsonWithBigInts(pr.payload),
        }),
      ),
    }),
    workspaceRef: create(WorkspaceRefSchema, {
      strategy: checkpoint.workspaceRef.strategy,
      reference: checkpoint.workspaceRef.reference,
    }),
    harnessState: toJsonCompatibleValue(checkpoint.harnessState) as JsonObject,
  });
}

export function protoSessionCheckpointToInternal(
  proto: ProtoSessionCheckpoint,
): SessionCheckpoint {
  const pendingRequests = (proto.runnerState?.pendingRequests ?? []).map((pr) => ({
    type: pr.type === 'approval' ? 'approval' as const : 'tool_call' as const,
    id: pr.id,
    payload: parseJsonOrThrow(pr.payloadJson, `pending request ${pr.id}`),
  }));
  const harnessState = isRecord(proto.harnessState) ? proto.harnessState : {};

  return {
    checkpointVersion: 2,
    sessionId: proto.sessionId,
    conversationId: proto.conversationId,
    harnessName: proto.harnessName,
    cursor: {
      nextMessageSeq: Number(proto.cursor?.nextMessageSeq ?? 0n),
      lastCompletedTurnId: proto.cursor?.lastCompletedTurnId,
    },
    runnerState: {
      status: proto.runnerState?.status === 'WAITING_INPUT' ? 'WAITING_INPUT' : 'IDLE',
      pendingRequests: pendingRequests.length > 0 ? pendingRequests : undefined,
    },
    workspaceRef: {
      strategy: toWorkspaceStrategy(proto.workspaceRef?.strategy),
      reference: proto.workspaceRef?.reference ?? '',
    },
    harnessState: {
      stateVersion: typeof harnessState.stateVersion === 'string' ? harnessState.stateVersion : '1',
      payload: isRecord(harnessState.payload) ? harnessState.payload : {},
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  Proto → Internal: ToolMetadata[] → ToolDefinition[]                        */
/* -------------------------------------------------------------------------- */

/**
 * Options for wiring orchestrator-location tool proxies.
 *
 * When provided, orchestrator-location tools will get a real gRPC proxy handler.
 * Missing routing metadata is treated as a wiring error instead of silently
 * degrading to a placeholder stub.
 */
export interface ProtoToolDefsOptions {
  orchestratorClient?: OrchestratorServiceClient;
  callbackRoute?: ToolCallbackRoute;
  daemonHandlers?: Map<string, (input: unknown) => Promise<string>>;
}

/**
 * Convert proto `ToolMetadata` messages to internal `ToolDefinition` instances.
 *
 * - **Sandbox-location tools**: Get a reconstructed Zod schema from the JSON
 *   Schema and a no-op handler (the harness SDK handles execution).
 * - **Orchestrator-location tools**: Get a proxy handler that calls back to
 *   the orchestrator via gRPC. Missing client/routing metadata throws during
 *   tool-definition construction so miswired plumbing fails fast at startup.
 */
export function protoToToolDefs(
  tools: ProtoToolMetadata[],
  opts?: ProtoToolDefsOptions,
): ToolDefinition[] {
  return tools.map((t) => {
    const inputJsonSchema = parseJsonOrThrow(t.inputSchemaJson, `tool ${t.name} input schema`) as Record<string, unknown>;
    const zodSchema = jsonSchemaToZod(inputJsonSchema);

    const isDaemon = t.location === ToolLocation.DAEMON;
    const isOrchestrator = t.location === ToolLocation.ORCHESTRATOR;

    let handler: (input: unknown) => Promise<string>;

    if (isDaemon && opts?.daemonHandlers?.has(t.name)) {
      handler = opts.daemonHandlers.get(t.name)!;
    } else if (isDaemon) {
      throw new Error(
        `Daemon handler for "${t.name}" is not configured. Ensure artifact storage and orchestrator routing are enabled before opening the session.`,
      );
    } else if (
      isOrchestrator
      && opts?.orchestratorClient
      && opts.callbackRoute
    ) {
      handler = createToolProxy(
        t.name,
        opts.orchestratorClient,
        opts.callbackRoute,
      );
    } else if (isOrchestrator) {
      throw new Error(
        `Orchestrator proxy for "${t.name}" is not connected. Session startup requires ORCHESTRATOR_URL and routing metadata.`,
      );
    } else {
      handler = createSandboxHandler(t.name);
    }

    return {
      name: t.name,
      description: t.description,
      input: zodSchema,
      programmatic: t.programmatic,
      ...(t.requiresApproval ? { requiresApproval: true } : {}),
      handler,
    };
  });
}

/**
 * Create a handler for sandbox-location tools.
 *
 * In practice, the harness SDK manages tool execution. This handler is a
 * fallback that should not normally be called — the harness intercepts tool
 * calls and executes them directly.
 */
function createSandboxHandler(toolName: string) {
  return async (_input: unknown): Promise<string> => {
    throw new Error(
      `Sandbox handler for "${toolName}" was called directly — this should be handled by the harness SDK.`,
    );
  };
}


/* -------------------------------------------------------------------------- */
/*  Private helpers                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Convert an internal `AgentEvent` discriminated union to the proto `AgentEvent`
 * oneof message.
 */
function convertAgentEvent(event: AgentEvent): ProtoAgentEvent {
  switch (event.type) {
    case 'text_delta':
      return create(AgentEventSchema, {
        event: {
          case: 'textDelta',
          value: create(TextDeltaSchema, { content: event.content }),
        },
      });

    case 'tool_call_start':
      return create(AgentEventSchema, {
        event: {
          case: 'toolCallStart',
          value: create(ToolCallStartSchema, {
            id: event.id,
            name: event.name,
            argsJson: stringifyProtoJsonPayload(event.args),
            parentToolCallId: event.parentToolCallId,
            agentName: event.agentName,
          }),
        },
      });

    case 'tool_call_end':
      return create(AgentEventSchema, {
        event: {
          case: 'toolCallEnd',
          value: create(ToolCallEndSchema, {
            id: event.id,
            result: event.result,
            error: event.error,
            durationMs: BigInt(event.durationMs),
            parentToolCallId: event.parentToolCallId,
          }),
        },
      });

    case 'approval_needed':
      return create(AgentEventSchema, {
        event: {
          case: 'approvalNeeded',
          value: create(ApprovalNeededSchema, {
            id: event.id,
            toolName: event.tool,
            argsJson: stringifyProtoJsonPayload(event.args),
          }),
        },
      });

    case 'approval_resolved':
      return create(AgentEventSchema, {
        event: {
          case: 'approvalResolved',
          value: create(ApprovalResolvedSchema, {
            id: event.id,
            action: event.action,
          }),
        },
      });

    case 'custom_agui_event':
      return create(AgentEventSchema, {
        event: {
          case: 'custom',
          value: create(CustomAgentEventSchema, {
            subtype: typeof event.event.subtype === 'string' ? event.event.subtype : 'custom',
            payloadJson: stringifyJsonWithBigInts(event.event),
          }),
        },
      });

    case 'error':
      return create(AgentEventSchema, {
        event: {
          case: 'error',
          value: create(ProtoErrorEventSchema, {
            message: event.error,
            category: 'runtime',
            ...(event.code ? { code: event.code } : {}),
            ...(event.details ? { detailsJson: stringifyJsonWithBigInts(event.details) } : {}),
          }),
        },
      });

    case 'done':
      return create(AgentEventSchema, {
        event: {
          case: 'done',
          value: create(ProtoDoneEventSchema, {
            result: event.result,
            interrupted: false,
            ...(event.usage
              ? {
                  usage: create(ProtoTokenUsageSchema, {
                    inputTokens: BigInt(event.usage.inputTokens),
                    outputTokens: BigInt(event.usage.outputTokens),
                    totalTokens: BigInt(event.usage.totalTokens),
                    costUsd: event.usage.costUsd,
                  }),
                }
              : {}),
          }),
        },
      });

    case 'message_committed':
      return create(AgentEventSchema, { event: { case: undefined } });

    default: {
      const _exhaustive: never = event;
      return create(AgentEventSchema, {
        event: {
          case: 'error',
          value: create(ProtoErrorEventSchema, {
            message: `Unknown event type: ${(_exhaustive as AgentEvent).type}`,
            category: 'internal',
          }),
        },
      });
    }
  }
}

function protoMessageToInternal(m: ProtoMessage): Message {
  return {
    id: m.id,
    agentId: '',
    role: m.role as Message['role'],
    content: m.content,
    toolCallId: m.toolCallId,
    toolCalls:
      m.toolCalls.length > 0
        ? m.toolCalls.map((tc) => ({
            id: tc.id,
            name: tc.name,
            arguments: parseJsonOrThrow(tc.argumentsJson, `tool call ${tc.name} arguments`),
          }))
        : undefined,
    createdAt: new Date(),
  };
}

function parseJsonOrThrow(s: string, context: string): Record<string, unknown> {
  if (!s) return {};
  try {
    return JSON.parse(s);
  } catch (err) {
    throw new Error(
      `Failed to parse JSON for ${context}: ${err instanceof Error ? err.message : String(err)}. Input: ${s.slice(0, 200)}`,
      { cause: err },
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toWorkspaceStrategy(value: string | undefined): SessionCheckpoint['workspaceRef']['strategy'] {
  return value === 'tar' || value === 'git' ? value : 'none';
}

function stringifyProtoJsonPayload(value: unknown): string {
  return typeof value === 'string' ? value : stringifyJsonWithBigInts(value);
}

/**
 * Convert a proto AgentEvent (from gRPC stream) into an AgentSessionEvent for SSE broadcast.
 * This is the REVERSE of convertAgentEvent().
 */
export function protoAgentEventToAGUI(
  proto: ProtoAgentEvent,
  runId: string,
): AgentSessionEvent | null {
  const ts = Date.now();

  switch (proto.event.case) {
    case 'textDelta':
      return {
        type: 'TEXT_MESSAGE_CONTENT',
        timestamp: ts,
        runId,
        delta: proto.event.value.content,
      };

    case 'toolCallStart': {
      const v = proto.event.value;
      return {
        type: 'TOOL_CALL_START',
        timestamp: ts,
        runId,
        toolCallId: v.id,
        toolCallName: v.name,
        args: v.argsJson ? JSON.parse(v.argsJson) : {},
        ...(v.parentToolCallId !== undefined ? { parentToolCallId: v.parentToolCallId } : {}),
        ...(v.agentName !== undefined ? { agentName: v.agentName } : {}),
      };
    }

    case 'toolCallEnd': {
      const v = proto.event.value;
      return {
        type: 'TOOL_CALL_RESULT',
        timestamp: ts,
        runId,
        toolCallId: v.id,
        toolCallName: '',
        result: v.result,
        error: v.error,
        durationMs: Number(v.durationMs),
        ...(v.parentToolCallId !== undefined ? { parentToolCallId: v.parentToolCallId } : {}),
      };
    }

    case 'approvalNeeded': {
      const v = proto.event.value;
      return {
        type: 'INTERRUPT_REQUESTED',
        timestamp: ts,
        runId,
        id: v.id,
        toolCallName: v.toolName,
        args: v.argsJson ? JSON.parse(v.argsJson) : {},
      };
    }

    case 'approvalResolved': {
      const v = proto.event.value;
      return {
        type: 'CUSTOM',
        timestamp: ts,
        runId,
        subtype: 'approval_resolved',
        id: v.id,
        action: v.action,
      };
    }

    case 'custom': {
      const v = proto.event.value;
      const payload = parseJsonOrThrow(v.payloadJson, `custom agent event ${v.subtype}`);
      return {
        ...payload,
        type: 'CUSTOM',
        timestamp: ts,
        runId,
        subtype: v.subtype || (typeof payload.subtype === 'string' ? payload.subtype : 'custom'),
      };
    }

    case 'error': {
      const v = proto.event.value;
      const details = v.detailsJson
        ? parseJsonOrThrow(v.detailsJson, 'error event details')
        : undefined;
      return {
        type: 'RUN_ERROR',
        timestamp: ts,
        runId,
        error: v.message,
        ...(v.code ? { code: v.code } : {}),
        ...(details ? { details } : {}),
      };
    }

    case 'done': {
      const v = proto.event.value;
      const usage = v.usage
        ? {
            inputTokens: Number(v.usage.inputTokens),
            outputTokens: Number(v.usage.outputTokens),
            totalTokens: Number(v.usage.totalTokens),
            costUsd: v.usage.costUsd,
          }
        : undefined;

      return {
        type: 'RUN_FINISHED',
        timestamp: ts,
        runId,
        result: v.result,
        usage,
      };
    }

    default:
      return null;
  }
}

/**
 * Convert a proto SessionEvent (from gRPC DeliverTurn stream) into the custom
 * SessionEvent type consumed by SandboxRunService.
 */
export function protoSessionEventToCustom(
  proto: ProtoSessionEvent,
  turnId: string,
): CustomSessionEvent | null {
  const converted = convertProtoSessionEvent(proto, turnId);
  if (converted && proto.deliveryId) {
    converted.delivery = {
      id: proto.deliveryId,
      seq: Number(proto.deliverySeq),
    };
  }
  return converted;
}

function convertProtoSessionEvent(
  proto: ProtoSessionEvent,
  turnId: string,
): CustomSessionEvent | null {
  switch (proto.payload.case) {
    case 'agentEvent': {
      const agui = protoAgentEventToAGUI(proto.payload.value, turnId);
      if (!agui) return null;

      const event: AGUISessionEvent = {
        type: 'ag_ui_event',
        event: agui,
      };
      return event;
    }

    case 'messageCommitted': {
      const mc = proto.payload.value;
      const event: MessageCommittedSessionEvent = {
        type: 'message_committed',
        role: mc.role as 'assistant' | 'tool',
        content: mc.content,
        toolCalls: mc.toolCalls.length > 0
          ? mc.toolCalls.map((tc) => ({
              id: tc.id,
              name: tc.name,
              args: tc.argumentsJson,
              status: 'complete' as const,
            }))
          : undefined,
        toolCallId: mc.toolCallId,
        turnId: mc.turnId,
        messageSeq: Number(mc.messageSeq),
      };
      return event;
    }

    case 'turnFailed': {
      const tf = proto.payload.value;
      const event: TurnFailedSessionEvent = {
        type: 'turn_failed',
        turnId: tf.turnId || turnId,
        errorMessage: tf.errorMessage,
      };
      return event;
    }

    default:
      return null;
  }
}
