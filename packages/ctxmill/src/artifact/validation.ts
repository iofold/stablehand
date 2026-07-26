import {
  ARTIFACT_METADATA_MAX_BYTES,
  ArtifactKindSchema,
  ArtifactMetadataSchema,
  serializedJsonByteLength,
} from '@ctxmill/contracts';

export type ArtifactRegistrationFieldsResult =
  | {
      success: true;
      kind?: string;
      metadata?: Record<string, unknown>;
    }
  | {
      success: false;
      reason: 'invalid_kind' | 'invalid_metadata' | 'metadata_too_large';
      error: string;
    };

export function validateArtifactRegistrationFields(input: {
  kind?: unknown;
  metadata?: unknown;
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

  return {
    success: true,
    ...(kind ? { kind } : {}),
    ...(metadata ? { metadata } : {}),
  };
}
