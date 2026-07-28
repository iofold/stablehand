import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createContainer,
  type AppContainer,
  type AppContainerOptions,
} from '../../packages/ctxmill/src/config/container.js';
import type { CTXMillConfig } from '../../packages/ctxmill/src/config/types.js';
import {
  createServer,
  type ServerOptions,
} from '../../packages/ctxmill/src/orchestrator/server.js';
import { resolveTestDatabaseUrl } from './test-db.js';

export interface TestAppHandle {
  app: Awaited<ReturnType<typeof createServer>>;
  container: AppContainer;
  dataDir: string;
  restart: (overrides?: TestServerOverrides) => Promise<Awaited<ReturnType<typeof createServer>>>;
  close: () => Promise<void>;
}

type TestServerOverrides =
  | Partial<ServerOptions>
  | ((ctx: { container: AppContainer; dataDir: string }) => Partial<ServerOptions>);

interface CreateTestAppOptions {
  dirPrefix?: string;
  config?: CTXMillConfig;
  databaseUrl?: string;
  serverOptions?: TestServerOverrides;
  containerRetriesOnAlreadyExists?: number;
}

function buildContainerConfig(options: CreateTestAppOptions): CTXMillConfig {
  return {
    ...(options.config ?? {}),
    database: {
      ...(options.config?.database ?? {}),
      url: options.databaseUrl ?? options.config?.database?.url ?? resolveTestDatabaseUrl(),
    },
  };
}

async function createContainerWithRetry(
  config: CTXMillConfig,
  dataDir: string,
  retries: number,
  options: AppContainerOptions,
): Promise<AppContainer> {
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      return await createContainer(config, dataDir, options);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('already exists') || attempt === retries - 1) {
        throw error;
      }
    }
  }

  throw new Error('unreachable');
}

async function removeScopedTestContainers(container: AppContainer): Promise<void> {
  const managedContainers = await container.containerManager.listManagedContainers();
  const removals = await Promise.allSettled(
    managedContainers.map(async (managedContainer) => {
      await container.containerManager.removeContainer(managedContainer.containerId, true);
      return managedContainer.containerId;
    }),
  );
  const failures = removals.flatMap((result, index) => {
    if (result.status === 'fulfilled') return [];
    const containerId = managedContainers[index]?.containerId ?? 'unknown';
    const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
    return [{ containerId, reason, error: result.reason }];
  });
  if (failures.length === 0) return;

  throw new AggregateError(
    failures.map((failure) => failure.error),
    `Failed to remove test sandbox containers: ${failures
      .map((failure) => `${failure.containerId}: ${failure.reason}`)
      .join('; ')}`,
  );
}

function defaultServerOptions(container: AppContainer, dataDir: string): ServerOptions {
  return {
    db: container.db,
    eventBus: container.eventBus,
    harnessSchemas: container.harnessSchemas,
    triggerManager: container.triggerManager,
    scheduleService: container.scheduleService,
    sse: container.sseManager,
    interrupts: container.interruptManager,
    secretProvider: container.secretProvider,
    toolDefinitionRegistry: container.toolRegistry,
    toolExecutor: container.toolExecutor,
    containerManager: container.containerManager,
    sessionManager: container.sessionManager,
    settingsService: container.settingsService,
    lifecyclePolicy: container.lifecyclePolicy,
    turnStartupService: container.turnStartupService,
    canonicalLog: container.canonicalLog,
    dataDir,
  };
}

function resolveServerOverrides(
  overrides: TestServerOverrides | undefined,
  container: AppContainer,
  dataDir: string,
): Partial<ServerOptions> {
  return typeof overrides === 'function'
    ? overrides({ container, dataDir })
    : overrides ?? {};
}

async function buildServer(
  container: AppContainer,
  dataDir: string,
  overrides?: TestServerOverrides,
): Promise<Awaited<ReturnType<typeof createServer>>> {
  const app = await createServer({
    ...defaultServerOptions(container, dataDir),
    ...resolveServerOverrides(overrides, container, dataDir),
  });
  await app.ready();
  return app;
}

export async function createTestApp(options: CreateTestAppOptions = {}): Promise<TestAppHandle> {
  const dataDir = mkdtempSync(join(tmpdir(), options.dirPrefix ?? 'ctxmill-test-'));
  const container = await createContainerWithRetry(
    buildContainerConfig(options),
    dataDir,
    options.containerRetriesOnAlreadyExists ?? 1,
    { containerScopeIdentity: `test:${dataDir}` },
  );
  let app = await buildServer(container, dataDir, options.serverOptions);

  return {
    get app() {
      return app;
    },
    container,
    dataDir,
    async restart(overrides?: TestServerOverrides) {
      await app.close();
      app = await buildServer(container, dataDir, overrides ?? options.serverOptions);
      return app;
    },
    async close() {
      await app.close().catch(() => undefined);
      await container.close().catch(() => undefined);
      try {
        await removeScopedTestContainers(container);
      } finally {
        rmSync(dataDir, { recursive: true, force: true });
      }
    },
  };
}
