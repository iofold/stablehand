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

/**
 * Reconstruct durable runtime ownership before Fastify runs `onReady` hooks or
 * accepts traffic. The interrupt-resume worker starts from an `onReady` hook,
 * so `listen` must remain the final operation in this barrier.
 */
export async function startRuntimeApi(
  options: StartRuntimeApiOptions,
): Promise<string> {
  const bootTimeMs = options.bootTimeMs ?? Date.now();
  const rehydrateAccounting =
    options.runtime.containerManager.rehydrateAccounting;
  if (rehydrateAccounting) {
    await runStartupStage(
      'Container slot-accounting rehydration',
      () => rehydrateAccounting.call(options.runtime.containerManager),
    );
  }
  await runStartupStage(
    'Sandbox lifecycle startup reconciliation',
    () => options.runtime.lifecyclePolicy.start(),
  );
  await runStartupStage(
    'Stranded-turn startup reconciliation',
    () => options.runtime.reconcileStrandedTurns(bootTimeMs),
  );
  await runStartupStage(
    'Schedule service startup',
    () => options.runtime.scheduleService.start(),
  );
  return options.server.listen(options.listen);
}
