import type { EventMap } from '../../events/bus.js';
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
          ...payload,
          runId: p.turnId,
          threadId: p.conversationId,
        })];
      }
      case 'user.message': {
        const p = payload as unknown as EventMap['user.message'];
        const base = {
          runId: p.conversationId,
          threadId: p.conversationId,
          messageId: p.messageId,
          role: 'user',
          content: p.content,
          timestamp: p.timestamp,
        };
        return [
          this.runFrame('TEXT_MESSAGE_START', p.agentId, null, p.conversationId, base),
          this.runFrame('TEXT_MESSAGE_CONTENT', p.agentId, null, p.conversationId, {
            ...base,
            delta: p.content,
            content: p.content,
          }),
          this.runFrame('TEXT_MESSAGE_END', p.agentId, null, p.conversationId, base),
        ];
      }
      case 'run.text_chunk': {
        const p = payload as unknown as EventMap['run.text_chunk'];
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
          ...payload,
          runId: p.turnId,
          threadId: p.conversationId,
          messageId: state.messageId,
          delta: p.content,
        }));
        return frames;
      }
      case 'run.tool_started': {
        const p = payload as unknown as EventMap['run.tool_started'];
        const frames = this.closeTextMessage(p.agentId, p.turnId, p.conversationId, p.timestamp);
        const serializedArgs = typeof p.args === 'string' ? p.args : JSON.stringify(p.args);
        frames.push(
          this.runFrame('TOOL_CALL_START', p.agentId, p.turnId, p.conversationId, {
            ...payload,
            runId: p.turnId,
            threadId: p.conversationId,
            toolCallName: p.toolName,
          }),
          this.runFrame('TOOL_CALL_ARGS', p.agentId, p.turnId, p.conversationId, {
            ...payload,
            runId: p.turnId,
            threadId: p.conversationId,
            args: serializedArgs,
            delta: serializedArgs,
          }),
        );
        return frames;
      }
      case 'run.tool_result': {
        const p = payload as unknown as EventMap['run.tool_result'];
        const frames: CanonicalFrame[] = [
          this.runFrame('TOOL_CALL_END', p.agentId, p.turnId, p.conversationId, {
            runId: p.turnId,
            threadId: p.conversationId,
            toolCallId: p.toolCallId,
            toolCallName: p.toolName,
            result: p.error ?? p.result,
            timestamp: p.timestamp,
          }),
          this.runFrame('TOOL_CALL_RESULT', p.agentId, p.turnId, p.conversationId, {
            ...payload,
            runId: p.turnId,
            threadId: p.conversationId,
            ...(typeof p.result === 'string' ? { content: p.result } : {}),
          }),
        ];
        const a2uiBlock = !p.error && isA2UIRenderTool(p.toolName) && typeof p.result === 'string'
          ? parseA2UIRenderBlock(p.toolCallId, p.result)
          : null;
        if (a2uiBlock) {
          frames.push(this.runFrame('CUSTOM', p.agentId, p.turnId, p.conversationId, {
            name: 'ctxmill.a2ui.render',
            subtype: 'a2ui_render',
            runId: p.turnId,
            threadId: p.conversationId,
            agentId: p.agentId,
            conversationId: p.conversationId,
            toolCallId: p.toolCallId,
            toolCallName: p.toolName,
            value: { block: a2uiBlock },
            block: a2uiBlock,
            timestamp: p.timestamp,
          }));
        }
        return frames;
      }
      case 'run.interrupted':
        return [this.custom('ctxmill.hitl.requested', payload as EventMap['run.interrupted'], 'hitl_pause')];
      case 'run.interrupt_resolved':
        return [this.custom('ctxmill.hitl.resolved', payload as EventMap['run.interrupt_resolved'], 'hitl_resolved')];
      case 'message.committed':
        return [this.custom('ctxmill.message.committed', payload as EventMap['message.committed'])];
      case 'turn.completed': {
        const p = payload as unknown as EventMap['turn.completed'];
        const frames = this.closeTextMessage(p.agentId, p.turnId, p.conversationId, p.timestamp);
        this.textStates.delete(p.turnId);
        if (p.status === 'error' || p.status === 'cancelled') {
          const { error: _error, ...rest } = payload;
          frames.push(this.runFrame('RUN_ERROR', p.agentId, p.turnId, p.conversationId, {
            ...rest,
            runId: p.turnId,
            threadId: p.conversationId,
            // AG-UI spec field for RUN_ERROR is top-level `message`.
            message: p.error ?? (p.status === 'cancelled' ? 'Run cancelled' : 'Run failed'),
          }));
        }
        frames.push(this.runFrame('RUN_FINISHED', p.agentId, p.turnId, p.conversationId, {
          ...payload,
          runId: p.turnId,
          threadId: p.conversationId,
        }));
        return frames;
      }
      case 'run.ag_ui_event': {
        const p = payload as unknown as EventMap['run.ag_ui_event'];
        const event = isRecord(p.event) ? p.event : {};
        const type = typeof event.type === 'string' ? event.type : 'CUSTOM';
        return [this.runFrame(type, p.agentId, p.turnId, p.conversationId, {
          ...event,
          runId: p.turnId,
          threadId: p.conversationId,
          timestamp: p.timestamp,
        })];
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
      role: 'assistant',
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
        agentId,
        conversationId: conversationId ?? undefined,
        ...body,
        type,
      },
    };
  }

  private custom(
    name: string,
    payload: Record<string, unknown>,
    subtype?: string,
  ): CanonicalFrame {
    const agentId = typeof payload.agentId === 'string' ? payload.agentId : '';
    const turnId = typeof payload.turnId === 'string' ? payload.turnId : null;
    const conversationId = typeof payload.conversationId === 'string' ? payload.conversationId : null;
    return this.runFrame('CUSTOM', agentId, turnId, conversationId, {
      name,
      ...(subtype ? { subtype } : {}),
      runId: turnId ?? undefined,
      threadId: conversationId ?? undefined,
      value: payload,
      ...payload,
    });
  }
}
