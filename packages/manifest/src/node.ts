import { createHash } from 'node:crypto';
import {
  lstat,
  readFile,
  readdir,
  realpath,
  stat,
} from 'node:fs/promises';
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { createGzip } from 'node:zlib';

import type { AgentCreateInput } from '@ctxmill/contracts';
import * as tar from 'tar-stream';

import { manifestToAgentCreateInput } from './convert.js';
import { parseManifestString } from './parser.js';
import type { AgentManifest, ManifestWorkspaceContent } from './types.js';
import { isCanonicalRelativePath, validateManifest } from './validate.js';

const CANONICAL_DIRECTORY_MODE = 0o755;
const EPOCH = new Date(0);

export interface WorkspacePlanFile {
  sourcePath: string;
  resolvedSourcePath: string;
  sourceRelativePath: string;
  destinationPath: string;
  mode: number;
  size: number;
  sha256: string;
}

export interface WorkspacePlanDirectory {
  destinationPath: string;
  mode: number;
}

export interface WorkspaceCopyPlan {
  projectDir: string;
  sha256: string;
  fileCount: number;
  totalBytes: number;
  files: WorkspacePlanFile[];
  directories: WorkspacePlanDirectory[];
}

export interface WorkspaceDigest {
  sha256: string;
  fileCount: number;
  totalBytes: number;
}

export interface LoadedManifestProject {
  projectDir: string;
  manifestPath: string;
  manifest: AgentManifest;
  resolvedInstructions: string;
  agentCreateInput: AgentCreateInput;
  workspace: WorkspaceCopyPlan;
}

export interface LoadManifestProjectOptions {
  projectDir?: string;
}

function toPosixPath(value: string): string {
  return value.split(sep).join('/');
}

function compareWorkspacePaths(left: string, right: string): number {
  const leftSegments = left.split('/');
  const rightSegments = right.split('/');
  const sharedLength = Math.min(leftSegments.length, rightSegments.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const comparison = leftSegments[index]!.localeCompare(rightSegments[index]!);
    if (comparison !== 0) {
      return comparison;
    }
  }
  return leftSegments.length - rightSegments.length;
}

function assertContained(root: string, candidate: string, label: string): void {
  const fromRoot = relative(root, candidate);
  if (isAbsolute(fromRoot) || fromRoot === '..' || fromRoot.startsWith(`..${sep}`)) {
    throw new Error(`${label} escapes project root`);
  }
}

async function requiredRealPath(path: string, label: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`${label} does not exist`, { cause: error });
    }
    throw error;
  }
}

async function resolveContainedPath(
  projectDir: string,
  relativePath: string,
  label: string,
): Promise<{ lexicalPath: string; realPath: string }> {
  if (!isCanonicalRelativePath(relativePath)) {
    throw new Error(`${label} must be a canonical project-relative path`);
  }

  const lexicalPath = resolve(projectDir, relativePath);
  assertContained(projectDir, lexicalPath, label);
  const realPath = await requiredRealPath(lexicalPath, label);
  assertContained(projectDir, realPath, label);
  return { lexicalPath, realPath };
}

export async function resolveManifestInstructions(
  manifest: AgentManifest,
  projectDir: string,
): Promise<string> {
  if (!manifest.spec.instructions.startsWith('file:')) {
    return manifest.spec.instructions;
  }

  const instructionPath = manifest.spec.instructions.slice('file:'.length);
  const resolved = await resolveContainedPath(
    projectDir,
    instructionPath,
    `Instruction file "${instructionPath}"`,
  );
  const fileStat = await stat(resolved.realPath);
  if (!fileStat.isFile()) {
    throw new Error(`Instruction file "${instructionPath}" must be a regular file`);
  }
  const content = await readFile(resolved.realPath, 'utf8');
  if (content.trim().length === 0) {
    throw new Error(`Instruction file "${instructionPath}" must not be empty`);
  }
  return content;
}

