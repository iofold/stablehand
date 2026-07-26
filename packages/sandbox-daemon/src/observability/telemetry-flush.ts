import {
  diag,
  ProxyTracerProvider,
  trace,
  type TracerProvider,
} from '@opentelemetry/api';

const DEFAULT_FLUSH_TIMEOUT_MS = 2_000;

interface FlushableTracerProvider extends TracerProvider {
  forceFlush(): Promise<void>;
}

function isFlushableTracerProvider(
  provider: TracerProvider,
): provider is FlushableTracerProvider {
  return 'forceFlush' in provider
    && typeof provider.forceFlush === 'function';
}

/**
 * Flush completed spans before an ephemeral sandbox is removed.
 *
 * OpenTelemetry exposes its SDK tracer provider behind a global proxy. The
 * standard TracerProvider interface omits lifecycle methods, so unwrap the
 * proxy and feature-detect forceFlush without depending on SDK internals.
 * Telemetry remains best-effort: exporter failure or timeout must not prevent
 * sandbox cleanup.
 */
export async function flushOpenTelemetry(
  provider: TracerProvider = trace.getTracerProvider(),
  timeoutMs = DEFAULT_FLUSH_TIMEOUT_MS,
): Promise<boolean> {
  const delegate = provider instanceof ProxyTracerProvider
    ? provider.getDelegate()
    : provider;
  if (!isFlushableTracerProvider(delegate)) {
    return false;
  }

  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      delegate.forceFlush().then(
        () => true,
        (error: unknown) => {
          diag.warn('OpenTelemetry forceFlush failed', error);
          return false;
        },
      ),
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => {
          diag.warn(`OpenTelemetry forceFlush timed out after ${timeoutMs}ms`);
          resolve(false);
        }, timeoutMs);
        timeout.unref();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
