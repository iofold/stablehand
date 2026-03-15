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

  list(): string[] {
    return [...this.harnesses.keys()];
  }
}
