export const DEFAULT_MAX_WORKSPACE_TAR_BYTES = 100 * 1024 * 1024;
export const DEFAULT_MAX_CHECKPOINT_BYTES    = 100 * 1024 * 1024;
export const DEFAULT_MAX_TAR_UPLOAD_BYTES    = 100 * 1024 * 1024;

export const DEFAULT_IDLE_TIMEOUT_MS              = 300_000;
export const DEFAULT_TURN_TIMEOUT_MS              = 1_800_000;
export const DEFAULT_RECONCILIATION_INTERVAL_MS   = 300_000;
export const DEFAULT_MAX_GLOBAL_CONTAINERS        = 20;
export const DEFAULT_QUEUE_TIMEOUT_MS             = 600_000;
export const DEFAULT_MAX_CONCURRENT_RUNS_PER_AGENT = 3;
export const DEFAULT_MAX_TRIGGER_DEPTH            = 5;
export const DEFAULT_DEFAULT_CPUS                 = 1.0;
export const DEFAULT_DEFAULT_MEMORY_MB            = 1024;
export const DEFAULT_DEFAULT_PIDS_LIMIT           = 256;
export const DEFAULT_DEFAULT_TIMEOUT_SEC          = 43_200;

export const SETTINGS_KEYS = {
  maxWorkspaceTarBytes:        'maxWorkspaceTarBytes',
  maxCheckpointBytes:          'maxCheckpointBytes',
  maxTarUploadBytes:           'maxTarUploadBytes',
  idleTimeoutMs:               'idleTimeoutMs',
  turnTimeoutMs:               'turnTimeoutMs',
  reconciliationIntervalMs:    'reconciliationIntervalMs',
  maxGlobalContainers:         'maxGlobalContainers',
  queueTimeoutMs:              'queueTimeoutMs',
  maxConcurrentSessionsPerAgent: 'maxConcurrentSessionsPerAgent',
  maxTriggerDepth:             'maxTriggerDepth',
  defaultCpus:                 'defaultCpus',
  defaultMemoryMb:             'defaultMemoryMb',
  defaultPidsLimit:            'defaultPidsLimit',
  defaultTimeoutSec:           'defaultTimeoutSec',
} as const;

export type SettingsKey = (typeof SETTINGS_KEYS)[keyof typeof SETTINGS_KEYS];

export const ENV_KEYS: Record<SettingsKey, string> = {
  maxWorkspaceTarBytes:      'CTXMILL_MAX_WORKSPACE_TAR_BYTES',
  maxCheckpointBytes:        'CTXMILL_MAX_CHECKPOINT_BYTES',
  maxTarUploadBytes:         'CTXMILL_MAX_TAR_UPLOAD_BYTES',
  idleTimeoutMs:             'CTXMILL_IDLE_TIMEOUT_MS',
  turnTimeoutMs:             'CTXMILL_TURN_TIMEOUT_MS',
  reconciliationIntervalMs:  'CTXMILL_RECONCILIATION_INTERVAL_MS',
  maxGlobalContainers:       'CTXMILL_MAX_GLOBAL_CONTAINERS',
  queueTimeoutMs:            'CTXMILL_QUEUE_TIMEOUT_MS',
  maxConcurrentSessionsPerAgent: 'CTXMILL_MAX_CONCURRENT_SESSIONS_PER_AGENT',
  maxTriggerDepth:           'CTXMILL_MAX_TRIGGER_DEPTH',
  defaultCpus:               'CTXMILL_DEFAULT_CPUS',
  defaultMemoryMb:           'CTXMILL_DEFAULT_MEMORY_MB',
  defaultPidsLimit:          'CTXMILL_DEFAULT_PIDS_LIMIT',
  defaultTimeoutSec:         'CTXMILL_DEFAULT_TIMEOUT_SEC',
};

