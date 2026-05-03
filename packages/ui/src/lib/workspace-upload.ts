/**
 * Workspace upload contract enforcement (per ADR 007 + ADR 010).
 *
 * Pre-upload client-side validation:
 *   - Extension: .tar.gz or .tgz only
 *   - Total archive size: must not exceed configured limit (default 100MB)
 *
 * The server is the source of truth — these checks fail-fast before bytes are
 * sent so users do not waste time uploading rejected archives.
 */

/** Default per-archive cap: 100MB matches ADR 010. */
export const DEFAULT_MAX_TAR_UPLOAD_BYTES = 100 * 1024 * 1024;

/** Default per-file cap inside the archive: 5MB matches ADR 010. */
export const DEFAULT_MAX_PER_FILE_BYTES = 5 * 1024 * 1024;

const ACCEPTED_EXTENSIONS = ['.tar.gz', '.tgz'] as const;

export interface ValidateOptions {
  /** Max archive size in bytes; defaults to 100MB. */
  maxBytes?: number;
}

export type ValidateResult =
  | { ok: true }
  | { ok: false; error: string };

function hasAcceptedExtension(name: string): boolean {
  const lower = name.toLowerCase();
  return ACCEPTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
}

/**
 * Validate that a File can be sent to the workspace upload endpoint.
 * Returns an inline error message when the upload should be rejected.
 */
export function validateWorkspaceArchive(
  file: File,
  options: ValidateOptions = {},
): ValidateResult {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_TAR_UPLOAD_BYTES;

  if (!hasAcceptedExtension(file.name)) {
    return {
      ok: false,
      error: `Workspace uploads must be a .tar.gz or .tgz archive. Got: ${file.name}`,
    };
  }

  if (file.size > maxBytes) {
    return {
      ok: false,
      error: `Archive is ${formatMb(file.size)}, which exceeds the ${formatMb(maxBytes)} limit.`,
    };
  }

  if (file.size === 0) {
    return { ok: false, error: 'Archive is empty.' };
  }

  return { ok: true };
}
