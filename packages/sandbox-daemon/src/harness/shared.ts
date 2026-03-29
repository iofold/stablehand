import type { ResolvedSecrets } from './types.js';
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

export function createStubKnowledgeContext() {
  return { query: async () => ({ items: [] as Array<{ id: string; content: string; score: number }> }) };
}
export function resolveSecretRef(
  ref: string | undefined,
  secrets: ResolvedSecrets,
): string | undefined {
  if (!ref) return undefined;
  const key = ref.startsWith('$secret:') ? ref.slice('$secret:'.length) : ref;
  return secrets[key] ?? secrets[ref];
}
