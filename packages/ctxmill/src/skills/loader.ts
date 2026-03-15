import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { join, basename, extname } from 'node:path';
import matter from 'gray-matter';
import type {
  SkillFrontmatter,
  SkillManifestEntry,
  LoadedSkill,
  SkillValidationResult,
} from '@ctxmill/shared';

// ── Name validation ─────────────────────────────────────────────────

const SKILL_NAME_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;

/** Validate a skill name (lowercase, hyphens, max 64 chars). */
export function isValidSkillName(name: string): boolean {
  return name.length > 0 && name.length <= MAX_NAME_LENGTH && SKILL_NAME_RE.test(name);
}

// ── Discovery ───────────────────────────────────────────────────────

/**
 * Scan a directory for subdirectories that contain a SKILL.md file.
 * Returns lightweight manifest entries (no file content parsed).
 */
export async function discoverSkills(skillsDir: string): Promise<SkillManifestEntry[]> {
  if (!existsSync(skillsDir)) return [];

  const entries = await readdir(skillsDir, { withFileTypes: true });
  const results: SkillManifestEntry[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const skillMdPath = join(skillsDir, entry.name, 'SKILL.md');
    if (!existsSync(skillMdPath)) continue;

    try {
      const raw = await readFile(skillMdPath, 'utf-8');
      const { data } = matter(raw);
      const fm = data as Partial<SkillFrontmatter>;

      results.push({
        name: fm.name ?? entry.name,
        description: fm.description ?? '',
        path: join(skillsDir, entry.name),
        source: 'project',
      });
    } catch {
      // Skip directories with invalid SKILL.md
    }
  }

  return results;
}

// ── Loading ─────────────────────────────────────────────────────────

/** List files inside a subdirectory (returns basenames, non-recursive). */
async function listSubdir(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.filter((e) => e.isFile()).map((e) => e.name);
}

/**
 * Load a full skill from its directory, parsing SKILL.md and listing
 * the scripts/, references/, and assets/ subdirectories.
 */
export async function loadSkill(skillDir: string): Promise<LoadedSkill> {
  const skillMdPath = join(skillDir, 'SKILL.md');
  const raw = await readFile(skillMdPath, 'utf-8');
  const { data, content } = matter(raw);
  const fm = data as SkillFrontmatter;

  const dirName = basename(skillDir);

  const [scripts, references, assets] = await Promise.all([
    listSubdir(join(skillDir, 'scripts')),
    listSubdir(join(skillDir, 'references')),
    listSubdir(join(skillDir, 'assets')),
  ]);

  return {
    name: fm.name ?? dirName,
    description: fm.description ?? '',
    path: skillDir,
    source: 'project',
    frontmatter: fm,
    instructions: content.trim(),
    scripts,
    references,
    assets,
  };
}

// ── Validation ──────────────────────────────────────────────────────

/** Validate a loaded skill against the Agent Skills standard. */
export function validateSkill(skill: LoadedSkill): SkillValidationResult {
  const errors: string[] = [];

  if (!skill.frontmatter.name) {
    errors.push('Missing required field: name');
  } else if (!isValidSkillName(skill.frontmatter.name)) {
    errors.push(
      `Invalid name "${skill.frontmatter.name}": must be lowercase, hyphens only, max ${MAX_NAME_LENGTH} chars`,
    );
  }

  if (!skill.frontmatter.description) {
    errors.push('Missing required field: description');
  } else if (skill.frontmatter.description.length > MAX_DESCRIPTION_LENGTH) {
    errors.push(`Description exceeds ${MAX_DESCRIPTION_LENGTH} characters`);
  }

  if (!skill.instructions) {
    errors.push('SKILL.md has no instruction content (body is empty)');
  }

  return { valid: errors.length === 0, errors };
}

// ── Creation ────────────────────────────────────────────────────────

/**
 * Create a new skill directory with a SKILL.md file.
 * Optionally accepts scripts as a map of filename -> content.
 */
export async function createSkillDirectory(
  skillsDir: string,
  name: string,
  description: string,
  instructions: string,
  scripts?: Record<string, string>,
): Promise<LoadedSkill> {
  const skillDir = join(skillsDir, name);
  await mkdir(skillDir, { recursive: true });

  // Build SKILL.md content
  const frontmatter: SkillFrontmatter = { name, description };
  const skillMdContent = matter.stringify(instructions, frontmatter);

  await writeFile(join(skillDir, 'SKILL.md'), skillMdContent, 'utf-8');

  // Write scripts if provided
  if (scripts && Object.keys(scripts).length > 0) {
    const scriptsDir = join(skillDir, 'scripts');
    await mkdir(scriptsDir, { recursive: true });
    for (const [filename, content] of Object.entries(scripts)) {
      await writeFile(join(scriptsDir, filename), content, 'utf-8');
    }
  }

  return loadSkill(skillDir);
}

// ── Update ──────────────────────────────────────────────────────────

/**
 * Update the SKILL.md of an existing skill (frontmatter and/or instructions).
 */
export async function updateSkillMd(
  skillDir: string,
  updates: { description?: string; instructions?: string; frontmatter?: Partial<SkillFrontmatter> },
): Promise<LoadedSkill> {
  const existing = await loadSkill(skillDir);

  const fm: SkillFrontmatter = {
    ...existing.frontmatter,
    ...(updates.frontmatter ?? {}),
  };

  if (updates.description !== undefined) {
    fm.description = updates.description;
  }

  const body = updates.instructions ?? existing.instructions;
  const content = matter.stringify(body, fm);

  await writeFile(join(skillDir, 'SKILL.md'), content, 'utf-8');

  return loadSkill(skillDir);
}

// ── Migration ───────────────────────────────────────────────────────

/**
 * Migrate a legacy .ts/.js skill file into the Agent Skills directory format.
 * Creates a skill directory, moves the file to scripts/, and generates SKILL.md.
 */
export async function migrateSkill(filePath: string, skillsDir: string): Promise<LoadedSkill> {
  const ext = extname(filePath);
  const name = basename(filePath, ext).replace(/[^a-z0-9-]/gi, '-').toLowerCase();
  const skillDir = join(skillsDir, name);

  await mkdir(join(skillDir, 'scripts'), { recursive: true });

  // Move the original file into scripts/
  const destPath = join(skillDir, 'scripts', basename(filePath));
  await rename(filePath, destPath);

  // Generate SKILL.md
  const instructions = `This skill was migrated from a legacy script file.\n\nSee \`scripts/${basename(filePath)}\` for the implementation.`;
  const fm: SkillFrontmatter = {
    name,
    description: `Migrated from ${basename(filePath)}`,
  };
  const content = matter.stringify(instructions, fm);
  await writeFile(join(skillDir, 'SKILL.md'), content, 'utf-8');

  return loadSkill(skillDir);
}

// ── Legacy detection ────────────────────────────────────────────────

/**
 * Discover legacy skill files (loose .ts/.js without SKILL.md) in a skills directory.
 */
export async function discoverLegacySkills(
  skillsDir: string,
): Promise<Array<{ name: string; filename: string; content: string }>> {
  if (!existsSync(skillsDir)) return [];

  const entries = await readdir(skillsDir, { withFileTypes: true });
  const results: Array<{ name: string; filename: string; content: string }> = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.js')) continue;

    const content = await readFile(join(skillsDir, entry.name), 'utf-8');
    results.push({
      name: entry.name.replace(/\.[tj]s$/, ''),
      filename: entry.name,
      content,
    });
  }

  return results;
}
