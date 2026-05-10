import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { settingsRoutes } from '../settings.js';
import type { SystemSettings } from '../../../settings/service.js';

const baseSettings: SystemSettings = {
  maxWorkspaceTarBytes: 104_857_600,
  maxTarUploadBytes: 104_857_600,
  idleTimeoutMs: 300_000,
  turnTimeoutMs: 1_800_000,
  reconciliationIntervalMs: 300_000,
  maxGlobalContainers: 20,
  queueTimeoutMs: 600_000,
  maxConcurrentSessionsPerAgent: 20,
  maxTriggerDepth: 5,
  defaultCpus: 1,
  defaultMemoryMb: 1024,
  defaultPidsLimit: 256,
  defaultTimeoutSec: 43_200,
};

async function createApp(settingsService: {
  getAll: () => Promise<SystemSettings>;
  set: (key: keyof SystemSettings, value: number) => Promise<void>;
}, onSettingsUpdated: (settings: SystemSettings) => void | Promise<void>) {
  const app = Fastify({ logger: false });
  await app.register(settingsRoutes, {
    prefix: '/api/settings',
    settingsService: settingsService as never,
    onSettingsUpdated,
  });
  return app;
}

describe('settings routes', () => {
  const apps: Array<Awaited<ReturnType<typeof createApp>>> = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it('notifies runtime components after settings are updated', async () => {
    const updatedSettings = { ...baseSettings, idleTimeoutMs: 10_000 };
    const settingsService = {
      getAll: vi.fn().mockResolvedValue(updatedSettings),
      set: vi.fn().mockResolvedValue(undefined),
    };
    const onSettingsUpdated = vi.fn().mockResolvedValue(undefined);
    const app = await createApp(settingsService, onSettingsUpdated);
    apps.push(app);

    const response = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { idleTimeoutMs: 10_000 },
    });

    expect(response.statusCode).toBe(200);
    expect(settingsService.set).toHaveBeenCalledWith('idleTimeoutMs', 10_000);
    expect(onSettingsUpdated).toHaveBeenCalledWith(updatedSettings);
  });
});
