/**
 * HITL Continuation Across Restore — Integration Tests
 *
 * Validates the end-to-end story: after a HITL approval is granted the agent
 * receives a continuation message (assistant tool-call + tool-result pair)
 * via deliverTurn, and this flow is correct whether or not the session was
 * checkpointed while paused.
 *
 * Scope: InterruptResumeService (the real implementation, not mocked).
 * Does NOT touch hitl-lifecycle.test.ts or hitl-interrupt-flow.test.ts.
 *
 * Recon findings (ctx-le6):
 *   - Continuation mechanism: resumeWithInterruptResolution() reads the
 *     resolved interrupt from DB, reconstructs the tool-call pair from
 *     checkpointData.runnerState.pendingRequests (or falls back to the
 *     interrupt row itself), and calls deliverTurn() with those messages.
 *   - Checkpoint/restore: HITL pause state IS persisted — pendingRequests
 *     live in checkpointData, resolved action lives in the interrupts table.
 *     The service is checkpoint-aware; no bug found.
 */

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { InterruptResumeService } from '../../packages/ctxmill/src/orchestrator/session-manager/interrupt-resume-service.js';
import type {
  CheckpointV2,
  DatabaseRepository,
  InterruptRow,
  SandboxSessionRow,
} from '../../packages/ctxmill/src/database/repository.js';
import type { AgentDefinition, Message } from '@ctxmill/sandbox-daemon';
import type { SessionEvent } from '../../packages/ctxmill/src/orchestrator/session-turn-service.js';

// ── Minimal helpers ─────────────────────────────────────────────────────────

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function makeEventBus() {
  return { emitAsync: vi.fn().mockResolvedValue(undefined) };
}

function makeAgentDef(overrides?: Partial<AgentDefinition>): AgentDefinition {
  return {
    name: 'test-agent',
    harness: 'langgraph',
    harnessConfig: {},
    tools: [],
    systemPrompt: 'You are a test agent.',
    ...overrides,
  } as AgentDefinition;
}

function makeDbSession(overrides?: Partial<SandboxSessionRow>): SandboxSessionRow {
  return {
    id: 'sess-1',
    conversationId: 'conv-1',
    agentId: 'agent-1',
    containerName: 'ctxmill-sandbox-sess-1',
    containerId: 'c-1',
    status: 'CHECKPOINTED',
    harnessName: 'langgraph',
    checkpointRef: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastActivityAt: Date.now(),
    ...overrides,
  };
}

function makeResolvedInterrupt(overrides?: Partial<InterruptRow>): InterruptRow {
  return {
    id: 'interrupt-1',
    turnId: 'turn-1',
    agentId: 'agent-1',
    toolCallId: 'tc-approval-1',
    toolName: 'request-approval',
    args: { tool: 'send_email', args: { to: 'user@example.com', body: 'Hello' } },
    timeoutMs: 300_000,
    createdAt: Date.now(),
    expiresAt: Date.now() + 300_000,
    status: 'resolved',
    resolvedAction: 'approve',
    resolvedData: { reason: 'looks good' },
    sandboxSessionId: 'sess-1',
    ...overrides,
  } as InterruptRow;
}

function makeCheckpoint(checkpointData: Record<string, unknown>): CheckpointV2 {
  return {
    id: 'ckpt-1',
    sandboxSessionId: 'sess-1',
    agentId: 'agent-1',
    checkpointVersion: 2,
    checkpointData,
    harnessState: {},
    workspaceRef: null,
    suspendReason: 'hitl-wait',
    createdAt: Date.now(),
  };
}

/** Checkpoint that contains a pending approval request the way the real runner serialises it. */
function makeCheckpointWithApproval(toolCallId: string, toolName: string, toolArgs: Record<string, unknown>): CheckpointV2 {
  return makeCheckpoint({
    runnerState: {
      pendingRequests: [
        {
          type: 'approval',
          id: toolCallId,
          payload: { tool: toolName, args: toolArgs },
        },
      ],
    },
  });
}

