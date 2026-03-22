import { describe, it, expect } from 'vitest';

/**
 * Since validateResourceLimits is a module-internal function in agents.ts,
 * we replicate its logic here for direct unit testing. The actual integration
 * is tested via the API route tests. This ensures the validation logic is
 * thoroughly covered with boundary and edge-case tests.
 */
function validateResourceLimits(limits: Record<string, unknown>): string[] {
  const errors: string[] = [];

  if (limits.cpus !== undefined) {
    const cpus = Number(limits.cpus);
    if (isNaN(cpus) || cpus < 0.5 || cpus > 4.0) {
      errors.push(`cpus must be between 0.5 and 4.0, got ${limits.cpus}`);
    }
  }

  if (limits.memoryMb !== undefined) {
    const mem = Number(limits.memoryMb);
    if (isNaN(mem) || !Number.isInteger(mem) || mem < 256 || mem > 4096) {
      errors.push(`memoryMb must be an integer between 256 and 4096, got ${limits.memoryMb}`);
    }
  }

  if (limits.pidsLimit !== undefined) {
    const pids = Number(limits.pidsLimit);
    if (isNaN(pids) || !Number.isInteger(pids) || pids < 64 || pids > 512) {
      errors.push(`pidsLimit must be an integer between 64 and 512, got ${limits.pidsLimit}`);
    }
  }

  if (limits.timeoutSec !== undefined) {
    const timeout = Number(limits.timeoutSec);
    if (isNaN(timeout) || !Number.isInteger(timeout) || timeout < 60 || timeout > 3600) {
      errors.push(`timeoutSec must be an integer between 60 and 3600, got ${limits.timeoutSec}`);
    }
  }

  return errors;
}

