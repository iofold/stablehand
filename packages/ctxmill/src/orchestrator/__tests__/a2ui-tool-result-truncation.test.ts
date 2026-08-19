import { describe, expect, it } from 'vitest';

import { toolResultForEvent } from '../agent-turn-service.js';
import { CanonicalProjector } from '../canonical/projector.js';

/**
 * Regression: tool results were capped at 500 characters before reaching the
 * event bus. The canonical projector reparses that string to build the
 * `ctxmill.a2ui.render` block, so any TableView or chart payload over the cap
 * failed JSON.parse and the render block vanished — while TOOL_CALL_END and
 * TOOL_CALL_RESULT still fired, so the drop was silent.
 */
function tableViewResult(rowCount: number): string {
  return JSON.stringify({
    component: 'TableView',
    props: {
      title: 'GL-2025-04412 — Meridian Metal Works — File Timeline',
      columns: [
        { key: 'date', label: 'Date' },
        { key: 'event', label: 'Event' },
        { key: 'status', label: 'Status' },
      ],
      data: Array.from({ length: rowCount }, (_, index) => ({
        date: `2025-01-${String(index + 1).padStart(2, '0')}`,
        event: `Diary entry ${index + 1} — demand review, reserve check, bordereau reconciliation`,
        status: index % 2 === 0 ? 'Overdue' : 'Logged',
      })),
    },
  });
}

const TOOL_EVENT = {
  turnId: 'turn-1',
  agentId: 'agent-1',
  conversationId: 'conv-1',
  toolCallId: 'tc-1',
  timestamp: 1_000,
};

describe('a2ui-render tool results survive the event-path truncation cap', () => {
  it('keeps an oversized TableView result intact', () => {
    const result = tableViewResult(12);
    expect(result.length).toBeGreaterThan(500);

    expect(toolResultForEvent('a2ui-render', result)).toBe(result);
    expect(toolResultForEvent('mcp__ctxmill__a2ui-render', result)).toBe(result);
  });

  it('still caps results from ordinary tools', () => {
    const bulky = 'x'.repeat(2_000);
    expect(toolResultForEvent('web_search', bulky)).toHaveLength(500);
  });

  it('emits ctxmill.a2ui.render for a TableView payload larger than the cap', () => {
    const projector = new CanonicalProjector();
    const result = tableViewResult(12);
    expect(result.length).toBeGreaterThan(500);

    const frames = projector.project('tool_call.completed', {
      ...TOOL_EVENT,
      toolName: 'mcp__ctxmill__a2ui-render',
      result: toolResultForEvent('mcp__ctxmill__a2ui-render', result),
      durationMs: 5,
    });

    const render = frames.find((frame) => frame.body.name === 'ctxmill.a2ui.render');
    expect(render).toBeDefined();

    const block = render!.body.block as { component: string; props: Record<string, unknown> };
    expect(block.component).toBe('TableView');
    expect(block.props.data).toHaveLength(12);
    expect(block.props.columns).toHaveLength(3);
  });

  it('drops the render block when a truncated payload reaches the projector', () => {
    const projector = new CanonicalProjector();

    const frames = projector.project('tool_call.completed', {
      ...TOOL_EVENT,
      toolName: 'mcp__ctxmill__a2ui-render',
      result: tableViewResult(12).slice(0, 500),
      durationMs: 5,
    });

    expect(frames.find((frame) => frame.body.name === 'ctxmill.a2ui.render')).toBeUndefined();
    expect(frames.some((frame) => frame.body.type === 'TOOL_CALL_RESULT')).toBe(true);
  });
});