function assertNoDestinationCollisions(
  files: readonly WorkspacePlanFile[],
  directories: readonly WorkspacePlanDirectory[],
): void {
  const fileDestinations = new Set(files.map((file) => file.destinationPath));
  if (fileDestinations.size !== files.length) {
    throw new Error('Workspace destination collision: multiple sources target the same file');
  }

  const directoryDestinations = new Set(directories.map((directory) => directory.destinationPath));
  for (const destination of fileDestinations) {
    if (directoryDestinations.has(destination)) {
      throw new Error(
        `Workspace destination collision: "${destination}" is both a file and a directory`,
      );
    }
  }
}

function addParentDirectories(
  destinationPath: string,
  directories: Map<string, WorkspacePlanDirectory>,
): void {
  const segments = destinationPath.split('/');
  for (let index = 1; index < segments.length; index += 1) {
    const parent = segments.slice(0, index).join('/');
    directories.set(parent, {
      destinationPath: parent,
      mode: CANONICAL_DIRECTORY_MODE,
    });
  }
}

async function updateFileDigest(
  digest: ReturnType<typeof createHash>,
  path: string,
  mode: number,
  sourcePath: string,
): Promise<{ size: number; sha256: string }> {
  const content = await readFile(sourcePath);
  digest.update(`file\0${path}\0${mode.toString(8)}\0${content.length}\0`);
  digest.update(content);
  digest.update('\n');
  return {
    size: content.byteLength,
    sha256: createHash('sha256').update(content).digest('hex'),
  };
}

async function digestWorkspacePlanEntries(
  directories: readonly WorkspacePlanDirectory[],
  files: readonly WorkspacePlanFile[],
): Promise<string> {
  const digest = createHash('sha256');
  const entries = [
    ...directories.map((directory) => ({
      kind: 'directory' as const,
      path: directory.destinationPath,
      directory,
    })),
    ...files.map((file) => ({
      kind: 'file' as const,
      path: file.destinationPath,
      file,
    })),
  ].sort((left, right) => compareWorkspacePaths(left.path, right.path));

  for (const entry of entries) {
    if (entry.kind === 'directory') {
      digest.update(
        `directory\0${entry.directory.destinationPath}\0${entry.directory.mode.toString(8)}\n`,
      );
    } else {
      await updateFileDigest(
        digest,
        entry.file.destinationPath,
        entry.file.mode,
        entry.file.resolvedSourcePath,
      );
    }
  }
  return digest.digest('hex');
}

