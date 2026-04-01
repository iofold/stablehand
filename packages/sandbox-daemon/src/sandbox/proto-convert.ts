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
  type Message as ProtoMessage,
} from '@ctxmill/proto/sandbox/v1';

import type { AGUIEvent } from '@ctxmill/shared';
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
} from '../session-event.js';
import type { ToolDefinition } from '../tool/types.js';
import type { Message } from '../types.js';
import { jsonSchemaToZod } from '../tool/schema-convert.js';
import { createToolProxy, type OrchestratorServiceClient } from './tool-proxy.js';

/* -------------------------------------------------------------------------- */
/*  Internal SessionCheckpoint type                                            */
/* -------------------------------------------------------------------------- */

export interface SessionCheckpoint {
  checkpointVersion: number;
  sessionId: string;
  conversationId: string;
  harnessName: string;
  cursor: {
    nextMessageSeq: number;
    lastCompletedTurnId?: string;
  };
  runnerState: {
    status: string;
    pendingRequests: Array<{
      type: string;
      id: string;
      payloadJson: string;
    }>;
  };
  workspaceRef: {
    strategy: string;
    reference: string;
  };
  harnessState: Record<string, unknown>;
}

type ProtoAGUISessionEvent = ProtoSessionEvent & {
  payload: {
    case: 'agUiEvent';
    value: ProtoAgentEvent;
  };
};

type ProtoCommittedSessionEvent = ProtoSessionEvent & {
  payload: {
    case: 'messageCommitted';
    value: NonNullable<ProtoSessionEvent['payload']['value']>;
  };
};

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

  return {
    stateVersion: String(checkpoint.checkpointVersion),
    payload: harnessState,
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
/*  Internal → Proto: AgentEvent → SessionEvent (agUiEvent variant)            */
/* -------------------------------------------------------------------------- */

export function agentEventToSessionEvent(
  event: AgentEvent,
): ProtoAGUISessionEvent {
  const payload: ProtoAGUISessionEvent['payload'] = {
    case: 'agUiEvent',
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
          argumentsJson:
            typeof tc.arguments === 'string'
              ? tc.arguments
              : JSON.stringify(tc.arguments),
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
      pendingRequests: checkpoint.runnerState.pendingRequests.map((pr) =>
        create(PendingRequestSchema, {
          type: pr.type,
          id: pr.id,
          payloadJson: pr.payloadJson,
        }),
      ),
    }),
    workspaceRef: create(WorkspaceRefSchema, {
      strategy: checkpoint.workspaceRef.strategy,
      reference: checkpoint.workspaceRef.reference,
    }),
    harnessState: sanitizeBigInts(checkpoint.harnessState) as unknown as JsonObject,
  });
}

export function protoSessionCheckpointToInternal(
  proto: ProtoSessionCheckpoint,
): SessionCheckpoint {
  return {
    checkpointVersion: proto.checkpointVersion,
    sessionId: proto.sessionId,
    conversationId: proto.conversationId,
    harnessName: proto.harnessName,
    cursor: {
      nextMessageSeq: Number(proto.cursor?.nextMessageSeq ?? 0n),
      lastCompletedTurnId: proto.cursor?.lastCompletedTurnId,
    },
    runnerState: {
      status: proto.runnerState?.status ?? 'idle',
      pendingRequests: (proto.runnerState?.pendingRequests ?? []).map((pr) => ({
        type: pr.type,
        id: pr.id,
        payloadJson: pr.payloadJson,
      })),
    },
    workspaceRef: {
      strategy: proto.workspaceRef?.strategy ?? 'none',
      reference: proto.workspaceRef?.reference ?? '',
    },
    harnessState: (proto.harnessState ?? {}) as Record<string, unknown>,
  };
}

/* -------------------------------------------------------------------------- */
/*  Proto → Internal: ToolMetadata[] → ToolDefinition[]                        */
/* -------------------------------------------------------------------------- */

/**
 * Options for wiring orchestrator-location tool proxies.
 *
 * When provided, orchestrator-location tools will get a real gRPC proxy handler
 * instead of the placeholder stub. If not provided (e.g., in tests), the
 * placeholder handler is used as a fallback.
 */
export interface ProtoToolDefsOptions {
  orchestratorClient?: OrchestratorServiceClient;
  sessionId?: string;
  sessionIdRef?: { current: string };
  agentId?: string;
  daemonHandlers?: Map<string, (input: unknown) => Promise<string>>;
}

