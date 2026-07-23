import type { BuiltinToolPolicy } from '@ctxmill/contracts';

export function builtinNamesAllowedByPolicy(
  builtinNames: ReadonlySet<string>,
  policy: BuiltinToolPolicy | undefined,
): ReadonlySet<string> {
  if (!policy || policy.policy === 'all') {
    return builtinNames;
  }
  if (policy.policy === 'none') {
    return new Set();
  }

  const configuredNames = new Set(policy.names);
  if (policy.policy === 'allow') {
    return new Set([...builtinNames].filter((name) => configuredNames.has(name)));
  }
  return new Set([...builtinNames].filter((name) => !configuredNames.has(name)));
}
