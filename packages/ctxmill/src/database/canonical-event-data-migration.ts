import type postgres from 'postgres';

export const TEXT_MESSAGE_END_CONTRACT_MIGRATION_ID = 'canonical-text-message-end-contract';
export const TEXT_MESSAGE_END_CONTRACT_MIGRATION_VERSION = 1;

/**
 * One-way persisted-data migration for the canonical event vocabulary.
 *
 * Runtime aliases were intentionally removed. Historical durable rows must be
 * rewritten before readers, trigger dispatch, or webhook delivery resume.
 */
export async function canonicalizePersistedEventContracts(sql: postgres.Sql): Promise<void> {
  // Unsupported provider telemetry never had a public contract.
  await sql`
    DELETE FROM event_store
    WHERE source_type = 'ctxmill.claude.runtime_capabilities'
       OR type = 'ctxmill.claude.runtime_capabilities'
       OR type = 'run_cancelled'
       OR (
         type = 'run.ag_ui_event'
         AND payload::jsonb#>>'{event,name}' = 'ctxmill.claude.runtime_capabilities'
       )
       OR (
         type = 'CUSTOM'
         AND payload::jsonb->>'name' = 'ctxmill.claude.runtime_capabilities'
       )
  `;

  // Baseline event rows predate source_type/source_payload and stored the
  // internal bus event directly in type/payload. Rewrite those rows too so
  // durable history contains no second event vocabulary.
  await sql`
    UPDATE event_store
    SET payload = (
      CASE
        WHEN type = 'run.text_chunk' THEN
          (payload::jsonb - 'content')
          || jsonb_build_object('delta', payload::jsonb->'content')
        WHEN type IN ('run.tool_started', 'run.tool_result', 'run.interrupted') THEN
          (payload::jsonb - 'toolName')
          || jsonb_build_object('toolCallName', payload::jsonb->'toolName')
        ELSE payload::jsonb
      END
    )::text
    WHERE type IN (
      'run.text_chunk',
      'run.tool_started',
      'run.tool_result',
      'run.interrupted',
      'run.interrupt_resolved',
      'run.ag_ui_event'
    )
  `;
  await sql`
    UPDATE event_store
    SET type = CASE type
      WHEN 'run.text_chunk' THEN 'message.delta'
      WHEN 'run.tool_started' THEN 'tool_call.started'
      WHEN 'run.tool_result' THEN 'tool_call.completed'
      WHEN 'run.interrupted' THEN 'interrupt.requested'
      WHEN 'run.interrupt_resolved' THEN 'interrupt.resolved'
      WHEN 'run.ag_ui_event' THEN 'ag_ui.event'
      ELSE type
    END
    WHERE type IN (
      'run.text_chunk',
      'run.tool_started',
      'run.tool_result',
      'run.interrupted',
      'run.interrupt_resolved',
      'run.ag_ui_event'
    )
  `;

  // Retain raw provenance under canonical names and field semantics.
  await sql`
    UPDATE event_store
    SET source_payload = (
      CASE
        WHEN source_type = 'run.text_chunk' THEN
          (source_payload::jsonb - 'content')
          || jsonb_build_object('delta', source_payload::jsonb->'content')
        WHEN source_type IN ('run.tool_started', 'run.tool_result', 'run.interrupted') THEN
          (source_payload::jsonb - 'toolName')
          || jsonb_build_object('toolCallName', source_payload::jsonb->'toolName')
        ELSE source_payload::jsonb
      END
    )::text
    WHERE source_payload IS NOT NULL
      AND source_type IN (
        'run.text_chunk',
        'run.tool_started',
        'run.tool_result',
        'run.interrupted'
      )
  `;
  await sql`
    UPDATE event_store
    SET source_type = CASE source_type
      WHEN 'run.text_chunk' THEN 'message.delta'
      WHEN 'run.tool_started' THEN 'tool_call.started'
      WHEN 'run.tool_result' THEN 'tool_call.completed'
      WHEN 'run.interrupted' THEN 'interrupt.requested'
      WHEN 'run.interrupt_resolved' THEN 'interrupt.resolved'
      WHEN 'run.ag_ui_event' THEN 'ag_ui.event'
      ELSE source_type
    END
    WHERE source_type IN (
      'run.text_chunk',
      'run.tool_started',
      'run.tool_result',
      'run.interrupted',
      'run.interrupt_resolved',
      'run.ag_ui_event'
    )
  `;

  // Older projectors copied internal event fields into run frames. Rebuild
  // each frame from only its strict AG-UI contract fields.
  await sql`
    UPDATE event_store
    SET payload = (
      CASE type
        WHEN 'RUN_STARTED' THEN jsonb_build_object(
          'type', 'RUN_STARTED',
          'runId', COALESCE(payload::jsonb->'runId', to_jsonb(turn_id)),
          'threadId', COALESCE(payload::jsonb->'threadId', to_jsonb(conversation_id)),
          'timestamp', payload::jsonb->'timestamp'
        )
        WHEN 'RUN_FINISHED' THEN jsonb_build_object(
          'type', 'RUN_FINISHED',
          'runId', COALESCE(payload::jsonb->'runId', to_jsonb(turn_id)),
          'threadId', COALESCE(payload::jsonb->'threadId', to_jsonb(conversation_id)),
          'timestamp', payload::jsonb->'timestamp'
        )
        || CASE WHEN payload::jsonb ? 'status'
          THEN jsonb_build_object('status', payload::jsonb->'status') ELSE '{}'::jsonb END
        || jsonb_build_object(
          'usage',
          CASE
            WHEN payload::jsonb->'usage' ?& ARRAY[
              'inputTokens', 'outputTokens', 'totalTokens'
            ] THEN jsonb_build_object(
              'inputTokens', payload::jsonb#>'{usage,inputTokens}',
              'outputTokens', payload::jsonb#>'{usage,outputTokens}',
              'totalTokens', payload::jsonb#>'{usage,totalTokens}',
              'modelCalls', jsonb_build_object(
                'observed', 0,
                'costKnown', 0,
                'expected', NULL
              ),
              'cost', CASE
                WHEN jsonb_typeof(payload::jsonb#>'{usage,costUsd}') = 'number'
                  THEN jsonb_build_object(
                    'totalUsd', payload::jsonb#>'{usage,costUsd}',
                    'knownUsd', payload::jsonb#>'{usage,costUsd}',
                    'coverage', 'complete'
                  )
                WHEN jsonb_typeof(payload::jsonb#>'{usage,cost}') = 'number'
                  THEN jsonb_build_object(
                    'totalUsd', payload::jsonb#>'{usage,cost}',
                    'knownUsd', payload::jsonb#>'{usage,cost}',
                    'coverage', 'complete'
                  )
                ELSE jsonb_build_object(
                  'totalUsd', NULL,
                  'knownUsd', 0,
                  'coverage', 'unpriced'
                )
              END
            )
            ELSE 'null'::jsonb
          END
        )
        WHEN 'RUN_ERROR' THEN jsonb_build_object(
          'type', 'RUN_ERROR',
          'runId', COALESCE(payload::jsonb->'runId', to_jsonb(turn_id)),
          'threadId', COALESCE(payload::jsonb->'threadId', to_jsonb(conversation_id)),
          'message', COALESCE(payload::jsonb->'message', payload::jsonb->'error', '"Run failed"'::jsonb),
          'timestamp', payload::jsonb->'timestamp'
        )
        || CASE WHEN payload::jsonb ? 'status'
          THEN jsonb_build_object('status', payload::jsonb->'status') ELSE '{}'::jsonb END
        WHEN 'TEXT_MESSAGE_START' THEN jsonb_build_object(
          'type', 'TEXT_MESSAGE_START',
          'runId', COALESCE(payload::jsonb->'runId', to_jsonb(turn_id)),
          'threadId', COALESCE(payload::jsonb->'threadId', to_jsonb(conversation_id)),
          'messageId', payload::jsonb->'messageId',
          'role', payload::jsonb->'role',
          'timestamp', payload::jsonb->'timestamp'
        )
        WHEN 'TEXT_MESSAGE_CONTENT' THEN jsonb_build_object(
          'type', 'TEXT_MESSAGE_CONTENT',
          'runId', COALESCE(payload::jsonb->'runId', to_jsonb(turn_id)),
          'threadId', COALESCE(payload::jsonb->'threadId', to_jsonb(conversation_id)),
          'messageId', payload::jsonb->'messageId',
          'delta', COALESCE(payload::jsonb->'delta', payload::jsonb->'content'),
          'timestamp', payload::jsonb->'timestamp'
        )
        WHEN 'TOOL_CALL_START' THEN jsonb_build_object(
          'type', 'TOOL_CALL_START',
          'runId', COALESCE(payload::jsonb->'runId', to_jsonb(turn_id)),
          'threadId', COALESCE(payload::jsonb->'threadId', to_jsonb(conversation_id)),
          'toolCallId', payload::jsonb->'toolCallId',
          'toolCallName', COALESCE(payload::jsonb->'toolCallName', payload::jsonb->'toolName'),
          'timestamp', payload::jsonb->'timestamp'
        )
        || CASE WHEN payload::jsonb ? 'parentMessageId'
          THEN jsonb_build_object('parentMessageId', payload::jsonb->'parentMessageId') ELSE '{}'::jsonb END
        WHEN 'TOOL_CALL_ARGS' THEN jsonb_build_object(
          'type', 'TOOL_CALL_ARGS',
          'runId', COALESCE(payload::jsonb->'runId', to_jsonb(turn_id)),
          'threadId', COALESCE(payload::jsonb->'threadId', to_jsonb(conversation_id)),
          'toolCallId', payload::jsonb->'toolCallId',
          'delta', COALESCE(
            payload::jsonb->'delta',
            CASE jsonb_typeof(payload::jsonb->'args')
              WHEN 'string' THEN payload::jsonb->'args'
              ELSE to_jsonb(COALESCE((payload::jsonb->'args')::text, ''))
            END
          ),
          'timestamp', payload::jsonb->'timestamp'
        )
        WHEN 'TOOL_CALL_END' THEN jsonb_build_object(
          'type', 'TOOL_CALL_END',
          'runId', COALESCE(payload::jsonb->'runId', to_jsonb(turn_id)),
          'threadId', COALESCE(payload::jsonb->'threadId', to_jsonb(conversation_id)),
          'toolCallId', payload::jsonb->'toolCallId',
          'timestamp', payload::jsonb->'timestamp'
        )
        WHEN 'TOOL_CALL_RESULT' THEN jsonb_build_object(
          'type', 'TOOL_CALL_RESULT',
          'runId', COALESCE(payload::jsonb->'runId', to_jsonb(turn_id)),
          'threadId', COALESCE(payload::jsonb->'threadId', to_jsonb(conversation_id)),
          'toolCallId', payload::jsonb->'toolCallId',
          'timestamp', payload::jsonb->'timestamp'
        )
        || CASE WHEN payload::jsonb ? 'result'
          THEN jsonb_build_object('result', payload::jsonb->'result')
          WHEN payload::jsonb ? 'content'
          THEN jsonb_build_object('result', payload::jsonb->'content')
          ELSE '{}'::jsonb END
        || CASE WHEN payload::jsonb ? 'error'
          THEN jsonb_build_object('error', payload::jsonb->'error') ELSE '{}'::jsonb END
        WHEN 'STATE_DELTA' THEN jsonb_build_object(
          'type', 'STATE_DELTA',
          'runId', COALESCE(payload::jsonb->'runId', to_jsonb(turn_id)),
          'threadId', COALESCE(payload::jsonb->'threadId', to_jsonb(conversation_id)),
          'delta', payload::jsonb->'delta',
          'timestamp', payload::jsonb->'timestamp'
        )
        WHEN 'MESSAGES_SNAPSHOT' THEN jsonb_build_object(
          'type', 'MESSAGES_SNAPSHOT',
          'runId', COALESCE(payload::jsonb->'runId', to_jsonb(turn_id)),
          'threadId', COALESCE(payload::jsonb->'threadId', to_jsonb(conversation_id)),
          'messages', COALESCE(payload::jsonb->'messages', '[]'::jsonb),
          'timestamp', payload::jsonb->'timestamp'
        )
        ELSE payload::jsonb
      END
    )::text
    WHERE channel = 'run'
      AND type IN (
        'RUN_STARTED',
        'RUN_FINISHED',
        'RUN_ERROR',
        'TEXT_MESSAGE_START',
        'TEXT_MESSAGE_CONTENT',
        'TOOL_CALL_START',
        'TOOL_CALL_ARGS',
        'TOOL_CALL_END',
        'TOOL_CALL_RESULT',
        'STATE_DELTA',
        'MESSAGES_SNAPSHOT'
      )
  `;

  await repairTextMessageEndContract(sql);
  await canonicalizeCustomFrames(sql);
  await canonicalizeSubscriptionsAndDeliveries(sql);
}