export interface SystemSettings {
  maxWorkspaceTarBytes:        number;
  maxCheckpointBytes:          number;
  maxTarUploadBytes:           number;
  idleTimeoutMs:               number;
  turnTimeoutMs:               number;
  reconciliationIntervalMs:    number;
  maxGlobalContainers:         number;
  queueTimeoutMs:              number;
  maxConcurrentSessionsPerAgent: number;
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
      maxWorkspaceTarBytes:      parseIntSetting(raw[SETTINGS_KEYS.maxWorkspaceTarBytes],      envInt('maxWorkspaceTarBytes', DEFAULT_MAX_WORKSPACE_TAR_BYTES)),
      maxCheckpointBytes:        parseIntSetting(raw[SETTINGS_KEYS.maxCheckpointBytes],        envInt('maxCheckpointBytes', DEFAULT_MAX_CHECKPOINT_BYTES)),
      maxTarUploadBytes:         parseIntSetting(raw[SETTINGS_KEYS.maxTarUploadBytes],         envInt('maxTarUploadBytes', DEFAULT_MAX_TAR_UPLOAD_BYTES)),
      idleTimeoutMs:             parseIntSetting(raw[SETTINGS_KEYS.idleTimeoutMs],             envInt('idleTimeoutMs', DEFAULT_IDLE_TIMEOUT_MS)),
      turnTimeoutMs:             parseIntSetting(raw[SETTINGS_KEYS.turnTimeoutMs],             envInt('turnTimeoutMs', DEFAULT_TURN_TIMEOUT_MS)),
      reconciliationIntervalMs:  parseIntSetting(raw[SETTINGS_KEYS.reconciliationIntervalMs],  envInt('reconciliationIntervalMs', DEFAULT_RECONCILIATION_INTERVAL_MS)),
      maxGlobalContainers:       parseIntSetting(raw[SETTINGS_KEYS.maxGlobalContainers],       envInt('maxGlobalContainers', DEFAULT_MAX_GLOBAL_CONTAINERS)),
      queueTimeoutMs:            parseIntSetting(raw[SETTINGS_KEYS.queueTimeoutMs],            envInt('queueTimeoutMs', DEFAULT_QUEUE_TIMEOUT_MS)),
      maxConcurrentSessionsPerAgent: parseIntSetting(raw[SETTINGS_KEYS.maxConcurrentSessionsPerAgent], envInt('maxConcurrentSessionsPerAgent', DEFAULT_MAX_CONCURRENT_RUNS_PER_AGENT)),
      maxTriggerDepth:           parseIntSetting(raw[SETTINGS_KEYS.maxTriggerDepth],           envInt('maxTriggerDepth', DEFAULT_MAX_TRIGGER_DEPTH)),
      defaultCpus:               parseFloatSetting(raw[SETTINGS_KEYS.defaultCpus],             envFloat('defaultCpus', DEFAULT_DEFAULT_CPUS)),
      defaultMemoryMb:           parseIntSetting(raw[SETTINGS_KEYS.defaultMemoryMb],           envInt('defaultMemoryMb', DEFAULT_DEFAULT_MEMORY_MB)),
      defaultPidsLimit:          parseIntSetting(raw[SETTINGS_KEYS.defaultPidsLimit],          envInt('defaultPidsLimit', DEFAULT_DEFAULT_PIDS_LIMIT)),
      defaultTimeoutSec:         parseIntSetting(raw[SETTINGS_KEYS.defaultTimeoutSec],         envInt('defaultTimeoutSec', DEFAULT_DEFAULT_TIMEOUT_SEC)),
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

/** Read env var as positive integer, or fall back to hardcoded default. */
function envInt(key: SettingsKey, hardDefault: number): number {
  const val = process.env[ENV_KEYS[key]];
  if (val === undefined || val === '') return hardDefault;
  const parsed = parseInt(val, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    console.warn(`[SystemSettings] Invalid ${ENV_KEYS[key]}="${val}", using default ${hardDefault}`);
    return hardDefault;
  }
  return parsed;
}

/** Read env var as non-negative integer (allows 0), or fall back to hardcoded default. */
function envNonNegativeInt(key: SettingsKey, hardDefault: number): number {
  const val = process.env[ENV_KEYS[key]];
  if (val === undefined || val === '') return hardDefault;
  const parsed = parseInt(val, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    console.warn(`[SystemSettings] Invalid ${ENV_KEYS[key]}="${val}", using default ${hardDefault}`);
    return hardDefault;
  }
  return parsed;
}

/** Read env var as positive float, or fall back to hardcoded default. */
function envFloat(key: SettingsKey, hardDefault: number): number {
  const val = process.env[ENV_KEYS[key]];
  if (val === undefined || val === '') return hardDefault;
  const parsed = parseFloat(val);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(`[SystemSettings] Invalid ${ENV_KEYS[key]}="${val}", using default ${hardDefault}`);
    return hardDefault;
  }
  return parsed;
}
