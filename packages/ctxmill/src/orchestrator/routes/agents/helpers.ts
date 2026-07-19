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
import type { AgentHttpToolDefinition, AgentRouteOptions, StoredAgent } from './types.js';

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

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

export function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function getHttpToolNames(httpTools?: AgentHttpToolDefinition[] | unknown): string[] {
  if (!Array.isArray(httpTools) || httpTools.length === 0) return [];
  return httpTools
    .filter((tool): tool is AgentHttpToolDefinition => isObjectRecord(tool) && isNonEmptyString(tool.name))
    .map((tool) => tool.name);
}

export function validateHttpTools(httpTools?: AgentHttpToolDefinition[] | unknown): string | null {
  return validateAgentHttpToolsConfig(httpTools);
}

export function mergeToolNames(baseTools: string[], httpTools?: AgentHttpToolDefinition[] | unknown): string[] {
  return [...new Set([...baseTools, ...getHttpToolNames(httpTools)])];
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
  const { nativeTools, workspaceContent, mode } = extractManifestRuntimeFields(agent);
  return AgentSchema.parse({
    ...agent,
    harnessConfig: parseStoredHarnessConfig(agent.harnessConfig),
    nativeTools: nativeTools ?? null,
    workspaceContent: workspaceContent ?? null,
    mode: mode ?? null,
    // Canonical resolution (metadata override ?? manifest spec.resources.sandbox) so the API
    // reports the limits the runtime actually enforces.
    resourceLimits: resolveResourceLimits(agent) ?? null,
  });
}

export function toApiAgentTurn(
  turn: { id: string; agentId: string; conversationId: string | null; sandboxSessionId: string | null; status: string; mode: string; taskDescription: string | null; startedAt: number; completedAt: number | null; error: string | null; inputTokens?: number | null; outputTokens?: number | null; totalTokens?: number | null; costUsd?: number | null },
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
    conversationId: turn.conversationId ?? '',
    ...(turn.sandboxSessionId ? { sandboxSessionId: turn.sandboxSessionId } : {}),
    ...(sandboxSession?.status ? { sandboxStatus: sandboxSession.status } : {}),
    status,
    mode: turn.mode || 'interactive',
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
    ...(turn.totalTokens != null
      ? {
        usage: {
          inputTokens: turn.inputTokens ?? 0,
          outputTokens: turn.outputTokens ?? 0,
          totalTokens: turn.totalTokens,
          ...(turn.costUsd != null ? { costUsd: turn.costUsd } : {}),
        },
      }
      : {}),
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
