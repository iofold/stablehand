import type { FastifyInstance } from 'fastify';
import type { SystemSettings, SystemSettingsService } from '../../settings/service.js';
import { SETTINGS_KEYS } from '../../settings/service.js';

export interface SettingsRouteOptions {
  settingsService: SystemSettingsService;
  onSettingsUpdated?: (settings: SystemSettings) => void | Promise<void>;
}

const MB = 1024 * 1024;

interface FieldValidator {
  min: number;
  max: number;
  isFloat?: boolean;
}

const FIELD_VALIDATORS: Record<string, FieldValidator> = {
  maxWorkspaceTarBytes:        { min: 1 * MB,    max: 1024 * MB },
  maxTarUploadBytes:           { min: 1 * MB,    max: 1024 * MB },
  idleTimeoutMs:               { min: 10_000,    max: 3_600_000 },
  turnTimeoutMs:               { min: 30_000,    max: 7_200_000 },
  reconciliationIntervalMs:    { min: 10_000,    max: 3_600_000 },
  maxGlobalContainers:         { min: 1,         max: 100 },
  queueTimeoutMs:              { min: 5_000,     max: 1_800_000 },
  maxConcurrentSessionsPerAgent:   { min: 1,         max: 20 },
  maxTriggerDepth:             { min: 1,         max: 20 },
  defaultCpus:                 { min: 0.1,       max: 16.0, isFloat: true },
  defaultMemoryMb:             { min: 128,       max: 32_768 },
  defaultPidsLimit:            { min: 32,        max: 2_048 },
  defaultTimeoutSec:           { min: 60,        max: 43_200 },
};

export async function settingsRoutes(
  app: FastifyInstance,
  opts: SettingsRouteOptions,
): Promise<void> {
  const { settingsService } = opts;

  app.get('/', async () => {
    const s = await settingsService.getAll();
    return {
      maxWorkspaceTarBytes:        s.maxWorkspaceTarBytes,
      maxTarUploadBytes:           s.maxTarUploadBytes,
      idleTimeoutMs:               s.idleTimeoutMs,
      turnTimeoutMs:               s.turnTimeoutMs,
      reconciliationIntervalMs:    s.reconciliationIntervalMs,
      maxGlobalContainers:         s.maxGlobalContainers,
      queueTimeoutMs:              s.queueTimeoutMs,
      maxConcurrentSessionsPerAgent:   s.maxConcurrentSessionsPerAgent,
      maxTriggerDepth:             s.maxTriggerDepth,
      defaultCpus:                 s.defaultCpus,
      defaultMemoryMb:             s.defaultMemoryMb,
      defaultPidsLimit:            s.defaultPidsLimit,
      defaultTimeoutSec:           s.defaultTimeoutSec,
    };
  });

  app.put('/', async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    if (!body || typeof body !== 'object') {
      return reply.status(400).send({ error: 'Request body must be a JSON object' });
    }

    const updates: Array<{ key: string; value: number }> = [];

    for (const [fieldKey, validator] of Object.entries(FIELD_VALIDATORS)) {
      const raw = body[fieldKey];
      if (raw === undefined) continue;

      if (validator.isFloat) {
        if (typeof raw !== 'number' || !Number.isFinite(raw)) {
          return reply.status(400).send({ error: `${fieldKey} must be a finite number` });
        }
      } else {
        if (typeof raw !== 'number' || !Number.isInteger(raw)) {
          return reply.status(400).send({ error: `${fieldKey} must be an integer` });
        }
      }

      if (raw < validator.min || raw > validator.max) {
        return reply.status(400).send({
          error: `${fieldKey} must be between ${validator.min} and ${validator.max}`,
        });
      }

      const settingKey = SETTINGS_KEYS[fieldKey as keyof typeof SETTINGS_KEYS];
      if (settingKey) {
        updates.push({ key: settingKey, value: raw });
      }
    }

    if (updates.length === 0) {
      return reply.status(400).send({ error: 'No valid settings fields provided' });
    }

    for (const { key, value } of updates) {
      await settingsService.set(key as Parameters<typeof settingsService.set>[0], value);
    }

    const updated = await settingsService.getAll();
    await opts.onSettingsUpdated?.(updated);
    return {
      maxWorkspaceTarBytes:        updated.maxWorkspaceTarBytes,
      maxTarUploadBytes:           updated.maxTarUploadBytes,
      idleTimeoutMs:               updated.idleTimeoutMs,
      turnTimeoutMs:               updated.turnTimeoutMs,
      reconciliationIntervalMs:    updated.reconciliationIntervalMs,
      maxGlobalContainers:         updated.maxGlobalContainers,
      queueTimeoutMs:              updated.queueTimeoutMs,
      maxConcurrentSessionsPerAgent:   updated.maxConcurrentSessionsPerAgent,
      maxTriggerDepth:             updated.maxTriggerDepth,
      defaultCpus:                 updated.defaultCpus,
      defaultMemoryMb:             updated.defaultMemoryMb,
      defaultPidsLimit:            updated.defaultPidsLimit,
      defaultTimeoutSec:           updated.defaultTimeoutSec,
    };
  });
}
