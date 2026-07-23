/**
 * Turn cancellation with AbortSignal integration tests.
 *
 * Tests the full cancellation flow using a real TestTurnRegistry + TypedEventBus
 * with mock DB/executor externals. Validates AbortController lifecycle,
 * signal propagation to the executor loop, and edge cases around
 * cancelling non-existent, already-completed, and concurrent turns.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TypedEventBus } from '../../packages/ctxmill/src/events/bus.js';
import { AgentTurnService } from '../../packages/ctxmill/src/orchestrator/agent-turn-service.js';
import type { DatabaseRepository } from '../../packages/ctxmill/src/database/repository.js';
import type { SandboxSessionManager } from '../../packages/ctxmill/src/orchestrator/sandbox-session-manager.js';
import type { SessionTurnExecutor } from '../../packages/ctxmill/src/orchestrator/session-turn-service.js';
import type { AgentDefinition, Message } from '@ctxmill/sandbox-daemon';
import {
  createTestBus,
  collectEvents,
  createMockDatabase,
} from '../utils/event-bus-test-helpers.js';
import {
  TestTurnRegistry,
  createTestSandboxSessionManager,
} from '../utils/test-turn-registry.js';

const settle = (ms = 10) => new Promise((r) => setTimeout(r, ms));

describe('Turn cancellation with AbortSignal', () => {
  let bus: TypedEventBus;
  let registry: TestTurnRegistry;

  beforeEach(() => {
    bus = createTestBus();
    registry = new TestTurnRegistry(bus);
  });

  // ── 1. AbortController lifecycle ─────────────────────────────────

  describe('AbortController lifecycle', () => {
    it('startTurn() creates an AbortController and getAbortSignal() returns it', async () => {
      const turn = await registry.startTurn('agent-1', 'conv-1', 'interactive', 'test task');

      const signal = registry.getAbortSignal(turn.turnId);
      expect(signal).toBeDefined();
      expect(signal!.aborted).toBe(false);
    });

    it('cancelTurn() aborts the signal and sets turn status to cancelled', async () => {
      const turn = await registry.startTurn('agent-1', 'conv-1', 'interactive');
      const signal = registry.getAbortSignal(turn.turnId)!;

      expect(signal.aborted).toBe(false);

      const result = await registry.cancelTurn(turn.turnId);

      expect(result).toBeDefined();
      expect(result!.status).toBe('cancelled');
      expect(result!.completedAt).toBeTypeOf('number');
      expect(signal.aborted).toBe(true);
    });

    it('cancelTurn() emits turn.completed with status cancelled', async () => {
      const turn = await registry.startTurn('agent-1', 'conv-1', 'interactive');
      const collector = collectEvents(bus, 'turn.completed');

      await registry.cancelTurn(turn.turnId);

      expect(collector.events).toHaveLength(1);
      expect(collector.events[0]).toEqual(
          expect.objectContaining({
          sandboxSessionId: turn.sandboxSessionId,
          turnId: turn.turnId,
          agentId: 'agent-1',
          status: 'cancelled',
        }),
      );

      collector.unsubscribe();
    });

    it('getAbortSignal() returns undefined after cancellation (controller cleaned up)', async () => {
      const turn = await registry.startTurn('agent-1', 'conv-1', 'interactive');

      // Grab signal reference before cancel
      const signalBefore = registry.getAbortSignal(turn.turnId);
      expect(signalBefore).toBeDefined();

      await registry.cancelTurn(turn.turnId);

      // Controller is deleted after cancel
      const signalAfter = registry.getAbortSignal(turn.turnId);
      expect(signalAfter).toBeUndefined();
    });
  });

  // ── 2. Signal propagation to executor loop ───────────────────────

  describe('Signal propagation to the turn executor loop', () => {
    it('cancelling mid-execution terminates the executor loop early and persists partial content', async () => {
      const mockDB = createMockDatabase();
      (mockDB as Record<string, unknown>).updateTurn = vi.fn().mockResolvedValue(undefined);
      (mockDB as Record<string, unknown>).finalizeTurnIfOpen = vi.fn().mockResolvedValue(true);

      // Track how many events the executor actually yielded before abort
      const yieldedEvents: string[] = [];

      // Mock sandbox turn executor that yields events slowly and checks the signal between yields.
      const mockSandboxTurnExecutor = {
        executeSessionTurn: vi.fn().mockImplementation(
          (
            _def: AgentDefinition,
            _conversationId: string,
            _messages: Message[],
            _turnId: string,
            options?: { signal?: AbortSignal },
          ) => {
            const signal = options?.signal;
            yieldedEvents.length = 0; // reset
            return (async function* () {
              yieldedEvents.push('chunk-1');
              yield {
                type: 'MESSAGE_COMMITTED',
                timestamp: Date.now(),
                runId: turn.turnId,
                role: 'assistant',
                content: 'Hello ',
                turnId: turn.turnId,
                messageSeq: 1,
              };

              await settle(30);
              if (signal?.aborted) return;

              yieldedEvents.push('chunk-2');
              yield {
                type: 'MESSAGE_COMMITTED',
                timestamp: Date.now(),
                runId: turn.turnId,
                role: 'assistant',
                content: 'World ',
                turnId: turn.turnId,
                messageSeq: 2,
              };

              await settle(30);
              if (signal?.aborted) return;

              yieldedEvents.push('chunk-3');
              yield {
                type: 'MESSAGE_COMMITTED',
                timestamp: Date.now(),
                runId: turn.turnId,
                role: 'assistant',
                content: 'Final',
                turnId: turn.turnId,
                messageSeq: 3,
              };
            })();
          },
        ),
      };

      const sessionManager = createTestSandboxSessionManager(registry);
      const turn = await registry.startTurn('agent-1', 'conv-1', 'interactive', 'cancellable task');

      const service = new AgentTurnService({
        sessionTurnService: mockSandboxTurnExecutor as unknown as SessionTurnExecutor,
        db: mockDB as unknown as DatabaseRepository,
        sessionManager: sessionManager as unknown as SandboxSessionManager,
        eventBus: bus,
      });

      // Start execution in background, cancel after first chunk
      const execPromise = service.executeTurn({
        agentDef: {
          name: 'test',
          harness: 'langgraph',
          harnessConfig: {},
          systemPrompt: 'test',
          tools: [],
        },
        messages: [{ id: 'u1', agentId: 'agent-1', role: 'user', content: 'Hi', createdAt: new Date() }],
        agentId: 'agent-1',
        conversationId: 'conv-1',
        turnId: turn.turnId,
        mode: 'interactive',
        taskDescription: 'cancellable task',
      });

      // Wait enough for first chunk to be yielded, then cancel
      await settle(50);
      await registry.cancelTurn(turn.turnId);

      // Wait for the turn execution to finish.
      await execPromise;

      // The executor should have been cut short — not all 3 chunks processed
      expect(yieldedEvents.length).toBeLessThan(3);

      // Partial content should still be persisted
      expect(mockDB.addCanonicalMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          turnId: turn.turnId,
          role: 'assistant',
          content: expect.stringContaining('Hello'),
        }),
        expect.objectContaining({
          ownerId: expect.any(String),
          fenceToken: expect.any(Number),
        }),
      );

      // The turn should not be completed again after cancelTurn finalized it.
      const finalTurn = registry.getTurn(turn.turnId);
      expect(finalTurn!.status).toBe('cancelled');
    });
  });

  // ── 3. Cancel non-existent turn ──────────────────────────────────

  describe('Cancel non-existent turn', () => {
    it('cancelTurn() with an unknown turnId returns undefined', async () => {
      const result = await registry.cancelTurn('non-existent-turn-id');
      expect(result).toBeUndefined();
    });

    it('no event is emitted for non-existent turn cancellation', async () => {
      const collector = collectEvents(bus, 'turn.completed');

      await registry.cancelTurn('non-existent-turn-id');

      expect(collector.events).toHaveLength(0);
      collector.unsubscribe();
    });
  });

  // ── 4. Cancel already completed turn ─────────────────────────────

  describe('Cancel already completed turn', () => {
    it('cancelTurn() after completeTurn() still returns the turn (status overwritten)', async () => {
      const turn = await registry.startTurn('agent-1', 'conv-1', 'interactive');

      // Complete the turn first.
      await registry.completeTurn(turn.turnId);

      // Verify the abort controller was cleaned up by completeTurn.
      const signalAfterComplete = registry.getAbortSignal(turn.turnId);
      expect(signalAfterComplete).toBeUndefined();

      // Attempting to cancel a completed turn — the turn still exists in the map
      // but the AbortController is already gone, so abort() won't be called
      const collector = collectEvents(bus, 'turn.completed');
      const result = await registry.cancelTurn(turn.turnId);

      // cancelTurn returns the turn (it exists in the map) but overwrites status.
      if (result) {
        expect(result.status).toBe('cancelled');
      }

      collector.unsubscribe();
    });

    it('AbortController is cleaned up after completeTurn()', async () => {
      const turn = await registry.startTurn('agent-1', 'conv-1', 'interactive');

      // Signal exists before completion
      expect(registry.getAbortSignal(turn.turnId)).toBeDefined();

      await registry.completeTurn(turn.turnId);

      // Signal cleaned up after completion
      expect(registry.getAbortSignal(turn.turnId)).toBeUndefined();
    });

    it('AbortController is cleaned up after completeTurn() with error', async () => {
      const turn = await registry.startTurn('agent-1', 'conv-1', 'interactive');

      expect(registry.getAbortSignal(turn.turnId)).toBeDefined();

      await registry.completeTurn(turn.turnId, 'something went wrong');

      expect(registry.getAbortSignal(turn.turnId)).toBeUndefined();
      expect(registry.getTurn(turn.turnId)!.status).toBe('error');
    });
  });

  // ── 5. Concurrent turns — cancel one, other continues ────────────

  describe('Concurrent turns — cancel one, other continues', () => {
    it('cancelling one turn does not affect another turn signal', async () => {
      const turn1 = await registry.startTurn('agent-1', 'conv-1', 'interactive', 'task 1');
      const turn2 = await registry.startTurn('agent-1', 'conv-2', 'interactive', 'task 2');

      const signal1 = registry.getAbortSignal(turn1.turnId)!;
      const signal2 = registry.getAbortSignal(turn2.turnId)!;

      expect(signal1.aborted).toBe(false);
      expect(signal2.aborted).toBe(false);

      // Cancel only turn 1.
      await registry.cancelTurn(turn1.turnId);

      expect(signal1.aborted).toBe(true);
      expect(signal2.aborted).toBe(false);

      // Turn 2 can still be completed normally.
      const result = await registry.completeTurn(turn2.turnId);
      expect(result!.status).toBe('completed');
    });

    it('concurrent cancellation emits distinct turn and sandbox session identities', async () => {
      const turn1 = await registry.startTurn('agent-1', 'conv-1', 'interactive');
      const turn2 = await registry.startTurn('agent-1', 'conv-2', 'interactive');

      const collector = collectEvents(bus, 'turn.completed');

      // Cancel turn 1, complete turn 2.
      await registry.cancelTurn(turn1.turnId);
      await registry.completeTurn(turn2.turnId);

      expect(collector.events).toHaveLength(2);

      const cancelEvent = collector.events.find((event) => event.turnId === turn1.turnId);
      const completeEvent = collector.events.find((event) => event.turnId === turn2.turnId);

      expect(cancelEvent).toBeDefined();
      expect(cancelEvent!.status).toBe('cancelled');
      expect(cancelEvent!.sandboxSessionId).toBe(turn1.sandboxSessionId);
      expect(cancelEvent!.sandboxSessionId).not.toBe(cancelEvent!.turnId);

      expect(completeEvent).toBeDefined();
      expect(completeEvent!.status).toBe('completed');
      expect(completeEvent!.sandboxSessionId).toBe(turn2.sandboxSessionId);
      expect(completeEvent!.sandboxSessionId).not.toBe(completeEvent!.turnId);

      collector.unsubscribe();
    });

    it('active turn count reflects cancellation correctly', async () => {
      const turn1 = await registry.startTurn('agent-1', 'conv-1', 'interactive');
      const turn2 = await registry.startTurn('agent-1', 'conv-2', 'interactive');
      await registry.startTurn('agent-1', 'conv-3', 'interactive');

      expect(registry.getActiveTurns('agent-1')).toHaveLength(3);

      await registry.cancelTurn(turn1.turnId);
      expect(registry.getActiveTurns('agent-1')).toHaveLength(2);

      await registry.cancelTurn(turn2.turnId);
      expect(registry.getActiveTurns('agent-1')).toHaveLength(1);
    });

    it('a cancelled turn frees a slot for a new concurrent turn', async () => {
      // Start turns up to the default limit (3).
      const turn1 = await registry.startTurn('agent-1', 'conv-1', 'interactive');
      await registry.startTurn('agent-1', 'conv-2', 'interactive');
      await registry.startTurn('agent-1', 'conv-3', 'interactive');

      // A fourth turn should fail at the limit.
      await expect(
        registry.startTurn('agent-1', 'conv-4', 'interactive'),
      ).rejects.toThrow(/Concurrent turn limit/);

      // Cancel one turn.
      await registry.cancelTurn(turn1.turnId);

      // Now a new turn should succeed.
      const turn4 = await registry.startTurn('agent-1', 'conv-4', 'interactive');
      expect(turn4).toBeDefined();
      expect(turn4.status).toBe('running');
    });
  });
});
