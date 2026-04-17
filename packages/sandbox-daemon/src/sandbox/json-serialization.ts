import type { JsonValue } from '@bufbuild/protobuf';

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

export function stringifyJsonWithBigInts(value: unknown): string {
  return JSON.stringify(value, bigintReplacer) ?? 'null';
}

export function toJsonCompatibleValue(value: unknown): JsonValue {
  return JSON.parse(stringifyJsonWithBigInts(value)) as JsonValue;
}
