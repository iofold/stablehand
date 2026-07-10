import type { FastifyInstance } from 'fastify';
import type { SettingsKey, SystemSettings, SystemSettingsService } from '../../settings/service.js';
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

type SettingsField = keyof SystemSettings;

const FIELD_VALIDATORS = {
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
} satisfies Record<SettingsField, FieldValidator>;

const SETTINGS_FIELDS = Object.keys(FIELD_VALIDATORS) as SettingsField[];

function serializeSettings(settings: SystemSettings): SystemSettings {
  const serialized = {} as SystemSettings;
  for (const field of SETTINGS_FIELDS) {
    serialized[field] = settings[field];
  }
  return serialized;
}

export async function settingsRoutes(
  app: FastifyInstance,
  opts: SettingsRouteOptions,
): Promise<void> {
  const { settingsService } = opts;

  app.get('/', async () => {
    return serializeSettings(await settingsService.getAll());
  });

  app.put('/', async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    if (!body || typeof body !== 'object') {
      return reply.status(400).send({ error: 'Request body must be a JSON object' });
    }

    const updates: Array<{ key: SettingsKey; value: number }> = [];

    for (const fieldKey of SETTINGS_FIELDS) {
      const validator: FieldValidator = FIELD_VALIDATORS[fieldKey];
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

      updates.push({ key: SETTINGS_KEYS[fieldKey], value: raw });
    }

    if (updates.length === 0) {
      return reply.status(400).send({ error: 'No valid settings fields provided' });
    }

    for (const { key, value } of updates) {
      await settingsService.set(key as Parameters<typeof settingsService.set>[0], value);
    }

    const updated = await settingsService.getAll();
    await opts.onSettingsUpdated?.(updated);
    return serializeSettings(updated);
  });
}
