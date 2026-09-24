import { create } from '@bufbuild/protobuf';
import { KillSessionRequestSchema } from '@stablehand/proto/sandbox/v1';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  flushOpenTelemetry: vi.fn(async () => true),
  killSession: vi.fn(async () => undefined),
}));

vi.mock('../../observability/telemetry-flush.js', () => ({
  flushOpenTelemetry: mocks.flushOpenTelemetry,
}));

vi.mock('../runner.js', () => ({
  openSession: vi.fn(),
  deliverTurn: vi.fn(async function* () {}),
  renewTurnDeliveryCapability: vi.fn(),
  suspendSession: vi.fn(),
  killSession: mocks.killSession,
}));

import { handleKillSession } from '../daemon.js';

describe('sandbox daemon telemetry lifecycle', () => {
  it('flushes completed streaming spans before KillSession returns', async () => {
    const response = await handleKillSession(create(KillSessionRequestSchema, {
      sessionId: 'sandbox-session-1',
      reason: 'benchmark cleanup',
    }));

    expect(response.finalStatus).toBe('killed');
    expect(mocks.killSession).toHaveBeenCalledWith('sandbox-session-1');
    expect(mocks.flushOpenTelemetry).toHaveBeenCalledOnce();
    expect(mocks.killSession.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.flushOpenTelemetry.mock.invocationCallOrder[0]!,
    );
  });
});
