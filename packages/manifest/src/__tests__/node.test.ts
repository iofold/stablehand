import {
  mkdir,
  mkdtemp,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { validateAndExtractTarball } from '../../../ctxmill/src/workspace/tar-upload.js';
import type { AgentManifest } from '../types.js';

interface WorkspacePlanFile {
  sourcePath: string;
  sourceRelativePath: string;
  destinationPath: string;
  mode: number;
  size: number;
  sha256: string;
}

interface WorkspacePlanDirectory {
  destinationPath: string;
  mode: number;
}

interface LoadedManifestProject {
  projectDir: string;
  manifestPath: string;
  manifest: AgentManifest;
  resolvedInstructions: string;
  agentCreateInput: {
    systemPrompt: string;
    workspaceContent?: {
      files?: Array<{ src: string; dest: string }>;
    };
  };
  workspace: {
    sha256: string;
    fileCount: number;
    totalBytes: number;
    files: WorkspacePlanFile[];
    directories: WorkspacePlanDirectory[];
  };
}

interface ManifestNodeModule {
  loadManifestProject(
    manifestPath: string,
    options?: { projectDir?: string },
  ): Promise<LoadedManifestProject>;
  createWorkspaceArchive(
    plan: LoadedManifestProject['workspace'],
  ): Promise<Buffer>;
  digestWorkspace(rootDir: string): Promise<{
    sha256: string;
    fileCount: number;
    totalBytes: number;
  }>;
}

async function importNodeModule(): Promise<ManifestNodeModule | null> {
  const modulePath = ['..', 'node.js'].join('/');
  try {
    return await import(modulePath) as ManifestNodeModule;
  } catch {
    return null;
  }
}

function manifest(
  instructions = 'Inline instructions.',
  workspaceFiles?: Array<{ src: string; dest: string }>,
): Record<string, unknown> {
  return {
    apiVersion: 'ctxmill.io/v1',
    kind: 'Agent',
    metadata: { name: 'node-loader-test' },
    spec: {
      harness: 'langgraph',
      harnessConfig: { provider: 'openai', model: 'gpt-5.4-mini' },
      instructions,
      ...(workspaceFiles
        ? { workspace: { content: { files: workspaceFiles } } }
        : {}),
    },
  };
}

describe('@ctxmill/manifest/node project loader', () => {
  let scratchRoot: string;

  beforeEach(async () => {
    await mkdir(join(process.cwd(), '.tmp'), { recursive: true });
    scratchRoot = await mkdtemp(join(process.cwd(), '.tmp', 'manifest-node-'));
  });

  afterEach(async () => {
    await rm(scratchRoot, { recursive: true, force: true });
  });

  async function writeManifest(
    projectDir: string,
    value: Record<string, unknown>,
  ): Promise<string> {
    const path = join(projectDir, 'agent.json');
    await writeFile(path, JSON.stringify(value), 'utf8');
    return path;
  }

  async function loader(): Promise<ManifestNodeModule> {
    const loaded = await importNodeModule();
    expect(loaded).not.toBeNull();
    if (!loaded) {
      throw new Error('Expected @ctxmill/manifest/node module');
    }
    return loaded;
  }

  it('exports the Node loader separately from the browser-light entrypoint', async () => {
    expect(await importNodeModule()).not.toBeNull();
  });

  it('resolves file-backed instructions relative to the project root', async () => {
    const projectDir = join(scratchRoot, 'project');
    await mkdir(join(projectDir, 'prompts'), { recursive: true });
    await writeFile(join(projectDir, 'prompts', 'system.md'), 'Resolved instructions.\n', 'utf8');
    const manifestPath = await writeManifest(
      projectDir,
      manifest('file:prompts/system.md'),
    );

    const result = await (await loader()).loadManifestProject(manifestPath);
    expect(result.resolvedInstructions).toBe('Resolved instructions.\n');
    expect(result.agentCreateInput.systemPrompt).toBe('Resolved instructions.\n');
    expect(result.manifest.spec.instructions).toBe('file:prompts/system.md');
  });

  it('rejects instruction traversal, missing files, and symlink escapes', async () => {
    const projectDir = join(scratchRoot, 'project');
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(scratchRoot, 'outside.md'), 'Outside', 'utf8');
    await symlink(join(scratchRoot, 'outside.md'), join(projectDir, 'linked.md'));
    const node = await loader();

    const traversal = await writeManifest(projectDir, manifest('file:../outside.md'));
    await expect(node.loadManifestProject(traversal)).rejects.toThrow(
      'canonical project-relative path',
    );

    const missing = await writeManifest(projectDir, manifest('file:missing.md'));
    await expect(node.loadManifestProject(missing)).rejects.toThrow('does not exist');

    const escaped = await writeManifest(projectDir, manifest('file:linked.md'));
    await expect(node.loadManifestProject(escaped)).rejects.toThrow('escapes project root');
  });

  it('rejects empty and non-file instruction targets', async () => {
    const projectDir = join(scratchRoot, 'project');
    await mkdir(join(projectDir, 'prompts'), { recursive: true });
    await writeFile(join(projectDir, 'empty.md'), '', 'utf8');
    const node = await loader();

    const empty = await writeManifest(projectDir, manifest('file:empty.md'));
    await expect(node.loadManifestProject(empty)).rejects.toThrow('must not be empty');

    const directory = await writeManifest(projectDir, manifest('file:prompts'));
    await expect(node.loadManifestProject(directory)).rejects.toThrow('regular file');
  });

  it('recursively expands directories into a sorted deterministic copy plan', async () => {
    const projectDir = join(scratchRoot, 'project');
    await mkdir(join(projectDir, 'assets', 'nested'), { recursive: true });
    await writeFile(join(projectDir, 'assets', 'z.txt'), 'Z', 'utf8');
    await writeFile(join(projectDir, 'assets', 'nested', 'a.txt'), 'AAA', 'utf8');
    const manifestPath = await writeManifest(
      projectDir,
      manifest('Inline.', [{ src: 'assets', dest: 'seed' }]),
    );

    const result = await (await loader()).loadManifestProject(manifestPath);
    expect(result.workspace.files.map((file) => ({
      src: file.sourceRelativePath,
      dest: file.destinationPath,
      size: file.size,
    }))).toEqual([
      { src: 'assets/nested/a.txt', dest: 'seed/nested/a.txt', size: 3 },
      { src: 'assets/z.txt', dest: 'seed/z.txt', size: 1 },
    ]);
    expect(result.workspace).toMatchObject({
      fileCount: 2,
      totalBytes: 4,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      directories: [
        { destinationPath: 'seed', mode: 0o755 },
        { destinationPath: 'seed/nested', mode: 0o755 },
      ],
    });
    expect(result.agentCreateInput.workspaceContent?.files).toEqual([
      { src: 'assets/nested/a.txt', dest: 'seed/nested/a.txt' },
      { src: 'assets/z.txt', dest: 'seed/z.txt' },
    ]);
  });

  it('creates a deterministic archive whose applied server digest equals the plan digest', async () => {
    const projectDir = join(scratchRoot, 'project');
    await mkdir(join(projectDir, 'assets', 'empty'), { recursive: true });
    await writeFile(join(projectDir, 'assets', 'run.sh'), '#!/bin/sh\necho ok\n', {
      encoding: 'utf8',
      mode: 0o755,
    });
    const manifestPath = await writeManifest(
      projectDir,
      manifest('Inline.', [{ src: 'assets', dest: 'seed' }]),
    );
    const node = await loader();
    expect(node.createWorkspaceArchive).toBeTypeOf('function');
    const result = await node.loadManifestProject(manifestPath);
    const firstArchive = await node.createWorkspaceArchive(result.workspace);
    const secondArchive = await node.createWorkspaceArchive(result.workspace);
    expect(firstArchive.equals(secondArchive)).toBe(true);

    const extracted = join(scratchRoot, 'extracted');
    await mkdir(extracted);
    await validateAndExtractTarball(Readable.from(firstArchive), extracted);
    const appliedDigest = await node.digestWorkspace(extracted);

    expect(appliedDigest).toEqual({
      sha256: result.workspace.sha256,
      fileCount: result.workspace.fileCount,
      totalBytes: result.workspace.totalBytes,
    });
    expect((await stat(join(extracted, 'seed', 'run.sh'))).mode & 0o7777).toBe(0o755);
    expect((await stat(join(extracted, 'seed', 'empty'))).isDirectory()).toBe(true);
  });

  it('rejects missing workspace sources and symlink escapes', async () => {
    const projectDir = join(scratchRoot, 'project');
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(scratchRoot, 'outside.txt'), 'Outside', 'utf8');
    await symlink(join(scratchRoot, 'outside.txt'), join(projectDir, 'linked.txt'));
    const node = await loader();

    const missing = await writeManifest(
      projectDir,
      manifest('Inline.', [{ src: 'missing', dest: 'missing' }]),
    );
    await expect(node.loadManifestProject(missing)).rejects.toThrow('does not exist');

    const escaped = await writeManifest(
      projectDir,
      manifest('Inline.', [{ src: 'linked.txt', dest: 'linked.txt' }]),
    );
    await expect(node.loadManifestProject(escaped)).rejects.toThrow('escapes project root');
  });

  it('rejects duplicate and file-directory destination collisions', async () => {
    const projectDir = join(scratchRoot, 'project');
    await mkdir(join(projectDir, 'dir'), { recursive: true });
    await writeFile(join(projectDir, 'dir', 'a.txt'), 'A', 'utf8');
    await writeFile(join(projectDir, 'one.txt'), 'One', 'utf8');
    await writeFile(join(projectDir, 'two.txt'), 'Two', 'utf8');
    const node = await loader();

    const duplicate = await writeManifest(projectDir, manifest('Inline.', [
      { src: 'one.txt', dest: 'same.txt' },
      { src: 'two.txt', dest: 'same.txt' },
    ]));
    await expect(node.loadManifestProject(duplicate)).rejects.toThrow(
      'destination collision',
    );

    const prefix = await writeManifest(projectDir, manifest('Inline.', [
      { src: 'one.txt', dest: 'seed' },
      { src: 'dir', dest: 'seed' },
    ]));
    await expect(node.loadManifestProject(prefix)).rejects.toThrow(
      'destination collision',
    );
  });

  it('computes the same digest across roots and creation order', async () => {
    const node = await loader();

    async function makeProject(name: string, reverse: boolean): Promise<string> {
      const projectDir = join(scratchRoot, name);
      await mkdir(join(projectDir, 'assets'), { recursive: true });
      const files = reverse
        ? [['b.txt', 'B'], ['a.txt', 'A']]
        : [['a.txt', 'A'], ['b.txt', 'B']];
      for (const [name, content] of files) {
        await writeFile(join(projectDir, 'assets', name), content, 'utf8');
      }
      return writeManifest(
        projectDir,
        manifest('Inline.', [{ src: 'assets', dest: 'seed' }]),
      );
    }

    const first = await node.loadManifestProject(await makeProject('one', false));
    const second = await node.loadManifestProject(await makeProject('two', true));
    expect(first.workspace.sha256).toBe(second.workspace.sha256);
  });

  it('changes the digest when content or destination changes', async () => {
    const projectDir = join(scratchRoot, 'project');
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, 'source.txt'), 'Version one', 'utf8');
    const node = await loader();

    const firstPath = await writeManifest(
      projectDir,
      manifest('Inline.', [{ src: 'source.txt', dest: 'one.txt' }]),
    );
    const first = await node.loadManifestProject(firstPath);

    await writeFile(join(projectDir, 'source.txt'), 'Version two', 'utf8');
    const contentChanged = await node.loadManifestProject(firstPath);

    const destinationPath = await writeManifest(
      projectDir,
      manifest('Inline.', [{ src: 'source.txt', dest: 'two.txt' }]),
    );
    const destinationChanged = await node.loadManifestProject(destinationPath);

    expect(contentChanged.workspace.sha256).not.toBe(first.workspace.sha256);
    expect(destinationChanged.workspace.sha256).not.toBe(contentChanged.workspace.sha256);
  });
});
