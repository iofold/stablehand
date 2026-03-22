import { z } from 'zod';
import type { AgentHarness, HarnessRegistry } from './types.js';

export class DefaultHarnessRegistry implements HarnessRegistry {
  private harnesses = new Map<string, AgentHarness>();

  register(harness: AgentHarness): void {
    this.harnesses.set(harness.name, harness);
  }

  get(name: string): AgentHarness {
    const h = this.harnesses.get(name);
    if (!h) {
      throw new Error(
        `Unknown harness: ${name}. Available: ${[...this.harnesses.keys()].join(', ')}`,
      );
    }
    return h;
  }

  getConfigSchema(name: string): z.ZodType {
    const harness = this.harnesses.get(name);
    if (!harness) {
      throw new Error(`Unknown harness: ${name}`);
    }
    return harness.configSchema;
  }

  list(): string[] {
    return [...this.harnesses.keys()];
  }
}
