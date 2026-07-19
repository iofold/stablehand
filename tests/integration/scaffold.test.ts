import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseManifestString, validateManifest } from '@ctxmill/manifest';

const CLI_PATH = join(
  __dirname,
  '..',
  '..',
  'packages',
  'create-ctxmill',
  'dist',
  'index.js',
);

describe('create-ctxmill scaffold', () => {
  let projectDir: string;
  const projectName = 'test-scaffold-project';

  beforeAll(() => {
    const tmp = mkdtempSync(join(tmpdir(), 'ctxmill-scaffold-'));
    projectDir = join(tmp, projectName);

    execSync(`node ${CLI_PATH} ${projectDir}`, {
      encoding: 'utf-8',
      timeout: 15_000,
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
    '.env.example',
    'README.md',
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
    '.ctxmill',
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

    it('has ctxmill dependency', () => {
      const deps = pkg.dependencies as Record<string, string>;
      expect(deps).toHaveProperty('ctxmill');
      expect(deps).toHaveProperty('@ctxmill/manifest');
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
      expect(content).toContain('apiVersion: ctxmill.io/v1');
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
    it('does not emit stale config, policies, feedback, or TypeScript agent files', () => {
      expect(existsSync(join(projectDir, 'ctxmill.config.ts'))).toBe(false);
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

  describe('.env.example', () => {
    it('contains OPENAI_API_KEY placeholder', () => {
      const content = readFileSync(
        join(projectDir, '.env.example'),
        'utf-8',
      );
      expect(content).toContain('OPENAI_MODEL=gpt-5.4-mini');
      expect(content).toContain('OPENAI_API_KEY');
    });
  });

  // --- tools/read-file.ts ---

  describe('tools/read-file.ts', () => {
    it('imports defineTool from ctxmill', () => {
      const content = readFileSync(
        join(projectDir, 'tools', 'read-file.ts'),
        'utf-8',
      );
      expect(content).toContain("import { defineTool } from 'ctxmill'");
    });
  });
});
