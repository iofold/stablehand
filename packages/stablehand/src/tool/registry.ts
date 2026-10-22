import type { ToolCatalogInfo, ToolProvider, ToolSourceKind } from './provider.js';
import type { ToolDefinition } from '@stablehand/sandbox-daemon';
import { builtinToolNames } from './builtin/index.js';

interface CacheEntry {
  tool: ToolDefinition;
  provider: string;
}

/** One cached tool with the facts the catalog reports about it. */
export interface ToolRegistryEntry {
  tool: ToolDefinition;
  providerName: string;
  source: ToolSourceKind;
  /** Set when only this agent may see the tool. */
  agentScope?: string;
  catalog?: ToolCatalogInfo;
}

/** Legacy naming for per-agent HTTP providers registered without `agentScope`. */
const LEGACY_HTTP_SCOPE_PREFIX = 'http-';

/**
 * Aggregates tools from multiple ToolProviders into a unified registry.
 *
 * Each provider contributes tools that are cached after the first load.
 * Tools are looked up by name, and the originating provider is tracked
 * so that execution can be delegated correctly.
 *
 * Agent-scoped providers (per-agent HTTP tools, per-agent MCP servers) are
 * visible only to their agent. A lookup made on behalf of one agent never
 * resolves to another agent's scoped tool, because those tools carry the
 * other agent's credentials.
 */
export class DefaultToolRegistry {
  private providers = new Map<string, ToolProvider>();
  private toolCache = new Map<string, CacheEntry>();
  private dirty = true;

  private cacheKey(provider: string, toolName: string): string {
    return `${provider}\u0000${toolName}`;
  }

  private scopeOf(providerName: string): string | undefined {
    const provider = this.providers.get(providerName);
    if (provider?.agentScope !== undefined) {
      return provider.agentScope;
    }
    return providerName.startsWith(LEGACY_HTTP_SCOPE_PREFIX)
      ? providerName.slice(LEGACY_HTTP_SCOPE_PREFIX.length)
      : undefined;
  }

  private isScoped(providerName: string): boolean {
    return this.scopeOf(providerName) !== undefined;
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

  /** Provider names whose tools belong to `agentId`. */
  providerNamesForAgent(agentId: string): string[] {
    return Array.from(this.providers.keys()).filter((name) => this.scopeOf(name) === agentId);
  }

  getProviderByName(name: string): ToolProvider | undefined {
    return this.providers.get(name);
  }

  /**
   * Refresh the tool cache by querying all providers.
   * Call this after adding/removing providers to pick up changes.
   */
  async refresh(): Promise<void> {
    // Build new cache completely before swapping — prevents race condition where
    // concurrent tool lookups see an empty/partial cache between clear() and
    // the completion of async listTools() calls.
    const newCache = new Map<string, CacheEntry>();
    const providers = Array.from(this.providers.entries());
    const listed = await Promise.all(
      providers.map(async ([providerName, provider]) => ({
        providerName,
        tools: await provider.listTools(),
      })),
    );
    for (const { providerName, tools } of listed) {
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

  /** Every cached tool with its provider-reported source, for the catalog. */
  listEntries(): ToolRegistryEntry[] {
    return Array.from(this.toolCache.values()).map((entry) => {
      const provider = this.providers.get(entry.provider);
      const agentScope = this.scopeOf(entry.provider);
      const catalog = provider?.catalogInfo?.(entry.tool);
      return {
        tool: entry.tool,
        providerName: entry.provider,
        source: provider?.source ?? 'local',
        ...(agentScope !== undefined ? { agentScope } : {}),
        ...(catalog ? { catalog } : {}),
      };
    });
  }

  listForAgent(declaredToolNames: string[], agentId?: string): ToolDefinition[] {
    const declared = new Set(declaredToolNames);
    const result = new Map<string, ToolDefinition>();
    const isOffered = (entry: CacheEntry): boolean =>
      declared.has(entry.tool.name) || builtinToolNames.has(entry.tool.name);

    for (const entry of this.toolCache.values()) {
      if (this.isScoped(entry.provider)) {
        continue;
      }
      if (isOffered(entry)) {
        result.set(entry.tool.name, entry.tool);
      }
    }

    for (const entry of this.toolCache.values()) {
      const scope = this.scopeOf(entry.provider);
      if (scope === undefined) {
        continue;
      }
      if (agentId !== undefined) {
        if (scope !== agentId) continue;
        const attachAll = this.providers.get(entry.provider)?.attachAll === true;
        if (attachAll || isOffered(entry)) {
          result.set(entry.tool.name, entry.tool);
        }
        continue;
      }
      if (!result.has(entry.tool.name) && isOffered(entry)) {
        result.set(entry.tool.name, entry.tool);
      }
    }

    return Array.from(result.values());
  }

  private findEntry(toolName: string, agentId?: string): CacheEntry | undefined {
    if (agentId !== undefined) {
      for (const entry of this.toolCache.values()) {
        if (entry.tool.name === toolName && this.scopeOf(entry.provider) === agentId) {
          return entry;
        }
      }
    }

    for (const entry of this.toolCache.values()) {
      if (entry.tool.name === toolName && !this.isScoped(entry.provider)) {
        return entry;
      }
    }

    if (agentId !== undefined) {
      // Never hand one agent another agent's scoped tool: it carries that
      // agent's credentials.
      return undefined;
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
