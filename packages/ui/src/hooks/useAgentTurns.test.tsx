import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useAgentTurns } from './useAgentTurns';
import type { AgentTurn } from '@/stores/agents';

function makeTurn(overrides: Partial<AgentTurn>): AgentTurn {
  return {
    id: 'turn-' + Math.random().toString(36).slice(2),
    agentId: 'agent-1',
    conversationId: 'conv-default',
    status: 'COMPLETED',
    mode: 'background',
    startedAt: 1_700_000_000_000,
    conversationMessageCount: 0,
    ...overrides,
  } as AgentTurn;
}

interface ProbeProps {
  turns: AgentTurn[];
  filter: string;
  onResult: (filtered: AgentTurn[]) => void;
}

// Tiny probe component that exposes the hook output via callback so the test
// can assert without pulling in @testing-library/react-hooks.
function Probe({ turns, filter, onResult }: ProbeProps) {
  const { filteredTurns } = useAgentTurns(turns, filter);
  onResult(filteredTurns);
  return null;
}

function captureFiltered(turns: AgentTurn[], filter: string): AgentTurn[] {
  let captured: AgentTurn[] = [];
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<Probe turns={turns} filter={filter} onResult={(value) => { captured = value; }} />);
  });
  act(() => {
    root.unmount();
  });
  container.remove();
  return captured;
}

describe('useAgentTurns filter normalization (ctx-u4p)', () => {
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

  it('passes through every turn when filter is "all"', () => {
    const turns = [
      makeTurn({ status: 'RUNNING', conversationId: 'a' }),
      makeTurn({ status: 'COMPLETED', conversationId: 'b' }),
      makeTurn({ status: 'CANCELLED', conversationId: 'c' }),
    ];

    expect(captureFiltered(turns, 'all')).toHaveLength(3);
  });

  it('matches uppercase RUNNING to the lowercase "running" filter', () => {
    const turns = [
      makeTurn({ status: 'RUNNING', conversationId: 'a' }),
      makeTurn({ status: 'QUEUED', conversationId: 'c' }),
      makeTurn({ status: 'COMPLETED', conversationId: 'd' }),
    ];

    const ids = captureFiltered(turns, 'running').map((s) => s.conversationId).sort();
    expect(ids).toEqual(['a']);
  });

  it('matches uppercase ERROR to the lowercase "error" filter without synonym mapping', () => {
    const turns = [
      makeTurn({ status: 'ERROR', conversationId: 'a' }),
      makeTurn({ status: 'failed' as never, conversationId: 'b' }),
      makeTurn({ status: 'COMPLETED', conversationId: 'c' }),
    ];

    const ids = captureFiltered(turns, 'error').map((s) => s.conversationId).sort();
    expect(ids).toEqual(['a']);
  });

  it('keeps completed turns out of the cancelled filter', () => {
    const turns = [
      makeTurn({ status: 'CANCELLED', conversationId: 'a' }),
      makeTurn({ status: 'COMPLETED', conversationId: 'b' }),
    ];

    expect(captureFiltered(turns, 'cancelled').map((s) => s.conversationId)).toEqual(['a']);
    expect(captureFiltered(turns, 'completed').map((s) => s.conversationId)).toEqual(['b']);
  });

  it('groups all turns of a matching conversation by latest-turn status', () => {
    const turns = [
      // Latest turn of conv-x is RUNNING → "running" group
      makeTurn({ id: 't1', status: 'COMPLETED', conversationId: 'conv-x', startedAt: 100 }),
      makeTurn({ id: 't2', status: 'RUNNING', conversationId: 'conv-x', startedAt: 200 }),
      // conv-y latest turn is COMPLETED → not in "running" group
      makeTurn({ id: 't3', status: 'COMPLETED', conversationId: 'conv-y', startedAt: 300 }),
    ];

    const ids = captureFiltered(turns, 'running').map((s) => s.id).sort();
    expect(ids).toEqual(['t1', 't2']);
  });
});
