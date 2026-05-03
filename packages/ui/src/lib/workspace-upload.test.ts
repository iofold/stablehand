import { describe, expect, it } from 'vitest';
import {
  validateWorkspaceArchive,
  DEFAULT_MAX_TAR_UPLOAD_BYTES,
  DEFAULT_MAX_PER_FILE_BYTES,
} from './workspace-upload';

function makeFile(name: string, sizeBytes: number, type = 'application/gzip'): File {
  const blob = new Blob([new Uint8Array(sizeBytes)], { type });
  return new File([blob], name, { type });
}

describe('validateWorkspaceArchive', () => {
  it('accepts .tar.gz archives within the size limit', () => {
    const result = validateWorkspaceArchive(makeFile('workspace.tar.gz', 1024));
    expect(result).toEqual({ ok: true });
  });

  it('accepts .tgz archives within the size limit', () => {
    const result = validateWorkspaceArchive(makeFile('workspace.tgz', 1024));
    expect(result).toEqual({ ok: true });
  });

  it('rejects archives without an accepted extension', () => {
    const result = validateWorkspaceArchive(makeFile('archive.zip', 1024, 'application/zip'));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('.tar.gz or .tgz');
    }
  });

  it('rejects archives whose name has no recognizable extension', () => {
    const result = validateWorkspaceArchive(makeFile('workspace', 1024));
    expect(result.ok).toBe(false);
  });

  it('rejects archives that exceed the configured byte limit', () => {
    const result = validateWorkspaceArchive(makeFile('big.tar.gz', 2_000), { maxBytes: 1_000 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/exceeds the/);
    }
  });

  it('rejects empty archives', () => {
    const result = validateWorkspaceArchive(makeFile('empty.tar.gz', 0));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/empty/);
    }
  });

  it('exposes 100MB as the default archive cap', () => {
    expect(DEFAULT_MAX_TAR_UPLOAD_BYTES).toBe(100 * 1024 * 1024);
  });

  it('exposes 5MB as the default per-file cap', () => {
    expect(DEFAULT_MAX_PER_FILE_BYTES).toBe(5 * 1024 * 1024);
  });
});
