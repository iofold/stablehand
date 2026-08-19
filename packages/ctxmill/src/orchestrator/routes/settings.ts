import type { FastifyInstance } from 'fastify';
import {
  SYSTEM_SETTING_BOUNDS,
  validateSystemSettingValue,
  type SystemSettingBounds,
} from '@ctxmill/shared';
import { SystemSettingsSchema } from '@ctxmill/contracts';
import type { SettingsKey, SystemSettings, SystemSettingsService } from '../../settings/service.js';
import { SETTINGS_KEYS } from '../../settings/service.js';

export interface SettingsRouteOptions {
  settingsService: SystemSettingsService;
  onSettingsUpdated?: (settings: SystemSettings) => void | Promise<void>;
}

type SettingsField = keyof SystemSettings;

const FIELD_VALIDATORS = SYSTEM_SETTING_BOUNDS satisfies Record<SettingsField, SystemSettingBounds>;
const SETTINGS_FIELDS = Object.keys(FIELD_VALIDATORS) as SettingsField[];

function serializeSettings(settings: SystemSettings): SystemSettings {
  const serialized = {} as SystemSettings;
  for (const field of SETTINGS_FIELDS) {
    serialized[field] = settings[field];
  }
  // ctx-iqzy R4: the reply must satisfy the public contract.
  return SystemSettingsSchema.parse(serialized) as SystemSettings;
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
      const raw = body[fieldKey];
      if (raw === undefined) continue;

      const validationError = validateSystemSettingValue(fieldKey, raw);
      if (validationError) {
        return reply.status(400).send({ error: validationError });
      }

      updates.push({ key: SETTINGS_KEYS[fieldKey], value: raw as number });
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
