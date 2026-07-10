import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useAgentSessions } from './useAgentSessions';
import type { AgentSession } from '@/stores/agents';

function makeSession(overrides: Partial<AgentSession>): AgentSession {
  return {
    id: 'session-' + Math.random().toString(36).slice(2),
    agentId: 'agent-1',
    conversationId: 'conv-default',
    status: 'COMPLETED',
    mode: 'background',
    startedAt: 1_700_000_000_000,
    messageCount: 0,
    ...overrides,
  } as AgentSession;
}

interface ProbeProps {
  sessions: AgentSession[];
  filter: string;
  onResult: (filtered: AgentSession[]) => void;
}

// Tiny probe component that exposes the hook output via callback so the test
// can assert without pulling in @testing-library/react-hooks.
function Probe({ sessions, filter, onResult }: ProbeProps) {
  const { filteredSessions } = useAgentSessions(sessions, filter);
  onResult(filteredSessions);
  return null;
}

function captureFiltered(sessions: AgentSession[], filter: string): AgentSession[] {
  let captured: AgentSession[] = [];
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<Probe sessions={sessions} filter={filter} onResult={(value) => { captured = value; }} />);
  });
  act(() => {
    root.unmount();
  });
  container.remove();
  return captured;
}

describe('useAgentSessions filter normalization (ctx-u4p)', () => {
  let dummyContainer: HTMLDivElement;
  let dummyRoot: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    dummyContainer = document.createElement('div');
    document.body.appendChild(dummyContainer);
    dummyRoot = createRoot(dummyContainer);
  });

  afterEach(() => {
    act(() => { dummyRoot.unmount(); });
    dummyContainer.remove();
  });

  it('passes through every session when filter is "all"', () => {
    const sessions = [
      makeSession({ status: 'ACTIVE' as never, conversationId: 'a' }),
      makeSession({ status: 'completed' as never, conversationId: 'b' }),
      makeSession({ status: 'CANCELLED', conversationId: 'c' }),
    ];

    expect(captureFiltered(sessions, 'all')).toHaveLength(3);
  });

  it('matches uppercase ACTIVE/RESTORING to the lowercase "running" filter', () => {
    const sessions = [
      makeSession({ status: 'ACTIVE' as never, conversationId: 'a' }),
      makeSession({ status: 'RESTORING', conversationId: 'c' }),
      makeSession({ status: 'COMPLETED', conversationId: 'd' }),
    ];

    const ids = captureFiltered(sessions, 'running').map((s) => s.conversationId).sort();
    expect(ids).toEqual(['a', 'c']);
  });

  it('matches uppercase COMPLETED/CHECKPOINTED to the lowercase "completed" filter', () => {
    const sessions = [
      makeSession({ status: 'COMPLETED', conversationId: 'a' }),
      makeSession({ status: 'CHECKPOINTED', conversationId: 'b' }),
      makeSession({ status: 'ACTIVE' as never, conversationId: 'c' }),
    ];

    const ids = captureFiltered(sessions, 'completed').map((s) => s.conversationId).sort();
    expect(ids).toEqual(['a', 'b']);
  });

  it('matches uppercase ERROR to the lowercase "error" filter without synonym mapping', () => {
    const sessions = [
      makeSession({ status: 'ERROR', conversationId: 'a' }),
      makeSession({ status: 'failed' as never, conversationId: 'b' }),
      makeSession({ status: 'COMPLETED', conversationId: 'c' }),
    ];

    const ids = captureFiltered(sessions, 'error').map((s) => s.conversationId).sort();
    expect(ids).toEqual(['a']);
  });

  it('matches uppercase CANCELLED/TERMINATED to the lowercase "cancelled" filter', () => {
    const sessions = [
      makeSession({ status: 'CANCELLED', conversationId: 'a' }),
      makeSession({ status: 'TERMINATED', conversationId: 'b' }),
      makeSession({ status: 'COMPLETED', conversationId: 'c' }),
    ];

    const ids = captureFiltered(sessions, 'cancelled').map((s) => s.conversationId).sort();
    expect(ids).toEqual(['a', 'b']);
  });

  it('groups all turns of a matching conversation by latest-turn status', () => {
    const sessions = [
      // Latest turn of conv-x is ACTIVE → "running" group
      makeSession({ id: 't1', status: 'COMPLETED', conversationId: 'conv-x', startedAt: 100 }),
      makeSession({ id: 't2', status: 'ACTIVE' as never, conversationId: 'conv-x', startedAt: 200 }),
      // conv-y latest turn is COMPLETED → not in "running" group
      makeSession({ id: 't3', status: 'COMPLETED', conversationId: 'conv-y', startedAt: 300 }),
    ];

    const ids = captureFiltered(sessions, 'running').map((s) => s.id).sort();
    expect(ids).toEqual(['t1', 't2']);
  });
});
