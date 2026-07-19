import type { TokenUsage } from '../types.js';

function readNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function readCost(record: Record<string, unknown>): number | undefined {
  const cost = record.cost;
  if (typeof cost === 'number' && Number.isFinite(cost)) {
    return cost;
  }
  if (typeof cost === 'object' && cost !== null && !Array.isArray(cost)) {
    const total = (cost as Record<string, unknown>).total;
    if (typeof total === 'number' && Number.isFinite(total)) {
      return total;
    }
  }
  return undefined;
}

export function normalizeTokenUsage(usage: Record<string, unknown> | undefined): TokenUsage | undefined {
  if (!usage) {
    return undefined;
  }

  const inputTokens = readNumber(usage, ['inputTokens', 'input', 'input_tokens']) ?? 0;
  const outputTokens = readNumber(usage, ['outputTokens', 'output', 'output_tokens']) ?? 0;
  const totalTokens = readNumber(usage, ['totalTokens', 'total', 'total_tokens']) ?? inputTokens + outputTokens;
  const costUsd = readCost(usage);

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
}
