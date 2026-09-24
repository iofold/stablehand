import type postgres from 'postgres';

/**
 * One-way hard cut for persisted agent tool configuration.
 *
 * Runtime aliases are intentionally absent. This rewrite executes before any
 * agent definition is read and is idempotent once the legacy keys disappear.
 */
export async function canonicalizePersistedToolPolicies(sql: postgres.Sql): Promise<void> {
  const conflicts = await sql`
    SELECT id
    FROM agents
    WHERE (
      metadata ? 'nativeTools'
      AND metadata ? 'nativeToolPolicy'
    ) OR (
      metadata ? 'excludeBuiltinTools'
      AND metadata ? 'builtinToolPolicy'
    ) OR (
      manifest->'spec' ? 'nativeTools'
      AND manifest->'spec' ? 'nativeToolPolicy'
    )
    ORDER BY id
  `;
  if (conflicts.length > 0) {
    throw new Error(
      `Cannot canonicalize agent tool policies with legacy/canonical conflicts: ${conflicts.map((row) => row.id).join(', ')}`,
    );
  }

  const malformed = await sql`
    SELECT id
    FROM agents
    WHERE (
      metadata ? 'nativeTools'
      AND metadata->'nativeTools' <> 'null'::jsonb
      AND (
        jsonb_typeof(metadata->'nativeTools') <> 'object'
        OR (
          metadata->'nativeTools' ? 'allowlist'
          AND jsonb_typeof(metadata->'nativeTools'->'allowlist') <> 'array'
        )
        OR (
          metadata->'nativeTools' ? 'blocklist'
          AND jsonb_typeof(metadata->'nativeTools'->'blocklist') <> 'array'
        )
      )
    ) OR (
      manifest->'spec' ? 'nativeTools'
      AND manifest->'spec'->'nativeTools' <> 'null'::jsonb
      AND (
        jsonb_typeof(manifest->'spec'->'nativeTools') <> 'object'
        OR (
          manifest->'spec'->'nativeTools' ? 'allowlist'
          AND jsonb_typeof(manifest->'spec'->'nativeTools'->'allowlist') <> 'array'
        )
        OR (
          manifest->'spec'->'nativeTools' ? 'blocklist'
          AND jsonb_typeof(manifest->'spec'->'nativeTools'->'blocklist') <> 'array'
        )
      )
    ) OR (
      metadata ? 'excludeBuiltinTools'
      AND metadata->'excludeBuiltinTools' <> 'null'::jsonb
      AND jsonb_typeof(metadata->'excludeBuiltinTools') <> 'array'
    )
    ORDER BY id
  `;
  if (malformed.length > 0) {
    throw new Error(
      `Cannot canonicalize malformed agent tool policy data: ${malformed.map((row) => row.id).join(', ')}`,
    );
  }

  await sql`
    UPDATE agents
    SET metadata = (metadata - 'nativeTools') || jsonb_build_object(
      'nativeToolPolicy',
      CASE
        WHEN metadata->'nativeTools' = 'null'::jsonb
          THEN jsonb_build_object('policy', 'all')
        WHEN metadata->'nativeTools' ? 'allowlist'
          THEN CASE jsonb_array_length(metadata->'nativeTools'->'allowlist')
            WHEN 0 THEN jsonb_build_object('policy', 'none')
            ELSE jsonb_build_object(
              'policy', 'allow',
              'names', metadata->'nativeTools'->'allowlist'
            )
          END
        WHEN metadata->'nativeTools' ? 'blocklist'
          AND jsonb_array_length(metadata->'nativeTools'->'blocklist') > 0
          THEN jsonb_build_object(
            'policy', 'deny',
            'names', metadata->'nativeTools'->'blocklist'
          )
        ELSE jsonb_build_object('policy', 'all')
      END
    )
    WHERE metadata ? 'nativeTools'
  `;

  await sql`
    UPDATE agents
    SET manifest = jsonb_set(
      manifest,
      '{spec}',
      ((manifest->'spec') - 'nativeTools') || jsonb_build_object(
        'nativeToolPolicy',
        CASE
          WHEN manifest->'spec'->'nativeTools' = 'null'::jsonb
            THEN jsonb_build_object('policy', 'all')
          WHEN manifest->'spec'->'nativeTools' ? 'allowlist'
            THEN CASE jsonb_array_length(manifest->'spec'->'nativeTools'->'allowlist')
              WHEN 0 THEN jsonb_build_object('policy', 'none')
              ELSE jsonb_build_object(
                'policy', 'allow',
                'names', manifest->'spec'->'nativeTools'->'allowlist'
              )
            END
          WHEN manifest->'spec'->'nativeTools' ? 'blocklist'
            AND jsonb_array_length(manifest->'spec'->'nativeTools'->'blocklist') > 0
            THEN jsonb_build_object(
              'policy', 'deny',
              'names', manifest->'spec'->'nativeTools'->'blocklist'
            )
          ELSE jsonb_build_object('policy', 'all')
        END
      )
    )
    WHERE manifest->'spec' ? 'nativeTools'
  `;

  await sql`
    UPDATE agents
    SET metadata = (metadata - 'excludeBuiltinTools') || jsonb_build_object(
      'builtinToolPolicy',
      CASE
        WHEN metadata->'excludeBuiltinTools' = 'null'::jsonb
          OR jsonb_array_length(metadata->'excludeBuiltinTools') = 0
          THEN jsonb_build_object('policy', 'all')
        ELSE jsonb_build_object(
          'policy', 'deny',
          'names', metadata->'excludeBuiltinTools'
        )
      END
    )
    WHERE metadata ? 'excludeBuiltinTools'
  `;

  await sql`
    UPDATE agents AS agent
    SET tools = COALESCE((
      SELECT jsonb_agg(tool_name.value ORDER BY tool_name.ordinality)
      FROM jsonb_array_elements_text(agent.tools)
        WITH ORDINALITY AS tool_name(value, ordinality)
      WHERE NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(agent.metadata->'httpTools') AS definition
        WHERE definition->>'name' = tool_name.value
      )
    ), '[]'::jsonb)
    WHERE jsonb_typeof(agent.metadata->'httpTools') = 'array'
  `;
}
