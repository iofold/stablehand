import type { EventMap } from '../../events/bus.js';
import { materializeTurnUsage } from '../usage.js';
import { classifyChannel, type CanonicalFrame } from './frames.js';

interface A2UIRenderBlock {
  id: string;
  component: string;
  props: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isA2UIRenderTool(toolName: string): boolean {
  return toolName === 'a2ui-render' || toolName.endsWith('__a2ui-render');
}

function parseA2UIRenderBlock(toolCallId: string, result: string): A2UIRenderBlock | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(result);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed.component !== 'string') {
    return null;
  }
  return {
    id: toolCallId,
    component: parsed.component,
    props: isRecord(parsed.props) ? parsed.props : {},
  };
}

interface TurnTextState {
  inProgress: boolean;
  messageId: string;
  counter: number;
}

/**
 * Projects internal bus events onto canonical AG-UI frames (ADR-015). One
 * server-side instance — message boundaries are synthesized ONCE here with
 * stable ids (`${turnId}-m${n}`), so reconnect replay reproduces in-flight
 * partials instead of minting msg-N per connection (ctx-4fs, ctx-16s).
 * a2ui-render detection also lives here, making blocks replayable.
 */
export class CanonicalProjector {
  private readonly textStates = new Map<string, TurnTextState>();

  project(eventName: string, payload: Record<string, unknown>): CanonicalFrame[] {
    const sourcePayload = JSON.stringify(payload);
    const frames = this.projectFrames(eventName, payload);
    const durableFrames = frames.length > 0 ? frames : [this.provenanceOnlyFrame(eventName, payload)];
    return durableFrames.map((frame, index) => index === 0
      ? { ...frame, sourceType: eventName, sourcePayload }
      : frame);
  }

