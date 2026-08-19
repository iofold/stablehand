import { join } from 'node:path';
import { chown, readdir, stat } from 'node:fs/promises';
import type { FastifyRequest } from 'fastify';
import { projectTurnStatus } from '@ctxmill/shared';
import { AgentSchema, type Agent } from '@ctxmill/contracts';

import type { HarnessConfigSchemas } from '@ctxmill/sandbox-daemon/harness/schemas';
import { ensureAgentWorkspace as ensureAgentWorkspaceShared } from '../../../workspace/ensure.js';
import {
  extractManifestRuntimeFields,
  parseStoredHarnessConfig,
  resolveResourceLimits,
} from '../../agent-definition.js';
import { validateAgentHttpToolsConfig } from '../../http-tools.js';
import { materializeTurnUsage } from '../../usage.js';
import type { AgentHttpToolDefinition, AgentRouteOptions, StoredAgent } from './types.js';

export const AGENT_MANAGED_METADATA_FIELDS: ReadonlySet<string> = new Set([
  'builtinToolPolicy',
  'httpTools',
  'mode',
  'nativeToolPolicy',
  'resourceLimits',
  'workspaceContent',
]);

export function safeError(message: string, err: unknown): { error: string; detail?: string } {
  console.error('[agents] endpoint error:', err);
  const detail = err instanceof Error ? err.message : String(err);
  return { error: message, detail };
}

export async function chownRecursive(dir: string, uid: number, gid: number): Promise<void> {
  try {
    await chown(dir, uid, gid);
    const entries = await readdir(dir);
    for (const name of entries) {
      const fullPath = join(dir, name);
      const entryStat = await stat(fullPath);
      await chown(fullPath, uid, gid);
      if (entryStat.isDirectory()) {
        await chownRecursive(fullPath, uid, gid);
      }
    }
  } catch {
    return;
  }
}

export function validateResourceLimits(limits: Record<string, unknown>): string[] {
  const errors: string[] = [];

  if (limits.cpus !== undefined) {
    const cpus = Number(limits.cpus);
    if (isNaN(cpus) || cpus < 0.5 || cpus > 4.0) {
      errors.push(`cpus must be between 0.5 and 4.0, got ${limits.cpus}`);
    }
  }

  if (limits.memoryMb !== undefined) {
    const mem = Number(limits.memoryMb);
    if (isNaN(mem) || !Number.isInteger(mem) || mem < 256 || mem > 4096) {
      errors.push(`memoryMb must be an integer between 256 and 4096, got ${limits.memoryMb}`);
    }
  }

  if (limits.pidsLimit !== undefined) {
    const pids = Number(limits.pidsLimit);
    if (isNaN(pids) || !Number.isInteger(pids) || pids < 64 || pids > 512) {
      errors.push(`pidsLimit must be an integer between 64 and 512, got ${limits.pidsLimit}`);
    }
  }

  if (limits.timeoutSec !== undefined) {
    const timeout = Number(limits.timeoutSec);
    if (isNaN(timeout) || !Number.isInteger(timeout) || timeout < 60 || timeout > 3600) {
      errors.push(`timeoutSec must be an integer between 60 and 3600, got ${limits.timeoutSec}`);
    }
  }

  return errors;
}

export function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function getAgentHttpTools(metadata: Record<string, unknown> | null | undefined): AgentHttpToolDefinition[] {
  return Array.isArray(metadata?.httpTools)
    ? metadata.httpTools as AgentHttpToolDefinition[]
    : [];
}

export function getPublicAgentMetadata(
  metadata: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!metadata) return null;
  const publicMetadata = Object.fromEntries(
    Object.entries(metadata).filter(([key]) => !AGENT_MANAGED_METADATA_FIELDS.has(key)),
  );
  return Object.keys(publicMetadata).length > 0 ? publicMetadata : null;
}

export function validateHttpTools(httpTools?: AgentHttpToolDefinition[] | unknown): string | null {
  return validateAgentHttpToolsConfig(httpTools);
}

type AgentRequest = FastifyRequest & { agent: StoredAgent };

export function getRequestAgent(request: FastifyRequest): StoredAgent {
  return (request as AgentRequest).agent;
}

export function ensureAgentWorkspace(
  agentId: string,
  opts: Pick<AgentRouteOptions, 'dataDir'>,
): string | undefined {
  if (!opts.dataDir) return undefined;
  return ensureAgentWorkspaceShared(opts.dataDir, agentId);
}

