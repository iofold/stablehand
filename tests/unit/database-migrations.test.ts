import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CanonicalStreamEventSchema,
  WEBHOOK_PAYLOAD_SCHEMAS,
} from '@stablehand/contracts';
import { createDatabase, type DatabaseConnection } from '../../packages/stablehand/src/database/connection.js';
import {
  CANONICAL_EVENT_CONTRACTS_MIGRATION_ID,
  INTERRUPT_TOOL_NAME_MIGRATION_ID,
  CANONICAL_EVENT_CONTRACTS_MIGRATION_VERSION,
  CURRENT_SCHEMA_VERSION,
  MESSAGE_HISTORY_ADOPTION_MIGRATION_ID,
  MESSAGE_HISTORY_ADOPTION_MIGRATION_VERSION,
  MIGRATION_ADVISORY_LOCK_ID,
  runMigrations,
  SCHEMA_FINGERPRINT_MARKER_ID,
  schemaMigrationFingerprint,
  TEXT_MESSAGE_END_CONTRACT_MIGRATION_ID,
  TEXT_MESSAGE_END_CONTRACT_MIGRATION_VERSION,
} from '../../packages/stablehand/src/database/migrations.js';
import { resolveTestDatabaseUrl } from '../utils/test-db.js';

async function dropAllPublicTables(conn: DatabaseConnection): Promise<void> {
  const tables = await conn.pgClient`
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
  `;

  for (const table of tables) {
    await conn.pgClient`DROP TABLE IF EXISTS ${conn.pgClient(table.tablename as string)} CASCADE`;
  }
}

/**
 * Make the next runMigrations start like one on a database last migrated by
 * older code: forget the schema fingerprint (and any named data-migration
 * markers) so the full pass runs over rows seeded in legacy shapes.
 */
async function forgetMigrationMarkers(
  conn: DatabaseConnection,
  ...markerIds: string[]
): Promise<void> {
  await conn.pgClient`
    DELETE FROM stablehand_schema_version
    WHERE id IN ${conn.pgClient([SCHEMA_FINGERPRINT_MARKER_ID, ...markerIds])}
  `;
}

