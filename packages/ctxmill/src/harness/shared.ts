/**
 * Shared utilities for agent harness adapters.
 */

/**
 * Create a stub knowledge context for tool execution when no real
 * knowledge store is available.
 *
 * This pattern was previously duplicated across pi-agent, claude-agents,
 * openai-agents, and vercel-ai harnesses.
 */
export function createStubKnowledgeContext() {
  return { query: async () => ({ items: [] as Array<{ id: string; content: string; score: number }> }) };
}
