import { describe, it, expect, beforeEach } from 'vitest';
import { useInterruptStore } from '../interrupt';

beforeEach(() => {
  useInterruptStore.getState().clear();
});

describe('interrupt store', () => {
  it('starts with no pending interrupt', () => {
    expect(useInterruptStore.getState().pending).toBeNull();
  });

  it('setPending sets the interrupt payload', () => {
    const payload = {
      interruptId: 'interrupt-1',
      turnId: 'turn-1',
      agentId: 'a1',
      toolCallName: 'shell',
      args: { cmd: 'ls' },
      toolCallId: 'tc1',
    };

    useInterruptStore.getState().setPending(payload);

    expect(useInterruptStore.getState().pending).toEqual(payload);
  });

  it('clear removes the pending interrupt', () => {
    useInterruptStore.getState().setPending({
      interruptId: 'interrupt-1',
      turnId: 'turn-1',
      agentId: 'a1',
      toolCallName: 'shell',
      args: {},
      toolCallId: 'tc1',
    });

    useInterruptStore.getState().clear();

    expect(useInterruptStore.getState().pending).toBeNull();
  });

  it('setPending(null) also clears the interrupt', () => {
    useInterruptStore.getState().setPending({
      interruptId: 'interrupt-1',
      turnId: 'turn-1',
      agentId: 'a1',
      toolCallName: 'shell',
      args: {},
      toolCallId: 'tc1',
    });

    useInterruptStore.getState().setPending(null);

    expect(useInterruptStore.getState().pending).toBeNull();
  });
});