  private projectFrames(eventName: string, payload: Record<string, unknown>): CanonicalFrame[] {
    const channel = classifyChannel(eventName);
    if (channel !== 'run') {
      // System and user-defined custom events persist verbatim: same type,
      // same payload — /api/events consumers (incl. ADR-012 E2E gates) see
      // exactly what they see today.
      return [{
        type: eventName,
        channel,
        agentId: typeof payload.agentId === 'string' ? payload.agentId : '',
        turnId: typeof payload.turnId === 'string' ? payload.turnId : null,
        conversationId: typeof payload.conversationId === 'string' ? payload.conversationId : null,
        body: payload,
      }];
    }

    switch (eventName) {
      case 'turn.pending':
        return [this.custom('ctxmill.turn.pending', payload as EventMap['turn.pending'])];
      case 'turn.started': {
        const p = payload as unknown as EventMap['turn.started'];
        return [this.runFrame('RUN_STARTED', p.agentId, p.turnId, p.conversationId, {
          runId: p.turnId,
          threadId: p.conversationId,
          timestamp: p.timestamp,
        })];
      }
      case 'user.message': {
        const p = payload as unknown as EventMap['user.message'];
        const identity = {
          runId: p.turnId,
          threadId: p.conversationId,
          messageId: p.messageId,
          timestamp: p.timestamp,
        };
        return [
          this.runFrame('TEXT_MESSAGE_START', p.agentId, p.turnId, p.conversationId, {
            ...identity,
            role: 'user',
          }),
          this.runFrame('TEXT_MESSAGE_CONTENT', p.agentId, p.turnId, p.conversationId, {
            ...identity,
            delta: p.content,
          }),
          this.runFrame('TEXT_MESSAGE_END', p.agentId, p.turnId, p.conversationId, identity),
        ];
      }
      case 'message.delta': {
        const p = payload as unknown as EventMap['message.delta'];
        const frames: CanonicalFrame[] = [];
        const state = this.textState(p.turnId);
        if (!state.inProgress) {
          state.counter += 1;
          state.messageId = `${p.turnId}-m${state.counter}`;
          state.inProgress = true;
          frames.push(this.runFrame('TEXT_MESSAGE_START', p.agentId, p.turnId, p.conversationId, {
            runId: p.turnId,
            threadId: p.conversationId,
            messageId: state.messageId,
            role: 'assistant',
            timestamp: p.timestamp,
          }));
        }
        frames.push(this.runFrame('TEXT_MESSAGE_CONTENT', p.agentId, p.turnId, p.conversationId, {
          runId: p.turnId,
          threadId: p.conversationId,
          messageId: state.messageId,
          delta: p.delta,
          timestamp: p.timestamp,
        }));
        return frames;
      }
      case 'tool_call.started': {
        const p = payload as unknown as EventMap['tool_call.started'];
        const frames = this.closeTextMessage(p.agentId, p.turnId, p.conversationId, p.timestamp);
        const serializedArgs = typeof p.args === 'string' ? p.args : JSON.stringify(p.args);
        frames.push(
          this.runFrame('TOOL_CALL_START', p.agentId, p.turnId, p.conversationId, {
            runId: p.turnId,
            threadId: p.conversationId,
            toolCallId: p.toolCallId,
            toolCallName: p.toolCallName,
            ...(p.parentToolCallId ? { parentToolCallId: p.parentToolCallId } : {}),
            ...(p.agentName ? { agentName: p.agentName } : {}),
            timestamp: p.timestamp,
          }),
          this.runFrame('TOOL_CALL_ARGS', p.agentId, p.turnId, p.conversationId, {
            runId: p.turnId,
            threadId: p.conversationId,
            toolCallId: p.toolCallId,
            delta: serializedArgs,
            timestamp: p.timestamp,
          }),
        );
        return frames;
      }
      case 'tool_call.completed': {
        const p = payload as unknown as EventMap['tool_call.completed'];
        const frames: CanonicalFrame[] = [
          this.runFrame('TOOL_CALL_END', p.agentId, p.turnId, p.conversationId, {
            runId: p.turnId,
            threadId: p.conversationId,
            toolCallId: p.toolCallId,
            timestamp: p.timestamp,
          }),
          this.runFrame('TOOL_CALL_RESULT', p.agentId, p.turnId, p.conversationId, {
            runId: p.turnId,
            threadId: p.conversationId,
            toolCallId: p.toolCallId,
            result: p.result,
            ...(p.error ? { error: p.error } : {}),
            ...(typeof p.durationMs === 'number' && p.durationMs > 0 ? { durationMs: p.durationMs } : {}),
            timestamp: p.timestamp,
          }),
        ];
        const a2uiBlock = !p.error && isA2UIRenderTool(p.toolCallName) && typeof p.result === 'string'
          ? parseA2UIRenderBlock(p.toolCallId, p.result)
          : null;
        if (a2uiBlock) {
          frames.push(this.runFrame('CUSTOM', p.agentId, p.turnId, p.conversationId, {
            name: 'ctxmill.a2ui.render',
            runId: p.turnId,
            threadId: p.conversationId,
            block: a2uiBlock,
            timestamp: p.timestamp,
          }));
        }
        return frames;
      }
      case 'interrupt.requested':
        return [this.custom('ctxmill.interrupt.requested', payload as EventMap['interrupt.requested'])];
      case 'interrupt.resolved':
        return [this.custom('ctxmill.interrupt.resolved', payload as EventMap['interrupt.resolved'])];
      case 'message.committed':
        return [this.custom('ctxmill.message.committed', payload as EventMap['message.committed'])];
      case 'message.updated':
        return [this.custom('ctxmill.message.updated', payload as EventMap['message.updated'])];
      case 'turn.completed': {
        const p = payload as unknown as EventMap['turn.completed'];
        const frames = this.closeTextMessage(p.agentId, p.turnId, p.conversationId, p.timestamp);
        this.textStates.delete(p.turnId);
        if (p.status === 'error' || p.status === 'cancelled') {
          frames.push(this.runFrame('RUN_ERROR', p.agentId, p.turnId, p.conversationId, {
            runId: p.turnId,
            threadId: p.conversationId,
            // AG-UI spec field for RUN_ERROR is top-level `message`.
            message: p.error ?? (p.status === 'cancelled' ? 'Run cancelled' : 'Run failed'),
            status: p.status,
            timestamp: p.timestamp,
          }));
        }
        frames.push(this.runFrame('RUN_FINISHED', p.agentId, p.turnId, p.conversationId, {
          runId: p.turnId,
          threadId: p.conversationId,
          status: p.status,
          usage: materializeTurnUsage(p.usage),
          timestamp: p.timestamp,
        }));
        return frames;
      }
      case 'ag_ui.event': {
        const p = payload as unknown as EventMap['ag_ui.event'];
        const event = isRecord(p.event) ? p.event : {};
        const type = typeof event.type === 'string' ? event.type : 'CUSTOM';
        const identity = {
          runId: p.turnId,
          threadId: p.conversationId,
          timestamp: typeof event.timestamp === 'number' ? event.timestamp : p.timestamp,
        };
        switch (type) {
          case 'RUN_STARTED':
            return [this.runFrame(type, p.agentId, p.turnId, p.conversationId, identity)];
          case 'RUN_FINISHED':
            return [this.runFrame(type, p.agentId, p.turnId, p.conversationId, {
              ...identity,
              ...(typeof event.status === 'string' ? { status: event.status } : {}),
              usage: materializeTurnUsage(
                isRecord(event.usage) ? event.usage : null,
              ),
            })];
          case 'RUN_ERROR':
            return [this.runFrame(type, p.agentId, p.turnId, p.conversationId, {
              ...identity,
              message: typeof event.message === 'string'
                ? event.message
                : typeof event.error === 'string'
                  ? event.error
                  : 'Run failed',
              ...(typeof event.status === 'string' ? { status: event.status } : {}),
            })];
          case 'TEXT_MESSAGE_START':
            return [this.runFrame(type, p.agentId, p.turnId, p.conversationId, {
              ...identity,
              messageId: event.messageId,
              role: event.role,
            })];
          case 'TEXT_MESSAGE_CONTENT':
            return [this.runFrame(type, p.agentId, p.turnId, p.conversationId, {
              ...identity,
              messageId: event.messageId,
              delta: event.delta,
            })];
          case 'TEXT_MESSAGE_END':
            return [this.runFrame(type, p.agentId, p.turnId, p.conversationId, {
              ...identity,
              messageId: event.messageId,
            })];
          case 'TOOL_CALL_START':
            return [this.runFrame(type, p.agentId, p.turnId, p.conversationId, {
              ...identity,
              toolCallId: event.toolCallId,
              toolCallName: event.toolCallName,
              ...(typeof event.parentMessageId === 'string'
                ? { parentMessageId: event.parentMessageId }
                : {}),
            })];
          case 'TOOL_CALL_ARGS':
            return [this.runFrame(type, p.agentId, p.turnId, p.conversationId, {
              ...identity,
              toolCallId: event.toolCallId,
              delta: event.delta,
            })];
          case 'TOOL_CALL_END':
            return [this.runFrame(type, p.agentId, p.turnId, p.conversationId, {
              ...identity,
              toolCallId: event.toolCallId,
            })];
          case 'TOOL_CALL_RESULT':
            return [this.runFrame(type, p.agentId, p.turnId, p.conversationId, {
              ...identity,
              toolCallId: event.toolCallId,
              result: event.result,
              ...(typeof event.error === 'string' ? { error: event.error } : {}),
            })];
          case 'STATE_DELTA':
            return [this.runFrame(type, p.agentId, p.turnId, p.conversationId, {
              ...identity,
              delta: event.delta,
            })];
          case 'MESSAGES_SNAPSHOT':
            return [this.runFrame(type, p.agentId, p.turnId, p.conversationId, {
              ...identity,
              messages: Array.isArray(event.messages) ? event.messages : [],
            })];
          case 'CUSTOM': {
            const name = typeof event.name === 'string' ? event.name : '';
            if (!name || name.startsWith('ctxmill.')) {
              return [];
            }
            const value = event.value;
            const customFields = Object.fromEntries(
              Object.entries(event).filter(([key]) =>
                !['type', 'name', 'runId', 'threadId', 'timestamp', 'value'].includes(key)),
            );
            const normalizedValue = value === undefined && Object.keys(customFields).length > 0
              ? customFields
              : value;
            return [this.runFrame(type, p.agentId, p.turnId, p.conversationId, {
              name,
              runId: p.turnId,
              threadId: p.conversationId,
              ...(normalizedValue === undefined ? {} : { value: normalizedValue }),
              timestamp: identity.timestamp,
            })];
          }
          default:
            return [];
        }
      }
      default:
        return [];
    }
  }

