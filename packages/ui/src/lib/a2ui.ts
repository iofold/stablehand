export function normalizeA2UIComponentName(name: string): string {
  if (name.startsWith('stablehand.charts:')) return name.slice('stablehand.charts:'.length);
  if (name.startsWith('charts:')) return name.slice('charts:'.length);
  return name;
}
