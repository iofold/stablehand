const MB = 1024 * 1024;

export interface SystemSettingBounds {
  min: number;
  max: number;
  integer: boolean;
}

/** Canonical numeric contract shared by the settings API and its clients. */
export const SYSTEM_SETTING_BOUNDS = {
  maxWorkspaceTarBytes:             { min: 1 * MB, max: 1024 * MB, integer: true },
  maxTarUploadBytes:                { min: 1 * MB, max: 1024 * MB, integer: true },
  idleTimeoutMs:                    { min: 10_000, max: 3_600_000, integer: true },
  turnTimeoutMs:                    { min: 30_000, max: 7_200_000, integer: true },
  reconciliationIntervalMs:         { min: 10_000, max: 3_600_000, integer: true },
  maxGlobalContainers:              { min: 1, max: 100, integer: true },
  queueTimeoutMs:                   { min: 5_000, max: 1_800_000, integer: true },
  maxQueuedTurnsGlobal:             { min: 1, max: 100_000, integer: true },
  maxQueuedTurnsPerAgent:           { min: 1, max: 10_000, integer: true },
  maxIngestQueueDepth:              { min: 100, max: 1_000_000, integer: true },
  queuedTurnTimeoutMs:              { min: 60_000, max: 86_400_000, integer: true },
  maxConcurrentSessionsPerAgent:    { min: 1, max: 20, integer: true },
  maxTriggerDepth:                  { min: 1, max: 20, integer: true },
  defaultCpus:                      { min: 0.1, max: 16, integer: false },
  defaultMemoryMb:                  { min: 128, max: 32_768, integer: true },
  defaultPidsLimit:                 { min: 32, max: 2_048, integer: true },
  defaultTimeoutSec:                { min: 60, max: 43_200, integer: true },
} as const satisfies Record<string, SystemSettingBounds>;

export type SystemSettingField = keyof typeof SYSTEM_SETTING_BOUNDS;

export const SYSTEM_SETTING_FIELDS = Object.freeze(
  Object.keys(SYSTEM_SETTING_BOUNDS) as SystemSettingField[],
);

export function validateSystemSettingValue(
  field: SystemSettingField,
  value: unknown,
): string | null {
  const bounds = SYSTEM_SETTING_BOUNDS[field];
  if (bounds.integer) {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      return `${field} must be an integer`;
    }
  } else if (typeof value !== 'number' || !Number.isFinite(value)) {
    return `${field} must be a finite number`;
  }

  if (value < bounds.min || value > bounds.max) {
    return `${field} must be between ${bounds.min} and ${bounds.max}`;
  }
  return null;
}