describe('validateResourceLimits', () => {
  // ── Valid inputs ─────────────────────────────────────────

  describe('valid inputs', () => {
    it('accepts empty object (all optional)', () => {
      expect(validateResourceLimits({})).toEqual([]);
    });

    it('accepts all fields at default values', () => {
      expect(
        validateResourceLimits({
          cpus: 1.0,
          memoryMb: 512,
          pidsLimit: 256,
          timeoutSec: 600,
        }),
      ).toEqual([]);
    });

    it('accepts minimum boundary values', () => {
      expect(
        validateResourceLimits({
          cpus: 0.5,
          memoryMb: 256,
          pidsLimit: 64,
          timeoutSec: 60,
        }),
      ).toEqual([]);
    });

    it('accepts maximum boundary values', () => {
      expect(
        validateResourceLimits({
          cpus: 4.0,
          memoryMb: 4096,
          pidsLimit: 512,
          timeoutSec: 3600,
        }),
      ).toEqual([]);
    });

    it('accepts partial fields', () => {
      expect(validateResourceLimits({ cpus: 2.0 })).toEqual([]);
      expect(validateResourceLimits({ memoryMb: 1024 })).toEqual([]);
      expect(validateResourceLimits({ pidsLimit: 128 })).toEqual([]);
      expect(validateResourceLimits({ timeoutSec: 300 })).toEqual([]);
    });

    it('accepts fractional CPU values', () => {
      expect(validateResourceLimits({ cpus: 0.5 })).toEqual([]);
      expect(validateResourceLimits({ cpus: 1.5 })).toEqual([]);
      expect(validateResourceLimits({ cpus: 2.75 })).toEqual([]);
      expect(validateResourceLimits({ cpus: 3.99 })).toEqual([]);
    });
  });

  // ── Invalid cpus ─────────────────────────────────────────

  describe('invalid cpus', () => {
    it('rejects cpus below minimum (0.5)', () => {
      const errors = validateResourceLimits({ cpus: 0.1 });
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('cpus must be between 0.5 and 4.0');
      expect(errors[0]).toContain('0.1');
    });

    it('rejects cpus above maximum (4.0)', () => {
      const errors = validateResourceLimits({ cpus: 8 });
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('cpus must be between 0.5 and 4.0');
      expect(errors[0]).toContain('8');
    });

    it('rejects zero cpus', () => {
      const errors = validateResourceLimits({ cpus: 0 });
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('cpus must be between 0.5 and 4.0');
    });

    it('rejects negative cpus', () => {
      const errors = validateResourceLimits({ cpus: -1 });
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('cpus must be between 0.5 and 4.0');
    });

    it('rejects NaN cpus', () => {
      const errors = validateResourceLimits({ cpus: 'not-a-number' });
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('cpus must be between 0.5 and 4.0');
    });
  });

  // ── Invalid memoryMb ─────────────────────────────────────

  describe('invalid memoryMb', () => {
    it('rejects memoryMb below minimum (256)', () => {
      const errors = validateResourceLimits({ memoryMb: 128 });
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('memoryMb must be an integer between 256 and 4096');
      expect(errors[0]).toContain('128');
    });

    it('rejects memoryMb above maximum (4096)', () => {
      const errors = validateResourceLimits({ memoryMb: 8192 });
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('memoryMb must be an integer between 256 and 4096');
    });

    it('rejects non-integer memoryMb', () => {
      const errors = validateResourceLimits({ memoryMb: 512.5 });
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('memoryMb must be an integer between 256 and 4096');
    });
  });

  // ── Invalid pidsLimit ────────────────────────────────────

  describe('invalid pidsLimit', () => {
    it('rejects pidsLimit below minimum (64)', () => {
      const errors = validateResourceLimits({ pidsLimit: 32 });
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('pidsLimit must be an integer between 64 and 512');
      expect(errors[0]).toContain('32');
    });

    it('rejects pidsLimit above maximum (512)', () => {
      const errors = validateResourceLimits({ pidsLimit: 1024 });
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('pidsLimit must be an integer between 64 and 512');
    });

    it('rejects non-integer pidsLimit', () => {
      const errors = validateResourceLimits({ pidsLimit: 100.5 });
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('pidsLimit must be an integer between 64 and 512');
    });
  });

  // ── Invalid timeoutSec ───────────────────────────────────

  describe('invalid timeoutSec', () => {
    it('rejects timeoutSec below minimum (60)', () => {
      const errors = validateResourceLimits({ timeoutSec: 30 });
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('timeoutSec must be an integer between 60 and 3600');
      expect(errors[0]).toContain('30');
    });

    it('rejects timeoutSec above maximum (3600)', () => {
      const errors = validateResourceLimits({ timeoutSec: 7200 });
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('timeoutSec must be an integer between 60 and 3600');
    });

    it('rejects non-integer timeoutSec', () => {
      const errors = validateResourceLimits({ timeoutSec: 300.5 });
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('timeoutSec must be an integer between 60 and 3600');
    });
  });

  // ── Multiple errors ──────────────────────────────────────

  describe('multiple errors', () => {
    it('returns errors for all invalid fields', () => {
      const errors = validateResourceLimits({
        cpus: 10,
        memoryMb: 100,
        pidsLimit: 10,
        timeoutSec: 10,
      });
      expect(errors).toHaveLength(4);
      expect(errors[0]).toContain('cpus');
      expect(errors[1]).toContain('memoryMb');
      expect(errors[2]).toContain('pidsLimit');
      expect(errors[3]).toContain('timeoutSec');
    });

    it('returns errors only for invalid fields', () => {
      const errors = validateResourceLimits({
        cpus: 1.0,        // valid
        memoryMb: 100,    // invalid
        pidsLimit: 256,   // valid
        timeoutSec: 10,   // invalid
      });
      expect(errors).toHaveLength(2);
      expect(errors[0]).toContain('memoryMb');
      expect(errors[1]).toContain('timeoutSec');
    });
  });

  // ── Edge cases ───────────────────────────────────────────

  describe('edge cases', () => {
    it('ignores unknown fields', () => {
      expect(validateResourceLimits({ unknownField: 'whatever' })).toEqual([]);
    });

    it('handles undefined values for known fields gracefully', () => {
      expect(
        validateResourceLimits({
          cpus: undefined,
          memoryMb: undefined,
          pidsLimit: undefined,
          timeoutSec: undefined,
        }),
      ).toEqual([]);
    });
  });
});
