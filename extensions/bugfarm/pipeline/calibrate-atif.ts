// ATIF v1.8 -> v1.7. Harbor 0.24 writes ATIF-v1.8 trajectories; v1.8 only adds audio content parts
// (`{"type": "audio", "source": {...}}`) next to text and image. A v1.7 consumer gets the same
// trajectory with its version strings lowered and each audio part replaced by a text note naming
// the file, so nothing is silently dropped. The raw v1.8 file is always kept beside the copy.

export interface AtifConversion {
  trajectory: Record<string, unknown>;
  /** Audio parts that became text notes. */
  audio_parts_replaced: number;
  /** schema_version values rewritten (root plus embedded subagents). */
  versions_rewritten: number;
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

function isObj(v: unknown): v is Record<string, Json> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function convertParts(parts: Json[], stats: { audio: number }): Json[] {
  return parts.map((p) => {
    if (isObj(p) && p.type === 'audio') {
      stats.audio++;
      const src = isObj(p.source) ? p.source : {};
      const path = typeof src.path === 'string' ? src.path : 'unknown';
      const media = typeof src.media_type === 'string' ? src.media_type : 'audio';
      return { type: 'text', text: `[audio omitted in ATIF-v1.7: ${media} at ${path}]` };
    }
    return p;
  });
}

function convertTrajectory(t: Record<string, Json>, stats: { audio: number; versions: number }): Record<string, Json> {
  const out: Record<string, Json> = { ...t };
  if (typeof out.schema_version === 'string' && out.schema_version !== 'ATIF-v1.7') {
    if (!/^ATIF-v1\.[0-8]$/.test(out.schema_version)) throw new Error(`unsupported ATIF version ${out.schema_version}`);
    // Only lower newer versions; older documents are already valid v1.7 readers' input.
    if (out.schema_version === 'ATIF-v1.8') {
      out.schema_version = 'ATIF-v1.7';
      stats.versions++;
    }
  }
  if (Array.isArray(out.steps)) {
    out.steps = out.steps.map((s) => {
      if (!isObj(s)) return s;
      const step: Record<string, Json> = { ...s };
      if (Array.isArray(step.message)) step.message = convertParts(step.message, stats);
      if (isObj(step.observation) && Array.isArray(step.observation.results)) {
        step.observation = {
          ...step.observation,
          results: step.observation.results.map((r) => (isObj(r) && Array.isArray(r.content) ? { ...r, content: convertParts(r.content, stats) } : r)),
        };
      }
      return step;
    });
  }
  if (Array.isArray(out.subagent_trajectories)) {
    out.subagent_trajectories = out.subagent_trajectories.map((sub) => (isObj(sub) ? convertTrajectory(sub, stats) : sub));
  }
  return out;
}

export function toAtifV17(trajectory: unknown): AtifConversion {
  if (!isObj(trajectory)) throw new Error('not an ATIF trajectory object');
  const stats = { audio: 0, versions: 0 };
  const converted = convertTrajectory(trajectory, stats);
  return { trajectory: converted, audio_parts_replaced: stats.audio, versions_rewritten: stats.versions };
}
