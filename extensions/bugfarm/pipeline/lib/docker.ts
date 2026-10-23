// Docker helpers. Every container and image we create carries the bugfarm=1 label, and cleanup
// only ever touches labelled objects or Harbor compose projects we started.
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { LABEL, LABEL_KEY, MAX_CONTAINERS } from './config.ts';
import { Semaphore, log, run, runOk } from './util.ts';
import type { ExecResult } from './util.ts';

/**
 * Containers this process starts also carry `bugfarm.owner=<OWNER>`. Task images carry
 * `bugfarm=1` too, so Harbor trial containers (calibration, benchmarks) inherit that label;
 * cleanup goes by the owner label so one run never removes another run's containers.
 */
export const OWNER_KEY = 'bugfarm.owner';
export const OWNER = process.env.BUGFARM_OWNER ?? `${hostname()}-${process.pid}-${randomBytes(3).toString('hex')}`;

/** Global gate so no stage, alone or combined, runs more than MAX_CONTAINERS containers. */
export const containerSlots = new Semaphore(MAX_CONTAINERS);

export interface BuildResult {
  ok: boolean;
  tag: string;
  ms: number;
  logs: string;
  sizeBytes: number;
}

export async function dockerBuild(opts: { dockerfileText: string; contextDir: string; tag: string; timeoutMs?: number }): Promise<BuildResult> {
  const r = await run('docker', [
    'build', '--progress=plain', '--label', LABEL, '-t', opts.tag, '-f', '-', opts.contextDir,
  ], { input: opts.dockerfileText, timeoutMs: opts.timeoutMs ?? 30 * 60_000, maxBytes: 4 * 1024 * 1024 });
  const ok = r.code === 0;
  return { ok, tag: opts.tag, ms: r.ms, logs: r.stdout + r.stderr, sizeBytes: ok ? await imageSize(opts.tag) : 0 };
}

export async function imageSize(tag: string): Promise<number> {
  const r = await run('docker', ['image', 'inspect', '--format', '{{.Size}}', tag]);
  return r.code === 0 ? Number(r.stdout.trim()) || 0 : 0;
}

export async function imageExists(tag: string): Promise<boolean> {
  const r = await run('docker', ['image', 'inspect', tag]);
  return r.code === 0;
}

export interface ContainerRun extends ExecResult {
  name: string;
}

/**
 * Run a command in a throwaway container, no network, killed on timeout. The tree is mounted
 * read-only at /src and copied to /app inside the container, so the command runs exactly like
 * Harbor's verifier (root, writable /app holding a plain copy) and nothing root-owned or
 * test-generated ever lands back in the work dir.
 */
export async function runInTree(opts: {
  image: string;
  treeDir: string;
  command: string[];
  timeoutMs: number;
  cpus?: number;
  memory?: string;
}): Promise<ContainerRun> {
  return containerSlots.use(async () => {
    const name = `bugfarm-${randomBytes(5).toString('hex')}`;
    const args = [
      'run', '--rm', '--name', name, '--label', LABEL, '--label', `${OWNER_KEY}=${OWNER}`, '--network', 'none',
      '--cpus', String(opts.cpus ?? 2), '--memory', opts.memory ?? '4g',
      '-e', 'PYTHONDONTWRITEBYTECODE=1',
      '-v', `${opts.treeDir}:/src:ro`, '-w', '/', opts.image,
      'sh', '-c', 'rm -rf /app && cp -a /src /app && cd /app && exec "$@"', 'bugfarm', ...opts.command,
    ];
    const r = await run('docker', args, {
      timeoutMs: opts.timeoutMs,
      onTimeout: async () => {
        await run('docker', ['kill', name]);
      },
    });
    return { ...r, name };
  });
}

export interface CacheRecord {
  id: string;
  description: string;
  sizeBytes: number;
  inUse: boolean;
  createdAt: string;
}

function parseSize(s: string): number {
  const m = /([\d.]+)\s*([kKMGT]?B)/.exec(s);
  if (!m) return 0;
  const mult: Record<string, number> = { B: 1, kB: 1e3, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 };
  return Math.round(Number(m[1]) * (mult[m[2]] ?? 1));
}

