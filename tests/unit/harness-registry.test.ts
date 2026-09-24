import { describe, it, expect } from 'vitest';
import { DefaultHarnessRegistry } from '../../packages/stablehand/src/harness/registry.js';
import type { AgentHarness } from '@stablehand/sandbox-daemon';

/**
 * Create a lightweight stub harness with the given canonical name.
 * Real harness modules pull in heavy SDK deps that are not available
 * in the unit-test environment; stubs let us verify registry behaviour
 * in isolation.
 */
function stubHarness(name: string): AgentHarness {
  return {
    name,
    async *run() { yield { type: 'done' as const }; },
  };
}

const EXPECTED_HARNESS_NAMES = [
  'langgraph',
  'claude-agents',
  'pi-agent',
] as const;

describe('DefaultHarnessRegistry', () => {
  it('all 3 harnesses are registered', () => {
    const registry = new DefaultHarnessRegistry();

    for (const name of EXPECTED_HARNESS_NAMES) {
      registry.register(stubHarness(name));
    }

    const names = registry.list();
    for (const expected of EXPECTED_HARNESS_NAMES) {
      expect(names).toContain(expected);
    }
    expect(names).toHaveLength(3);
  });

  it('get() returns the correct harness by name', () => {
    const registry = new DefaultHarnessRegistry();
    registry.register(stubHarness('langgraph'));
    registry.register(stubHarness('claude-agents'));

    const harness = registry.get('langgraph');
    expect(harness.name).toBe('langgraph');
  });

  it('get() throws for unknown harness', () => {
    const registry = new DefaultHarnessRegistry();
    expect(() => registry.get('nonexistent')).toThrow('Unknown harness: nonexistent');
  });

  it('register() overwrites duplicate names', () => {
    const registry = new DefaultHarnessRegistry();
    registry.register(stubHarness('langgraph'));
    registry.register(stubHarness('langgraph'));
    expect(registry.list()).toHaveLength(1);
  });
});
