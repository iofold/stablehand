import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SessionThread } from '../SessionThread';
import type { Message } from '@/stores/conversation';

/**
 * ctx-5myn / ctx-q201: subagent activity nests under its spawning Task card
 * behind a labeled, collapsed-by-default badge, and runs of more than two
 * top-level tool calls collapse behind a summary row.
 */
describe('SessionThread subagent grouping and collapse', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const message = (parts: Message['parts']): Message => ({
    id: 'm-1',
    messageRevision: 0,
    role: 'assistant',
    content: '',
    createdAt: Date.now(),
    parts,
  } as Message);

  const renderThread = (messages: Message[]) => {
    act(() => {
      root.render(
        <SessionThread
          messages={messages}
          streamingContent=""
          isStreaming={false}
        />,
      );
    });
  };

  it('nests subagent calls under the Task card behind a labeled collapsed badge', () => {
    renderThread([message([
      { type: 'tool_call', id: 'task-1', name: 'Task', args: '{"subagent_type":"researcher"}', status: 'complete' },
      { type: 'tool_call', id: 'child-1', name: 'Read', args: '{}', status: 'complete', parentToolCallId: 'task-1', agentName: 'researcher' },
      { type: 'tool_call', id: 'child-2', name: 'Grep', args: '{}', status: 'complete', parentToolCallId: 'task-1', agentName: 'researcher' },
    ])]);

    // The badge names the subagent and counts its calls; children start hidden.
    expect(container.textContent).toContain('researcher · 2 calls');
    expect(container.textContent).toContain('Subagent');
    expect(container.textContent).not.toContain('Grep');

    const badge = [...container.querySelectorAll('button')]
      .find((b) => b.textContent?.includes('researcher · '));
    expect(badge).toBeTruthy();
    act(() => badge!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(container.textContent).toContain('Read');
    expect(container.textContent).toContain('Grep');
  });

  it('collapses runs of more than two top-level tool calls (ctx-q201)', () => {
    renderThread([message([
      { type: 'tool_call', id: 't-1', name: 'AlphaTool', args: '{}', status: 'complete' },
      { type: 'tool_call', id: 't-2', name: 'BetaTool', args: '{}', status: 'complete' },
      { type: 'tool_call', id: 't-3', name: 'GammaTool', args: '{}', status: 'complete' },
    ])]);

    expect(container.textContent).toContain('3 tool calls');
    expect(container.textContent).not.toContain('Alpha tool');

    const summary = [...container.querySelectorAll('button')]
      .find((b) => b.textContent?.includes('3 tool calls'));
    expect(summary).toBeTruthy();
    act(() => summary!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(container.textContent).toContain('Alpha tool');
    expect(container.textContent).toContain('Gamma tool');
  });

  it('renders two or fewer top-level cards flat, with a subagent group counting once', () => {
    renderThread([message([
      { type: 'tool_call', id: 'task-1', name: 'Task', args: '{}', status: 'complete' },
      { type: 'tool_call', id: 'child-1', name: 'Bash', args: '{}', status: 'complete', parentToolCallId: 'task-1', agentName: 'coder' },
      { type: 'tool_call', id: 'solo-1', name: 'DeltaTool', args: '{}', status: 'complete' },
    ])]);

    // Two top-level items (Task group + DeltaTool): no run-level collapse.
    expect(container.textContent).not.toContain('tool calls');
    expect(container.textContent).toContain('Delta tool');
    expect(container.textContent).toContain('coder · 1 call');
    expect(container.textContent).not.toContain('Bash');
  });
});
