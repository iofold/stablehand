import {
  SpanStatusCode,
  metrics,
  trace,
  type Attributes,
  type Exception,
} from '@opentelemetry/api';

export const PERFORMANCE_PHASES = [
  'turn.execute',
  'session.ensure',
  'session.create',
  'session.restore',
  'workspace.prepare',
  'workspace.restore',
  'sandbox.queue',
  'sandbox.create',
  'sandbox.start',
  'sandbox.ready',
  'harness.open',
  'turn.first_event',
  'turn.first_token',
  'turn.delivery',
  'event.persist',
  'checkpoint.suspend',
] as const;

export type PerformancePhase = (typeof PERFORMANCE_PHASES)[number];
export type PerformanceAttributeValue = string | number | boolean;
export type PerformanceAttributes = Record<
  string,
  PerformanceAttributeValue | undefined
>;
export type PerformanceOutcome = 'ok' | 'error' | 'cancelled' | 'empty';

export interface PerformanceObservation {
  phase: PerformancePhase;
  durationMs: number;
  outcome: PerformanceOutcome;
}

export interface PerformanceSpan {
  setAttribute(
    key: string,
    value: PerformanceAttributeValue,
  ): PerformanceSpan;
  setStatus(status: { code: number; message?: string }): PerformanceSpan;
  recordException(exception: Exception): void;
  end(): void;
}

export interface PerformanceMeasurement {
  setAttribute(key: string, value: PerformanceAttributeValue): void;
  end(
    outcome?: PerformanceOutcome,
    error?: unknown,
  ): PerformanceObservation;
}

export interface PerformanceRecorder {
  start(
    phase: PerformancePhase,
    attributes?: PerformanceAttributes,
  ): PerformanceMeasurement;
  measure<T>(
    phase: PerformancePhase,
    attributes: PerformanceAttributes,
    operation: () => Promise<T>,
  ): Promise<T>;
}

type ActiveSpanRunner = <T>(
  name: string,
  attributes: Record<string, PerformanceAttributeValue>,
  operation: (span: PerformanceSpan) => T,
) => T;

interface PerformanceInstrumentationOptions {
  now?: () => number;
  startSpan?: (
    name: string,
    attributes: Record<string, PerformanceAttributeValue>,
  ) => PerformanceSpan;
  startActiveSpan?: ActiveSpanRunner;
  recordDuration?: (
    durationMs: number,
    attributes: Record<string, PerformanceAttributeValue>,
  ) => void;
}

const LOW_CARDINALITY_METRIC_ATTRIBUTES: ReadonlySet<string> = new Set([
  'stablehand.harness',
  'stablehand.mode',
  'stablehand.outcome',
  'stablehand.phase',
  'stablehand.runtime',
  'stablehand.session.state',
  'stablehand.topology',
]);

function definedAttributes(
  attributes: PerformanceAttributes,
): Record<string, PerformanceAttributeValue> {
  return Object.fromEntries(
    Object.entries(attributes).filter(
      (entry): entry is [string, PerformanceAttributeValue] =>
        entry[1] !== undefined,
    ),
  );
}

function metricAttributes(
  attributes: Record<string, PerformanceAttributeValue>,
): Record<string, PerformanceAttributeValue> {
  return Object.fromEntries(
    Object.entries(attributes).filter(([key]) =>
      LOW_CARDINALITY_METRIC_ATTRIBUTES.has(key),
    ),
  );
}

function errorValue(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Small manual-instrumentation layer for benchmark-critical lifecycle phases.
 *
 * Turn/session/container identifiers stay on traces for correlation. Histograms
 * receive only the bounded attributes above, so enabling the OTLP metrics
 * exporter cannot create an unbounded time-series cardinality explosion.
 */
export class PerformanceInstrumentation implements PerformanceRecorder {
  private readonly now: () => number;
  private readonly startSpan: NonNullable<
    PerformanceInstrumentationOptions['startSpan']
  >;
  private readonly startActiveSpan: ActiveSpanRunner;
  private readonly recordDuration: NonNullable<
    PerformanceInstrumentationOptions['recordDuration']
  >;

  constructor(options: PerformanceInstrumentationOptions = {}) {
    const tracer = trace.getTracer('stablehand.performance', '0.1.0');
    const duration = metrics
      .getMeter('stablehand.performance', '0.1.0')
      .createHistogram('stablehand.lifecycle.duration', {
        description: 'Duration of a STABLEHAND lifecycle phase',
        unit: 'ms',
      });

    this.now = options.now ?? (() => performance.now());
    this.startSpan = options.startSpan
      ?? ((name, attributes) => tracer.startSpan(name, { attributes }));
    this.startActiveSpan = options.startActiveSpan
      ?? ((name, attributes, operation) =>
        tracer.startActiveSpan(
          name,
          { attributes },
          (span) => operation(span),
        ));
    this.recordDuration = options.recordDuration
      ?? ((durationMs, attributes) => duration.record(durationMs, attributes));
  }

  start(
    phase: PerformancePhase,
    attributes: PerformanceAttributes = {},
  ): PerformanceMeasurement {
    const initialAttributes = {
      ...definedAttributes(attributes),
      'stablehand.phase': phase,
    };
    const span = this.startSpan(`stablehand.${phase}`, initialAttributes);
    return this.createMeasurement(phase, initialAttributes, span, this.now());
  }

  async measure<T>(
    phase: PerformancePhase,
    attributes: PerformanceAttributes,
    operation: () => Promise<T>,
  ): Promise<T> {
    const initialAttributes = {
      ...definedAttributes(attributes),
      'stablehand.phase': phase,
    };

    return this.startActiveSpan(
      `stablehand.${phase}`,
      initialAttributes,
      async (span) => {
        const measurement = this.createMeasurement(
          phase,
          initialAttributes,
          span,
          this.now(),
        );
        try {
          const result = await operation();
          measurement.end('ok');
          return result;
        } catch (error) {
          measurement.end('error', error);
          throw error;
        }
      },
    );
  }

  private createMeasurement(
    phase: PerformancePhase,
    initialAttributes: Record<string, PerformanceAttributeValue>,
    span: PerformanceSpan,
    startedAt: number,
  ): PerformanceMeasurement {
    const attributes = { ...initialAttributes };
    let observation: PerformanceObservation | undefined;

    return {
      setAttribute: (key, value) => {
        attributes[key] = value;
        span.setAttribute(key, value);
      },
      end: (outcome = 'ok', error) => {
        if (observation) {
          return observation;
        }

        const durationMs = Math.max(0, this.now() - startedAt);
        attributes['stablehand.outcome'] = outcome;
        attributes['stablehand.duration_ms'] = durationMs;
        span.setAttribute('stablehand.outcome', outcome);
        span.setAttribute('stablehand.duration_ms', durationMs);

        if (error !== undefined) {
          const normalized = errorValue(error);
          span.recordException(normalized);
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: normalized.message,
          });
        } else {
          span.setStatus({ code: SpanStatusCode.OK });
        }

        this.recordDuration(durationMs, metricAttributes(attributes));
        span.end();
        observation = { phase, durationMs, outcome };
        return observation;
      },
    };
  }
}

export const performanceInstrumentation = new PerformanceInstrumentation();

export function traceAttributes(
  attributes: PerformanceAttributes,
): Attributes {
  return definedAttributes(attributes);
}
