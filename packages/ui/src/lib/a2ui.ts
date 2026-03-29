export function normalizeA2UIComponentName(name: string): string {
  if (name.startsWith('ctxmill.charts:')) return name.slice('ctxmill.charts:'.length);
  if (name.startsWith('charts:')) return name.slice('charts:'.length);
  return name;
}
