import type { ToolProvider, ToolRegistry } from './provider.js';
import type { ToolDefinition } from './types.js';
import { builtinToolNames } from './builtin/index.js';

/**
 * Aggregates tools from multiple ToolProviders into a unified registry.
 *
 * Each provider contributes tools that are cached after the first load.
 * Tools are looked up by name, and the originating provider is tracked
 * so that execution can be delegated correctly.
 */
export class DefaultToolRegistry implements ToolRegistry {
  private providers = new Map<string, ToolProvider>();
  private toolCache = new Map<string, { tool: ToolDefinition; provider: string }>();
  private dirty = true;

  addProvider(provider: ToolProvider): void {
    this.providers.set(provider.name, provider);
    this.dirty = true;
  }

  removeProvider(name: string): void {
    this.providers.delete(name);
    // Remove cached tools from this provider
    for (const [toolName, entry] of this.toolCache) {
      if (entry.provider === name) {
        this.toolCache.delete(toolName);
      }
    }
    this.dirty = true;
  }

  /**
   * Refresh the tool cache by querying all providers.
   * Call this after adding/removing providers to pick up changes.
   */
  async refresh(): Promise<void> {
    this.toolCache.clear();
    for (const [providerName, provider] of this.providers) {
      const tools = await provider.listTools();
      for (const tool of tools) {
        this.toolCache.set(tool.name, { tool, provider: providerName });
      }
    }
    this.dirty = false;
  }

  listAll(): ToolDefinition[] {
    return Array.from(this.toolCache.values()).map((entry) => entry.tool);
  }

  listForAgent(declaredToolNames: string[]): ToolDefinition[] {
    const declared = new Set(declaredToolNames);
    return this.listAll().filter(
      (t) => declared.has(t.name) || builtinToolNames.has(t.name),
    );
  }

  getProvider(toolName: string): ToolProvider | undefined {
    const entry = this.toolCache.get(toolName);
    if (!entry) return undefined;
    return this.providers.get(entry.provider);
  }

  /**
   * Get a specific tool definition by name.
   */
  getTool(toolName: string): ToolDefinition | undefined {
    return this.toolCache.get(toolName)?.tool;
  }

  /**
   * Check if the cache needs refreshing (providers were added/removed).
   */
  get needsRefresh(): boolean {
    return this.dirty;
  }
}
