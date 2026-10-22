import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

interface PackageJson {
  name: string;
  version: string;
  private?: boolean;
  license?: string;
  files?: string[];
  bin?: Record<string, string>;
  repository?: { type: string; url: string; directory: string };
  publishConfig?: { access?: string };
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

const ROOT = resolve(process.cwd());

/** The npm packages the project publishes (stablehand, create-stablehand, @stablehand/*). */
const PUBLISHED = [
  'stablehand',
  'create-stablehand',
  '@stablehand/client',
  '@stablehand/contracts',
  '@stablehand/manifest',
  '@stablehand/proto',
  '@stablehand/react',
  '@stablehand/sandbox-daemon',
  '@stablehand/shared',
];

function workspacePackages(): Map<string, { dir: string; pkg: PackageJson }> {
  const found = new Map<string, { dir: string; pkg: PackageJson }>();
  for (const parent of ['packages', 'packages/examples', 'extensions']) {
    for (const entry of readdirSync(join(ROOT, parent), { withFileTypes: true })) {
      const dir = join(parent, entry.name);
      const manifest = join(ROOT, dir, 'package.json');
      if (!entry.isDirectory() || !existsSync(manifest)) continue;
      const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as PackageJson;
      found.set(pkg.name, { dir, pkg });
    }
  }
  return found;
}

describe('npm packages', () => {
  const packages = workspacePackages();

  it('publishes exactly the documented set; everything else stays private', () => {
    const publishable = [...packages.values()]
      .filter(({ pkg }) => !pkg.private)
      .map(({ pkg }) => pkg.name)
      .sort();
    expect(publishable).toEqual([...PUBLISHED].sort());
  });

  for (const name of PUBLISHED) {
    it(`${name} carries what npm needs`, () => {
      const entry = packages.get(name);
      expect(entry, name).toBeDefined();
      const { dir, pkg } = entry!;
      expect(pkg.version).toMatch(/^\d+\.\d+\.\d+(-[\w.]+)?$/);
      expect(pkg.license).toBe('MIT');
      expect(pkg.repository).toEqual({
        type: 'git',
        url: 'git+https://github.com/iofold/stablehand.git',
        directory: dir,
      });
      expect(pkg.publishConfig?.access).toBe('public');
      expect(pkg.files?.length, `${name} lists its files`).toBeGreaterThan(0);
    });

    it(`${name} depends only on packages that are published too`, () => {
      const { pkg } = packages.get(name)!;
      const workspaceDeps = Object.entries({ ...pkg.dependencies, ...pkg.peerDependencies })
        .filter(([, range]) => range.startsWith('workspace:'))
        .map(([dep]) => dep);
      for (const dep of workspaceDeps) {
        expect(PUBLISHED, `${name} -> ${dep}`).toContain(dep);
      }
    });
  }

  it('ships runnable CLIs', () => {
    expect(packages.get('stablehand')?.pkg.bin).toEqual({ stablehand: './dist/cli/index.js' });
    expect(packages.get('create-stablehand')?.pkg.bin).toEqual({ 'create-stablehand': './dist/index.js' });
    expect(packages.get('create-stablehand')?.pkg.files).toEqual(['dist', 'templates']);
    for (const source of ['packages/stablehand/src/cli/index.ts', 'packages/create-stablehand/src/index.ts']) {
      expect(readFileSync(join(ROOT, source), 'utf8').startsWith('#!/usr/bin/env node\n'), source).toBe(true);
    }
  });
});
