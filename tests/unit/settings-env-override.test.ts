import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  SystemSettingsService,
  ENV_KEYS,
  DEFAULT_TURN_TIMEOUT_MS,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_DEFAULT_CPUS,
  DEFAULT_MAX_GLOBAL_CONTAINERS,
} from '../../packages/ctxmill/src/settings/service.js';
import type { SettingsDb } from '../../packages/ctxmill/src/settings/service.js';

function createMockDb(overrides: Record<string, string> = {}): SettingsDb {
  return {
    getAllSystemSettings: vi.fn().mockResolvedValue(overrides),
    setSystemSetting: vi.fn().mockResolvedValue(undefined),
  };
}

const LEGACY_MAX_CONTAINERS_ENV_KEY = 'CTXMILL_MAX_CONTAINERS';
const ALL_ENV_KEYS = [...Object.values(ENV_KEYS), LEGACY_MAX_CONTAINERS_ENV_KEY] as string[];

describe('SystemSettingsService env var overrides', () => {
  const envBackup: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const envKey of ALL_ENV_KEYS) {
      envBackup[envKey] = process.env[envKey];
      delete process.env[envKey];
    }
  });

  afterEach(() => {
    for (const [key, val] of Object.entries(envBackup)) {
      if (val === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = val;
      }
    }
  });

  it('uses hardcoded defaults when no env vars or DB values are set', async () => {
    const service = new SystemSettingsService(createMockDb());
    const settings = await service.getAll();

    expect(settings.turnTimeoutMs).toBe(DEFAULT_TURN_TIMEOUT_MS);
    expect(settings.idleTimeoutMs).toBe(DEFAULT_IDLE_TIMEOUT_MS);
    expect(settings.defaultCpus).toBe(DEFAULT_DEFAULT_CPUS);
  });

  it('env var overrides hardcoded default when no DB value exists', async () => {
    process.env.CTXMILL_TURN_TIMEOUT_MS = '600000';
    process.env.CTXMILL_IDLE_TIMEOUT_MS = '120000';
    process.env.CTXMILL_MAX_GLOBAL_CONTAINERS = '9';

    const service = new SystemSettingsService(createMockDb());
    const settings = await service.getAll();

    expect(settings.turnTimeoutMs).toBe(600_000);
    expect(settings.idleTimeoutMs).toBe(120_000);
    expect(settings.maxGlobalContainers).toBe(9);
  });

  it('deprecated CTXMILL_MAX_CONTAINERS aliases maxGlobalContainers with a warning', async () => {
    process.env.CTXMILL_MAX_CONTAINERS = '7';

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const service = new SystemSettingsService(createMockDb());
    const settings = await service.getAll();

    expect(settings.maxGlobalContainers).toBe(7);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('CTXMILL_MAX_CONTAINERS is deprecated; use CTXMILL_MAX_GLOBAL_CONTAINERS instead'),
    );
    warnSpy.mockRestore();
  });

  it('canonical CTXMILL_MAX_GLOBAL_CONTAINERS wins over deprecated CTXMILL_MAX_CONTAINERS', async () => {
    process.env.CTXMILL_MAX_GLOBAL_CONTAINERS = '11';
    process.env.CTXMILL_MAX_CONTAINERS = '7';

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const service = new SystemSettingsService(createMockDb());
    const settings = await service.getAll();

    expect(settings.maxGlobalContainers).toBe(11);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('CTXMILL_MAX_CONTAINERS is deprecated and ignored because CTXMILL_MAX_GLOBAL_CONTAINERS is set'),
    );
    warnSpy.mockRestore();
  });

  it('invalid deprecated CTXMILL_MAX_CONTAINERS falls back to hardcoded default', async () => {
    process.env.CTXMILL_MAX_CONTAINERS = 'not-a-number';

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const service = new SystemSettingsService(createMockDb());
    const settings = await service.getAll();

    expect(settings.maxGlobalContainers).toBe(DEFAULT_MAX_GLOBAL_CONTAINERS);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('CTXMILL_MAX_CONTAINERS'),
    );
    warnSpy.mockRestore();
  });

  it('DB value takes precedence over env var', async () => {
    process.env.CTXMILL_TURN_TIMEOUT_MS = '600000';

    const service = new SystemSettingsService(createMockDb({
      turnTimeoutMs: '900000',
    }));
    const settings = await service.getAll();

    expect(settings.turnTimeoutMs).toBe(900_000);
  });

  it('invalid env var falls back to hardcoded default', async () => {
    process.env.CTXMILL_TURN_TIMEOUT_MS = 'not-a-number';

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const service = new SystemSettingsService(createMockDb());
    const settings = await service.getAll();

    expect(settings.turnTimeoutMs).toBe(DEFAULT_TURN_TIMEOUT_MS);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('CTXMILL_TURN_TIMEOUT_MS'),
    );
    warnSpy.mockRestore();
  });

  it('negative env var falls back to hardcoded default for positive-int settings', async () => {
    process.env.CTXMILL_TURN_TIMEOUT_MS = '-1';

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const service = new SystemSettingsService(createMockDb());
    const settings = await service.getAll();

    expect(settings.turnTimeoutMs).toBe(DEFAULT_TURN_TIMEOUT_MS);
    warnSpy.mockRestore();
  });

  it('float env var works for defaultCpus', async () => {
    process.env.CTXMILL_DEFAULT_CPUS = '2.5';

    const service = new SystemSettingsService(createMockDb());
    const settings = await service.getAll();

    expect(settings.defaultCpus).toBe(2.5);
  });

  it('empty string env var falls back to hardcoded default', async () => {
    process.env.CTXMILL_TURN_TIMEOUT_MS = '';

    const service = new SystemSettingsService(createMockDb());
    const settings = await service.getAll();

    expect(settings.turnTimeoutMs).toBe(DEFAULT_TURN_TIMEOUT_MS);
  });
});
