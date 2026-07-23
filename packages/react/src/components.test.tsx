// @vitest-environment jsdom

import {
  CtxmillAgUiClient,
  type CtxmillAgUiRunInput,
  type CtxmillStreamEvent,
} from '@ctxmill/client';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { useCtxmillChat } from './components.js';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

interface ControlledRun {
  input: CtxmillAgUiRunInput;
  release: () => void;
}

class ControlledAgUiClient extends CtxmillAgUiClient {
  readonly runs: ControlledRun[] = [];

  override async *streamAgentRun(
    input: CtxmillAgUiRunInput,
  ): AsyncGenerator<CtxmillStreamEvent> {
    let release = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runIndex = this.runs.length;
    this.runs.push({ input, release });

    const runId = input.runId ?? 'missing-run';
    const threadId = input.threadId ?? 'missing-thread';
    yield {
      type: 'RUN_STARTED',
      runId,
      threadId,
      timestamp: 1,
    };
    await released;

    // The first stream deliberately emits after abort. A consumer-side identity
    // guard must keep a late frame from contaminating the replacement chat.
    if (runIndex === 0) {
      yield {
        type: 'RUN_ERROR',
        runId,
        threadId,
        message: 'stale run error',
        timestamp: 2,
      };
    }
  }
}

describe('useCtxmillChat identity lifecycle', () => {
  let root: Root | undefined;

  afterEach(async () => {
    if (root) {
      await act(async () => root?.unmount());
      root = undefined;
    }
  });

  it('aborts and resets on identity change without letting the old run settle the new chat', async () => {
    const client = new ControlledAgUiClient();
    let latest: ReturnType<typeof useCtxmillChat> | undefined;

    function Probe({ agentId, threadId }: { agentId: string; threadId: string }) {
      latest = useCtxmillChat({ agentId, threadId, client });
      return null;
    }

    const container = document.createElement('div');
    root = createRoot(container);
    await act(async () => {
      root?.render(<Probe agentId="agent-1" threadId="thread-1" />);
    });

    let firstRun: Promise<void> | undefined;
    await act(async () => {
      firstRun = latest?.sendMessage('first identity');
      await Promise.resolve();
    });
    expect(client.runs).toHaveLength(1);
    expect(latest).toMatchObject({
      threadId: 'thread-1',
      isRunning: true,
    });

    await act(async () => {
      root?.render(<Probe agentId="agent-2" threadId="thread-2" />);
      await Promise.resolve();
    });

    expect(client.runs[0]?.input.signal?.aborted).toBe(true);
    expect(latest).toMatchObject({
      threadId: 'thread-2',
      messages: [],
      isRunning: false,
      error: null,
    });

    let secondRun: Promise<void> | undefined;
    await act(async () => {
      secondRun = latest?.sendMessage('second identity');
      await Promise.resolve();
    });
    expect(client.runs).toHaveLength(2);
    expect(client.runs[1]?.input).toMatchObject({
      agentId: 'agent-2',
      threadId: 'thread-2',
    });
    expect(latest?.isRunning).toBe(true);

    await act(async () => {
      client.runs[0]?.release();
      await firstRun;
    });
    expect(latest?.isRunning).toBe(true);
    expect(latest?.error).toBeNull();
    expect(latest?.messages).toHaveLength(1);
    expect(latest?.messages[0]?.content).toBe('second identity');

    await act(async () => {
      client.runs[1]?.release();
      await secondRun;
    });
    expect(latest?.isRunning).toBe(false);
  });
});
