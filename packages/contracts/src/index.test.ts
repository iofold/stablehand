import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import * as contracts from './index.js';

describe('@ctxmill/contracts', () => {
  it('defines one strict analytics overview contract for API and SDK consumers', () => {
    const schema = (contracts as Record<string, unknown>).AnalyticsOverviewSchema;
    expect(schema).toBeDefined();
    const overviewSchema = schema as {
      parse(value: unknown): unknown;
    };
    const metrics = {
      turns: 2,
      completedTurns: 1,
      errorTurns: 1,
      cancelledTurns: 0,
      activeTurns: 0,
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      tokenReportedTurns: 2,
      knownCostUsd: 0.01,
      costCoverage: {
        complete: 1,
        partial: 0,
        pending: 0,
        unpriced: 1,
      },
    };
    const overview = {
      window: '24h',
      from: 1_000,
      to: 2_000,
      bucketSizeMs: 100,
      totals: {
        agents: 2,
        activeAgents: 1,
        ...metrics,
      },
      activity: [{
        from: 1_000,
        to: 1_100,
        ...metrics,
      }],
      agents: [{
        agentId: 'agent-1',
        name: 'Close analyst',
        harness: 'langgraph',
        model: 'gpt-5.4-mini',
        lastActivityAt: 1_500,
        ...metrics,
      }],
    };

    expect(overviewSchema.parse(overview)).toEqual(overview);
    expect(() => overviewSchema.parse({
      ...overview,
      unexpected: true,
    })).toThrow();
  });

  it('defines a strict conversation snapshot boundary for SSE replay', () => {
    const snapshot = {
      conversationId: 'conversation-1',
      eventCursor: '000000000042',
      messages: [{
        id: 'message-1',
        conversationId: 'conversation-1',
        agentId: 'agent-1',
        turnId: 'turn-1',
        messageSeq: 0,
        messageRevision: 2,
        role: 'assistant',
        content: 'Complete',
        createdAt: 1,
      }],
    };

    expect(contracts.ConversationSnapshotResponseSchema.parse(snapshot))
      .toEqual(snapshot);
    expect(() => contracts.ConversationSnapshotResponseSchema.parse(
      snapshot.messages,
    )).toThrow();
    expect(() => contracts.ConversationSnapshotResponseSchema.parse({
      ...snapshot,
      eventCursor: 'legacy-cursor',
    })).toThrow();
  });

  it('validates the complete server-emitted canonical fixture', () => {
    const fixture = JSON.parse(readFileSync(
      new URL('../test-fixtures/canonical-stream-events.json', import.meta.url),
      'utf8',
    )) as unknown[];

    expect(fixture.map((event) => contracts.CanonicalStreamEventSchema.parse(event)))
      .toHaveLength(19);
  });

  it('preserves persisted message timestamps in AG-UI snapshots', () => {
    const snapshot = {
      type: 'MESSAGES_SNAPSHOT',
      runId: 'turn-1',
      threadId: 'conversation-1',
      timestamp: 1_784_546_935_300,
      messages: [{
        id: 'message-1',
        role: 'assistant',
        content: 'Persisted answer',
        createdAt: 1_784_546_935_222,
      }],
    };

    expect(contracts.MessagesSnapshotEventSchema.parse(snapshot))
      .toEqual(snapshot);
    expect(() => contracts.MessagesSnapshotEventSchema.parse({
      ...snapshot,
      messages: [{
        ...snapshot.messages[0],
        createdAt: '2026-07-20T11:28:55.222Z',
      }],
    })).toThrow();
  });

  it('strictly validates canonical agent inputs without legacy model fields', () => {
    const valid = {
      name: 'bank-reconciliation',
      harness: 'claude-agents',
      harnessConfig: { model: 'claude-sonnet-4-20250514' },
      systemPrompt: 'Reconcile the account.',
      tools: ['artifact_upload'],
      builtinToolPolicy: { policy: 'deny', names: ['emit-event'] },
      nativeToolPolicy: { policy: 'allow', names: ['Bash'] },
      workspaceContent: {
        files: [{ src: 'skills', dest: '.claude/skills' }],
      },
      mode: 'background',
      manifest: {
        apiVersion: 'ctxmill.io/v1',
        kind: 'Agent',
      },
    };

    expect(contracts.AgentCreateInputSchema.parse(valid)).toEqual(valid);
    expect(contracts.AgentPatchInputSchema.parse({
      description: null,
      builtinToolPolicy: null,
      metadata: null,
      nativeToolPolicy: null,
      workspaceContent: null,
      mode: null,
      manifest: null,
    })).toEqual({
      description: null,
      builtinToolPolicy: null,
      metadata: null,
      nativeToolPolicy: null,
      workspaceContent: null,
      mode: null,
      manifest: null,
    });
    expect(() => contracts.AgentCreateInputSchema.parse({
      ...valid,
      model: 'legacy-model',
    })).toThrow();
    expect(() => contracts.AgentCreateInputSchema.parse({
      ...valid,
      nativeTools: { allowlist: ['Bash'] },
      nativeToolPolicy: undefined,
    })).toThrow();
  });

  it('owns strict canonical config schemas for every shipped harness', () => {
    expect(contracts.LangGraphConfigSchema.parse({
      model: 'gpt-5',
      subagents: [{
        name: 'reviewer',
        description: 'Review close output',
        systemPrompt: 'Review carefully.',
        provider: 'openai',
        reasoning: 'off',
      }],
    })).toMatchObject({ provider: 'openai', model: 'gpt-5' });
    expect(contracts.ClaudeAgentsConfigSchema.parse({
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      maxTurns: 20,
    })).toMatchObject({ provider: 'anthropic' });
    expect(contracts.PIAgentConfigSchema.parse({
      provider: 'google',
      model: 'gemini-2.5-pro',
      maxTokens: 96,
      reasoning: true,
      thinkingLevel: 'minimal',
    })).toMatchObject({
      provider: 'google',
      maxTokens: 96,
      reasoning: true,
      thinkingLevel: 'minimal',
    });
    expect(Object.keys(contracts.HARNESS_CONFIG_SCHEMAS).sort()).toEqual([
      'claude-agents',
      'langgraph',
      'pi-agent',
    ]);

    expect(() => contracts.ClaudeAgentsConfigSchema.parse({
      model: 'claude-sonnet-4-20250514',
      nativeToolPolicy: { policy: 'allow', names: ['Read'] },
    })).toThrow();
    expect(() => contracts.PIAgentConfigSchema.parse({
      provider: 'gemini',
      model: 'gemini-2.5-pro',
    })).toThrow();
    expect(() => contracts.LangGraphConfigSchema.parse({
      model: 'gpt-5',
      unknownOption: true,
    })).toThrow();
    expect(() => contracts.ClaudeAgentsConfigSchema.parse({
      model: 'claude-sonnet-4-20250514',
      setup: {
        symlinks: [{ src: '../host-secrets', dest: '.claude/skills' }],
      },
    })).toThrow();
    expect(() => contracts.PIAgentConfigSchema.parse({
      model: 'gpt-5',
      extensions: ['/host/extension.ts'],
    })).toThrow();
    expect(() => contracts.NativeToolPolicySchema.parse({
      policy: 'allow',
      names: ['Bash', 'Bash'],
    })).toThrow();
    expect(() => contracts.NativeToolPolicySchema.parse({
      policy: 'allow',
      names: [],
    })).toThrow();
    expect(() => contracts.NativeToolPolicySchema.parse({
      policy: 'all',
      names: ['Bash'],
    })).toThrow();
    expect(contracts.NativeToolPolicySchema.parse({ policy: 'all' })).toEqual({ policy: 'all' });
    expect(contracts.NativeToolPolicySchema.parse({ policy: 'none' })).toEqual({ policy: 'none' });
  });

  it('validates the Pilot control-plane response surface', () => {
    const agent = {
      id: 'agent-1',
      name: 'bank-reconciliation',
      harness: 'claude-agents',
      harnessConfig: { model: 'claude-sonnet-4-20250514' },
      systemPrompt: 'Reconcile the account.',
      tools: [],
      description: null,
      workspaceDir: '/data/agents/agent-1',
      status: 'idle',
      manifest: null,
      metadata: null,
      createdAt: 1,
      updatedAt: 2,
      builtinToolPolicy: null,
      nativeToolPolicy: null,
      httpTools: [],
      workspaceContent: null,
      mode: null,
      resourceLimits: null,
      sseClients: 0,
      hasPendingInterrupt: false,
      conversationCount: 1,
      turnCount: 2,
      completedTurnCount: 2,
      failedTurnCount: 0,
      activeTurnCount: 0,
      tokensTotal: 100,
      tokensLast24h: 100,
      sandboxSessionsByStatus: {
        ACTIVE: 0,
        CHECKPOINTED: 1,
        RESTORING: 0,
        TERMINATED: 0,
      },
      lastActivity: null,
    };
    expect(contracts.AgentListResponseSchema.parse([agent])).toHaveLength(1);
    expect(() => contracts.AgentSchema.parse({ ...agent, version: 1 })).toThrow();
    expect(() => contracts.AgentSchema.parse({ ...agent, recentTurns: [] })).toThrow();

    expect(contracts.SecretListResponseSchema.parse({ keys: ['ANTHROPIC_API_KEY'] }))
      .toEqual({ keys: ['ANTHROPIC_API_KEY'] });
    expect(() => contracts.SecretListResponseSchema.parse({
      keys: ['ANTHROPIC_API_KEY'],
      values: { ANTHROPIC_API_KEY: 'must-not-leak' },
    })).toThrow();
  });

  it('validates durable cross-agent interrupt records without resolution data', () => {
    const response = contracts.InterruptRecordListResponseSchema.parse({
      interrupts: [{
        interruptId: 'interrupt-1',
        agentId: 'agent-1',
        turnId: 'turn-1',
        sandboxSessionId: null,
        toolCallId: 'tool-call-1',
        toolName: 'request-approval',
        args: { reason: 'publish' },
        status: 'timed_out',
        createdAt: 1,
        expiresAt: 2,
        resolvedAt: null,
        resolvedAction: 'timeout',
      }],
      nextBefore: 1,
    });

    expect(response.interrupts[0]?.status).toBe('timed_out');
    expect(() => contracts.InterruptRecordListResponseSchema.parse({
      interrupts: [{
        ...response.interrupts[0],
        resolvedData: { secret: 'must-not-be-listed' },
      }],
    })).toThrow();
  });

  it('validates artifact kind, metadata size, and canonical records', () => {
    expect(contracts.ArtifactKindSchema.parse('eval_report')).toBe('eval_report');
    expect(() => contracts.ArtifactKindSchema.parse('Eval Report')).toThrow();
    expect(contracts.ArtifactMetadataSchema.parse({
      content: 'x'.repeat((16 * 1024) - 14),
    })).toBeDefined();
    expect(() => contracts.ArtifactMetadataSchema.parse({
      content: 'x'.repeat(16 * 1024),
    })).toThrow();

    expect(contracts.ArtifactSchema.parse({
      id: 'artifact-1',
      agentId: 'agent-1',
      turnId: 'turn-1',
      conversationId: 'conversation-1',
      name: 'report.json',
      mimeType: 'application/json',
      sizeBytes: 42,
      storageKey: 'artifacts/artifact-1/report.json',
      bucket: 'artifacts',
      kind: 'eval_report',
      metadata: { suite: 'smoke' },
      status: 'active',
      expiresAt: null,
      createdAt: 1,
      updatedAt: 2,
    })).toMatchObject({ kind: 'eval_report' });
  });

  it('validates correlated persisted-event list contracts', () => {
    expect(contracts.EventListInputSchema.parse({
      turnId: 'turn-1',
      conversationId: 'conversation-1',
      limit: 25,
    })).toMatchObject({
      turnId: 'turn-1',
      conversationId: 'conversation-1',
    });

    expect(contracts.EventListResponseSchema.parse({
      events: [{
        seq: 12,
        type: 'custom.eval.verdict',
        agentId: 'agent-1',
        turnId: 'turn-1',
        conversationId: 'conversation-1',
        payload: '{"verdict":"pass"}',
        createdAt: 123,
      }],
      nextCursor: 11,
    })).toMatchObject({
      events: [{ turnId: 'turn-1', conversationId: 'conversation-1' }],
      nextCursor: 11,
    });
  });

  it('rejects sandbox runtime controls from per-turn secret inputs', () => {
    expect(contracts.BackgroundTurnStartInputSchema.parse({
      task: 'Run close workflow',
      sandboxSecrets: {
        PILOT_TURN_OWNERSHIP_TOKEN: 'turn-token',
      },
    })).toMatchObject({
      sandboxSecrets: {
        PILOT_TURN_OWNERSHIP_TOKEN: 'turn-token',
      },
    });

    expect(() => contracts.BackgroundTurnStartInputSchema.parse({
      task: 'Run close workflow',
      sandboxSecrets: {
        CTXMILL_CALLBACK_TOKEN: 'forged-token',
      },
    })).toThrow();
    expect(() => contracts.ConversationTurnStartInputSchema.parse({
      content: 'Run close workflow',
      sandboxSecrets: {
        ORCHESTRATOR_URL: 'https://attacker.example',
      },
    })).toThrow();
    expect(() => contracts.BackgroundTurnStartInputSchema.parse({
      task: 'Run close workflow',
      sandboxSecrets: {
        PILOT_TURN_OWNERSHIP_TOKEN: 'token\0suffix',
      },
    })).toThrow();
    expect(() => contracts.BackgroundTurnStartInputSchema.parse({
      task: 'Run close workflow',
      sandboxSecrets: JSON.parse('{"__proto__":"forged"}'),
    })).toThrow();
  });

  it('validates canonical sandbox-session restore lease fields', () => {
    const sandboxSession = {
      id: 'sandbox-1',
      conversationId: 'conversation-1',
      agentId: 'agent-1',
      containerName: 'ctxmill-sandbox-1',
      containerId: 'container-1',
      status: 'ACTIVE',
      harnessName: 'claude-agents',
      checkpointRef: null,
      createdAt: 1,
      updatedAt: 2,
      lastActivityAt: 3,
      restoreAttempts: 1,
      lastRestoreError: null,
      restoreOwnerId: null,
      restoreFenceToken: 2,
      restoreLeaseExpiresAt: null,
    };

    expect(contracts.SandboxSessionListResponseSchema.parse([sandboxSession]))
      .toEqual([sandboxSession]);
  });

  it('uses an explicit immutable workspace revision contract', () => {
    const revision = {
      revision: 3,
      sha256: '8d7df0f0',
      fileCount: 12,
      totalBytes: 4096,
      appliedAt: 42,
    };

    expect(contracts.WorkspaceRevisionResponseSchema.parse(revision)).toEqual(revision);
    expect(contracts.WorkspaceReplaceResponseSchema.parse(revision)).toEqual(revision);
    expect(() => contracts.WorkspaceRevisionResponseSchema.parse({
      revision: '3',
      digest: '8d7df0f0',
      files: 12,
      totalBytes: 4096,
    })).toThrow();
  });

  it('accepts every canonical AG-UI frame and rejects compatibility fields', () => {
    expect(contracts.CanonicalStreamEventSchema.parse({
      type: 'TEXT_MESSAGE_CONTENT',
      runId: 'turn-1',
      threadId: 'conversation-1',
      messageId: 'message-1',
      delta: 'hello',
      timestamp: 1,
    })).toMatchObject({ delta: 'hello' });

    expect(contracts.CanonicalStreamEventSchema.parse({
      type: 'TEXT_MESSAGE_START',
      runId: 'turn-1',
      threadId: 'conversation-1',
      messageId: 'message-user-1',
      role: 'user',
      timestamp: 1,
    })).toMatchObject({ role: 'user' });

    expect(contracts.CanonicalStreamEventSchema.parse({
      type: 'CUSTOM',
      name: 'ctxmill.interrupt.requested',
      agentId: 'agent-1',
      turnId: 'turn-1',
      conversationId: 'conversation-1',
      interruptId: 'interrupt-1',
      toolCallId: 'tool-call-1',
      toolCallName: 'request-approval',
      args: { reason: 'publish' },
      timestamp: 1,
    })).toMatchObject({ name: 'ctxmill.interrupt.requested' });

    expect(contracts.CanonicalStreamEventSchema.parse({
      type: 'CUSTOM',
      name: 'ctxmill.turn.pending',
      agentId: 'agent-1',
      turnId: 'turn-1',
      conversationId: 'conversation-1',
      mode: 'background',
      taskDescription: 'Close April',
      timestamp: 1,
    })).toMatchObject({ mode: 'background' });

    expect(contracts.CanonicalStreamEventSchema.parse({
      type: 'CUSTOM',
      name: 'ctxmill.message.committed',
      agentId: 'agent-1',
      turnId: 'turn-1',
      conversationId: 'conversation-1',
      messageId: 'message-1',
      messageSeq: 1,
      role: 'assistant',
      content: 'Complete',
      parts: [{ type: 'text', content: 'Complete' }],
      toolCalls: [],
      timestamp: 1,
    })).toMatchObject({ messageId: 'message-1' });

    expect(() => contracts.CanonicalStreamEventSchema.parse({
      type: 'TEXT_MESSAGE_CONTENT',
      runId: 'turn-1',
      threadId: 'conversation-1',
      messageId: 'message-1',
      content: 'legacy alias',
      timestamp: 1,
    })).toThrow();

    expect(() => contracts.CanonicalStreamEventSchema.parse({
      type: 'CUSTOM',
      name: 'ctxmill.interrupt.requested',
      subtype: 'hitl_pause',
      runId: 'turn-1',
      interruptId: 'interrupt-1',
      toolCallId: 'tool-call-1',
      toolName: 'legacy alias',
      args: {},
      timestamp: 1,
    })).toThrow();
  });

  it('requires the canonical named sandbox-session snapshot', () => {
    expect(contracts.AgentStreamEventSchema.parse({
      type: 'CUSTOM',
      name: 'ctxmill.sandbox_session.snapshot',
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      sandboxSessionId: 'sandbox-1',
      activeTurnId: null,
      status: 'ACTIVE',
      harnessName: 'claude-agents',
      containerName: 'ctxmill-sandbox-1',
      timestamp: 1,
    })).toMatchObject({ sandboxSessionId: 'sandbox-1' });

    expect(() => contracts.AgentStreamEventSchema.parse({
      type: 'CUSTOM',
      subtype: 'state_snapshot',
      agentId: 'agent-1',
      sandboxSessionId: 'sandbox-1',
      timestamp: 1,
    })).toThrow();
  });

  it('strictly validates webhook payload identities', () => {
    expect(contracts.InterruptRequestedWebhookPayloadSchema.parse({
      agentId: 'agent-1',
      turnId: 'turn-1',
      conversationId: 'conversation-1',
      interruptId: 'interrupt-1',
      timestamp: 1,
      toolCallId: 'tool-call-1',
      toolCallName: 'request-approval',
      args: {},
    })).toMatchObject({ interruptId: 'interrupt-1' });

    expect(() => contracts.InterruptRequestedWebhookPayloadSchema.parse({
      event: 'interrupt.requested',
      deliveryId: 'delivery-1',
      agentId: 'agent-1',
      timestamp: 1,
      data: {},
    })).toThrow();
    expect(() => contracts.WebhookEventNameSchema.parse('message.delta')).toThrow();
    expect(() => contracts.WebhookEventNameSchema.parse('ag_ui.event')).toThrow();
  });

  it('validates every event-specific flat webhook body contract', () => {
    const identities = {
      turnId: 'turn-1',
      agentId: 'agent-1',
      conversationId: 'conversation-1',
    };
    const fixtures = {
      'turn.started': {
        ...identities,
        sandboxSessionId: 'sandbox-1',
        mode: 'interactive',
        taskDescription: 'Close April',
        timestamp: 1,
      },
      'turn.completed': {
        ...identities,
        status: 'completed',
        durationMs: 10,
        usage: null,
        timestamp: 2,
      },
      'tool_call.started': {
        ...identities,
        toolCallId: 'tool-call-1',
        toolCallName: 'search',
        args: { query: 'April' },
        timestamp: 3,
      },
      'tool_call.completed': {
        ...identities,
        toolCallId: 'tool-call-1',
        toolCallName: 'search',
        result: '{"ok":true}',
        durationMs: 12,
        timestamp: 4,
      },
      'interrupt.requested': {
        ...identities,
        interruptId: 'interrupt-1',
        toolCallId: 'tool-call-2',
        toolCallName: 'approve',
        args: {},
        timestamp: 5,
      },
      'interrupt.resolved': {
        ...identities,
        interruptId: 'interrupt-1',
        action: 'approve',
        timestamp: 6,
      },
      'message.committed': {
        ...identities,
        messageId: 'message-1',
        messageSeq: 1,
        role: 'assistant',
        content: 'Done',
        parts: [{ type: 'text', text: 'Done' }],
        toolCalls: [{
          id: 'tool-call-1',
          name: 'search',
          args: '{}',
          status: 'done',
        }],
        timestamp: 7,
      },
      'message.updated': {
        ...identities,
        messageId: 'message-1',
        messageSeq: 1,
        messageRevision: 1,
        role: 'assistant',
        content: 'Updated',
        parts: [{ type: 'text', text: 'Updated' }],
        toolCalls: [{
          id: 'tool-call-1',
          name: 'search',
          args: '{}',
          status: 'done',
        }],
        timestamp: 8,
      },
      'feedback.received': {
        feedbackId: 'feedback-1',
        turnId: 'turn-1',
        agentId: 'agent-1',
        type: 'thumbs_up',
        messageId: 'message-1',
        timestamp: 9,
      },
      'budget.threshold': {
        policyId: 'policy-1',
        policyName: 'Monthly budget',
        action: 'warn',
        threshold: 0.8,
        metric: 'costUsd',
        spent: 80,
        limit: 100,
        agentId: 'agent-1',
        timestamp: 10,
      },
      'artifact.created': {
        artifactId: 'artifact-1',
        agentId: 'agent-1',
        turnId: 'turn-1',
        name: 'report.json',
        mimeType: 'application/json',
        sizeBytes: 42,
        kind: 'eval_report',
        timestamp: 11,
      },
    } as const;

    expect(contracts.WebhookEventNameSchema.options).toContain('message.updated');
    for (const eventName of contracts.WebhookEventNameSchema.options) {
      expect(contracts.WEBHOOK_PAYLOAD_SCHEMAS[eventName].parse(fixtures[eventName]))
        .toEqual(fixtures[eventName]);
    }
    expect(() => contracts.TurnCompletedWebhookPayloadSchema.parse({
      ...fixtures['turn.completed'],
      event: 'turn.completed',
    })).toThrow();
  });

  it('never exposes a stored webhook signing secret on readback', () => {
    expect(() => contracts.WebhookCreateInputSchema.parse({
      url: 'https://pilot.test/hooks/ctxmill',
      events: ['turn.completed'],
    })).toThrow();
    expect(contracts.WebhookCreateInputSchema.parse({
      url: 'https://pilot.test/hooks/ctxmill',
      events: ['turn.completed'],
      secret: 'rotation-key',
    })).toEqual({
      url: 'https://pilot.test/hooks/ctxmill',
      events: ['turn.completed'],
      secret: 'rotation-key',
    });
    expect(contracts.WebhookPatchInputSchema.parse({
      events: ['message.updated'],
    })).toEqual({
      events: ['message.updated'],
    });
    expect(contracts.WebhookPatchInputSchema.parse({
      secret: 'rotated-key',
    })).toEqual({
      secret: 'rotated-key',
    });
    expect(() => contracts.WebhookPatchInputSchema.parse({})).toThrow();

    const webhook = {
      id: 'webhook-1',
      agentId: 'agent-1',
      url: 'https://pilot.test/hooks/ctxmill',
      events: ['turn.completed'],
      active: true,
      hasSecret: true,
      createdAt: 1,
      updatedAt: 2,
    };

    expect(contracts.WebhookSchema.parse(webhook)).toEqual(webhook);
    expect(() => contracts.WebhookSchema.parse({
      ...webhook,
      secret: 'must-not-leak',
    })).toThrow();
  });

  it('verifies the fixed v1 webhook signature fixture and rotated keys', async () => {
    const fixture = JSON.parse(readFileSync(
      new URL('../test-fixtures/webhook-signature-v1.json', import.meta.url),
      'utf8',
    )) as {
      timestamp: string;
      rawBody: string;
      currentSecret: string;
      previousSecret: string;
      currentSignature: string;
      previousSignature: string;
      headers: Record<string, string>;
    };

    expect(contracts.CtxmillWebhookHeadersSchema.parse(fixture.headers))
      .toEqual(fixture.headers);
    await expect(contracts.createCtxmillWebhookSignature({
      secret: fixture.currentSecret,
      timestamp: fixture.timestamp,
      rawBody: fixture.rawBody,
    })).resolves.toBe(fixture.currentSignature);

    await expect(contracts.verifyCtxmillWebhook({
      headers: fixture.headers,
      rawBody: fixture.rawBody,
      secrets: [fixture.previousSecret, fixture.currentSecret],
      nowSeconds: Number(fixture.timestamp),
    })).resolves.toMatchObject({
      valid: true,
      payload: {
        status: 'completed',
        turnId: 'turn-fixture-1',
      },
    });

    await expect(contracts.verifyCtxmillWebhook({
      headers: {
        ...fixture.headers,
        'X-Webhook-Signature': fixture.previousSignature,
      },
      rawBody: fixture.rawBody,
      secrets: [fixture.currentSecret, fixture.previousSecret],
      nowSeconds: Number(fixture.timestamp),
    })).resolves.toMatchObject({ valid: true });
  });

  it('rejects stale, tampered, and identity-mismatched signed webhooks', async () => {
    const fixture = JSON.parse(readFileSync(
      new URL('../test-fixtures/webhook-signature-v1.json', import.meta.url),
      'utf8',
    )) as {
      timestamp: string;
      rawBody: string;
      currentSecret: string;
      headers: Record<string, string>;
    };

    await expect(contracts.verifyCtxmillWebhook({
      headers: fixture.headers,
      rawBody: fixture.rawBody,
      secrets: fixture.currentSecret,
      nowSeconds: Number(fixture.timestamp) + 301,
      toleranceSeconds: 300,
    })).resolves.toEqual({
      valid: false,
      reason: 'timestamp_outside_tolerance',
    });

    await expect(contracts.verifyCtxmillWebhook({
      headers: fixture.headers,
      rawBody: `${fixture.rawBody} `,
      secrets: fixture.currentSecret,
      nowSeconds: Number(fixture.timestamp),
    })).resolves.toEqual({
      valid: false,
      reason: 'invalid_signature',
    });

    const mismatchedHeaders = {
      ...fixture.headers,
      'X-Agent-Id': 'agent-other',
    };
    await expect(contracts.verifyCtxmillWebhook({
      headers: mismatchedHeaders,
      rawBody: fixture.rawBody,
      secrets: fixture.currentSecret,
      nowSeconds: Number(fixture.timestamp),
    })).resolves.toEqual({
      valid: false,
      reason: 'header_body_mismatch',
    });
  });
});