export function toAgentResponse(agent: StoredAgent): Agent {
  const {
    builtinToolPolicy,
    nativeToolPolicy,
    workspaceContent,
    mode,
  } = extractManifestRuntimeFields(agent);
  return AgentSchema.parse({
    id: agent.id,
    name: agent.name,
    harness: agent.harness,
    harnessConfig: parseStoredHarnessConfig(agent.harnessConfig),
    systemPrompt: agent.systemPrompt,
    tools: agent.tools,
    description: agent.description,
    workspaceDir: agent.workspaceDir,
    status: 'idle',
    manifest: agent.manifest,
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
    httpTools: getAgentHttpTools(agent.metadata),
    metadata: getPublicAgentMetadata(agent.metadata),
    builtinToolPolicy: builtinToolPolicy ?? null,
    nativeToolPolicy: nativeToolPolicy ?? null,
    workspaceContent: workspaceContent ?? null,
    mode: mode ?? null,
    // Canonical resolution (metadata override ?? manifest spec.resources.sandbox) so the API
    // reports the limits the runtime actually enforces.
    resourceLimits: resolveResourceLimits(agent) ?? null,
  });
}

export function toApiAgentTurn(
  turn: { id: string; agentId: string; conversationId: string | null; sandboxSessionId: string | null; status: string; mode: string; taskDescription: string | null; queuedAt: number; startedAt: number; completedAt: number | null; error: string | null; inputTokens?: number | null; outputTokens?: number | null; totalTokens?: number | null; costUsd?: number | null; gatewayMode?: string | null; gatewayCorrelationId?: string | null; usageReconciledAt?: number | null; tags?: Record<string, string> | null },
  sandboxSession?: {
    status: string;
    restoreAttempts?: number | null;
    lastRestoreError?: string | null;
    updatedAt?: number;
  } | null,
  conversationMessageCount?: number,
) {
  const status = projectTurnStatus(turn);

  return {
    id: turn.id,
    agentId: turn.agentId,
    conversationId: turn.conversationId ?? null,
    ...(turn.sandboxSessionId ? { sandboxSessionId: turn.sandboxSessionId } : {}),
    ...(sandboxSession?.status ? { sandboxStatus: sandboxSession.status } : {}),
    status,
    mode: turn.mode || 'interactive',
    queuedAt: turn.queuedAt,
    startedAt: turn.startedAt,
    ...(turn.completedAt != null ? { completedAt: turn.completedAt } : {}),
    ...(turn.error ? { error: turn.error } : {}),
    ...(turn.taskDescription ? { taskDescription: turn.taskDescription } : {}),
    ...(conversationMessageCount !== undefined ? { conversationMessageCount } : {}),
    ...(sandboxSession?.restoreAttempts !== undefined ? { restoreAttempts: sandboxSession.restoreAttempts } : {}),
    ...(sandboxSession?.lastRestoreError ? { lastRestoreError: sandboxSession.lastRestoreError } : {}),
    ...(sandboxSession?.status === 'CHECKPOINTED' && typeof sandboxSession.updatedAt === 'number'
      ? { checkpointAt: sandboxSession.updatedAt }
      : {}),
    // Gateway-attributed turns without a reconciled usage envelope are awaiting
    // spend reconciliation; direct turns without cost stay unpriced. Keeps this
    // projection in agreement with the analytics costCoverage classification.
    usage: materializeTurnUsage(turn, {
      gatewayPending: turn.gatewayMode === 'gateway_only' || turn.gatewayMode === 'mixed',
    }),
    tags: turn.tags ?? {},
    gatewayMode: turn.gatewayMode === 'gateway_only' || turn.gatewayMode === 'mixed'
      ? turn.gatewayMode
      : null,
    ...(turn.gatewayCorrelationId ? { gatewayCorrelationId: turn.gatewayCorrelationId } : {}),
    ...(turn.usageReconciledAt != null ? { usageReconciledAt: turn.usageReconciledAt } : {}),
  };
}

export function getHarnessError(harnessName: string, harnessSchemas: HarnessConfigSchemas): string {
  const available = Object.keys(harnessSchemas);
  if (available.length === 0) {
    return `Unknown harness: ${harnessName}`;
  }

  return `Unknown harness: ${harnessName}. Available: ${available.join(', ')}`;
}

export function validateHarnessConfigInput(
  harnessName: string,
  harnessConfig: unknown,
  harnessSchemas: HarnessConfigSchemas,
):
  | { success: true; harnessConfig: Record<string, unknown> }
  | { success: false; status: number; body: Record<string, unknown> } {
  if (!isObjectRecord(harnessConfig)) {
    return {
      success: false,
      status: 400,
      body: {
        error: `Invalid harnessConfig for harness "${harnessName}"`,
        details: [{ message: 'harnessConfig must be an object' }],
      },
    };
  }

  const schema = harnessSchemas[harnessName];
  if (!schema) {
    return {
      success: false,
      status: 400,
      body: { error: getHarnessError(harnessName, harnessSchemas) },
    };
  }

  const parseResult = schema.safeParse(harnessConfig);
  if (!parseResult.success) {
    return {
      success: false,
      status: 400,
      body: {
        error: `Invalid harnessConfig for harness "${harnessName}"`,
        details: parseResult.error.issues,
      },
    };
  }

  return {
    success: true,
    harnessConfig: parseResult.data as Record<string, unknown>,
  };
}
