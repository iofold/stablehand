import { describe, expect, it, vi } from 'vitest';

import { TypedEventBus } from '../../events/bus.js';
import { ArtifactRegistrationService } from '../registration-service.js';

function artifactRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'artifact-1',
    agentId: 'agent-1',
    turnId: 'turn-1',
    conversationId: 'conversation-1',
    name: 'report.json',
    mimeType: 'application/json',
    sizeBytes: 42,
    storageKey: 'artifacts/artifact-1/report.json',
    bucket: 'artifacts',
    kind: 'eval_report',
    metadata: { suite: 'smoke' },
    status: 'active',
    expiresAt: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('ArtifactRegistrationService', () => {
  it('emits one typed artifact.created event after persistence', async () => {
    const row = artifactRow();
    const repository = { saveArtifact: vi.fn().mockResolvedValue(row) };
    const eventBus = new TypedEventBus();
    const emit = vi.spyOn(eventBus, 'emit');
    const service = new ArtifactRegistrationService({
      repository: repository as never,
      eventBus,
      now: () => 123,
    });

    await expect(service.register(row as never)).resolves.toEqual(row);
    expect(emit).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledWith('artifact.created', {
      artifactId: 'artifact-1',
      agentId: 'agent-1',
      turnId: 'turn-1',
      name: 'report.json',
      mimeType: 'application/json',
      sizeBytes: 42,
      kind: 'eval_report',
      timestamp: 123,
    });
  });

  it('does not emit when a fenced registration loses delivery ownership', async () => {
    const repository = { saveArtifactIfDeliveryOwned: vi.fn().mockResolvedValue(undefined) };
    const eventBus = new TypedEventBus();
    const emit = vi.spyOn(eventBus, 'emit');
    const service = new ArtifactRegistrationService({
      repository: repository as never,
      eventBus,
    });

    await expect(service.registerIfDeliveryOwned(
      artifactRow() as never,
      { turnId: 'turn-1' } as never,
    )).resolves.toBeUndefined();
    expect(emit).not.toHaveBeenCalled();
  });
});
