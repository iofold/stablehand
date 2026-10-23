import type { StartupPhaseRecorder } from '../util/startup-timeline.js';

export interface RuntimeApiListenOptions {
  port: number;
  host: string;
}

export interface RuntimeApiServer {
  listen(options: RuntimeApiListenOptions): Promise<string>;
}

export interface RecoverableRuntime {
  containerManager: {
    rehydrateAccounting?: () => Promise<number>;
  };
  lifecyclePolicy: {
    start(): Promise<void>;
  };
  reconcileStrandedTurns(bootTimeMs: number): Promise<unknown>;
  scheduleService: {
    start(): Promise<void>;
  };
}

export interface StartRuntimeApiOptions {
  server: RuntimeApiServer;
  runtime: RecoverableRuntime;
  listen: RuntimeApiListenOptions;
  bootTimeMs?: number;
  /** Receives one phase per recovery stage and `listen` (ctx-new8). */
  timeline?: StartupPhaseRecorder;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runStartupStage<T>(
  label: string,
  action: () => Promise<T>,
): Promise<T> {
  try {
    return await action();
  } catch (error) {
    throw new Error(`${label} failed: ${describeError(error)}`, {
      cause: error,
    });
  }
}

/** Running turns handed to crash takeover (ADR 025), when the runtime reports them. */
function takeoverDetail(result: unknown): string | undefined {
  if (typeof result !== 'object' || result === null || !('adopting' in result)) {
    return undefined;
  }
  const adopting = result.adopting;
  return typeof adopting === 'number' && adopting > 0
    ? `taking over ${adopting} running turn(s)`
    : undefined;
}

/**
 * Reconstruct durable runtime ownership before Fastify runs `onReady` hooks or
 * accepts traffic. The interrupt-resume worker starts from an `onReady` hook,
 * so `listen` must remain the final operation in this barrier.
 */
export async function startRuntimeApi(
  options: StartRuntimeApiOptions,
): Promise<string> {
  const bootTimeMs = options.bootTimeMs ?? Date.now();
  const timeline = options.timeline;
  const rehydrateAccounting =
    options.runtime.containerManager.rehydrateAccounting;
  if (rehydrateAccounting) {
    await runStartupStage(
      'Container slot-accounting rehydration',
      () => rehydrateAccounting.call(options.runtime.containerManager),
    );
  }
  timeline?.mark('slot-accounting');
  await runStartupStage(
    'Sandbox lifecycle startup reconciliation',
    () => options.runtime.lifecyclePolicy.start(),
  );
  timeline?.mark('sandbox-reconciliation');
  const turns = await runStartupStage(
    'Stranded-turn startup reconciliation',
    () => options.runtime.reconcileStrandedTurns(bootTimeMs),
  );
  timeline?.mark('turn-reconciliation', takeoverDetail(turns));
  await runStartupStage(
    'Schedule service startup',
    () => options.runtime.scheduleService.start(),
  );
  timeline?.mark('schedules');
  const address = await options.server.listen(options.listen);
  timeline?.mark('listen');
  return address;
}