describe('database migration baseline guard', () => {
  let conn: DatabaseConnection;

  beforeAll(async () => {
    conn = await createDatabase(resolveTestDatabaseUrl());
    await conn.pgClient`SELECT pg_advisory_lock(${MIGRATION_ADVISORY_LOCK_ID})`;
  });

  afterAll(async () => {
    if (!conn) return;
    try {
      await dropAllPublicTables(conn);
      await runMigrations(conn.pgClient);
      await conn.pgClient`SELECT pg_advisory_unlock(${MIGRATION_ADVISORY_LOCK_ID})`;
    } finally {
      await conn.close();
    }
  });

  it('fails clearly for existing non-empty databases without a stablehand baseline marker', async () => {
    await dropAllPublicTables(conn);
    await conn.pgClient`CREATE TABLE legacy_unversioned_table (id TEXT PRIMARY KEY)`;

    await expect(runMigrations(conn.pgClient)).rejects.toThrow(
      /existing unversioned public tables \(legacy_unversioned_table\)/,
    );
  });

  it('adopts a pre-rename ctxmill_schema_version marker in place', async () => {
    await dropAllPublicTables(conn);
    await conn.pgClient`
      CREATE TABLE ctxmill_schema_version (
        id TEXT PRIMARY KEY NOT NULL,
        version INTEGER NOT NULL,
        baseline TEXT NOT NULL,
        initialized_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `;
    await conn.pgClient`
      INSERT INTO ctxmill_schema_version (id, version, baseline, initialized_at)
      VALUES ('baseline', ${CURRENT_SCHEMA_VERSION}, 'pre-release', '2026-03-17T00:00:00Z')
    `;

    await runMigrations(conn.pgClient);

    const [tables] = await conn.pgClient`
      SELECT
        to_regclass('public.ctxmill_schema_version') AS legacy,
        to_regclass('public.stablehand_schema_version') AS current
    `;
    expect(tables?.legacy).toBeNull();
    expect(tables?.current).toBe('stablehand_schema_version');

    const [baseline] = await conn.pgClient`
      SELECT version, baseline, initialized_at
      FROM stablehand_schema_version
      WHERE id = 'baseline'
    `;
    expect(baseline?.version).toBe(CURRENT_SCHEMA_VERSION);
    expect(baseline?.baseline).toBe('pre-release');
    expect(new Date(baseline?.initialized_at as string).toISOString()).toBe('2026-03-17T00:00:00.000Z');
  });

  it('refuses to guess when both the legacy and current schema markers exist', async () => {
    await dropAllPublicTables(conn);
    await conn.pgClient`CREATE TABLE ctxmill_schema_version (id TEXT PRIMARY KEY NOT NULL)`;
    await conn.pgClient`CREATE TABLE stablehand_schema_version (id TEXT PRIMARY KEY NOT NULL)`;

    await expect(runMigrations(conn.pgClient)).rejects.toThrow(
      /both ctxmill_schema_version and stablehand_schema_version exist/,
    );
  });

  it('hard-migrates explicit tool policies and separates HTTP definitions from tool refs', async () => {
    await dropAllPublicTables(conn);
    await runMigrations(conn.pgClient);
    await conn.pgClient`
      INSERT INTO agents (
        id, name, harness, harness_config, system_prompt, tools,
        manifest, metadata, created_at, updated_at
      )
      VALUES
        (
          'agent-policy-allow', 'allow-agent', 'claude-agents', '{}', 'prompt',
          '["search","weather","artifact_upload"]',
          '{"spec":{"nativeTools":{"blocklist":["Bash"]}}}',
          '{
            "nativeTools":{"allowlist":["Read","Write"],"blocklist":["Bash"]},
            "excludeBuiltinTools":["artifact_download"],
            "httpTools":[{"name":"weather","description":"Weather","endpoint":"https://example.test"}],
            "owner":"ops"
          }',
          1, 1
        ),
        (
          'agent-policy-none', 'none-agent', 'pi-agent', '{}', 'prompt',
          '["weather"]',
          NULL,
          '{
            "nativeTools":{"allowlist":[],"blocklist":["bash"]},
            "excludeBuiltinTools":[],
            "httpTools":[{"name":"weather","description":"Weather","endpoint":"https://example.test"}]
          }',
          1, 1
        ),
        (
          'agent-policy-deny', 'deny-agent', 'langgraph', '{}', 'prompt',
          '[]',
          '{"spec":{"nativeTools":{}}}',
          '{"nativeTools":{"blocklist":["execute"]}}',
          1, 1
        )
    `;

    await forgetMigrationMarkers(conn);
    await runMigrations(conn.pgClient);

    const rows = await conn.pgClient`
      SELECT id, tools, manifest, metadata
      FROM agents
      WHERE id LIKE 'agent-policy-%'
      ORDER BY id
    `;
    expect(rows).toEqual([
      expect.objectContaining({
        id: 'agent-policy-allow',
        tools: ['search', 'artifact_upload'],
        manifest: {
          spec: { nativeToolPolicy: { policy: 'deny', names: ['Bash'] } },
        },
        metadata: {
          nativeToolPolicy: { policy: 'allow', names: ['Read', 'Write'] },
          builtinToolPolicy: { policy: 'deny', names: ['artifact_download'] },
          httpTools: [{
            name: 'weather',
            description: 'Weather',
            endpoint: 'https://example.test',
          }],
          owner: 'ops',
        },
      }),
      expect.objectContaining({
        id: 'agent-policy-deny',
        tools: [],
        manifest: { spec: { nativeToolPolicy: { policy: 'all' } } },
        metadata: { nativeToolPolicy: { policy: 'deny', names: ['execute'] } },
      }),
      expect.objectContaining({
        id: 'agent-policy-none',
        tools: [],
        manifest: null,
        metadata: {
          nativeToolPolicy: { policy: 'none' },
          builtinToolPolicy: { policy: 'all' },
          httpTools: [{
            name: 'weather',
            description: 'Weather',
            endpoint: 'https://example.test',
          }],
        },
      }),
    ]);

    await forgetMigrationMarkers(conn);
    await runMigrations(conn.pgClient);
    const repeated = await conn.pgClient`
      SELECT id, tools, manifest, metadata
      FROM agents
      WHERE id LIKE 'agent-policy-%'
      ORDER BY id
    `;
    expect(repeated).toEqual(rows);
  });

  it('establishes unique deployment names without clobbering existing suffix-shaped names', async () => {
    await dropAllPublicTables(conn);
    await runMigrations(conn.pgClient);
    await conn.pgClient`DROP INDEX idx_agents_name`;
    await conn.pgClient`
      INSERT INTO agents (
        id, name, harness, harness_config, system_prompt, tools,
        manifest, created_at, updated_at
      )
      VALUES
        (
          'agent-a', 'shared', 'langgraph', '{}', 'prompt', '[]',
          '{"metadata":{"name":"shared"},"spec":{}}', 1, 1
        ),
        (
          'agent-b', 'shared', 'langgraph', '{}', 'prompt', '[]',
          '{"metadata":{"name":"shared"},"spec":{}}', 2, 2
        ),
        (
          'agent-c', 'shared', 'langgraph', '{}', 'prompt', '[]',
          '{"metadata":{"name":"shared"},"spec":{}}', 3, 3
        ),
        (
          'agent-collision', 'shared-duplicate-agent-b', 'langgraph', '{}', 'prompt', '[]',
          NULL, 1, 1
        )
    `;

    await forgetMigrationMarkers(conn);
    await runMigrations(conn.pgClient);

    const rows = await conn.pgClient`
      SELECT id, name, manifest
      FROM agents
      ORDER BY id
    `;
    expect(rows).toEqual([
      expect.objectContaining({
        id: 'agent-a',
        name: 'shared',
        manifest: { metadata: { name: 'shared' }, spec: {} },
      }),
      expect.objectContaining({
        id: 'agent-b',
        name: 'shared-duplicate-agent-b-1',
        manifest: { metadata: { name: 'shared-duplicate-agent-b-1' }, spec: {} },
      }),
      expect.objectContaining({
        id: 'agent-c',
        name: 'shared-duplicate-agent-c',
        manifest: { metadata: { name: 'shared-duplicate-agent-c' }, spec: {} },
      }),
      expect.objectContaining({
        id: 'agent-collision',
        name: 'shared-duplicate-agent-b',
        manifest: null,
      }),
    ]);

    await forgetMigrationMarkers(conn);
    await runMigrations(conn.pgClient);
    const repeated = await conn.pgClient`
      SELECT id, name, manifest
      FROM agents
      ORDER BY id
    `;
    expect(repeated).toEqual(rows);
  });

  it('removes retired agent version storage', async () => {
    await dropAllPublicTables(conn);
    await runMigrations(conn.pgClient);

    const [table] = await conn.pgClient`
      SELECT to_regclass('public.agent_versions') AS name
    `;
    const retiredColumns = await conn.pgClient`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'agents'
        AND column_name IN ('status', 'version')
    `;

    expect(table?.name).toBeNull();
    expect(retiredColumns).toEqual([]);
  });

  it('adds artifact routing metadata and content hash idempotently', async () => {
    await dropAllPublicTables(conn);
    await runMigrations(conn.pgClient);
    await forgetMigrationMarkers(conn);
    await runMigrations(conn.pgClient);

    const columns = await conn.pgClient`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'artifacts'
        AND column_name IN ('kind', 'metadata', 'sha256')
      ORDER BY column_name
    `;

    expect(columns).toEqual([
      { column_name: 'kind' },
      { column_name: 'metadata' },
      { column_name: 'sha256' },
    ]);
  });

  it('adds the event conversation correlation index idempotently', async () => {
    await dropAllPublicTables(conn);
    await runMigrations(conn.pgClient);
    await forgetMigrationMarkers(conn);
    await runMigrations(conn.pgClient);

    const [index] = await conn.pgClient`
      SELECT indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname = 'idx_event_store_conversation_seq'
    `;

    expect(index?.indexdef).toContain('(conversation_id, seq)');
    expect(index?.indexdef).toContain('WHERE (conversation_id IS NOT NULL)');
  });

  it('skips the schema pass when this build already completed it on the database', async () => {
    const indexName = async () => {
      const [row] = await conn.pgClient`
        SELECT to_regclass('public.idx_event_store_conversation_seq')::text AS name
      `;
      return row?.name ?? null;
    };
    const recordedFingerprint = async () => {
      const [row] = await conn.pgClient`
        SELECT version, baseline
        FROM stablehand_schema_version
        WHERE id = ${SCHEMA_FINGERPRINT_MARKER_ID}
      `;
      return row ? { version: Number(row.version), baseline: row.baseline } : null;
    };
    const fingerprint = schemaMigrationFingerprint();
    expect(fingerprint).toMatch(/^[0-9a-f]{32}$/);

    await dropAllPublicTables(conn);
    await expect(runMigrations(conn.pgClient)).resolves.toEqual({ schema: 'applied', fingerprint });
    expect(await recordedFingerprint()).toEqual({
      version: CURRENT_SCHEMA_VERSION,
      baseline: fingerprint,
    });

    // Same build, same database: nothing runs, so a dropped index stays dropped.
    await conn.pgClient`DROP INDEX idx_event_store_conversation_seq`;
    await expect(runMigrations(conn.pgClient)).resolves.toEqual({ schema: 'current', fingerprint });
    expect(await indexName()).toBeNull();

    // A database last migrated by different code gets the full pass again.
    await conn.pgClient`
      UPDATE stablehand_schema_version
      SET baseline = 'older-build'
      WHERE id = ${SCHEMA_FINGERPRINT_MARKER_ID}
    `;
    await expect(runMigrations(conn.pgClient)).resolves.toEqual({ schema: 'applied', fingerprint });
    expect(await indexName()).toBe('idx_event_store_conversation_seq');
    expect(await recordedFingerprint()).toEqual({
      version: CURRENT_SCHEMA_VERSION,
      baseline: fingerprint,
    });
  });

  it('records the schema fingerprint only after the pass completes', async () => {
    await dropAllPublicTables(conn);
    await runMigrations(conn.pgClient);
    await forgetMigrationMarkers(conn);
    // Legacy and canonical policy keys together make the tool-policy hard cut
    // refuse, failing the pass part-way.
    await conn.pgClient`
      INSERT INTO agents (
        id, name, harness, harness_config, system_prompt, tools, metadata,
        created_at, updated_at
      )
      VALUES (
        'agent-conflict', 'conflict', 'langgraph', '{}', 'prompt', '[]',
        '{"nativeTools":{"allowlist":["Read"]},"nativeToolPolicy":{"policy":"all"}}',
        1, 1
      )
    `;

    await expect(runMigrations(conn.pgClient)).rejects.toThrow(/legacy\/canonical conflicts/);
    const markers = await conn.pgClient`
      SELECT id FROM stablehand_schema_version WHERE id = ${SCHEMA_FINGERPRINT_MARKER_ID}
    `;
    expect(markers).toHaveLength(0);

    await conn.pgClient`DELETE FROM agents WHERE id = 'agent-conflict'`;
    await expect(runMigrations(conn.pgClient)).resolves.toMatchObject({ schema: 'applied' });
    await expect(runMigrations(conn.pgClient)).resolves.toMatchObject({ schema: 'current' });
  });

  it('adopts pre-revision message history once, not on every full pass', async () => {
    await dropAllPublicTables(conn);
    await runMigrations(conn.pgClient);
    const [adoption] = await conn.pgClient`
      SELECT version
      FROM stablehand_schema_version
      WHERE id = ${MESSAGE_HISTORY_ADOPTION_MIGRATION_ID}
    `;
    expect(Number(adoption?.version)).toBe(MESSAGE_HISTORY_ADOPTION_MIGRATION_VERSION);

    // History in the pre-revision shape: no message identity on the row, no
    // terminal watermark on the completed turn.
    await conn.pgClient`
      INSERT INTO agents (
        id, name, harness, harness_config, system_prompt, tools,
        created_at, updated_at
      )
      VALUES ('agent-1', 'agent', 'langgraph', '{}', 'prompt', '[]', 1, 1)
    `;
    await conn.pgClient`
      INSERT INTO conversations (id, agent_id, created_at, updated_at)
      VALUES ('conversation-1', 'agent-1', 1, 1)
    `;
    await conn.pgClient`
      INSERT INTO turns (
        id, agent_id, conversation_id, mode, status, queued_at, started_at, completed_at, tags
      )
      VALUES ('turn-1', 'agent-1', 'conversation-1', 'interactive', 'completed', 1, 1, 20, '{}')
    `;
    await conn.pgClient`
      INSERT INTO messages (id, conversation_id, agent_id, role, content, created_at)
      VALUES ('message-1', 'conversation-1', 'agent-1', 'assistant', 'Done.', 1)
    `;
    const source = {
      turnId: 'turn-1',
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      messageId: 'message-1',
      messageSeq: 0,
      role: 'assistant',
      content: 'Done.',
      timestamp: 10,
    };
    await conn.pgClient`
      INSERT INTO event_store (
        type, agent_id, payload, created_at, turn_id, conversation_id,
        channel, source_type, source_payload
      )
      VALUES
        (
          'CUSTOM', 'agent-1',
          ${JSON.stringify({ type: 'CUSTOM', name: 'stablehand.message.committed', ...source, delivery: { id: 'd-1', seq: 3 } })},
          10, 'turn-1', 'conversation-1', 'run', 'message.committed',
          ${JSON.stringify(source)}
        ),
        (
          'RUN_FINISHED', 'agent-1',
          '{"type":"RUN_FINISHED","runId":"turn-1","threadId":"conversation-1","timestamp":20}',
          20, 'turn-1', 'conversation-1', 'run', 'turn.completed',
          '{"turnId":"turn-1","agentId":"agent-1","conversationId":"conversation-1","status":"completed","durationMs":19,"timestamp":20}'
        )
    `;
    const snapshot = async () => {
      const [message] = await conn.pgClient`
        SELECT turn_id, message_seq FROM messages WHERE id = 'message-1'
      `;
      const [turn] = await conn.pgClient`
        SELECT terminal_published_seq FROM turns WHERE id = 'turn-1'
      `;
      const frames = await conn.pgClient`
        SELECT seq, xmin::text AS row_version FROM event_store ORDER BY seq
      `;
      return {
        turnId: message?.turn_id ?? null,
        messageSeq: message?.message_seq == null ? null : Number(message.message_seq),
        terminalPublishedSeq: turn?.terminal_published_seq == null
          ? null
          : Number(turn.terminal_published_seq),
        frames: frames.map((frame) => `${frame.seq}:${frame.row_version}`),
      };
    };
    const before = await snapshot();

    // A full pass (new build) does not repeat the recorded adoption.
    await forgetMigrationMarkers(conn);
    await expect(runMigrations(conn.pgClient)).resolves.toMatchObject({ schema: 'applied' });
    expect(await snapshot()).toEqual(before);

    // Without the adoption marker (a database from before it), it adopts.
    await forgetMigrationMarkers(conn, MESSAGE_HISTORY_ADOPTION_MIGRATION_ID);
    await runMigrations(conn.pgClient);
    const after = await snapshot();
    const [finished] = await conn.pgClient`
      SELECT seq FROM event_store WHERE type = 'RUN_FINISHED'
    `;
    expect(after).toMatchObject({
      turnId: 'turn-1',
      messageSeq: 0,
      terminalPublishedSeq: Number(finished?.seq),
    });
  });

  it('hard-migrates persisted event, trigger, wait, and webhook contracts', async () => {
    await dropAllPublicTables(conn);
    await runMigrations(conn.pgClient);
    await conn.pgClient`
      DELETE FROM stablehand_schema_version
      WHERE id IN (${CANONICAL_EVENT_CONTRACTS_MIGRATION_ID}, ${INTERRUPT_TOOL_NAME_MIGRATION_ID})
    `;

    await conn.pgClient`
      INSERT INTO agents (
        id, name, harness, harness_config, system_prompt, tools,
        created_at, updated_at
      )
      VALUES (
        'agent-1', 'agent', 'langgraph', '{"model":"gpt-5"}', 'prompt', '[]',
        1, 1
      )
    `;
    await conn.pgClient`
      INSERT INTO event_store (
        type, agent_id, payload, created_at, turn_id, conversation_id,
        channel, source_type, source_payload
      )
      VALUES
      (
        'TEXT_MESSAGE_CONTENT',
        'agent-1',
        '{"type":"TEXT_MESSAGE_CONTENT","agentId":"agent-1","turnId":"turn-1","conversationId":"conversation-1","runId":"turn-1","threadId":"conversation-1","messageId":"message-1","content":"hello","delta":"hello","timestamp":10}',
        10,
        'turn-1',
        'conversation-1',
        'run',
        'run.text_chunk',
        '{"turnId":"turn-1","agentId":"agent-1","conversationId":"conversation-1","messageId":"message-1","content":"hello","timestamp":10}'
      ),
      (
        'CUSTOM',
        'agent-1',
        '{"type":"CUSTOM","name":"stablehand.hitl.requested","subtype":"hitl_pause","runId":"turn-1","threadId":"conversation-1","value":{},"agentId":"agent-1","turnId":"turn-1","conversationId":"conversation-1","interruptId":"interrupt-1","toolCallId":"tool-call-1","toolName":"Bash","args":{},"timestamp":11}',
        11,
        'turn-1',
        'conversation-1',
        'run',
        'run.interrupted',
        '{"turnId":"turn-1","agentId":"agent-1","conversationId":"conversation-1","interruptId":"interrupt-1","toolCallId":"tool-call-1","toolName":"Bash","args":{},"timestamp":11}'
      ),
      (
        'CUSTOM',
        'agent-1',
        '{"type":"CUSTOM","name":"stablehand.claude.runtime_capabilities","value":{},"timestamp":12}',
        12,
        NULL,
        NULL,
        'run',
        'stablehand.claude.runtime_capabilities',
        '{"agentId":"agent-1","timestamp":12}'
      ),
      (
        'RUN_FINISHED',
        'agent-1',
        '{"type":"RUN_FINISHED","agentId":"agent-1","turnId":"turn-1","conversationId":"conversation-1","runId":"turn-1","threadId":"conversation-1","status":"completed","usage":{"inputTokens":3,"outputTokens":5,"totalTokens":8,"cost":0.01},"timestamp":13}',
        13,
        'turn-1',
        'conversation-1',
        'run',
        'run.ag_ui_event',
        '{"type":"RUN_FINISHED","runId":"turn-1","threadId":"conversation-1","status":"completed","usage":{"inputTokens":3,"outputTokens":5,"totalTokens":8,"cost":0.01},"timestamp":13}'
      ),
      (
        'run.tool_started',
        'agent-1',
        '{"turnId":"turn-1","agentId":"agent-1","conversationId":"conversation-1","toolCallId":"tool-call-1","toolName":"Bash","args":{},"timestamp":14}',
        14,
        'turn-1',
        'conversation-1',
        'system',
        NULL,
        NULL
      )
    `;
    await conn.pgClient`
      INSERT INTO event_triggers (
        id, agent_id, event_type, selector, selector_hash,
        task_template, enabled, created_at
      )
      VALUES
        ('trigger-old', 'agent-1', 'run.tool_started', NULL, 'same', 'old', true, '1'),
        ('trigger-new', 'agent-1', 'tool_call.started', NULL, 'same', 'new', true, '1')
    `;
    await conn.pgClient`
      INSERT INTO suspended_sessions (
        id, turn_id, agent_id, wait_event_type, wait_selector,
        snapshot_state, created_at
      )
      VALUES (
        'suspended-1', 'turn-1', 'agent-1', 'run.interrupt_resolved',
        '{}', '{}', 1
      )
    `;
    await conn.pgClient`
      INSERT INTO webhooks (
        id, agent_id, url, events, secret, active, created_at, updated_at
      )
      VALUES (
        'webhook-1',
        'agent-1',
        'https://example.test/webhook',
        '["run.tool_started","tool_call.started","artifact.created","custom.eval.verdict","custom.Bad","unsupported.event"]',
        'secret',
        true,
        1,
        1
      )
    `;
    await conn.pgClient`
      INSERT INTO callback_outbox (
        id, agent_id, turn_id, callback_url, event_type, payload,
        status, attempts, max_attempts, next_attempt_at, created_at
      )
      VALUES (
        'delivery-1',
        'agent-1',
        NULL,
        'https://example.test/webhook',
        'run.tool_started',
        '{"turnId":"turn-1","agentId":"agent-1","conversationId":"conversation-1","toolCallId":"tool-call-1","toolName":"Bash","args":{},"timestamp":13}',
        'pending',
        0,
        5,
        1,
        1
      )
    `;

    await forgetMigrationMarkers(conn);
    await runMigrations(conn.pgClient);

    const frames = await conn.pgClient`
      SELECT source_type, source_payload, payload
      FROM event_store
      WHERE channel = 'run'
      ORDER BY seq
    `;
    expect(frames).toHaveLength(3);
    for (const frame of frames) {
      expect(() => CanonicalStreamEventSchema.parse(JSON.parse(frame.payload as string))).not.toThrow();
    }
    expect(frames[0]?.source_type).toBe('message.delta');
    expect(JSON.parse(frames[0]?.source_payload as string)).toMatchObject({ delta: 'hello' });
    expect(JSON.parse(frames[0]?.source_payload as string)).not.toHaveProperty('content');
    expect(frames[1]?.source_type).toBe('interrupt.requested');
    expect(JSON.parse(frames[1]?.payload as string)).toEqual({
      type: 'CUSTOM',
      name: 'stablehand.interrupt.requested',
      agentId: 'agent-1',
      turnId: 'turn-1',
      conversationId: 'conversation-1',
      interruptId: 'interrupt-1',
      toolCallId: 'tool-call-1',
      toolName: 'Bash',
      args: {},
      timestamp: 11,
    });
    expect(frames[2]?.source_type).toBe('ag_ui.event');
    expect(JSON.parse(frames[2]?.payload as string)).toEqual({
      type: 'RUN_FINISHED',
      runId: 'turn-1',
      threadId: 'conversation-1',
      status: 'completed',
      usage: {
        inputTokens: 3,
        outputTokens: 5,
        totalTokens: 8,
        modelCalls: {
          observed: 0,
          costKnown: 0,
          expected: null,
        },
        cost: {
          totalUsd: 0.01,
          knownUsd: 0.01,
          coverage: 'complete',
        },
      },
      timestamp: 13,
    });

    const [legacySystemEvent] = await conn.pgClient`
      SELECT type, payload
      FROM event_store
      WHERE channel = 'system' AND created_at = 14
    `;
    expect(legacySystemEvent?.type).toBe('tool_call.started');
    expect(JSON.parse(legacySystemEvent?.payload as string)).toEqual({
      turnId: 'turn-1',
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      toolCallId: 'tool-call-1',
      toolName: 'Bash',
      args: {},
      timestamp: 14,
    });

    const triggers = await conn.pgClient`
      SELECT id, event_type FROM event_triggers ORDER BY id
    `;
    expect(triggers).toEqual([{ id: 'trigger-new', event_type: 'tool_call.started' }]);

    const [suspended] = await conn.pgClient`
      SELECT wait_event_type FROM suspended_sessions WHERE id = 'suspended-1'
    `;
    expect(suspended?.wait_event_type).toBe('interrupt.resolved');

    const [webhook] = await conn.pgClient`
      SELECT events FROM webhooks WHERE id = 'webhook-1'
    `;
    expect(webhook?.events).toEqual([
      'artifact.created',
      'custom.eval.verdict',
      'tool_call.started',
    ]);

    const [delivery] = await conn.pgClient`
      SELECT event_type, webhook_id, payload, status
      FROM callback_outbox
      WHERE id = 'delivery-1'
    `;
    expect(delivery).toMatchObject({
      event_type: 'tool_call.started',
      webhook_id: 'webhook-1',
      status: 'pending',
    });
    expect(() => WEBHOOK_PAYLOAD_SCHEMAS['tool_call.started'].parse(delivery?.payload)).not.toThrow();
  });

  it('applies the versioned TEXT_MESSAGE_END repair idempotently', async () => {
    await dropAllPublicTables(conn);
    await runMigrations(conn.pgClient);
    await conn.pgClient`
      DELETE FROM stablehand_schema_version
      WHERE id IN (
        ${CANONICAL_EVENT_CONTRACTS_MIGRATION_ID},
        ${TEXT_MESSAGE_END_CONTRACT_MIGRATION_ID}
      )
    `;

    await conn.pgClient`
      INSERT INTO agents (
        id, name, harness, harness_config, system_prompt, tools,
        created_at, updated_at
      )
      VALUES (
        'agent-1', 'agent', 'langgraph', '{"model":"gpt-5"}', 'prompt', '[]',
        1, 1
      )
    `;
    await conn.pgClient`
      INSERT INTO event_store (
        type, agent_id, payload, created_at, turn_id, conversation_id, channel
      )
      VALUES (
        'TEXT_MESSAGE_END',
        'agent-1',
        '{"type":"TEXT_MESSAGE_END","runId":"turn-1","threadId":"conversation-1","messageId":"message-1","role":"assistant","agentId":"agent-1","legacy":"remove-me","timestamp":10}',
        10,
        'turn-1',
        'conversation-1',
        'run'
      )
    `;

    await forgetMigrationMarkers(conn);
    await runMigrations(conn.pgClient);
    const [firstRepair] = await conn.pgClient`
      SELECT payload FROM event_store WHERE type = 'TEXT_MESSAGE_END'
    `;
    const repairedPayload = JSON.parse(firstRepair.payload as string);
    expect(repairedPayload).toEqual({
      type: 'TEXT_MESSAGE_END',
      runId: 'turn-1',
      threadId: 'conversation-1',
      messageId: 'message-1',
      timestamp: 10,
    });
    expect(() => CanonicalStreamEventSchema.parse(repairedPayload)).not.toThrow();

    const [applied] = await conn.pgClient`
      SELECT version
      FROM stablehand_schema_version
      WHERE id = ${TEXT_MESSAGE_END_CONTRACT_MIGRATION_ID}
    `;
    expect(Number(applied?.version)).toBe(TEXT_MESSAGE_END_CONTRACT_MIGRATION_VERSION);

    await forgetMigrationMarkers(conn);
    await runMigrations(conn.pgClient);
    const [secondRepair] = await conn.pgClient`
      SELECT payload FROM event_store WHERE type = 'TEXT_MESSAGE_END'
    `;
    expect(secondRepair.payload).toBe(firstRepair.payload);
  });

  it('does not rewrite canonical event history after the migration version is recorded', async () => {
    await dropAllPublicTables(conn);
    await runMigrations(conn.pgClient);
    await conn.pgClient`
      DELETE FROM stablehand_schema_version
      WHERE id = ${CANONICAL_EVENT_CONTRACTS_MIGRATION_ID}
    `;
    await conn.pgClient`
      INSERT INTO agents (
        id, name, harness, harness_config, system_prompt, tools,
        created_at, updated_at
      )
      VALUES ('agent-1', 'agent', 'langgraph', '{}', 'prompt', '[]', 1, 1)
    `;
    await conn.pgClient`
      INSERT INTO event_store (
        type, agent_id, payload, created_at, turn_id, conversation_id,
        channel, source_type, source_payload
      )
      VALUES (
        'CUSTOM',
        'agent-1',
        '{"type":"CUSTOM","name":"stablehand.turn.pending","agentId":"agent-1","turnId":"turn-1","conversationId":"conversation-1","mode":"interactive","timestamp":10}',
        10,
        'turn-1',
        'conversation-1',
        'run',
        'turn.pending',
        '{"turnId":"turn-1","agentId":"agent-1","conversationId":"conversation-1","mode":"interactive","timestamp":10}'
      )
    `;

    await forgetMigrationMarkers(conn);
    await runMigrations(conn.pgClient);
    const [firstStart] = await conn.pgClient`
      SELECT xmin::text AS row_version, payload
      FROM event_store
      WHERE type = 'CUSTOM'
    `;
    const [applied] = await conn.pgClient`
      SELECT version
      FROM stablehand_schema_version
      WHERE id = ${CANONICAL_EVENT_CONTRACTS_MIGRATION_ID}
    `;

    expect(Number(applied?.version)).toBe(CANONICAL_EVENT_CONTRACTS_MIGRATION_VERSION);

    await forgetMigrationMarkers(conn);
    await runMigrations(conn.pgClient);
    const [secondStart] = await conn.pgClient`
      SELECT xmin::text AS row_version, payload
      FROM event_store
      WHERE type = 'CUSTOM'
    `;

    expect(secondStart?.payload).toBe(firstStart?.payload);
    expect(secondStart?.row_version).toBe(firstStart?.row_version);
  });

  it('retains strict message.updated frames and webhook subscriptions across restarts', async () => {
    await dropAllPublicTables(conn);
    await runMigrations(conn.pgClient);
    await conn.pgClient`
      DELETE FROM stablehand_schema_version
      WHERE id = ${CANONICAL_EVENT_CONTRACTS_MIGRATION_ID}
    `;
    await conn.pgClient`
      INSERT INTO agents (
        id, name, harness, harness_config, system_prompt, tools,
        created_at, updated_at
      )
      VALUES (
        'agent-1', 'agent', 'langgraph', '{"model":"gpt-5"}', 'prompt', '[]',
        1, 1
      )
    `;
    await conn.pgClient`
      INSERT INTO event_store (
        type, agent_id, payload, created_at, turn_id, conversation_id,
        channel, source_type, source_payload
      )
      VALUES (
        'CUSTOM',
        'agent-1',
        '{"type":"CUSTOM","name":"stablehand.message.updated","agentId":"agent-1","turnId":"turn-1","conversationId":"conversation-1","messageId":"message-1","messageSeq":0,"messageRevision":1,"role":"assistant","content":"Checking.","parts":[{"type":"text","content":"Checking."},{"type":"tool_call","id":"tool-1","name":"search","args":"{}","result":"found","status":"complete"}],"toolCalls":[{"id":"tool-1","name":"search","args":"{}","status":"complete"}],"legacy":"remove-me","timestamp":10}',
        10,
        'turn-1',
        'conversation-1',
        'run',
        'message.updated',
        '{"turnId":"turn-1","agentId":"agent-1","conversationId":"conversation-1","messageId":"message-1","messageSeq":0,"messageRevision":1,"role":"assistant","content":"Checking.","parts":[{"type":"text","content":"Checking."},{"type":"tool_call","id":"tool-1","name":"search","args":"{}","result":"found","status":"complete"}],"toolCalls":[{"id":"tool-1","name":"search","args":"{}","status":"complete"}],"timestamp":10}'
      )
    `;
    await conn.pgClient`
      INSERT INTO webhooks (
        id, agent_id, url, events, secret, active, created_at, updated_at
      )
      VALUES (
        'webhook-updates',
        'agent-1',
        'https://example.test/message-updates',
        '["message.updated"]',
        'secret',
        true,
        1,
        1
      )
    `;

    await forgetMigrationMarkers(conn);
    await runMigrations(conn.pgClient);

    const assertRetained = async () => {
      const [frame] = await conn.pgClient`
        SELECT payload
        FROM event_store
        WHERE source_type = 'message.updated'
      `;
      const payload = JSON.parse(frame?.payload as string);
      expect(payload).toEqual({
        type: 'CUSTOM',
        name: 'stablehand.message.updated',
        agentId: 'agent-1',
        turnId: 'turn-1',
        conversationId: 'conversation-1',
        messageId: 'message-1',
        messageSeq: 0,
        messageRevision: 1,
        role: 'assistant',
        content: 'Checking.',
        parts: [
          { type: 'text', content: 'Checking.' },
          { type: 'tool_call', id: 'tool-1', name: 'search', args: '{}', result: 'found', status: 'complete' },
        ],
        toolCalls: [
          { id: 'tool-1', name: 'search', args: '{}', status: 'complete' },
        ],
        timestamp: 10,
      });
      expect(() => CanonicalStreamEventSchema.parse(payload)).not.toThrow();

      const [webhook] = await conn.pgClient`
        SELECT events FROM webhooks WHERE id = 'webhook-updates'
      `;
      expect(webhook?.events).toEqual(['message.updated']);
    };

    await assertRetained();
    await forgetMigrationMarkers(conn);
    await runMigrations(conn.pgClient);
    await assertRetained();
  });

  it('repairs terminal message snapshots in place and leaves open message snapshots pending', async () => {
    await dropAllPublicTables(conn);
    await runMigrations(conn.pgClient);
    await conn.pgClient`
      INSERT INTO agents (
        id, name, harness, harness_config, system_prompt, tools,
        created_at, updated_at
      )
      VALUES ('agent-1', 'agent', 'langgraph', '{}', 'prompt', '[]', 1, 1)
    `;
    await conn.pgClient`
      INSERT INTO conversations (id, agent_id, created_at, updated_at)
      VALUES ('conversation-1', 'agent-1', 1, 1)
    `;
    await conn.pgClient`
      INSERT INTO turns (
        id, agent_id, conversation_id, mode, status, queued_at, started_at, completed_at, tags
      )
      VALUES
        ('turn-1', 'agent-1', 'conversation-1', 'interactive', 'completed', 1, 1, 20, '{}'),
        ('turn-open', 'agent-1', 'conversation-1', 'interactive', 'running', 2, 2, NULL, '{}')
    `;
    await conn.pgClient`
      INSERT INTO messages (
        id, conversation_id, agent_id, role, content, tool_calls, parts, created_at
      )
      VALUES
        (
          'message-stale', 'conversation-1', 'agent-1', 'assistant', 'Checking.',
          '[{"id":"tool-1","name":"search","args":"{}","status":"complete"},{"id":"tool-2","name":"lookup","args":"{}","status":"complete"}]',
          '[{"type":"text","content":"Checking."},{"type":"tool_call","id":"tool-1","name":"search","args":"{}","result":"one","status":"complete"},{"type":"tool_call","id":"tool-2","name":"lookup","args":"{}","result":"two","status":"complete"}]',
          1
        ),
        (
          'message-malformed', 'conversation-1', 'agent-1', 'assistant', 'Legacy.',
          NULL, NULL, 2
        ),
        (
          'message-open', 'conversation-1', 'agent-1', 'assistant', 'Working.',
          '[{"id":"tool-open-1","name":"search","args":"{}","status":"complete"},{"id":"tool-open-2","name":"lookup","args":"{}","status":"complete"}]',
          '[{"type":"text","content":"Working."},{"type":"tool_call","id":"tool-open-1","name":"search","args":"{}","result":"one","status":"complete"},{"type":"tool_call","id":"tool-open-2","name":"lookup","args":"{}","result":"two","status":"complete"}]',
          3
        )
    `;

    const committedSource = {
      turnId: 'turn-1',
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      messageId: 'message-stale',
      messageSeq: 0,
      role: 'assistant',
      content: 'Checking.',
      parts: [
        { type: 'text', content: 'Checking.' },
        { type: 'tool_call', id: 'tool-1', name: 'search', args: '{}', result: 'one', status: 'complete' },
      ],
      toolCalls: [
        { id: 'tool-1', name: 'search', args: '{}', status: 'complete' },
      ],
      timestamp: 10,
    };
    const openSource = {
      turnId: 'turn-open',
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      messageId: 'message-open',
      messageSeq: 0,
      role: 'assistant',
      content: 'Working.',
      parts: [
        { type: 'text', content: 'Working.' },
        { type: 'tool_call', id: 'tool-open-1', name: 'search', args: '{}', result: 'one', status: 'complete' },
      ],
      toolCalls: [
        { id: 'tool-open-1', name: 'search', args: '{}', status: 'complete' },
      ],
      timestamp: 12,
    };
    await conn.pgClient`
      INSERT INTO event_store (
        type, agent_id, payload, created_at, turn_id, conversation_id,
        channel, source_type, source_payload
      )
      VALUES
        (
          'CUSTOM', 'agent-1',
          ${JSON.stringify({ type: 'CUSTOM', name: 'stablehand.message.committed', value: committedSource })},
          10, 'turn-1', 'conversation-1', 'run', 'message.committed',
          ${JSON.stringify(committedSource)}
        ),
        (
          'CUSTOM', 'agent-1',
          '{"type":"CUSTOM","name":"stablehand.message.committed","value":{"messageId":"message-malformed"}}',
          11, 'turn-1', 'conversation-1', 'run', 'message.committed',
          '{"turnId":"turn-1","agentId":"agent-1","conversationId":"conversation-1","messageId":"message-malformed","messageSeq":"not-a-number","role":"assistant","content":"Legacy.","timestamp":11}'
        ),
        (
          'RUN_FINISHED', 'agent-1',
          '{"type":"RUN_FINISHED","runId":"turn-1","threadId":"conversation-1","status":"completed","timestamp":20}',
          20, 'turn-1', 'conversation-1', 'run', 'turn.completed',
          '{"turnId":"turn-1","agentId":"agent-1","conversationId":"conversation-1","status":"completed","durationMs":10,"timestamp":20}'
        ),
        (
          'CUSTOM', 'agent-1',
          ${JSON.stringify({ type: 'CUSTOM', name: 'stablehand.message.committed', ...openSource })},
          12, 'turn-open', 'conversation-1', 'run', 'message.committed',
          ${JSON.stringify(openSource)}
        )
    `;
    const [terminalMessageEvent] = await conn.pgClient`
      SELECT seq FROM event_store
      WHERE source_type = 'message.committed'
        AND source_payload::jsonb->>'messageId' = 'message-stale'
    `;
    await conn.pgClient`
      INSERT INTO webhooks (
        id, agent_id, url, events, secret, active, created_at, updated_at
      )
      VALUES (
        'webhook-message-stale', 'agent-1', 'https://example.test/webhook',
        '["message.committed"]', 'test-signing-secret', true, 1, 1
      )
    `;
    await conn.pgClient`
      INSERT INTO callback_outbox (
        id, agent_id, turn_id, webhook_id, callback_url, event_type, event_seq, payload,
        status, attempts, max_attempts, next_attempt_at, created_at
      )
      VALUES (
        'callback-message-stale', 'agent-1', 'turn-1', 'webhook-message-stale',
        'https://example.test/webhook',
        'message.committed', ${Number(terminalMessageEvent?.seq)},
        ${JSON.stringify(committedSource)}::jsonb, 'pending', 0, 5, 0, 1
      )
    `;

    const assertBackfill = async () => {
      const rows = await conn.pgClient`
        SELECT id, turn_id, message_seq, message_revision, published_revision
        FROM messages
        ORDER BY id
      `;
      expect(rows.map((row) => ({
        ...row,
        message_seq: row.message_seq == null ? null : Number(row.message_seq),
        message_revision: Number(row.message_revision),
        published_revision: Number(row.published_revision),
      }))).toEqual([
        expect.objectContaining({
          id: 'message-malformed',
          turn_id: null,
          message_seq: null,
          message_revision: 0,
          published_revision: 0,
        }),
        expect.objectContaining({
          id: 'message-open',
          turn_id: 'turn-open',
          message_seq: 0,
          message_revision: 1,
          published_revision: 0,
        }),
        expect.objectContaining({
          id: 'message-stale',
          turn_id: 'turn-1',
          message_seq: 0,
          message_revision: 0,
          published_revision: 0,
        }),
      ]);
      const turns = await conn.pgClient`
        SELECT id, next_message_seq FROM turns
        WHERE id IN ('turn-1', 'turn-open')
        ORDER BY id
      `;
      expect(turns.map((turn) => ({
        id: turn.id,
        next_message_seq: Number(turn.next_message_seq),
      }))).toEqual([
        { id: 'turn-1', next_message_seq: 1 },
        { id: 'turn-open', next_message_seq: 1 },
      ]);

      const [repairedEvent] = await conn.pgClient`
        SELECT seq, payload, source_payload
        FROM event_store
        WHERE source_type = 'message.committed'
          AND source_payload::jsonb->>'messageId' = 'message-stale'
      `;
      const repairedPayload = JSON.parse(repairedEvent?.payload as string);
      const repairedSource = JSON.parse(repairedEvent?.source_payload as string);
      expect(repairedPayload).toMatchObject({
        type: 'CUSTOM',
        name: 'stablehand.message.committed',
        messageId: 'message-stale',
        content: 'Checking.',
        toolCalls: [
          { id: 'tool-1' },
          { id: 'tool-2' },
        ],
        parts: [
          { type: 'text', content: 'Checking.' },
          { type: 'tool_call', id: 'tool-1' },
          { type: 'tool_call', id: 'tool-2' },
        ],
      });
      expect(repairedSource).toMatchObject({
        messageId: 'message-stale',
        content: 'Checking.',
        toolCalls: [
          { id: 'tool-1' },
          { id: 'tool-2' },
        ],
      });
      expect(() => CanonicalStreamEventSchema.parse(repairedPayload)).not.toThrow();

      const [terminal] = await conn.pgClient`
        SELECT min(seq) AS seq
        FROM event_store
        WHERE turn_id = 'turn-1'
          AND type IN ('RUN_ERROR', 'RUN_FINISHED')
      `;
      expect(Number(repairedEvent?.seq)).toBeLessThan(Number(terminal?.seq));
      const [messageEventCount] = await conn.pgClient`
        SELECT count(*)::int AS count
        FROM event_store
        WHERE source_type IN ('message.committed', 'message.updated')
          AND turn_id = 'turn-1'
          AND (
            source_payload::jsonb->>'messageId' = 'message-stale'
            OR payload::jsonb->>'messageId' = 'message-stale'
          )
      `;
      expect(messageEventCount?.count).toBe(1);

      const [callback] = await conn.pgClient`
        SELECT payload
        FROM callback_outbox
        WHERE id = 'callback-message-stale'
      `;
      expect(callback?.payload).toMatchObject({
        messageId: 'message-stale',
        content: 'Checking.',
        toolCalls: [
          { id: 'tool-1' },
          { id: 'tool-2' },
        ],
      });

      const [openEvent] = await conn.pgClient`
        SELECT payload
        FROM event_store
        WHERE source_type = 'message.committed'
          AND source_payload::jsonb->>'messageId' = 'message-open'
      `;
      expect(JSON.parse(openEvent?.payload as string).toolCalls).toHaveLength(1);
    };

    await forgetMigrationMarkers(conn, MESSAGE_HISTORY_ADOPTION_MIGRATION_ID);
    await runMigrations(conn.pgClient);
    await assertBackfill();
    await forgetMigrationMarkers(conn, MESSAGE_HISTORY_ADOPTION_MIGRATION_ID);
    await runMigrations(conn.pgClient);
    await assertBackfill();
  });
});
