import { create } from '@bufbuild/protobuf';
import {
  FreshBootstrapSchema,
  OpenSessionRequestSchema,
  RestoreBootstrapSchema,
  SessionCheckpointSchema,
  ToolLocation,
  ToolMetadataSchema,
} from '@ctxmill/proto/sandbox/v1';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getSessionTools } from '../daemon.js';

const mocks = vi.hoisted(() => ({
  generatePtcScripts: vi.fn(async () => [] as string[]),
  harnessOpenSession: vi.fn(),
  harnessClose: vi.fn(async () => undefined),
}));

vi.mock('../../harness/langgraph.js', () => ({
  LangGraphHarness: class {
    async openSession(...args: Parameters<typeof mocks.harnessOpenSession>) {
      return await mocks.harnessOpenSession(...args);
    }
  },
}));

vi.mock('../ptc-codegen.js', () => ({
  generatePtcScripts: mocks.generatePtcScripts,
}));

async function importRunner() {
  return await import('../runner.js');
}

describe('runner openSession PTC bootstrap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.harnessOpenSession.mockResolvedValue({
      deliverTurn: async function* () {},
      exportState: async () => ({}),
      close: mocks.harnessClose,
    });
  });

  afterEach(async () => {
    const { killSession, resetOrchestratorClient } = await importRunner();
    await killSession();
    resetOrchestratorClient();
  });

  it('uses the fresh workspaceDir when generating PTC scripts', async () => {
    const { openSession } = await importRunner();
    const req = create(OpenSessionRequestSchema, {
      bootstrap: {
        case: 'fresh',
        value: create(FreshBootstrapSchema, {
          agentId: 'agent-1',
          conversationId: 'conv-1',
          harnessName: 'langgraph',
          harnessConfigJson: '{}',
          systemPrompt: 'Prompt',
          workspaceDir: '/tmp/custom-workspace',
          tools: [
            create(ToolMetadataSchema, {
              name: 'search',
              description: 'Search docs',
              inputSchemaJson: '{"type":"object"}',
              location: ToolLocation.ORCHESTRATOR,
              programmatic: true,
            }),
          ],
        }),
      },
    });

    await openSession(req, {});

    expect(mocks.generatePtcScripts).toHaveBeenCalledWith(expect.objectContaining({
      scriptDir: '/tmp/custom-workspace/.tools',
      tools: [expect.objectContaining({ name: 'search', programmatic: true })],
    }));
  });

  it('reconstructs restore tools, repopulates daemon state, and regenerates PTC scripts', async () => {
    const { openSession } = await importRunner();
    const req = create(OpenSessionRequestSchema, {
      bootstrap: {
        case: 'restore',
        value: create(RestoreBootstrapSchema, {
          sessionCheckpoint: create(SessionCheckpointSchema, {
            checkpointVersion: 2,
            sessionId: 'session-restore',
            conversationId: 'conv-restore',
            harnessName: 'langgraph',
            workspaceRef: {
              strategy: 'dir',
              reference: '/tmp/restore-workspace',
            },
            harnessState: { restored: true },
          }),
          agentId: 'agent-restore',
          harnessConfigJson: '{"model":"claude-sonnet-4-6"}',
          systemPrompt: 'Restore system prompt',
          tools: [
            create(ToolMetadataSchema, {
              name: 'search',
              description: 'Search docs',
              inputSchemaJson: '{"type":"object"}',
              location: ToolLocation.ORCHESTRATOR,
              programmatic: true,
            }),
          ],
        }),
      },
    });

    await openSession(req, {});

    expect(mocks.generatePtcScripts).toHaveBeenCalledWith(expect.objectContaining({
      scriptDir: '/tmp/restore-workspace/.tools',
      tools: [expect.objectContaining({ name: 'search', programmatic: true })],
    }));
    expect(getSessionTools()).toEqual([
      expect.objectContaining({ name: 'search', programmatic: true }),
    ]);
    expect(mocks.harnessOpenSession).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-restore',
        systemPrompt: 'Restore system prompt',
        harnessConfigJson: '{"model":"claude-sonnet-4-6"}',
        workspaceDir: '/tmp/restore-workspace',
        tools: [expect.objectContaining({ name: 'search', programmatic: true })],
      }),
      expect.objectContaining({
        stateVersion: '2',
        payload: { restored: true },
      }),
    );
  });
});
