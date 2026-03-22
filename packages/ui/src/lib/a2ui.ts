import type { ApiA2UIBlock } from '@ctxmill/shared';

export const A2UI_BLOCK_PATTERN = /\{\s*"component"\s*:\s*"[^"]+"\s*,\s*"props"\s*:\s*\{[\s\S]*?\}\s*\}/g;

export function normalizeA2UIComponentName(name: string): string {
  if (name.startsWith('ctxmill.charts:')) return name.slice('ctxmill.charts:'.length);
  if (name.startsWith('ctxmill.hitl:')) return name.slice('ctxmill.hitl:'.length);
  if (name.startsWith('charts:')) return name.slice('charts:'.length);
  if (name.startsWith('hitl:')) return name.slice('hitl:'.length);
  return name;
}

export function normalizeA2UIBlock(
  value: unknown,
  fallbackId: string,
): ApiA2UIBlock | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const block = value as Record<string, unknown>;
  if (typeof block.component !== 'string') return undefined;

  return {
    id: typeof block.id === 'string' && block.id.length > 0 ? block.id : fallbackId,
    component: normalizeA2UIComponentName(block.component),
    props: block.props && typeof block.props === 'object' ? block.props as Record<string, unknown> : {},
  };
}

export function normalizeStoredA2UIBlocks(
  value: unknown,
  idPrefix: string,
): ApiA2UIBlock[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const blocks = value
    .map((block, index) => normalizeA2UIBlock(block, `${idPrefix}-${index}`))
    .filter((block): block is ApiA2UIBlock => Boolean(block));

  return blocks.length > 0 ? blocks : undefined;
}

export function extractEmbeddedA2UIBlocks(
  text: string,
  idPrefix: string,
): ApiA2UIBlock[] | undefined {
  const blocks: ApiA2UIBlock[] = [];
  let match;

  while ((match = A2UI_BLOCK_PATTERN.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[0]);
      const block = normalizeA2UIBlock(parsed, `${idPrefix}-${blocks.length}`);
      if (block) blocks.push(block);
    } catch {
      // Ignore malformed embedded blocks and keep the assistant text visible.
    }
  }

  A2UI_BLOCK_PATTERN.lastIndex = 0;
  return blocks.length > 0 ? blocks : undefined;
}

export function stripEmbeddedA2UIBlocks(text: string): string {
  return text.replace(A2UI_BLOCK_PATTERN, '').trim();
}
