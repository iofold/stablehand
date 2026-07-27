import {
  ARTIFACT_METADATA_MAX_BYTES,
  ArtifactKindSchema,
  ArtifactMetadataSchema,
  ArtifactSha256Schema,
  serializedJsonByteLength,
} from '@ctxmill/contracts';

export type ArtifactRegistrationFieldsResult =
  | {
      success: true;
      kind?: string;
      metadata?: Record<string, unknown>;
      sha256?: string;
    }
  | {
      success: false;
      reason: 'invalid_kind' | 'invalid_metadata' | 'metadata_too_large' | 'invalid_sha256';
      error: string;
    };

export function validateArtifactRegistrationFields(input: {
  kind?: unknown;
  metadata?: unknown;
  sha256?: unknown;
}): ArtifactRegistrationFieldsResult {
  let kind: string | undefined;
  if (input.kind !== undefined) {
    const parsedKind = ArtifactKindSchema.safeParse(input.kind);
    if (!parsedKind.success) {
      return {
        success: false,
        reason: 'invalid_kind',
        error: 'kind must match ^[a-z0-9][a-z0-9_-]{0,63}$',
      };
    }
    kind = parsedKind.data;
  }

  let metadata: Record<string, unknown> | undefined;
  if (input.metadata !== undefined) {
    if (
      input.metadata === null
      || typeof input.metadata !== 'object'
      || Array.isArray(input.metadata)
    ) {
      return {
        success: false,
        reason: 'invalid_metadata',
        error: 'metadata must be a JSON object',
      };
    }
    const sizeBytes = serializedJsonByteLength(input.metadata);
    if (sizeBytes > ARTIFACT_METADATA_MAX_BYTES) {
      return {
        success: false,
        reason: 'metadata_too_large',
        error: `metadata exceeds ${ARTIFACT_METADATA_MAX_BYTES} serialized bytes`,
      };
    }
    const parsedMetadata = ArtifactMetadataSchema.safeParse(input.metadata);
    if (!parsedMetadata.success) {
      return {
        success: false,
        reason: 'invalid_metadata',
        error: 'metadata must be a JSON object',
      };
    }
    metadata = parsedMetadata.data;
  }

  let sha256: string | undefined;
  if (input.sha256 !== undefined) {
    const parsedSha256 = ArtifactSha256Schema.safeParse(input.sha256);
    if (!parsedSha256.success) {
      return {
        success: false,
        reason: 'invalid_sha256',
        error: 'sha256 must be 64 lowercase hex characters',
      };
    }
    sha256 = parsedSha256.data;
  }

  return {
    success: true,
    ...(kind ? { kind } : {}),
    ...(metadata ? { metadata } : {}),
    ...(sha256 ? { sha256 } : {}),
  };
}
