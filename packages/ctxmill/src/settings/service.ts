export const DEFAULT_MAX_WORKSPACE_TAR_BYTES = 100 * 1024 * 1024;
export const DEFAULT_MAX_CHECKPOINT_BYTES    =   5 * 1024 * 1024;
export const DEFAULT_MAX_TAR_UPLOAD_BYTES    = 100 * 1024 * 1024;

export const DEFAULT_IDLE_TIMEOUT_MS              = 300_000;
export const DEFAULT_FREEZE_PROMOTION_MS          = 600_000;
export const DEFAULT_MAX_PAUSE_DURATION_MS        = 300_000;
export const DEFAULT_PAUSE_DELAY_MS               = 5_000;
export const DEFAULT_TURN_TIMEOUT_MS              = 300_000;
export const DEFAULT_RECONCILIATION_INTERVAL_MS   = 300_000;
export const DEFAULT_MAX_GLOBAL_CONTAINERS        = 20;
export const DEFAULT_QUEUE_TIMEOUT_MS             = 60_000;
export const DEFAULT_MAX_CONCURRENT_RUNS_PER_AGENT = 3;
export const DEFAULT_MAX_TRIGGER_DEPTH            = 5;
export const DEFAULT_DEFAULT_CPUS                 = 1.0;
export const DEFAULT_DEFAULT_MEMORY_MB            = 1024;
export const DEFAULT_DEFAULT_PIDS_LIMIT           = 256;
export const DEFAULT_DEFAULT_TIMEOUT_SEC          = 600;

export const SETTINGS_KEYS = {
  maxWorkspaceTarBytes:        'maxWorkspaceTarBytes',
  maxCheckpointBytes:          'maxCheckpointBytes',
  maxTarUploadBytes:           'maxTarUploadBytes',
  idleTimeoutMs:               'idleTimeoutMs',
  freezePromotionMs:           'freezePromotionMs',
  maxPauseDurationMs:          'maxPauseDurationMs',
  pauseDelayMs:                'pauseDelayMs',
  turnTimeoutMs:               'turnTimeoutMs',
  reconciliationIntervalMs:    'reconciliationIntervalMs',
  maxGlobalContainers:         'maxGlobalContainers',
  queueTimeoutMs:              'queueTimeoutMs',
  maxConcurrentRunsPerAgent:   'maxConcurrentRunsPerAgent',
  maxTriggerDepth:             'maxTriggerDepth',
  defaultCpus:                 'defaultCpus',
  defaultMemoryMb:             'defaultMemoryMb',
  defaultPidsLimit:            'defaultPidsLimit',
  defaultTimeoutSec:           'defaultTimeoutSec',
} as const;

export type SettingsKey = (typeof SETTINGS_KEYS)[keyof typeof SETTINGS_KEYS];

export interface SystemSettings {
  maxWorkspaceTarBytes:        number;
  maxCheckpointBytes:          number;
  maxTarUploadBytes:           number;
  idleTimeoutMs:               number;
  freezePromotionMs:           number;
  maxPauseDurationMs:          number;
  pauseDelayMs:                number;
  turnTimeoutMs:               number;
  reconciliationIntervalMs:    number;
  maxGlobalContainers:         number;
  queueTimeoutMs:              number;
  maxConcurrentRunsPerAgent:   number;
  maxTriggerDepth:             number;
  defaultCpus:                 number;
  defaultMemoryMb:             number;
  defaultPidsLimit:            number;
  defaultTimeoutSec:           number;
}

export interface SettingsDb {
  getAllSystemSettings(): Promise<Record<string, string>>;
  setSystemSetting(key: string, value: string): Promise<void>;
}

const CACHE_TTL_MS = 5 * 60 * 1000;

export class SystemSettingsService {
  private readonly db: SettingsDb;
  private cache: SystemSettings | null = null;
  private cacheExpiresAt = 0;
  private inflightFetch: Promise<SystemSettings> | null = null;

  constructor(db: SettingsDb) {
    this.db = db;
  }

  async getAll(): Promise<SystemSettings> {
    if (this.cache && Date.now() < this.cacheExpiresAt) {
      return this.cache;
    }

    if (this.inflightFetch) {
      return this.inflightFetch;
    }

    this.inflightFetch = this._fetchAndCache();
    try {
      return await this.inflightFetch;
    } finally {
      this.inflightFetch = null;
    }
  }

