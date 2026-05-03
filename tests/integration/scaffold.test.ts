import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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
    'ctxmill.config.ts',
    'agents/assistant/agent.ts',
    'tools/read-file.ts',
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
    'feedback',
    'policies',
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
    });

    it('has vitest devDependency', () => {
      const devDeps = pkg.devDependencies as Record<string, string>;
      expect(devDeps).toHaveProperty('vitest');
    });

    it('has expected scripts', () => {
      const scripts = pkg.scripts as Record<string, string>;
      expect(scripts).toHaveProperty('dev');
      expect(scripts).toHaveProperty('test');
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

  // --- Agent definition imports defineAgent (AC CLI-01) ---

  describe('agents/assistant/agent.ts', () => {
    it('imports defineAgent from ctxmill', () => {
      const content = readFileSync(
        join(projectDir, 'agents', 'assistant', 'agent.ts'),
        'utf-8',
      );
      expect(content).toContain("import { defineAgent } from 'ctxmill'");
    });

    it('exports a defineAgent call with name assistant', () => {
      const content = readFileSync(
        join(projectDir, 'agents', 'assistant', 'agent.ts'),
        'utf-8',
      );
      expect(content).toContain("name: 'assistant'");
      expect(content).toContain('export default defineAgent(');
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
    it('contains ANTHROPIC_API_KEY placeholder', () => {
      const content = readFileSync(
        join(projectDir, '.env.example'),
        'utf-8',
      );
      expect(content).toContain('ANTHROPIC_API_KEY');
    });
  });

  // --- ctxmill.config.ts ---

  describe('ctxmill.config.ts', () => {
    it('imports defineConfig from ctxmill', () => {
      const content = readFileSync(
        join(projectDir, 'ctxmill.config.ts'),
        'utf-8',
      );
      expect(content).toContain("import { defineConfig } from 'ctxmill'");
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
