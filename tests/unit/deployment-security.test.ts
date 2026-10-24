import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

interface ComposeFile {
  services: Record<string, { ports?: string[] }>;
}

const files = [
  ['docker-compose.yml', ['postgres', 'minio', 'pgadmin']],
  ['packages/create-stablehand/templates/_base/docker-compose.yml', ['postgres', 'minio']],
] as const;

function publishedHosts(path: string, service: string, env: Record<string, string> = {}): string[] {
  const compose = parse(readFileSync(resolve(process.cwd(), path), 'utf8')) as ComposeFile;
  const ports = compose.services[service]?.ports;
  expect(ports, `${path}: ${service} has no host-port configuration`).toBeDefined();
  return (ports ?? []).map((port) => {
    const rendered = port.replace(/\$\{([A-Z_]+):-([^}]+)\}/g, (_match, key: string, fallback: string) => env[key] ?? fallback);
    const parts = rendered.split(':');
    return parts.length === 3 ? parts[0] : '0.0.0.0';
  });
}

describe('deployment data-service exposure', () => {
  for (const [path, services] of files) {
    it.each(services)(`${path}: %s is reachable only through loopback by default`, (service) => {
      expect(publishedHosts(path, service).every((host) => host === '127.0.0.1')).toBe(true);
    });

    it.each(services)(`${path}: %s can be exposed by an explicit operator override`, (service) => {
      expect(publishedHosts(path, service, { STABLEHAND_DATA_BIND_ADDRESS: '192.0.2.10' }).every((host) => host === '192.0.2.10')).toBe(true);
    });
  }
});