export async function buildWorkspaceCopyPlan(
  manifest: AgentManifest,
  projectDir: string,
): Promise<WorkspaceCopyPlan> {
  const files: WorkspacePlanFile[] = [];
  const directories = new Map<string, WorkspacePlanDirectory>();
  const explicitDirectories = new Set<string>();
  const activeDirectories = new Set<string>();

  async function addPath(
    lexicalPath: string,
    realPath: string,
    destinationPath: string,
  ): Promise<void> {
    const sourceLabel = `Workspace source "${toPosixPath(relative(projectDir, lexicalPath))}"`;
    assertContained(projectDir, realPath, sourceLabel);
    const fileStat = await stat(realPath);

    if (fileStat.isDirectory()) {
      if (explicitDirectories.has(destinationPath)) {
        throw new Error(
          `Workspace destination collision: multiple directories target "${destinationPath}"`,
        );
      }
      explicitDirectories.add(destinationPath);
      addParentDirectories(destinationPath, directories);
      directories.set(destinationPath, {
        destinationPath,
        mode: CANONICAL_DIRECTORY_MODE,
      });

      if (activeDirectories.has(realPath)) {
        throw new Error(`Workspace source directory cycle at "${destinationPath}"`);
      }
      activeDirectories.add(realPath);
      try {
        const entries = await readdir(lexicalPath);
        entries.sort((left, right) => left.localeCompare(right));
        for (const entry of entries) {
          const childLexicalPath = resolve(lexicalPath, entry);
          const childLabel = `Workspace source "${toPosixPath(relative(projectDir, childLexicalPath))}"`;
          const childRealPath = await requiredRealPath(childLexicalPath, childLabel);
          assertContained(projectDir, childRealPath, childLabel);
          const childDestination = `${destinationPath}/${entry}`;
          if (!isCanonicalRelativePath(childDestination)) {
            throw new Error(
              `Workspace destination "${childDestination}" is not a canonical relative path`,
            );
          }
          await addPath(childLexicalPath, childRealPath, childDestination);
        }
      } finally {
        activeDirectories.delete(realPath);
      }
      return;
    }

    if (!fileStat.isFile()) {
      const kind = (await lstat(lexicalPath)).isSymbolicLink() ? 'symlink target' : 'special file';
      throw new Error(`Workspace source "${lexicalPath}" resolves to an unsupported ${kind}`);
    }

    const sourceRelativePath = toPosixPath(relative(projectDir, lexicalPath));
    if (!isCanonicalRelativePath(sourceRelativePath)) {
      throw new Error(
        `Workspace source "${sourceRelativePath}" is not a canonical project-relative path`,
      );
    }
    addParentDirectories(destinationPath, directories);
    const content = await readFile(realPath);
    files.push({
      sourcePath: lexicalPath,
      resolvedSourcePath: realPath,
      sourceRelativePath,
      destinationPath,
      mode: fileStat.mode & 0o7777,
      size: content.byteLength,
      sha256: createHash('sha256').update(content).digest('hex'),
    });
  }

  for (const mapping of manifest.spec.workspace?.content?.files ?? []) {
    const resolved = await resolveContainedPath(
      projectDir,
      mapping.src,
      `Workspace source "${mapping.src}"`,
    );
    await addPath(resolved.lexicalPath, resolved.realPath, mapping.dest);
  }

  files.sort((left, right) => compareWorkspacePaths(left.destinationPath, right.destinationPath));
  const sortedDirectories = [...directories.values()].sort(
    (left, right) => compareWorkspacePaths(left.destinationPath, right.destinationPath),
  );
  assertNoDestinationCollisions(files, sortedDirectories);

  return {
    projectDir,
    sha256: await digestWorkspacePlanEntries(sortedDirectories, files),
    fileCount: files.length,
    totalBytes: files.reduce((total, file) => total + file.size, 0),
    files,
    directories: sortedDirectories,
  };
}

async function readVerifiedPlanFile(
  plan: WorkspaceCopyPlan,
  file: WorkspacePlanFile,
): Promise<Buffer> {
  const currentRealPath = await requiredRealPath(
    file.sourcePath,
    `Workspace source "${file.sourceRelativePath}"`,
  );
  assertContained(
    plan.projectDir,
    currentRealPath,
    `Workspace source "${file.sourceRelativePath}"`,
  );
  if (currentRealPath !== file.resolvedSourcePath) {
    throw new Error(
      `Workspace source "${file.sourceRelativePath}" changed after the copy plan was built`,
    );
  }
  const fileStat = await stat(currentRealPath);
  const content = await readFile(currentRealPath);
  const sha256 = createHash('sha256').update(content).digest('hex');
  if (
    !fileStat.isFile()
    || content.byteLength !== file.size
    || sha256 !== file.sha256
    || (fileStat.mode & 0o7777) !== file.mode
  ) {
    throw new Error(
      `Workspace source "${file.sourceRelativePath}" changed after the copy plan was built`,
    );
  }
  return content;
}

async function addTarEntry(
  pack: ReturnType<typeof tar.pack>,
  header: {
    name: string;
    type: 'directory' | 'file';
    mode: number;
    size?: number;
  },
  content?: Buffer,
): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    pack.entry({
      ...header,
      uid: 0,
      gid: 0,
      mtime: EPOCH,
    }, content, (error) => {
      if (error) {
        rejectPromise(error);
      } else {
        resolvePromise();
      }
    });
  });
}

