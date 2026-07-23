import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const readDockerfile = (name: string): string =>
  readFileSync(resolve(process.cwd(), name), 'utf8');

describe('Docker workspace packaging', () => {
  it.each([
    ['@ctxmill/contracts', 'contracts'],
    ['@ctxmill/manifest', 'manifest'],
  ])(
    'packages %s before building its consumers',
    (packageName, packageDirectory) => {
      for (const name of ['Dockerfile', 'Dockerfile.sandbox']) {
      const dockerfile = readDockerfile(name);
      const manifestCopy = dockerfile.indexOf(
          `COPY packages/${packageDirectory}/package.json packages/${packageDirectory}/tsconfig.json packages/${packageDirectory}/`,
      );
      const sourceCopy = dockerfile.indexOf(
          `COPY packages/${packageDirectory}/src/ packages/${packageDirectory}/src/`,
      );
        const dependencyBuild = dockerfile.indexOf(
          `RUN pnpm --filter ${packageName} build`,
      );
        const consumerBuild = dockerfile.indexOf(
          packageName === '@ctxmill/contracts'
            ? 'RUN pnpm --filter @ctxmill/sandbox-daemon build'
            : 'RUN pnpm --filter ctxmill build',
      );

      expect(manifestCopy).toBeGreaterThan(-1);
      expect(sourceCopy).toBeGreaterThan(manifestCopy);
        expect(dependencyBuild).toBeGreaterThan(sourceCopy);
        expect(consumerBuild).toBeGreaterThan(dependencyBuild);
      }
    },
  );

  it.each([
    ['@ctxmill/contracts', 'contracts'],
    ['@ctxmill/manifest', 'manifest'],
  ])('packages %s in the orchestrator runtime image', (_packageName, packageDirectory) => {
    const dockerfile = readDockerfile('Dockerfile');
    const runtimeStage = dockerfile.slice(
      dockerfile.indexOf('FROM node:22-slim AS orchestrator'),
    );

    expect(runtimeStage).toContain(
        `COPY packages/${packageDirectory}/package.json packages/${packageDirectory}/`,
    );
    expect(runtimeStage).toContain(
        `COPY --from=build /app/packages/${packageDirectory}/dist/ packages/${packageDirectory}/dist/`,
    );
  });
});
