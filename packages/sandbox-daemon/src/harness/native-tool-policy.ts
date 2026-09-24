import type { NativeToolPolicy } from '@stablehand/contracts';

/** Apply one canonical policy meaning to a harness-owned tool name. */
export function isNativeToolAllowed(
  nativeToolPolicy: NativeToolPolicy | undefined,
  toolName: string,
): boolean {
  if (!nativeToolPolicy || nativeToolPolicy.policy === 'all') {
    return true;
  }
  if (nativeToolPolicy.policy === 'none') {
    return false;
  }

  const selected = nativeToolPolicy.names.includes(toolName);
  return nativeToolPolicy.policy === 'allow' ? selected : !selected;
}

export function filterNativeToolNames(
  availableNames: readonly string[],
  nativeToolPolicy: NativeToolPolicy | undefined,
): string[] {
  return availableNames.filter((name) => isNativeToolAllowed(nativeToolPolicy, name));
}
