import type { ToolProvider } from './provider.js';
import type { ToolDefinition } from '@stablehand/sandbox-daemon';
import { builtinToolNames } from './builtin/index.js';

/**
 * Aggregates tools from multiple ToolProviders into a unified registry.
 *
 * Each provider contributes tools that are cached after the first load.
 * Tools are looked up by name, and the originating provider is tracked
 * so that execution can be delegated correctly.
 */
export class DefaultToolRegistry {
  private providers = new Map<string, ToolProvider>();
  private toolCache = new Map<string, { tool: ToolDefinition; provider: string }>();
  private dirty = true;

  private cacheKey(provider: string, toolName: string): string {
    return `${provider}\u0000${toolName}`;
  }

  private scopedHttpProviderName(agentId: string): string {
    return `http-${agentId}`;
  }

  private isScopedHttpProvider(providerName: string): boolean {
    return providerName.startsWith('http-');
  }

  addProvider(provider: ToolProvider): void {
    this.providers.set(provider.name, provider);
    this.dirty = true;
  }

  removeProvider(name: string): void {
    this.providers.delete(name);
    // Remove cached tools from this provider
    for (const [cacheKey, entry] of this.toolCache) {
      if (entry.provider === name) {
        this.toolCache.delete(cacheKey);
      }
    }
    this.dirty = true;
  }

  /**
   * Refresh the tool cache by querying all providers.
   * Call this after adding/removing providers to pick up changes.
   */
  async refresh(): Promise<void> {
    // Build new cache completely before swapping — prevents race condition where
    // concurrent tool lookups see an empty/partial cache between clear() and
    // the completion of async listTools() calls.
    const newCache = new Map<string, { tool: ToolDefinition; provider: string }>();
    for (const [providerName, provider] of this.providers) {
      const tools = await provider.listTools();
      for (const tool of tools) {
        newCache.set(this.cacheKey(providerName, tool.name), { tool, provider: providerName });
      }
    }
    this.toolCache = newCache;
    this.dirty = false;
  }

  listAll(): ToolDefinition[] {
    const byName = new Map<string, ToolDefinition>();
    for (const entry of this.toolCache.values()) {
      if (!byName.has(entry.tool.name)) {
        byName.set(entry.tool.name, entry.tool);
      }
    }
    return Array.from(byName.values());
  }

  listForAgent(declaredToolNames: string[], agentId?: string): ToolDefinition[] {
    const declared = new Set(declaredToolNames);
    const scopedProvider = agentId ? this.scopedHttpProviderName(agentId) : undefined;
    const result = new Map<string, ToolDefinition>();

    for (const entry of this.toolCache.values()) {
      if (this.isScopedHttpProvider(entry.provider)) {
        continue;
      }
      if (declared.has(entry.tool.name) || builtinToolNames.has(entry.tool.name)) {
        result.set(entry.tool.name, entry.tool);
      }
    }

    for (const entry of this.toolCache.values()) {
      if (scopedProvider && entry.provider !== scopedProvider) {
        continue;
      }
      if (!scopedProvider && this.isScopedHttpProvider(entry.provider) && result.has(entry.tool.name)) {
        continue;
      }
      if (declared.has(entry.tool.name) || builtinToolNames.has(entry.tool.name)) {
        result.set(entry.tool.name, entry.tool);
      }
    }

    return Array.from(result.values());
  }

  private findEntry(toolName: string, agentId?: string): { tool: ToolDefinition; provider: string } | undefined {
    if (agentId) {
      const scoped = this.toolCache.get(this.cacheKey(this.scopedHttpProviderName(agentId), toolName));
      if (scoped) return scoped;
    }

    for (const entry of this.toolCache.values()) {
      if (entry.tool.name === toolName && !this.isScopedHttpProvider(entry.provider)) {
        return entry;
      }
    }

    for (const entry of this.toolCache.values()) {
      if (entry.tool.name === toolName) {
        return entry;
      }
    }

    return undefined;
  }

  getProvider(toolName: string, agentId?: string): ToolProvider | undefined {
    const entry = this.findEntry(toolName, agentId);
    if (!entry) return undefined;
    return this.providers.get(entry.provider);
  }

  /**
   * Get a specific tool definition by name.
   */
  getTool(toolName: string, agentId?: string): ToolDefinition | undefined {
    return this.findEntry(toolName, agentId)?.tool;
  }

  /**
   * Check if the cache needs refreshing (providers were added/removed).
   */
  get needsRefresh(): boolean {
    return this.dirty;
  }
}
