import { describe, it, expect } from 'vitest';
import type {
  ApiAgent,
  ApiAgentRun,
  ApiMessage,
  ApiKnowledgeItem,
  ApiToolCallState,
  ApiA2UIBlock,
  ApiInterruptPayload,
  ApiFeedbackRequest,
} from '@ctxmill/shared';

describe('Shared API contract types', () => {
  it('should type-check ApiAgent', () => {
    const agent: ApiAgent = {
      id: 'a1',
      name: 'test',
      status: 'running',
      tools: ['t1'],
      model: 'gpt-4',
    };
    expect(agent.id).toBe('a1');
  });

  it('should type-check ApiMessage', () => {
    const msg: ApiMessage = {
      id: 'm1',
      role: 'assistant',
      content: 'hello',
      createdAt: new Date().toISOString(),
    };
    expect(msg.role).toBe('assistant');
  });

  it('should type-check ApiAgentRun', () => {
    const run: ApiAgentRun = {
      id: 'r1',
      agentId: 'a1',
      conversationId: 'c1',
      status: 'running',
      mode: 'interactive',
      startedAt: Date.now(),
    };
    expect(run.status).toBe('running');
  });

  it('should type-check ApiInterruptPayload', () => {
    const interrupt: ApiInterruptPayload = {
      agentId: 'a1',
      toolName: 'exec',
      args: { cmd: 'ls' },
      toolCallId: 'tc1',
    };
    expect(interrupt.toolName).toBe('exec');
  });
});