/**
 * Convert proto `ToolMetadata` messages to internal `ToolDefinition` instances.
 *
 * - **Sandbox-location tools**: Get a reconstructed Zod schema from the JSON
 *   Schema and a no-op handler (the harness SDK handles execution).
 * - **Orchestrator-location tools**: Get a proxy handler that calls back to
 *   the orchestrator via gRPC. If `opts.orchestratorClient` is provided the
 *   real proxy is used; otherwise a placeholder stub is returned.
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

    const effectiveSessionId = opts?.sessionId ?? opts?.sessionIdRef;
    if (isDaemon && opts?.daemonHandlers?.has(t.name)) {
      handler = opts.daemonHandlers.get(t.name)!;
    } else if (isDaemon) {
      handler = createDaemonStub(t.name);
    } else if (isOrchestrator && opts?.orchestratorClient && effectiveSessionId && opts.agentId) {
      handler = createToolProxy(t.name, opts.orchestratorClient, effectiveSessionId, opts.agentId);
    } else if (isOrchestrator) {
      handler = createOrchestratorProxyStub(t.name);
    } else {
      handler = createSandboxHandler(t.name);
    }

    return {
      name: t.name,
      description: t.description,
      input: zodSchema,
      programmatic: t.programmatic,
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
    return JSON.stringify({
      error: `Sandbox handler for "${toolName}" was called directly — this should be handled by the harness SDK.`,
    });
  };
}

function createDaemonStub(toolName: string) {
  return async (_input: unknown): Promise<string> => {
    return JSON.stringify({
      error: `Daemon handler for "${toolName}" is not configured. Ensure artifact storage is enabled.`,
    });
  };
}

/**
 * Create a stub proxy handler for orchestrator-location tools.
 *
 * Used as a fallback when the orchestrator gRPC client is not available
 * (e.g., in unit tests or when the sandbox is not connected to an orchestrator).
 */
function createOrchestratorProxyStub(toolName: string) {
  return async (input: unknown): Promise<string> => {
    return JSON.stringify({
      error: `Orchestrator proxy for "${toolName}" is not yet connected. Args: ${JSON.stringify(input)}`,
    });
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
            argsJson: typeof event.args === 'string' ? event.args : JSON.stringify(event.args),
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
            argsJson: typeof event.args === 'string' ? event.args : JSON.stringify(event.args),
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

    case 'error':
      return create(AgentEventSchema, {
        event: {
          case: 'error',
          value: create(ProtoErrorEventSchema, {
            message: event.error,
            category: 'runtime',
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
                    cost: event.usage.cost,
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

/**
 * Convert a proto AgentEvent (from gRPC stream) into an AGUIEvent for SSE broadcast.
 * This is the REVERSE of convertAgentEvent().
 */
export function protoAgentEventToAGUI(
  proto: ProtoAgentEvent,
  runId: string,
): AGUIEvent | null {
  const ts = Date.now();

  switch (proto.event.case) {
    case 'textDelta':
      return {
        type: 'TEXT_MESSAGE_CONTENT',
        timestamp: ts,
        runId,
        content: proto.event.value.content,
      };

    case 'toolCallStart': {
      const v = proto.event.value;
      return {
        type: 'TOOL_CALL_START',
        timestamp: ts,
        runId,
        toolCallId: v.id,
        toolName: v.name,
        args: v.argsJson ? JSON.parse(v.argsJson) : {},
      };
    }

    case 'toolCallEnd': {
      const v = proto.event.value;
      return {
        type: 'TOOL_CALL_RESULT',
        timestamp: ts,
        runId,
        toolCallId: v.id,
        toolName: '',
        result: v.result,
        error: v.error,
        durationMs: Number(v.durationMs),
      };
    }

    case 'approvalNeeded': {
      const v = proto.event.value;
      return {
        type: 'HITL_PAUSE',
        timestamp: ts,
        runId,
        id: v.id,
        tool: v.toolName,
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

    case 'error':
      return {
        type: 'RUN_ERROR',
        timestamp: ts,
        runId,
        error: proto.event.value.message,
      };

    case 'done': {
      const v = proto.event.value;
      const usage = v.usage
        ? {
            inputTokens: Number(v.usage.inputTokens),
            outputTokens: Number(v.usage.outputTokens),
            totalTokens: Number(v.usage.totalTokens),
            cost: v.usage.cost,
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
  switch (proto.payload.case) {
    case 'agUiEvent': {
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

    default:
      return null;
  }
}

function sanitizeBigInts(obj: unknown): unknown {
  if (typeof obj === 'bigint') return Number(obj);
  if (Array.isArray(obj)) return obj.map(sanitizeBigInts);
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = sanitizeBigInts(value);
    }
    return result;
  }
  return obj;
}
