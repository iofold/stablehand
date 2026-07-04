import { vi } from 'vitest';

import { RunStartupService } from '../run-startup-service.js';

type ExecutionDeps = Parameters<RunStartupService['configureExecution']>[0];

/**
 * Real RunStartupService wired like production (ctx-4jp): prepareRunStart and
 * launchPreparedRun run their actual logic against in-memory execution deps,
 * so route tests exercise the same startup contract the server does.
 */
export function createTestRunStartupService(overrides: Partial<ExecutionDeps> = {}): RunStartupService {
  const service = new RunStartupService({ logger: console });

  const db = overrides.db ?? ({
    addMessage: vi.fn(async (input: { agentId: string; conversationId: string }) => ({
      id: `msg-${Math.random().toString(36).slice(2, 10)}`,
      ...input,
    })),
    createConversation: vi.fn(async (agentId: string, id?: string) => ({
      id: id ?? `conv-${Math.random().toString(36).slice(2, 10)}`,
      agentId,
    })),
    createTurn: vi.fn(async (input: { id?: string }) => ({
      id: input.id ?? `turn-${Math.random().toString(36).slice(2, 10)}`,
    })),
    deleteMessage: vi.fn(async () => undefined),
    getConversation: vi.fn(async () => undefined),
    getMessages: vi.fn(async () => []),
    getTurn: vi.fn(async () => undefined),
    updateTurn: vi.fn(async () => undefined),
    finalizeTurnIfOpen: vi.fn(async () => true),
  } as unknown as ExecutionDeps['db']);

  service.configureExecution({
    db,
    eventBus: overrides.eventBus,
    sessionManager: overrides.sessionManager ?? null,
    agentSessionService: overrides.agentSessionService
      ?? ({ executeSession: vi.fn(async () => {}) } as unknown as ExecutionDeps['agentSessionService']),
  });

  return service;
}
