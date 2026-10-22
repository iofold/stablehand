import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseManifestString, validateManifest } from '@stablehand/manifest';
import { parse as parseYaml } from 'yaml';

const CLI_PATH = join(
  __dirname,
  '..',
  '..',
  'packages',
  'create-stablehand',
  'dist',
  'index.js',
);

describe('create-stablehand scaffold', () => {
  let projectDir: string;
  const projectName = 'test-scaffold-project';

  beforeAll(() => {
    const tmp = mkdtempSync(join(tmpdir(), 'stablehand-scaffold-'));
    projectDir = join(tmp, projectName);

    execSync(`node ${CLI_PATH} ${projectDir}`, {
      encoding: 'utf-8',
      timeout: 15_000,
      env: { ...process.env, OPENAI_API_KEY: '' },
    });
  });

  afterAll(() => {
    if (projectDir && existsSync(projectDir)) {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  // --- File existence checks ---

  const expectedFiles = [
    'package.json',
    'tsconfig.json',
    'vitest.config.ts',
    'agents/assistant/agent.yaml',
    'tools/read-file.ts',
    'tools/list-directory.ts',
    'tools/search-files.ts',
    'tests/assistant.test.ts',
    '.gitignore',
    '.env',
    '.env.example',
    'README.md',
    'docker-compose.yml',
  ];

  for (const file of expectedFiles) {
    it(`creates ${file}`, () => {
      expect(existsSync(join(projectDir, file))).toBe(true);
    });
  }

  const expectedDirs = [
    'agents/assistant',
    'tools',
    'tests',
    '.stablehand',
  ];

  for (const dir of expectedDirs) {
    it(`creates directory ${dir}/`, () => {
      expect(existsSync(join(projectDir, dir))).toBe(true);
    });
  }

  // --- package.json structure (AC CLI-01) ---

  describe('package.json', () => {
    let pkg: Record<string, unknown>;

    beforeAll(() => {
      const raw = readFileSync(join(projectDir, 'package.json'), 'utf-8');
      pkg = JSON.parse(raw);
    });

    it('is valid JSON with correct name', () => {
      expect(pkg.name).toBe(projectName);
    });

    it('sets type to module', () => {
      expect(pkg.type).toBe('module');
    });

    it('depends on the published packages at this release', () => {
      const deps = pkg.dependencies as Record<string, string>;
      const version = (JSON.parse(readFileSync(join(CLI_PATH, '..', '..', 'package.json'), 'utf-8')) as { version: string }).version;
      expect(deps.stablehand).toBe(`^${version}`);
      expect(deps['@stablehand/manifest']).toBe(`^${version}`);
    });

    it('has vitest devDependency', () => {
      const devDeps = pkg.devDependencies as Record<string, string>;
      expect(devDeps).toHaveProperty('vitest');
    });

    it('has expected scripts', () => {
      const scripts = pkg.scripts as Record<string, string>;
      expect(scripts).toHaveProperty('dev');
      expect(scripts).toHaveProperty('test');
      expect(scripts).toHaveProperty('typecheck');
      expect(scripts).not.toHaveProperty('eval');
    });
  });

  // --- tsconfig.json ---

  describe('tsconfig.json', () => {
    it('is valid JSON with compilerOptions', () => {
      const raw = readFileSync(join(projectDir, 'tsconfig.json'), 'utf-8');
      const tsconfig = JSON.parse(raw);
      expect(tsconfig.compilerOptions).toBeDefined();
      expect(tsconfig.compilerOptions.strict).toBe(true);
    });
  });

  // --- Agent manifest (AC CLI-01) ---

  describe('agents/assistant/agent.yaml', () => {
    it('uses a manifest with explicit harness config', () => {
      const content = readFileSync(
        join(projectDir, 'agents', 'assistant', 'agent.yaml'),
        'utf-8',
      );
      expect(content).toContain('apiVersion: stablehand.io/v1');
      expect(content).toContain('kind: Agent');
      expect(content).toContain('name: assistant');
      expect(content).toContain('harness: langgraph');
      expect(content).toContain('harnessConfig:');
      expect(content).toContain('provider: openai');
      expect(content).toContain('model: gpt-5.4-mini');
      expect(content).toContain('apiKeyRef: "$secret:OPENAI_API_KEY"');
    });

    it('is accepted by the canonical manifest schema', () => {
      const content = readFileSync(
        join(projectDir, 'agents', 'assistant', 'agent.yaml'),
        'utf-8',
      );

      expect(validateManifest(parseManifestString(content)).metadata.name).toBe('assistant');
    });

    it('references the generated starter tools', () => {
      const content = readFileSync(
        join(projectDir, 'agents', 'assistant', 'agent.yaml'),
        'utf-8',
      );
      expect(content).toContain('- ref: read-file');
      expect(content).toContain('- ref: list-directory');
      expect(content).toContain('- ref: search-files');
    });
  });

  describe('retired scaffold output', () => {
    it('does not emit a local Dockerfile: the stack runs on prebuilt images', () => {
      expect(existsSync(join(projectDir, 'Dockerfile'))).toBe(false);
    });

    it('does not emit stale config, policies, feedback, or TypeScript agent files', () => {
      expect(existsSync(join(projectDir, 'stablehand.config.ts'))).toBe(false);
      expect(existsSync(join(projectDir, 'agents', 'assistant', 'agent.ts'))).toBe(false);
      expect(existsSync(join(projectDir, 'feedback'))).toBe(false);
      expect(existsSync(join(projectDir, 'policies'))).toBe(false);
    });
  });

  // --- .gitignore contains .env (AC CLI-11) ---

  describe('.gitignore', () => {
    it('contains .env line', () => {
      const content = readFileSync(
        join(projectDir, '.gitignore'),
        'utf-8',
      );
      const lines = content.split('\n').map((l) => l.trim());
      expect(lines).toContain('.env');
    });

    it('contains node_modules/', () => {
      const content = readFileSync(
        join(projectDir, '.gitignore'),
        'utf-8',
      );
      expect(content).toContain('node_modules/');
    });
  });

  // --- .env.example ---

  describe('.env', () => {
    it('holds generated secrets, readable only by the owner', () => {
      const env = readFileSync(join(projectDir, '.env'), 'utf-8');
      expect(env).toMatch(/^SECRET_MASTER_KEY=[0-9a-f]{64}$/m);
      expect(env).toMatch(/^STABLEHAND_API_TOKEN=[0-9a-f]{64}$/m);
      expect(env).toMatch(/^OPENAI_API_KEY=$/m);
      expect(statSync(join(projectDir, '.env')).mode & 0o077).toBe(0);
    });

    it('ships an .env.example with blank values only', () => {
      const example = readFileSync(join(projectDir, '.env.example'), 'utf-8');
      expect(example).toContain('OPENAI_API_KEY=');
      expect(example).not.toMatch(/=[0-9a-f]{32,}/);
    });
  });

  describe('docker-compose.yml', () => {
    interface Compose {
      services: Record<string, { image?: string; build?: unknown; volumes?: string[]; environment?: Record<string, string> }>;
    }
    let compose: Compose;

    beforeAll(() => {
      compose = parseYaml(readFileSync(join(projectDir, 'docker-compose.yml'), 'utf-8')) as Compose;
    });

    it('runs the full stack, including file storage and the egress proxy', () => {
      expect(Object.keys(compose.services)).toEqual(expect.arrayContaining([
        'postgres', 'orchestrator', 'ui', 'minio', 'egress',
        'sandbox-langgraph', 'sandbox-claude-agents', 'sandbox-pi-agent',
      ]));
    });

    it('uses prebuilt images and never builds', () => {
      for (const [name, service] of Object.entries(compose.services)) {
        expect(service.build, name).toBeUndefined();
        expect(service.image, name).toBeTruthy();
      }
      expect(compose.services.orchestrator.image).toMatch(
        /^\$\{STABLEHAND_IMAGE_REGISTRY:-ghcr\.io\/iofold\}\/stablehand-orchestrator:\$\{STABLEHAND_IMAGE_TAG:-\d+\.\d+\.\d+\}$/,
      );
    });

    it('mounts the project agents and tools into the orchestrator', () => {
      expect(compose.services.orchestrator.volumes).toEqual(expect.arrayContaining([
        './agents:/app/project/agents:ro',
        './tools:/app/project/tools:ro',
      ]));
    });
  });

  // --- tools/read-file.ts ---

  describe('tools/read-file.ts', () => {
    it('imports defineTool from stablehand', () => {
      const content = readFileSync(
        join(projectDir, 'tools', 'read-file.ts'),
        'utf-8',
      );
      expect(content).toContain("import { defineTool } from 'stablehand'");
    });
  });
});

describe('create-stablehand templates', () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'stablehand-templates-'));
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('lists the templates', () => {
    const out = execSync(`node ${CLI_PATH} --list-templates`, { encoding: 'utf-8' });
    expect(out).toContain('assistant');
    expect(out).toContain('overnight-analyst');
  });

  it('scaffolds the Overnight Analyst with the example\'s exact manifest', () => {
    const dir = join(root, 'analyst');
    execSync(`node ${CLI_PATH} ${dir} --template overnight-analyst`, {
      encoding: 'utf-8',
      env: { ...process.env, OPENAI_API_KEY: 'sk-test-key' },
    });

    const manifest = readFileSync(join(dir, 'agents', 'overnight-analyst', 'agent.yaml'), 'utf-8');
    const example = readFileSync(
      join(__dirname, '..', '..', 'packages', 'examples', 'overnight-analyst', 'agents', 'overnight-analyst', 'agent.yaml'),
      'utf-8',
    );
    expect(manifest).toBe(example);
    expect(validateManifest(parseManifestString(manifest)).metadata.name).toBe('overnight-analyst');

    const env = readFileSync(join(dir, '.env'), 'utf-8');
    expect(env).toContain('OPENAI_API_KEY=sk-test-key');
    expect(env).toContain('STABLEHAND_EGRESS_EXTRA_ALLOW="GET *;HEAD *"');
    expect(env).toContain('COMPOSE_PROFILES=gallery');

    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8')) as { scripts: Record<string, string> };
    expect(pkg.scripts.seed).toContain('-e API_URL=http://localhost:3001');
    expect(pkg.scripts['run-once']).toContain('run-once.ts');
    expect(existsSync(join(dir, 'tools', 'read-file.ts'))).toBe(false);
  });

  it('refuses an unknown template and a non-empty directory', () => {
    expect(() => execSync(`node ${CLI_PATH} ${join(root, 'x')} --template nope`, { stdio: 'pipe' })).toThrow();
    const busy = join(root, 'busy');
    mkdirSync(busy);
    writeFileSync(join(busy, 'keep.txt'), 'mine');
    expect(() => execSync(`node ${CLI_PATH} ${busy}`, { stdio: 'pipe' })).toThrow();
    expect(readFileSync(join(busy, 'keep.txt'), 'utf-8')).toBe('mine');
  });
});
