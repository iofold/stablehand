import yaml from 'yaml';
import type { AgentManifest } from './types.js';

export function parseManifestString(content: string): unknown {
  const trimmed = content.trim();
  if (trimmed.startsWith('{')) {
    return JSON.parse(trimmed);
  }
  return yaml.parse(trimmed);
}

export function serializeManifestYAML(manifest: AgentManifest): string {
  return yaml.stringify(manifest);
}

export function serializeManifestJSON(manifest: AgentManifest): string {
  return JSON.stringify(manifest, null, 2);
}