export async function buildCacheRecords(): Promise<CacheRecord[]> {
  const out = await runOk('docker', ['buildx', 'du', '--verbose'], { timeoutMs: 5 * 60_000 });
  const records: CacheRecord[] = [];
  for (const block of out.split(/\n\s*\n/)) {
    const field = (k: string) => new RegExp(`^${k}:\\s*(.*)$`, 'm').exec(block)?.[1]?.trim() ?? '';
    const id = field('ID');
    if (!id) continue;
    records.push({ id, description: field('Description'), sizeBytes: parseSize(field('Size')), inUse: field('In use') === 'true', createdAt: field('Created at') });
  }
  return records;
}

/**
 * Harbor's `compose down --rmi local` removes task images but leaves their build-cache records
 * (one tree-sized COPY layer per task). Remove only unused records whose description matches a
 * step that exists solely in this pipeline's Dockerfiles (`ownSteps`), never anyone else's cache.
 */
export async function pruneOwnBuildCache(ownSteps: string[], opts: { dryRun?: boolean } = {}): Promise<{ records: number; bytes: number }> {
  const mine = (await buildCacheRecords()).filter((r) => !r.inUse && ownSteps.some((s) => r.description.includes(s)));
  let bytes = 0;
  let records = 0;
  for (const r of mine) {
    if (!opts.dryRun) {
      const res = await run('docker', ['buildx', 'prune', '-f', '--filter', `id=${r.id}`]);
      if (res.code !== 0) continue;
    }
    bytes += r.sizeBytes;
    records++;
  }
  log('docker', `${opts.dryRun ? 'would prune' : 'pruned'} ${records} bugfarm build-cache records (${(bytes / 1e9).toFixed(2)} GB)`);
  return { records, bytes };
}

/**
 * Remove containers this process started. With `all`, remove every container any pipeline run
 * started (a crashed or killed run can leave some behind). Containers without the owner label,
 * such as Harbor trials of our task images, are never touched.
 */
export async function removeLabelledContainers(opts: { all?: boolean } = {}): Promise<number> {
  const filter = opts.all ? `label=${OWNER_KEY}` : `label=${OWNER_KEY}=${OWNER}`;
  const ids = (await runOk('docker', ['ps', '-aq', '--filter', `label=${LABEL_KEY}=1`, '--filter', filter])).split('\n').filter(Boolean);
  if (ids.length) await run('docker', ['rm', '-f', ...ids]);
  return ids.length;
}

/**
 * Remove containers, networks and images left by Harbor compose projects whose names start with
 * one of the given trial names. Harbor names projects `<trial>__env` and `<trial>__verifier__<key>`;
 * its egress sidecar does not carry our label, so we match on the compose project instead.
 */
export async function cleanupHarborProjects(trialNames: string[]): Promise<{ containers: number; networks: number; images: number }> {
  const prefixes = trialNames.map((t) => `${t.toLowerCase()}__`);
  const matches = (project: string) => prefixes.some((p) => project.startsWith(p));
  let containers = 0;
  let networks = 0;
  let images = 0;

  const ps = await runOk('docker', ['ps', '-a', '--format', '{{.ID}}\t{{.Label "com.docker.compose.project"}}']);
  const cids = ps.split('\n').filter(Boolean).map((l) => l.split('\t')).filter(([, proj]) => proj && matches(proj)).map(([id]) => id);
  if (cids.length) {
    await run('docker', ['rm', '-f', ...cids]);
    containers = cids.length;
  }

  const nets = await runOk('docker', ['network', 'ls', '--format', '{{.ID}}\t{{.Label "com.docker.compose.project"}}']);
  const nids = nets.split('\n').filter(Boolean).map((l) => l.split('\t')).filter(([, proj]) => proj && matches(proj)).map(([id]) => id);
  for (const id of nids) {
    const r = await run('docker', ['network', 'rm', id]);
    if (r.code === 0) networks++;
  }

  // Task images Harbor built from our Dockerfiles carry LABEL bugfarm=1; only remove those that belong to these trials.
  const imgs = await runOk('docker', ['images', '--filter', `label=${LABEL_KEY}=1`, '--format', '{{.Repository}}:{{.Tag}}\t{{.ID}}']);
  const iids = imgs.split('\n').filter(Boolean).map((l) => l.split('\t')).filter(([ref]) => matches(ref.split(':')[0])).map(([ref]) => ref);
  for (const ref of iids) {
    const r = await run('docker', ['rmi', '-f', ref]);
    if (r.code === 0) images++;
  }
  if (containers + networks + images > 0) log('docker', `cleaned harbor leftovers: ${containers} containers, ${networks} networks, ${images} images`);
  return { containers, networks, images };
}
