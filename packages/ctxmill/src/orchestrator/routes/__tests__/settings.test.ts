import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SYSTEM_SETTING_BOUNDS, SYSTEM_SETTING_FIELDS } from '@ctxmill/shared';

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

  it('serializes all system settings on read', async () => {
    const settingsService = {
      getAll: vi.fn().mockResolvedValue(baseSettings),
      set: vi.fn().mockResolvedValue(undefined),
    };
    const app = await createApp(settingsService, vi.fn());
    apps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: '/api/settings',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(baseSettings);
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
    expect(response.json()).toEqual(updatedSettings);
    expect(settingsService.set).toHaveBeenCalledWith('idleTimeoutMs', 10_000);
    expect(onSettingsUpdated).toHaveBeenCalledWith(updatedSettings);
  });

  it.each(SYSTEM_SETTING_FIELDS)('enforces the canonical %s bounds', async (field) => {
    const settingsService = {
      getAll: vi.fn().mockResolvedValue(baseSettings),
      set: vi.fn().mockResolvedValue(undefined),
    };
    const app = await createApp(settingsService, vi.fn());
    apps.push(app);
    const bounds = SYSTEM_SETTING_BOUNDS[field];
    const increment = bounds.integer ? 1 : 0.1;

    const below = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { [field]: bounds.min - increment },
    });
    const above = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { [field]: bounds.max + increment },
    });
    const boundary = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { [field]: bounds.max },
    });

    expect(below.statusCode).toBe(400);
    expect(above.statusCode).toBe(400);
    expect(boundary.statusCode).toBe(200);
    expect(settingsService.set).toHaveBeenLastCalledWith(field, bounds.max);
  });
});
