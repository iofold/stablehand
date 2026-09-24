/**
 * ctx-iqzy R4: the contracts SystemSettingsSchema and the shared
 * SYSTEM_SETTING_BOUNDS table are two declarations of the same surface —
 * this pins them to the identical key set so neither can drift.
 */
import { describe, expect, it } from 'vitest';
import { SystemSettingsSchema } from '@stablehand/contracts';
import { SYSTEM_SETTING_BOUNDS } from '@stablehand/shared';

describe('system settings contract drift', () => {
  it('SystemSettingsSchema keys match SYSTEM_SETTING_BOUNDS exactly', () => {
    const schemaKeys = Object.keys(SystemSettingsSchema.shape).sort();
    const boundsKeys = Object.keys(SYSTEM_SETTING_BOUNDS).sort();
    expect(schemaKeys).toEqual(boundsKeys);
  });
});