/** Checkpoint that has runnerState but no approval-typed pending requests. */
function makeCheckpointWithoutApproval(): CheckpointV2 {
  return makeCheckpoint({ runnerState: { status: 'HITL_WAIT' } });
}

async function* streamEvents(...events: SessionEvent[]): AsyncGenerator<SessionEvent> {
  for (const event of events) yield event;
}

// ── Shared mock DB builder ──────────────────────────────────────────────────

interface MockDbOpts {
  dbSession?: SandboxSessionRow;
  resolvedInterrupts?: InterruptRow[];
  checkpoint?: CheckpointV2 | null;
  agentRow?: Record<string, unknown> | null;
}

function makeMockDb(opts: MockDbOpts = {}): Pick<
  DatabaseRepository,
  'getTurn' | 'getSandboxSession' | 'getResolvedInterruptsForSandboxSession' | 'getCheckpointV2' | 'addCanonicalMessage' | 'getAgent'
> {
  let messageSeq = 0;
  const canonicalMessages = new Map<string, Record<string, unknown>>();
  return {
    getTurn: vi.fn().mockResolvedValue({ status: 'running' }),
    getSandboxSession: vi.fn().mockResolvedValue(opts.dbSession ?? makeDbSession()),
    getResolvedInterruptsForSandboxSession: vi.fn().mockResolvedValue(opts.resolvedInterrupts ?? [makeResolvedInterrupt()]),
    getCheckpointV2: vi.fn().mockResolvedValue(opts.checkpoint !== undefined ? opts.checkpoint : makeCheckpointWithApproval('tc-approval-1', 'send_email', { to: 'user@example.com', body: 'Hello' })),
    addCanonicalMessage: vi.fn().mockImplementation(async (data: Record<string, unknown>) => {
      const id = typeof data.id === 'string' ? data.id : randomUUID();
      const existing = canonicalMessages.get(id);
      if (existing) return existing;
      const message = {
        id,
        createdAt: Date.now(),
        messageSeq: messageSeq++,
        messageRevision: 0,
        publishedRevision: -1,
        ...data,
      };
      canonicalMessages.set(id, message);
      return message;
    }),
    getAgent: vi.fn().mockResolvedValue(opts.agentRow ?? null),
  };
}

// ── Service factory ─────────────────────────────────────────────────────────