async function repairTextMessageEndContract(sql: postgres.Sql): Promise<void> {
  const [applied] = await sql`
    SELECT version
    FROM ctxmill_schema_version
    WHERE id = ${TEXT_MESSAGE_END_CONTRACT_MIGRATION_ID}
  `;
  if (Number(applied?.version ?? 0) >= TEXT_MESSAGE_END_CONTRACT_MIGRATION_VERSION) {
    return;
  }

  // v1 removes role and every other historical projector field. Rebuilding
  // from the strict contract also makes replay safe for cursors parked
  // immediately before a poisoned terminal frame.
  await sql`
    UPDATE event_store
    SET payload = (
      jsonb_build_object(
        'type', 'TEXT_MESSAGE_END',
        'runId', COALESCE(payload::jsonb->'runId', to_jsonb(turn_id)),
        'threadId', COALESCE(payload::jsonb->'threadId', to_jsonb(conversation_id)),
        'messageId', payload::jsonb->'messageId'
      )
      || CASE WHEN payload::jsonb ? 'timestamp'
        THEN jsonb_build_object('timestamp', payload::jsonb->'timestamp')
        ELSE '{}'::jsonb
      END
    )::text
    WHERE channel = 'run'
      AND type = 'TEXT_MESSAGE_END'
  `;
  await sql`
    INSERT INTO ctxmill_schema_version (id, version, baseline)
    VALUES (
      ${TEXT_MESSAGE_END_CONTRACT_MIGRATION_ID},
      ${TEXT_MESSAGE_END_CONTRACT_MIGRATION_VERSION},
      'data-migration'
    )
    ON CONFLICT (id) DO UPDATE
    SET version = EXCLUDED.version, baseline = EXCLUDED.baseline
  `;
}

