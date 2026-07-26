import { ProxyTracerProvider, type TracerProvider } from '@opentelemetry/api';
import { describe, expect, it, vi } from 'vitest';

import { flushOpenTelemetry } from '../telemetry-flush.js';

describe('flushOpenTelemetry', () => {
  it('flushes the SDK provider hidden behind the global proxy', async () => {
    const forceFlush = vi.fn(async () => undefined);
    const delegate = {
      forceFlush,
      getTracer: vi.fn(),
    } satisfies TracerProvider & { forceFlush(): Promise<void> };
    const provider = new ProxyTracerProvider();
    provider.setDelegate(delegate);

    await expect(flushOpenTelemetry(provider)).resolves.toBe(true);
    expect(forceFlush).toHaveBeenCalledOnce();
  });

  it('is a no-op when tracing has no flushable SDK provider', async () => {
    const provider = {
      getTracer: vi.fn(),
    } satisfies TracerProvider;

    await expect(flushOpenTelemetry(provider)).resolves.toBe(false);
  });
});
