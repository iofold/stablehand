import type { CanonicalFrame } from './frames.js';

/**
 * Phase-A wire compatibility (ADR-015): renders a canonical frame as today's
 * native SSE event so the cutover is invisible to native-stream consumers
 * (packages/ui, pilot's proxy). Returns null for frames the native wire never
 * carried (assistant TEXT_MESSAGE_START/END boundaries, TOOL_CALL_END, a2ui
 * CUSTOM frames) — those stay canonical-only until Phase B flips the wire.
 *
 * Deliberate divergence from the pre-canonical wire: TEXT_MESSAGE_CONTENT
 * messageId is the stable server-minted `${turnId}-m${n}` instead of the
 * sandbox-supplied id (ctx-4fs) — no consumer reads it on this wire.
 */
export function formatNativeLegacy(frame: CanonicalFrame): Record<string, unknown> | null {
  const body = frame.body;
  const conversationId = frame.conversationId ?? (body.conversationId as string | undefined);
  const base = {
    conversationId,
    threadId: conversationId,
  };

  switch (frame.type) {
    case 'RUN_STARTED':
      return { ...stripFrameFields(body), ...base, type: 'RUN_STARTED', runId: frame.turnId, internalType: 'turn.started' };
    case 'RUN_ERROR':
      return { ...stripFrameFields(body), ...base, type: 'RUN_ERROR', runId: frame.turnId, internalType: 'turn.completed' };
    case 'RUN_FINISHED':
      return { ...stripFrameFields(body), ...base, type: 'RUN_FINISHED', runId: frame.turnId, internalType: 'turn.completed' };
    case 'TEXT_MESSAGE_START':
    case 'TEXT_MESSAGE_END': {
      if (body.role !== 'user') {
        return null;
      }
      // The legacy wire only carried role on START.
      const { role, ...rest } = stripFrameFields(body);
      return {
        ...(frame.type === 'TEXT_MESSAGE_START' ? { ...rest, role } : rest),
        ...base,
        type: frame.type,
        runId: conversationId,
        internalType: 'user.message',
      };
    }
    case 'TEXT_MESSAGE_CONTENT': {
      if (body.role === 'user') {
        const { role: _role, ...rest } = stripFrameFields(body);
        return {
          ...rest,
          ...base,
          type: 'TEXT_MESSAGE_CONTENT',
          runId: conversationId,
          delta: body.delta ?? body.content,
          internalType: 'user.message',
        };
      }
      return {
        ...stripFrameFields(body),
        ...base,
        type: 'TEXT_MESSAGE_CONTENT',
        runId: frame.turnId,
        delta: body.delta ?? body.content,
        internalType: 'run.text_chunk',
      };
    }
    case 'TOOL_CALL_START':
      return { ...stripFrameFields(body), ...base, type: 'TOOL_CALL_START', runId: frame.turnId, internalType: 'run.tool_started' };
    case 'TOOL_CALL_ARGS':
      return { ...stripFrameFields(body), ...base, type: 'TOOL_CALL_ARGS', runId: frame.turnId, internalType: 'run.tool_started' };
    case 'TOOL_CALL_END':
      return null;
    case 'TOOL_CALL_RESULT':
      return { ...stripFrameFields(body), ...base, type: 'TOOL_CALL_RESULT', runId: frame.turnId, internalType: 'run.tool_result' };
    case 'CUSTOM': {
      switch (body.name) {
        case 'ctxmill.turn.pending':
          return { ...flattenCustom(body), ...base, type: 'TURN_PENDING', runId: frame.turnId, internalType: 'turn.pending' };
        case 'ctxmill.hitl.requested':
          return { ...flattenCustom(body), ...base, type: 'HITL_PAUSE', runId: frame.turnId, internalType: 'run.interrupted' };
        case 'ctxmill.hitl.resolved':
          return { ...flattenCustom(body), ...base, type: 'CUSTOM', runId: frame.turnId, internalType: 'run.interrupt_resolved' };
        case 'ctxmill.message.committed':
          return { ...flattenCustom(body), ...base, type: 'MESSAGE_COMMITTED', runId: frame.turnId, internalType: 'message.committed' };
        case 'ctxmill.a2ui.render':
          return null;
        default:
          // Passthrough CUSTOM from run.ag_ui_event keeps its shape.
          return { ...stripFrameFields(body), ...base, type: 'CUSTOM', runId: frame.turnId, internalType: 'run.ag_ui_event' };
      }
    }
    default:
      // Passthrough frame types from run.ag_ui_event (e.g. STATE_DELTA).
      return { ...stripFrameFields(body), ...base, type: frame.type, runId: frame.turnId, internalType: 'run.ag_ui_event' };
  }
}

/** Remove canonical-only envelope fields the native wire never carried. */
function stripFrameFields(body: Record<string, unknown>): Record<string, unknown> {
  const { type: _type, value: _value, ...rest } = body;
  return rest;
}

/** Flatten a ctxmill.* CUSTOM back to the original event payload spread. */
function flattenCustom(body: Record<string, unknown>): Record<string, unknown> {
  const { type: _type, name: _name, subtype: _subtype, value: _value, ...rest } = body;
  return rest;
}