async function canonicalizeCustomFrames(sql: postgres.Sql): Promise<void> {
  // Remove unsupported ctxmill CUSTOM names; all supported names are rebuilt
  // below without subtype/value/identity compatibility fields.
  await sql`
    DELETE FROM event_store
    WHERE channel = 'run'
      AND type = 'CUSTOM'
      AND payload::jsonb->>'name' LIKE 'ctxmill.%'
      AND payload::jsonb->>'name' NOT IN (
        'ctxmill.hitl.requested',
        'ctxmill.hitl.resolved',
        'ctxmill.interrupt.requested',
        'ctxmill.interrupt.resolved',
        'ctxmill.turn.pending',
        'ctxmill.message.committed',
        'ctxmill.message.updated',
        'ctxmill.a2ui.render',
        'ctxmill.sandbox_session.snapshot'
      )
  `;
  await sql`
    UPDATE event_store
    SET payload = (
      CASE
        WHEN payload::jsonb->>'name' IN ('ctxmill.hitl.requested', 'ctxmill.interrupt.requested') THEN
          jsonb_build_object(
            'type', 'CUSTOM',
            'name', 'ctxmill.interrupt.requested',
            'agentId', payload::jsonb->'agentId',
            'turnId', payload::jsonb->'turnId',
            'conversationId', payload::jsonb->'conversationId',
            'interruptId', payload::jsonb->'interruptId',
            'toolCallId', payload::jsonb->'toolCallId',
            'toolCallName', COALESCE(payload::jsonb->'toolCallName', payload::jsonb->'toolName'),
            'args', COALESCE(payload::jsonb->'args', '{}'::jsonb),
            'timestamp', payload::jsonb->'timestamp'
          )
          || CASE WHEN payload::jsonb ? 'sandboxSessionId'
            THEN jsonb_build_object('sandboxSessionId', payload::jsonb->'sandboxSessionId')
            ELSE '{}'::jsonb END
        WHEN payload::jsonb->>'name' IN ('ctxmill.hitl.resolved', 'ctxmill.interrupt.resolved') THEN
          jsonb_build_object(
            'type', 'CUSTOM',
            'name', 'ctxmill.interrupt.resolved',
            'agentId', payload::jsonb->'agentId',
            'turnId', payload::jsonb->'turnId',
            'conversationId', payload::jsonb->'conversationId',
            'interruptId', payload::jsonb->'interruptId',
            'action', payload::jsonb->'action',
            'timestamp', payload::jsonb->'timestamp'
          )
          || CASE WHEN payload::jsonb ? 'sandboxSessionId'
            THEN jsonb_build_object('sandboxSessionId', payload::jsonb->'sandboxSessionId')
            ELSE '{}'::jsonb END
        WHEN payload::jsonb->>'name' = 'ctxmill.turn.pending' THEN
          jsonb_build_object(
            'type', 'CUSTOM',
            'name', 'ctxmill.turn.pending',
            'agentId', payload::jsonb->'agentId',
            'turnId', payload::jsonb->'turnId',
            'conversationId', payload::jsonb->'conversationId',
            'mode', payload::jsonb->'mode',
            'timestamp', payload::jsonb->'timestamp'
          )
          || CASE WHEN payload::jsonb ? 'taskDescription'
            THEN jsonb_build_object('taskDescription', payload::jsonb->'taskDescription')
            ELSE '{}'::jsonb END
        WHEN payload::jsonb->>'name' = 'ctxmill.message.committed' THEN
          jsonb_build_object(
            'type', 'CUSTOM',
            'name', 'ctxmill.message.committed',
            'agentId', payload::jsonb->'agentId',
            'turnId', payload::jsonb->'turnId',
            'conversationId', payload::jsonb->'conversationId',
            'messageId', payload::jsonb->'messageId',
            'messageSeq', payload::jsonb->'messageSeq',
            'role', payload::jsonb->'role',
            'content', payload::jsonb->'content',
            'timestamp', payload::jsonb->'timestamp'
          )
          || CASE WHEN payload::jsonb ? 'parts'
            THEN jsonb_build_object('parts', payload::jsonb->'parts') ELSE '{}'::jsonb END
          || CASE WHEN payload::jsonb ? 'toolCalls'
            THEN jsonb_build_object('toolCalls', payload::jsonb->'toolCalls') ELSE '{}'::jsonb END
          || CASE WHEN payload::jsonb ? 'toolCallId'
            THEN jsonb_build_object('toolCallId', payload::jsonb->'toolCallId') ELSE '{}'::jsonb END
        WHEN payload::jsonb->>'name' = 'ctxmill.message.updated' THEN
          jsonb_build_object(
            'type', 'CUSTOM',
            'name', 'ctxmill.message.updated',
            'agentId', payload::jsonb->'agentId',
            'turnId', payload::jsonb->'turnId',
            'conversationId', payload::jsonb->'conversationId',
            'messageId', payload::jsonb->'messageId',
            'messageSeq', payload::jsonb->'messageSeq',
            'messageRevision', payload::jsonb->'messageRevision',
            'role', 'assistant',
            'content', payload::jsonb->'content',
            'timestamp', payload::jsonb->'timestamp'
          )
          || CASE WHEN payload::jsonb ? 'parts'
            THEN jsonb_build_object('parts', payload::jsonb->'parts') ELSE '{}'::jsonb END
          || CASE WHEN payload::jsonb ? 'toolCalls'
            THEN jsonb_build_object('toolCalls', payload::jsonb->'toolCalls') ELSE '{}'::jsonb END
        WHEN payload::jsonb->>'name' = 'ctxmill.a2ui.render' THEN
          jsonb_build_object(
            'type', 'CUSTOM',
            'name', 'ctxmill.a2ui.render',
            'block', COALESCE(payload::jsonb->'block', payload::jsonb#>'{value,block}'),
            'timestamp', payload::jsonb->'timestamp'
          )
          || CASE WHEN payload::jsonb ? 'runId'
            THEN jsonb_build_object('runId', payload::jsonb->'runId') ELSE '{}'::jsonb END
          || CASE WHEN payload::jsonb ? 'threadId'
            THEN jsonb_build_object('threadId', payload::jsonb->'threadId') ELSE '{}'::jsonb END
        WHEN payload::jsonb->>'name' = 'ctxmill.sandbox_session.snapshot' THEN
          jsonb_build_object(
            'type', 'CUSTOM',
            'name', 'ctxmill.sandbox_session.snapshot',
            'agentId', payload::jsonb->'agentId',
            'conversationId', payload::jsonb->'conversationId',
            'sandboxSessionId', payload::jsonb->'sandboxSessionId',
            'activeTurnId', payload::jsonb->'activeTurnId',
            'status', payload::jsonb->'status',
            'harnessName', payload::jsonb->'harnessName',
            'containerName', payload::jsonb->'containerName',
            'timestamp', payload::jsonb->'timestamp'
          )
        ELSE jsonb_build_object('type', 'CUSTOM', 'name', payload::jsonb->'name')
          || CASE WHEN payload::jsonb ? 'runId'
            THEN jsonb_build_object('runId', payload::jsonb->'runId') ELSE '{}'::jsonb END
          || CASE WHEN payload::jsonb ? 'threadId'
            THEN jsonb_build_object('threadId', payload::jsonb->'threadId') ELSE '{}'::jsonb END
          || CASE WHEN payload::jsonb ? 'value'
            THEN jsonb_build_object('value', payload::jsonb->'value')
            ELSE jsonb_build_object(
              'value',
              payload::jsonb - ARRAY[
                'type', 'name', 'runId', 'threadId', 'timestamp', 'subtype'
              ]::text[]
            )
            END
          || CASE WHEN payload::jsonb ? 'timestamp'
            THEN jsonb_build_object('timestamp', payload::jsonb->'timestamp') ELSE '{}'::jsonb END
      END
    )::text
    WHERE channel = 'run'
      AND type = 'CUSTOM'
  `;
}