export async function createWorkspaceArchive(plan: WorkspaceCopyPlan): Promise<Buffer> {
  const pack = tar.pack();
  const gzip = createGzip({ level: 9 });
  pack.pipe(gzip);
  const outputPromise = (async (): Promise<Buffer> => {
    const chunks: Buffer[] = [];
    for await (const chunk of gzip) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  })();

  const entries = [
    ...plan.directories.map((directory) => ({
      kind: 'directory' as const,
      path: directory.destinationPath,
      directory,
    })),
    ...plan.files.map((file) => ({
      kind: 'file' as const,
      path: file.destinationPath,
      file,
    })),
  ].sort((left, right) => compareWorkspacePaths(left.path, right.path));

  for (const entry of entries) {
    if (entry.kind === 'directory') {
      await addTarEntry(pack, {
        name: entry.directory.destinationPath,
        type: 'directory',
        mode: entry.directory.mode,
      });
    } else {
      const content = await readVerifiedPlanFile(plan, entry.file);
      await addTarEntry(pack, {
        name: entry.file.destinationPath,
        type: 'file',
        mode: entry.file.mode,
        size: content.byteLength,
      }, content);
    }
  }

  pack.finalize();
  return outputPromise;
}

export async function digestWorkspace(rootDir: string): Promise<WorkspaceDigest> {
  const hash = createHash('sha256');
  let fileCount = 0;
  let totalBytes = 0;

  const walk = async (directory: string, prefix: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = join(directory, entry.name);
      const entryStat = await lstat(absolutePath);
      const mode = entryStat.mode & 0o7777;

      if (entry.isDirectory()) {
        hash.update(`directory\0${relativePath}\0${mode.toString(8)}\n`);
        await walk(absolutePath, relativePath);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`Unsupported workspace entry type at ${relativePath}`);
      }

      const content = await readFile(absolutePath);
      hash.update(`file\0${relativePath}\0${mode.toString(8)}\0${content.length}\0`);
      hash.update(content);
      hash.update('\n');
      fileCount += 1;
      totalBytes += content.length;
    }
  };

  await walk(rootDir, '');
  return {
    sha256: hash.digest('hex'),
    fileCount,
    totalBytes,
  };
}

function expandedWorkspaceContent(
  manifest: AgentManifest,
  plan: WorkspaceCopyPlan,
): ManifestWorkspaceContent | undefined {
  if (!manifest.spec.workspace?.content) {
    return undefined;
  }
  return {
    files: plan.files.map((file) => ({
      src: file.sourceRelativePath,
      dest: file.destinationPath,
    })),
  };
}

export async function loadManifestProject(
  manifestPath: string,
  options: LoadManifestProjectOptions = {},
): Promise<LoadedManifestProject> {
  const requestedManifestPath = resolve(manifestPath);
  const requestedProjectDir = resolve(options.projectDir ?? dirname(requestedManifestPath));
  const projectDir = await requiredRealPath(requestedProjectDir, 'Manifest project directory');
  const projectStat = await stat(projectDir);
  if (!projectStat.isDirectory()) {
    throw new Error('Manifest project directory must be a directory');
  }

  const resolvedManifestPath = await requiredRealPath(requestedManifestPath, 'Manifest file');
  assertContained(projectDir, resolvedManifestPath, 'Manifest file');
  const manifestStat = await stat(resolvedManifestPath);
  if (!manifestStat.isFile()) {
    throw new Error('Manifest file must be a regular file');
  }

  const raw = parseManifestString(await readFile(resolvedManifestPath, 'utf8'));
  const manifest = validateManifest(raw);
  const resolvedInstructions = await resolveManifestInstructions(manifest, projectDir);
  const workspace = await buildWorkspaceCopyPlan(manifest, projectDir);
  const workspaceContent = expandedWorkspaceContent(manifest, workspace);
  const agentCreateInput = manifestToAgentCreateInput(manifest, {
    resolvedInstructions,
    ...(workspaceContent ? { workspaceContent } : {}),
  });

  return {
    projectDir,
    manifestPath: resolvedManifestPath,
    manifest,
    resolvedInstructions,
    agentCreateInput,
    workspace,
  };
}
