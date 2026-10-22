import { describe, expect, it, vi } from 'vitest';

import { TypedEventBus } from '../../events/bus.js';
import type { InterruptManager } from '../../orchestrator/interrupt.js';
import {
  DefaultOrchestratorToolRegistry,
  registerDefaultToolHandlers,
} from '../../orchestrator/grpc/orchestrator-service.js';
import { EDIT_DOCUMENT_TOOL_NAME, editDocumentResult } from '../builtin/edit-document.js';

describe('edit_document', () => {
  it('returns the edited text, the plain approval, or the rejection note', () => {
    expect(JSON.parse(editDocumentResult('draft', { action: 'approve' })))
      .toEqual({ approved: true, edited: false, content: 'draft' });
    expect(JSON.parse(editDocumentResult('draft', { action: 'approve', data: { content: 'better draft', note: 'cut the hype' } })))
      .toEqual({ approved: true, edited: true, content: 'better draft', note: 'cut the hype' });
    expect(JSON.parse(editDocumentResult('draft', { action: 'reject', data: { note: 'Not this week.' } })))
      .toEqual({ approved: false, note: 'Not this week.' });
    expect(JSON.parse(editDocumentResult('draft', { action: 'reject', data: 'Too long' })))
      .toEqual({ approved: false, note: 'Too long' });
  });

  it('waits on an interrupt with the draft and hands back what the reviewer decided', async () => {
    const waitForApproval = vi.fn<InterruptManager['waitForApproval']>()
      .mockResolvedValue({ action: 'approve', data: { content: 'Edited post' } });
    const registry = new DefaultOrchestratorToolRegistry();
    registerDefaultToolHandlers(registry, {
      eventBus: new TypedEventBus(),
      interruptManager: { waitForApproval } as unknown as InterruptManager,
    });

    const handler = registry.get(EDIT_DOCUMENT_TOOL_NAME, 'agent-1');
    expect(handler).toBeDefined();
    const result = await handler!(
      { title: 'LinkedIn post', content: 'Original post', format: 'linkedin' },
      { turnId: 'turn-1', agentId: 'agent-1', requestId: 'req-1', conversationId: 'conv-1' },
    );
    expect(JSON.parse(result)).toEqual({ approved: true, edited: true, content: 'Edited post' });
    expect(waitForApproval).toHaveBeenCalledWith(
      'turn-1',
      'agent-1',
      'req-1',
      'edit_document',
      { title: 'LinkedIn post', content: 'Original post', format: 'linkedin' },
      300_000,
      undefined,
      'conv-1',
      undefined,
    );

    const invalid = await handler!({ title: 'x' }, { turnId: 't', agentId: 'agent-1', requestId: 'r' });
    expect(JSON.parse(invalid).error).toMatch(/title and the full content/);
  });
});