async function canonicalizeSubscriptionsAndDeliveries(sql: postgres.Sql): Promise<void> {
  await sql`
    DELETE FROM event_triggers AS retired
    USING event_triggers AS canonical
    WHERE retired.id <> canonical.id
      AND retired.agent_id = canonical.agent_id
      AND retired.selector_hash = canonical.selector_hash
      AND canonical.event_type = CASE retired.event_type
        WHEN 'run.text_chunk' THEN 'message.delta'
        WHEN 'run.tool_started' THEN 'tool_call.started'
        WHEN 'run.tool_result' THEN 'tool_call.completed'
        WHEN 'run.interrupted' THEN 'interrupt.requested'
        WHEN 'run.interrupt_resolved' THEN 'interrupt.resolved'
        WHEN 'run.ag_ui_event' THEN 'ag_ui.event'
        ELSE retired.event_type
      END
      AND retired.event_type <> canonical.event_type
  `;
  await sql`
    UPDATE event_triggers
    SET event_type = CASE event_type
      WHEN 'run.text_chunk' THEN 'message.delta'
      WHEN 'run.tool_started' THEN 'tool_call.started'
      WHEN 'run.tool_result' THEN 'tool_call.completed'
      WHEN 'run.interrupted' THEN 'interrupt.requested'
      WHEN 'run.interrupt_resolved' THEN 'interrupt.resolved'
      WHEN 'run.ag_ui_event' THEN 'ag_ui.event'
      ELSE event_type
    END
    WHERE event_type IN (
      'run.text_chunk',
      'run.tool_started',
      'run.tool_result',
      'run.interrupted',
      'run.interrupt_resolved',
      'run.ag_ui_event'
    )
  `;
  await sql`
    UPDATE suspended_sessions
    SET wait_event_type = CASE wait_event_type
      WHEN 'run.text_chunk' THEN 'message.delta'
      WHEN 'run.tool_started' THEN 'tool_call.started'
      WHEN 'run.tool_result' THEN 'tool_call.completed'
      WHEN 'run.interrupted' THEN 'interrupt.requested'
      WHEN 'run.interrupt_resolved' THEN 'interrupt.resolved'
      WHEN 'run.ag_ui_event' THEN 'ag_ui.event'
      ELSE wait_event_type
    END
    WHERE wait_event_type IN (
      'run.text_chunk',
      'run.tool_started',
      'run.tool_result',
      'run.interrupted',
      'run.interrupt_resolved',
      'run.ag_ui_event'
    )
  `;

  // Webhook events are a closed enum: map old names and discard unsupported
  // subscriptions instead of carrying compatibility state.
  await sql`
    UPDATE webhooks AS webhook
    SET events = COALESCE((
      SELECT jsonb_agg(mapped.event_name ORDER BY mapped.event_name)
      FROM (
        SELECT DISTINCT CASE value
          WHEN 'run.tool_started' THEN 'tool_call.started'
          WHEN 'run.tool_result' THEN 'tool_call.completed'
          WHEN 'run.interrupted' THEN 'interrupt.requested'
          WHEN 'run.interrupt_resolved' THEN 'interrupt.resolved'
          ELSE value
        END AS event_name
        FROM jsonb_array_elements_text(webhook.events) AS entry(value)
      ) AS mapped
      WHERE mapped.event_name IN (
        'turn.started',
        'turn.completed',
        'tool_call.started',
        'tool_call.completed',
        'interrupt.requested',
        'interrupt.resolved',
        'message.committed',
        'message.updated',
        'feedback.received',
        'budget.threshold',
        'artifact.created'
      )
    ), '[]'::jsonb)
  `;
  await sql`UPDATE webhooks SET active = false WHERE secret IS NULL`;

  await sql`
    UPDATE callback_outbox
    SET
      event_type = CASE event_type
        WHEN 'run.tool_started' THEN 'tool_call.started'
        WHEN 'run.tool_result' THEN 'tool_call.completed'
        WHEN 'run.interrupted' THEN 'interrupt.requested'
        WHEN 'run.interrupt_resolved' THEN 'interrupt.resolved'
        ELSE event_type
      END,
      payload = CASE
        WHEN event_type IN ('run.tool_started', 'run.tool_result', 'run.interrupted') THEN
          (payload - 'toolName') || jsonb_build_object('toolCallName', payload->'toolName')
        ELSE payload
      END
    WHERE event_type IN (
      'run.tool_started',
      'run.tool_result',
      'run.interrupted',
      'run.interrupt_resolved'
    )
  `;
  await sql`
    UPDATE callback_outbox AS delivery
    SET webhook_id = match.id
    FROM (
      SELECT agent_id, url, min(id) AS id
      FROM webhooks
      GROUP BY agent_id, url
      HAVING count(*) = 1
    ) AS match
    WHERE delivery.webhook_id IS NULL
      AND delivery.agent_id = match.agent_id
      AND delivery.callback_url = match.url
  `;
  await sql`
    UPDATE callback_outbox
    SET
      status = 'failed',
      last_error = 'Unsigned historical delivery removed by canonical webhook migration'
    WHERE status = 'pending'
      AND webhook_id IS NULL
  `;
}