  private async _fetchAndCache(): Promise<SystemSettings> {
    const raw = await this.db.getAllSystemSettings();
    const settings: SystemSettings = {
      maxWorkspaceTarBytes:      parseIntSetting(raw[SETTINGS_KEYS.maxWorkspaceTarBytes],      DEFAULT_MAX_WORKSPACE_TAR_BYTES),
      maxCheckpointBytes:        parseIntSetting(raw[SETTINGS_KEYS.maxCheckpointBytes],        DEFAULT_MAX_CHECKPOINT_BYTES),
      maxTarUploadBytes:         parseIntSetting(raw[SETTINGS_KEYS.maxTarUploadBytes],         DEFAULT_MAX_TAR_UPLOAD_BYTES),
      idleTimeoutMs:             parseIntSetting(raw[SETTINGS_KEYS.idleTimeoutMs],             DEFAULT_IDLE_TIMEOUT_MS),
      freezePromotionMs:         parseIntSetting(raw[SETTINGS_KEYS.freezePromotionMs],         DEFAULT_FREEZE_PROMOTION_MS),
      maxPauseDurationMs:        parseIntSetting(raw[SETTINGS_KEYS.maxPauseDurationMs],        DEFAULT_MAX_PAUSE_DURATION_MS),
      pauseDelayMs:              parseNonNegativeIntSetting(raw[SETTINGS_KEYS.pauseDelayMs],   DEFAULT_PAUSE_DELAY_MS),
      turnTimeoutMs:             parseIntSetting(raw[SETTINGS_KEYS.turnTimeoutMs],             DEFAULT_TURN_TIMEOUT_MS),
      reconciliationIntervalMs:  parseIntSetting(raw[SETTINGS_KEYS.reconciliationIntervalMs],  DEFAULT_RECONCILIATION_INTERVAL_MS),
      maxGlobalContainers:       parseIntSetting(raw[SETTINGS_KEYS.maxGlobalContainers],       DEFAULT_MAX_GLOBAL_CONTAINERS),
      queueTimeoutMs:            parseIntSetting(raw[SETTINGS_KEYS.queueTimeoutMs],            DEFAULT_QUEUE_TIMEOUT_MS),
      maxConcurrentRunsPerAgent: parseIntSetting(raw[SETTINGS_KEYS.maxConcurrentRunsPerAgent], DEFAULT_MAX_CONCURRENT_RUNS_PER_AGENT),
      maxTriggerDepth:           parseIntSetting(raw[SETTINGS_KEYS.maxTriggerDepth],           DEFAULT_MAX_TRIGGER_DEPTH),
      defaultCpus:               parseFloatSetting(raw[SETTINGS_KEYS.defaultCpus],             DEFAULT_DEFAULT_CPUS),
      defaultMemoryMb:           parseIntSetting(raw[SETTINGS_KEYS.defaultMemoryMb],           DEFAULT_DEFAULT_MEMORY_MB),
      defaultPidsLimit:          parseIntSetting(raw[SETTINGS_KEYS.defaultPidsLimit],          DEFAULT_DEFAULT_PIDS_LIMIT),
      defaultTimeoutSec:         parseIntSetting(raw[SETTINGS_KEYS.defaultTimeoutSec],         DEFAULT_DEFAULT_TIMEOUT_SEC),
    };

    this.cache = settings;
    this.cacheExpiresAt = Date.now() + CACHE_TTL_MS;
    return settings;
  }

  invalidateCache(): void {
    this.cache = null;
    this.cacheExpiresAt = 0;
  }

  async set(key: SettingsKey, value: number): Promise<void> {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`Invalid setting value for ${key}: ${value} (must be a non-negative finite number)`);
    }
    await this.db.setSystemSetting(key, String(value));
    this.invalidateCache();
  }
}

function parseIntSetting(raw: string | undefined, defaultValue: number): number {
  if (raw === undefined) return defaultValue;
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    console.warn(`[SystemSettings] Invalid setting value "${raw}", using default ${defaultValue}`);
    return defaultValue;
  }
  return parsed;
}

function parseNonNegativeIntSetting(raw: string | undefined, defaultValue: number): number {
  if (raw === undefined) return defaultValue;
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    console.warn(`[SystemSettings] Invalid setting value "${raw}", using default ${defaultValue}`);
    return defaultValue;
  }
  return parsed;
}

function parseFloatSetting(raw: string | undefined, defaultValue: number): number {
  if (raw === undefined) return defaultValue;
  const parsed = parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(`[SystemSettings] Invalid setting value "${raw}", using default ${defaultValue}`);
    return defaultValue;
  }
  return parsed;
}
