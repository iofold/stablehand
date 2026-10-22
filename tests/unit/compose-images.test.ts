import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

interface ComposeService {
  build?: { context?: string; dockerfile?: string; target?: string };
  image?: string;
  environment?: Record<string, string>;
}

interface ComposeFile {
  services?: Record<string, ComposeService>;
  networks?: Record<string, { name?: string }>;
}

interface ImagesWorkflow {
  jobs: {
    image: {
      if?: string;
      strategy: { matrix: { include: Array<{ image: string; context: string; file: string; target: string }> } };
    };
  };
  permissions?: Record<string, string>;
}

const COMPOSE_FILES = [
  'docker-compose.yml',
  'deploy/compose/model-gateway/docker-compose.yml',
  'extensions/artifact-gallery/docker-compose.yml',
] as const;

const IMAGE_PATTERN = /^\$\{STABLEHAND_IMAGE_REGISTRY:-ghcr\.io\/iofold\}\/(stablehand-[a-z0-9-]+):\$\{STABLEHAND_IMAGE_TAG:-latest\}$/;

function readYaml<T>(path: string): T {
  return parse(readFileSync(resolve(process.cwd(), path), 'utf8')) as T;
}

/** Every built image across the quickstart compose files, by published name. */
function builtImages(): Map<string, { context: string; file: string; target: string }> {
  const images = new Map<string, { context: string; file: string; target: string }>();
  for (const path of COMPOSE_FILES) {
    for (const [name, service] of Object.entries(readYaml<ComposeFile>(path).services ?? {})) {
      if (!service.build) continue;
      const match = IMAGE_PATTERN.exec(service.image ?? '');
      expect(match, `${path}: ${name} builds an image without the registry/tag image name`).not.toBeNull();
      const context = service.build.context ?? '.';
      images.set(match![1], {
        context,
        file: service.build.dockerfile ?? `${context === '.' ? '' : `${context}/`}Dockerfile`,
        target: service.build.target ?? '',
      });
    }
  }
  return images;
}

describe('prebuilt images', () => {
  it('names every image the stack builds after the published GHCR package', () => {
    expect([...builtImages().keys()].sort()).toEqual([
      'stablehand-artifact-gallery',
      'stablehand-egress',
      'stablehand-harness-claude-agents',
      'stablehand-harness-langgraph',
      'stablehand-harness-pi-agent',
      'stablehand-model-gateway',
      'stablehand-orchestrator',
      'stablehand-ui',
    ]);
  });

  it('publishes each of those images from the same Dockerfile and target', () => {
    const workflow = readYaml<ImagesWorkflow>('.github/workflows/images.yml');
    const matrix = new Map(
      workflow.jobs.image.strategy.matrix.include.map((entry) => [
        entry.image,
        { context: entry.context, file: entry.file, target: entry.target ?? '' },
      ]),
    );
    expect(Object.fromEntries(matrix)).toEqual(Object.fromEntries(builtImages()));
    expect(workflow.permissions?.packages).toBe('write');
    expect(workflow.jobs.image.if).toBe("github.repository == 'iofold/stablehand'");
  });

  it('points the orchestrator at the sandbox images and network compose creates', () => {
    const compose = readYaml<ComposeFile>('docker-compose.yml');
    const env = compose.services?.orchestrator?.environment ?? {};
    const prefix = env.STABLEHAND_IMAGE_PREFIX;
    const tag = env.STABLEHAND_SANDBOX_IMAGE_TAG;
    for (const harness of ['langgraph', 'claude-agents', 'pi-agent']) {
      expect(compose.services?.[`sandbox-${harness}`]?.image).toBe(`${prefix}-${harness}:${tag}`);
    }
    expect(env.STABLEHAND_SANDBOX_NETWORK).toBe(compose.networks?.['stablehand-agents']?.name);
  });
});