  /** Drop per-turn text state (e.g. after reconciliation closes a turn). */
  clearTurn(turnId: string): void {
    this.textStates.delete(turnId);
  }

  private textState(turnId: string): TurnTextState {
    let state = this.textStates.get(turnId);
    if (!state) {
      state = { inProgress: false, messageId: '', counter: 0 };
      this.textStates.set(turnId, state);
    }
    return state;
  }

  private closeTextMessage(
    agentId: string,
    turnId: string,
    conversationId: string | undefined,
    timestamp: number,
  ): CanonicalFrame[] {
    const state = this.textStates.get(turnId);
    if (!state?.inProgress) {
      return [];
    }
    state.inProgress = false;
    const messageId = state.messageId;
    state.messageId = '';
    return [this.runFrame('TEXT_MESSAGE_END', agentId, turnId, conversationId, {
      runId: turnId,
      threadId: conversationId,
      messageId,
      timestamp,
    })];
  }

  private runFrame(
    type: string,
    agentId: string,
    turnId: string | null | undefined,
    conversationId: string | null | undefined,
    body: Record<string, unknown>,
  ): CanonicalFrame {
    return {
      type,
      channel: 'run',
      agentId,
      turnId: turnId ?? null,
      conversationId: conversationId ?? null,
      body: {
        ...body,
        type,
      },
    };
  }

  private custom(
    name: string,
    payload: Record<string, unknown>,
  ): CanonicalFrame {
    const agentId = typeof payload.agentId === 'string' ? payload.agentId : '';
    const turnId = typeof payload.turnId === 'string' ? payload.turnId : null;
    const conversationId = typeof payload.conversationId === 'string' ? payload.conversationId : null;
    return this.runFrame('CUSTOM', agentId, turnId, conversationId, {
      name,
      ...payload,
    });
  }

  private provenanceOnlyFrame(eventName: string, payload: Record<string, unknown>): CanonicalFrame {
    return {
      type: 'ctxmill.raw_event',
      channel: 'system',
      agentId: typeof payload.agentId === 'string' ? payload.agentId : '',
      turnId: typeof payload.turnId === 'string' ? payload.turnId : null,
      conversationId: typeof payload.conversationId === 'string' ? payload.conversationId : null,
      body: {
        type: 'ctxmill.raw_event',
        sourceType: eventName,
        timestamp: typeof payload.timestamp === 'number' ? payload.timestamp : Date.now(),
      },
    };
  }
}