function makeService(opts: {
  db: ReturnType<typeof makeMockDb>;
  agentDef?: AgentDefinition;
  deliverTurn?: (sandboxSessionId: string, messages: Message[], turnId: string) => AsyncGenerator<SessionEvent>;
  eventBus?: ReturnType<typeof makeEventBus>;
  sandboxSessionId?: string;
}): InterruptResumeService {
  const agentDef = opts.agentDef ?? makeAgentDef();
  const resolvedSandboxSessionId = opts.sandboxSessionId ?? 'sess-1';

  const agentDefs = new Map<string, AgentDefinition>([['conv-1', agentDef]]);

  return new InterruptResumeService({
    db: opts.db,
    eventBus: opts.eventBus ?? makeEventBus(),
    stateStore: {
      getAgentDef: (conversationId: string) => agentDefs.get(conversationId) ?? undefined,
      setAgentDef: (conversationId: string, def: AgentDefinition) => { agentDefs.set(conversationId, def); },
    },
    logger: makeLogger(),
    ensureSession: vi.fn().mockResolvedValue({ sessionId: resolvedSandboxSessionId }),
    deliverTurn: opts.deliverTurn ?? (async function* () {}),
    resolveAgentDefinition: vi.fn().mockResolvedValue(null),
  });
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('HITL continuation across restore', () => {

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Test 1: continuation message fires after approval (no restore) ─────────

  describe('Test 1 — continuation message fires after approval (no restore)', () => {
    it('calls deliverTurn with an assistant tool-call message and a tool-result message after approval', async () => {
      const capturedCalls: Array<{ sandboxSessionId: string; messages: Message[]; turnId: string }> = [];

      const db = makeMockDb();
      const service = makeService({
        db,
        deliverTurn: async function* (sandboxSessionId, messages, turnId) {
          capturedCalls.push({ sandboxSessionId, messages, turnId });
          yield* streamEvents();
        },
      });

      await service.resumeWithInterruptResolution('sess-1', 'turn-1', 'agent-1', 'interrupt-1');

      // deliverTurn must have been called exactly once
      expect(capturedCalls).toHaveLength(1);
      const { sandboxSessionId, messages, turnId } = capturedCalls[0]!;

      // Session ID forwarded correctly
      expect(sandboxSessionId).toBe('sess-1');

      // The interrupt-derived ID is stable across process retries.
      expect(turnId).toBe('hitl-resume-d718a80a945f45badc81fb3dc779eb89');

      // Exactly two messages: assistant (tool-call) + tool (result)
      expect(messages).toHaveLength(2);

      const assistantMsg = messages[0]!;
      const toolMsg = messages[1]!;

      expect(assistantMsg.role).toBe('assistant');
      expect(assistantMsg.agentId).toBe('agent-1');
      expect(assistantMsg.toolCalls).toHaveLength(1);
      expect(assistantMsg.toolCalls![0]!.id).toBe('tc-approval-1');
      expect(assistantMsg.toolCalls![0]!.name).toBe('request-approval');

      expect(toolMsg.role).toBe('tool');
      expect(toolMsg.agentId).toBe('agent-1');
      expect(toolMsg.toolCallId).toBe('tc-approval-1');
      expect(toolMsg.content).toBe('APPROVED');
    });

    it('persists the assistant and tool messages to the database before delivering the turn', async () => {
      const db = makeMockDb();
      const eventBus = makeEventBus();
      const service = makeService({
        db,
        eventBus,
        deliverTurn: async function* () {},
      });

      await service.resumeWithInterruptResolution('sess-1', 'turn-1', 'agent-1', 'interrupt-1');

      // Canonical commit called twice — assistant then tool.
      expect(db.addCanonicalMessage).toHaveBeenCalledTimes(2);
      expect(db.addCanonicalMessage).toHaveBeenNthCalledWith(1, expect.objectContaining({
        role: 'assistant',
        agentId: 'agent-1',
        conversationId: 'conv-1',
        toolCalls: [expect.objectContaining({ id: 'tc-approval-1', name: 'request-approval' })],
      }));
      expect(db.addCanonicalMessage).toHaveBeenNthCalledWith(2, expect.objectContaining({
        role: 'tool',
        content: 'APPROVED',
        toolCallId: 'tc-approval-1',
      }));
      expect(eventBus.emitAsync).toHaveBeenCalledTimes(2);
      expect(eventBus.emitAsync).toHaveBeenNthCalledWith(
        1,
        'message.committed',
        expect.objectContaining({ role: 'assistant', messageSeq: 0 }),
      );
      expect(eventBus.emitAsync).toHaveBeenNthCalledWith(
        2,
        'message.committed',
        expect.objectContaining({ role: 'tool', messageSeq: 1 }),
      );
    });

    it('reuses deterministic continuation rows when canonical publication is retried', async () => {
      const db = makeMockDb();
      const eventBus = makeEventBus();
      eventBus.emitAsync
        .mockRejectedValueOnce(new Error('injected canonical publication failure'))
        .mockResolvedValue(undefined);
      let deliveries = 0;
      const service = makeService({
        db,
        eventBus,
        deliverTurn: async function* () {
          deliveries++;
          yield* streamEvents();
        },
      });

      await expect(
        service.resumeWithInterruptResolution('sess-1', 'turn-1', 'agent-1', 'interrupt-1'),
      ).rejects.toThrow(/injected canonical publication failure/);
      await service.resumeWithInterruptResolution('sess-1', 'turn-1', 'agent-1', 'interrupt-1');

      const inserts = db.addCanonicalMessage.mock.calls
        .map(([input]) => input as Record<string, unknown>);
      expect(inserts).toHaveLength(3);
      expect(inserts[0]?.role).toBe('assistant');
      expect(inserts[1]?.role).toBe('assistant');
      expect(inserts[0]?.id).toBe(inserts[1]?.id);
      expect(inserts[2]?.role).toBe('tool');
      expect(new Set(inserts.map((input) => input.id)).size).toBe(2);
      expect(deliveries).toBe(1);
    });

    it('produces a REJECTED tool message when the interrupt was rejected', async () => {
      const capturedMessages: Message[][] = [];

      const db = makeMockDb({
        resolvedInterrupts: [makeResolvedInterrupt({ resolvedAction: 'reject' })],
      });
      const service = makeService({
        db,
        deliverTurn: async function* (_sid, messages) {
          capturedMessages.push(messages);
          yield* streamEvents();
        },
      });

      await service.resumeWithInterruptResolution('sess-1', 'turn-1', 'agent-1', 'interrupt-1');

      expect(capturedMessages).toHaveLength(1);
      const toolMsg = capturedMessages[0]![1]!;
      expect(toolMsg.role).toBe('tool');
      expect(toolMsg.content).toBe('REJECTED');
    });

    it('does NOT call deliverTurn when no resolved interrupt matches the turnId', async () => {
      const capturedCalls: unknown[] = [];

      const db = makeMockDb({
        // interrupt exists but for a different turn
        resolvedInterrupts: [makeResolvedInterrupt({ turnId: 'other-turn' })],
      });
      const service = makeService({
        db,
        deliverTurn: async function* (_sid, messages, turnId) {
          capturedCalls.push({ messages, turnId });
          yield* streamEvents();
        },
      });

      await expect(
        service.resumeWithInterruptResolution(
          'sess-1',
          'turn-1',
          'agent-1',
          'interrupt-1',
        ),
      ).rejects.toThrow(/does not match continuation ownership/);

      expect(capturedCalls).toHaveLength(0);
    });
  });

  // ── Test 2: continuation across checkpoint/restore ────────────────────────

  describe('Test 2 — continuation message survives checkpoint/restore cycle', () => {
    /**
     * Simulate a checkpoint/restore cycle:
     *   1. An agent turn is paused mid-execution; the runner serialises its
     *      pending approval request into checkpointData.runnerState.pendingRequests.
     *   2. The process restarts (or the session is evicted) — the in-memory
     *      InterruptManager loses all state.
     *   3. The human approves via the REST endpoint; the approval is persisted
     *      to the interrupts table.
     *   4. resumeWithInterruptResolution is called with the restored session.
     *
     * The service must reconstruct the continuation messages from the checkpoint
     * and deliver them to the harness without any in-memory interrupt state.
     */
    it('delivers the continuation turn after restore when runnerState.pendingRequests contains the approval', async () => {
      const capturedCalls: Array<{ sandboxSessionId: string; messages: Message[]; turnId: string }> = [];

      // Checkpoint contains the serialised pending approval request
      const checkpointData = {
        runnerState: {
          pendingRequests: [
            {
              type: 'approval',
              id: 'tc-approval-restored',
              payload: { tool: 'delete_file', args: { path: '/critical/data.json' } },
            },
          ],
        },
      };
      const checkpoint = makeCheckpoint(checkpointData);

      // DB has the resolved interrupt (human approved while process was down)
      const resolvedInterrupt = makeResolvedInterrupt({
        turnId: 'turn-restored',
        toolCallId: 'tc-approval-restored',
        toolName: 'delete_file',
        args: { path: '/critical/data.json' },
        resolvedAction: 'approve',
      });

      const db = makeMockDb({
        dbSession: makeDbSession({ id: 'sess-restored', conversationId: 'conv-restored' }),
        resolvedInterrupts: [resolvedInterrupt],
        checkpoint,
      });

      // Build service with agent def cached for the restored conversation
      const agentDefs = new Map<string, AgentDefinition>([['conv-restored', makeAgentDef()]]);
      const service = new InterruptResumeService({
        db,
        eventBus: makeEventBus(),
        stateStore: {
          getAgentDef: (cid) => agentDefs.get(cid) ?? undefined,
          setAgentDef: (cid, def) => { agentDefs.set(cid, def); },
        },
        logger: makeLogger(),
        ensureSession: vi.fn().mockResolvedValue({ sessionId: 'sess-restored' }),
        deliverTurn: async function* (sandboxSessionId, messages, turnId) {
          capturedCalls.push({ sandboxSessionId, messages, turnId });
          yield* streamEvents();
        },
        resolveAgentDefinition: vi.fn().mockResolvedValue(null),
      });

      await service.resumeWithInterruptResolution(
        'sess-restored',
        'turn-restored',
        'agent-1',
        'interrupt-1',
      );

      // The continuation turn must have been delivered
      expect(capturedCalls).toHaveLength(1);
      const { sandboxSessionId, messages, turnId } = capturedCalls[0]!;

      expect(sandboxSessionId).toBe('sess-restored');
      expect(turnId).toBe('hitl-resume-d718a80a945f45badc81fb3dc779eb89');

      expect(messages).toHaveLength(2);
      const [assistantMsg, toolMsg] = messages;

      // The tool-call id must come from the checkpoint's pendingRequests, not a generated fallback
      expect(assistantMsg!.role).toBe('assistant');
      expect(assistantMsg!.toolCalls![0]!.id).toBe('tc-approval-restored');
      expect(assistantMsg!.toolCalls![0]!.name).toBe('request-approval');
      expect((assistantMsg!.toolCalls![0]! as unknown as Record<string, unknown>).arguments).toMatchObject({
        tool: 'delete_file',
        args: { path: '/critical/data.json' },
      });

      expect(toolMsg!.role).toBe('tool');
      expect(toolMsg!.content).toBe('APPROVED');
      expect(toolMsg!.toolCallId).toBe('tc-approval-restored');
    });

    it('falls back to interrupt-row data when checkpoint has no pendingRequests after restore', async () => {
      /**
       * Edge case: checkpoint exists but runnerState has no pendingRequests
       * (e.g. stale checkpoint from before the approval serialisation was added).
       * The service must fall back to the interrupt row's toolCallId/args.
       */
      const capturedCalls: Array<{ messages: Message[] }> = [];

      const resolvedInterrupt = makeResolvedInterrupt({
        turnId: 'turn-stale',
        toolCallId: 'tc-stale-fallback',
        args: { tool: 'send_slack', args: { channel: '#ops', text: 'alert' } },
        resolvedAction: 'approve',
      });

      const db = makeMockDb({
        dbSession: makeDbSession({ id: 'sess-stale', conversationId: 'conv-stale' }),
        resolvedInterrupts: [resolvedInterrupt],
        checkpoint: makeCheckpointWithoutApproval(), // no pendingRequests
      });

      const agentDefs = new Map<string, AgentDefinition>([['conv-stale', makeAgentDef()]]);
      const service = new InterruptResumeService({
        db,
        eventBus: makeEventBus(),
        stateStore: {
          getAgentDef: (cid) => agentDefs.get(cid) ?? undefined,
          setAgentDef: (cid, def) => { agentDefs.set(cid, def); },
        },
        logger: makeLogger(),
        ensureSession: vi.fn().mockResolvedValue({ sessionId: 'sess-stale' }),
        deliverTurn: async function* (_sid, messages) {
          capturedCalls.push({ messages });
          yield* streamEvents();
        },
        resolveAgentDefinition: vi.fn().mockResolvedValue(null),
      });

      await service.resumeWithInterruptResolution(
        'sess-stale',
        'turn-stale',
        'agent-1',
        'interrupt-1',
      );

      expect(capturedCalls).toHaveLength(1);
      const [assistantMsg, toolMsg] = capturedCalls[0]!.messages;

      // Fallback uses the interrupt row's toolCallId
      expect(assistantMsg!.toolCalls![0]!.id).toBe('tc-stale-fallback');
      expect(toolMsg!.content).toBe('APPROVED');
      expect(toolMsg!.toolCallId).toBe('tc-stale-fallback');
    });

    it('persists both messages to DB when delivering a continuation after restore', async () => {
      const db = makeMockDb({
        dbSession: makeDbSession({ id: 'sess-r2', conversationId: 'conv-r2' }),
        resolvedInterrupts: [makeResolvedInterrupt({
          turnId: 'turn-r2',
          toolCallId: 'tc-r2',
          resolvedAction: 'approve',
        })],
        checkpoint: makeCheckpointWithApproval('tc-r2', 'send_email', { to: 'ops@example.com' }),
      });

      const agentDefs = new Map<string, AgentDefinition>([['conv-r2', makeAgentDef()]]);
      const service = new InterruptResumeService({
        db,
        eventBus: makeEventBus(),
        stateStore: {
          getAgentDef: (cid) => agentDefs.get(cid) ?? undefined,
          setAgentDef: (cid, def) => { agentDefs.set(cid, def); },
        },
        logger: makeLogger(),
        ensureSession: vi.fn().mockResolvedValue({ sessionId: 'sess-r2' }),
        deliverTurn: async function* () {},
        resolveAgentDefinition: vi.fn().mockResolvedValue(null),
      });

      await service.resumeWithInterruptResolution(
        'sess-r2',
        'turn-r2',
        'agent-1',
        'interrupt-1',
      );

      expect(db.addCanonicalMessage).toHaveBeenCalledTimes(2);
      expect(db.addCanonicalMessage).toHaveBeenNthCalledWith(1, expect.objectContaining({
        role: 'assistant',
        conversationId: 'conv-r2',
        toolCalls: [expect.objectContaining({ id: 'tc-r2', name: 'request-approval' })],
      }));
      expect(db.addCanonicalMessage).toHaveBeenNthCalledWith(2, expect.objectContaining({
        role: 'tool',
        content: 'APPROVED',
        toolCallId: 'tc-r2',
        conversationId: 'conv-r2',
      }));
    });
  });

  // ── getPendingApprovalRequests unit-level contract ─────────────────────────

  describe('getPendingApprovalRequests — checkpoint parsing contract', () => {
    /**
     * These tests pin the exact shape of checkpointData that the service
     * expects so that any future checkpoint schema change that would break
     * HITL continuation is immediately visible.
     */
    it('extracts all typed entries from runnerState.pendingRequests (type filter is at call site)', () => {
      const db = makeMockDb();
      const service = makeService({ db });

      const result = service.getPendingApprovalRequests({
        runnerState: {
          pendingRequests: [
            { type: 'approval', id: 'tc-1', payload: { tool: 'do_thing', args: { x: 1 } } },
            { type: 'other', id: 'tc-2', payload: {} },
          ],
        },
      });

      // getPendingApprovalRequests returns all valid entries regardless of type;
      // the caller (.filter(type === 'approval') in resumeWithInterruptResolution) does the filtering.
      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({ type: 'approval', id: 'tc-1', payload: { tool: 'do_thing', args: { x: 1 } } });
      expect(result[1]).toMatchObject({ type: 'other', id: 'tc-2' });
    });

    it('returns empty array when checkpointData is undefined', () => {
      const db = makeMockDb();
      const service = makeService({ db });
      expect(service.getPendingApprovalRequests(undefined)).toEqual([]);
    });

    it('returns empty array when runnerState has no pendingRequests', () => {
      const db = makeMockDb();
      const service = makeService({ db });
      expect(service.getPendingApprovalRequests({ runnerState: { status: 'HITL_WAIT' } })).toEqual([]);
    });

    it('handles JSON-encoded payload strings', () => {
      const db = makeMockDb();
      const service = makeService({ db });
      const result = service.getPendingApprovalRequests({
        runnerState: {
          pendingRequests: [
            {
              type: 'approval',
              id: 'tc-json',
              payload: JSON.stringify({ tool: 'bash', args: { cmd: 'ls' } }),
            },
          ],
        },
      });
      expect(result[0]!.payload).toEqual({ tool: 'bash', args: { cmd: 'ls' } });
    });
  });
});
