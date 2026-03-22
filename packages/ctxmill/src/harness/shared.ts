/**
 * Shared utilities for agent harness adapters.
 */

import type { ResolvedSecrets } from './types.js';

/**
 * Normalize text deltas from various LLM response shapes.
 * Handles strings, arrays, and objects with text/delta/value/content fields.
 */
export function normalizeStreamTextDeltas(content: unknown): string[] {
  if (typeof content === 'string') {
    return content.length > 0 ? [content] : [];
  }

  if (Array.isArray(content)) {
    return content.flatMap((block) => normalizeStreamTextDeltas(block));
  }

  if (!content || typeof content !== 'object') {
    return [];
  }

  const block = content as Record<string, unknown>;
  const type = typeof block.type === 'string' ? block.type : undefined;
  const textLikeType = !type || type === 'text' || type === 'text_delta';

  if (textLikeType) {
    if (typeof block.text === 'string' && block.text.length > 0) {
      return [block.text];
    }
    if (typeof block.delta === 'string' && block.delta.length > 0) {
      return [block.delta];
    }
    if (typeof block.value === 'string' && block.value.length > 0) {
      return [block.value];
    }
  }

  if (Array.isArray(block.content)) {
    return normalizeStreamTextDeltas(block.content);
  }

  if (typeof block.content === 'string' && textLikeType && block.content.length > 0) {
    return [block.content];
  }

  return [];
}

/**
 * Create a stub knowledge context for tool execution when no real
 * knowledge store is available.
 *
 * This pattern was previously duplicated across multiple harnesses.
 */
export function createStubKnowledgeContext() {
  return { query: async () => ({ items: [] as Array<{ id: string; content: string; score: number }> }) };
}

/**
 * Resolve a secret reference from the secrets map.
 *
 * Agent YAML uses `apiKeyRef: "$secret:OPENAI_API_KEY"` but the secrets map
 * (populated from env vars) is keyed by plain names like
 * `OPENAI_API_KEY`. This function strips the `$secret:` prefix before lookup
 * so both forms work.
 *
 * Returns `undefined` if `ref` is falsy or the key is not found.
 */
export function resolveSecretRef(
  ref: string | undefined,
  secrets: ResolvedSecrets,
): string | undefined {
  if (!ref) return undefined;
  // Strip the "$secret:" prefix if present
  const key = ref.startsWith('$secret:') ? ref.slice('$secret:'.length) : ref;
  return secrets[key] ?? secrets[ref];
}
