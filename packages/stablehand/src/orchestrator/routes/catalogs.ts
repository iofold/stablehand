import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { builtinToolNames } from '../../tool/builtin/index.js';
import { resolveToolLocation } from '../../tool/metadata.js';
import type { ToolContext } from '@stablehand/sandbox-daemon';
import {
  CatalogToolListResponseSchema,
  ToolTestResponseSchema,
  type CatalogTool as CatalogToolResponse,
  type ToolTestResponse as TestToolResponse,
} from '@stablehand/contracts';

interface TestToolRequestBody {
  toolName: string;
  input?: Record<string, unknown>;
}

const TOOL_TEST_TIMEOUT_MS = 30_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTestToolRequestBody(value: unknown): value is TestToolRequestBody {
  if (!isRecord(value)) {
    return false;
  }

  if (typeof value.toolName !== 'string') {
    return false;
  }

  if (value.input === undefined) {
    return true;
  }

  return isRecord(value.input);
}

function createToolTestContext(): ToolContext {
  return {
    agentId: 'tool-tester',
    conversationId: 'test',
    workspaceDir: process.cwd(),
  };
}

async function executeWithTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`Tool execution timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

export async function catalogRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/catalogs/tools - Return flat list of all tool definitions across agents
  app.get('/tools', async (_request): Promise<CatalogToolResponse[]> => {
    const db = app.db;
    const agents = await db.listAgents();
    const seen = new Map<string, CatalogToolResponse>();

    for (const agent of agents) {
      // agent.tools is JSON-parsed by drizzle (string[]), but guard defensively
      const toolNames: string[] = Array.isArray(agent.tools) ? agent.tools : [];

      for (const name of toolNames) {
        if (!seen.has(name)) {
          // A declared name no provider serves yet. Its source is unknown, so
          // report it as local rather than guessing from the name (ctx-z08z).
          seen.set(name, {
            name,
            description: `Tool registered by agent ${agent.name ?? agent.id}`,
            source: 'local',
            requiresApproval: false,
          });
        }
      }
    }

    // Enrich with actual tool definitions from the registry. The provider
    // reports each tool's source; the first entry for a name wins.
    if (app.toolDefinitionRegistry) {
      const registryEntries = app.toolDefinitionRegistry.listEntries();
      const enriched = new Set<string>();

      for (const registryEntry of registryEntries) {
        const toolDef = registryEntry.tool;
        if (enriched.has(toolDef.name)) continue;
        enriched.add(toolDef.name);
        const entry: CatalogToolResponse = {
          name: toolDef.name,
          ...(registryEntry.catalog?.displayName ? { displayName: registryEntry.catalog.displayName } : {}),
          description: toolDef.description,
          source: registryEntry.source,
          ...(registryEntry.catalog?.server ? { server: registryEntry.catalog.server } : {}),
          requiresApproval: toolDef.requiresApproval ?? false,
          secrets: toolDef.secrets,
          builtin: builtinToolNames.has(toolDef.name),
          location: resolveToolLocation(toolDef),
        };

        if (toolDef.input !== undefined && typeof toolDef.input === 'object' && toolDef.input !== null) {
          const input = toolDef.input;
          if ('toJSON' in input) {
            entry.inputSchema = (input as { toJSON(): Record<string, unknown> }).toJSON();
          } else if (typeof (input as { safeParse?: unknown }).safeParse === 'function') {
            // A live Zod schema is a runtime validator, not a JSON schema.
            // Convert to real JSON Schema; omit when the schema is not
            // representable (previously the raw object's internals leaked).
            try {
              entry.inputSchema = z.toJSONSchema(input as z.ZodType) as Record<string, unknown>;
            } catch {
              // unrepresentable — omit
            }
          } else if (!Array.isArray(input)) {
            entry.inputSchema = input as Record<string, unknown>;
          }
        }

        seen.set(toolDef.name, entry);
      }
    }

    return CatalogToolListResponseSchema.parse(Array.from(seen.values()));
  });

  app.post<{ Body: unknown }>('/tools/test', async (request, reply): Promise<TestToolResponse> => {
    if (!isTestToolRequestBody(request.body)) {
      // ctx-iqzy S12: a rejected request gets the standard error envelope,
      // not a success-flagged ToolTestResponse.
      return reply.code(400).send({
        error: 'Invalid request body: toolName must be a string and input must be an object when provided',
        code: 'invalid_tool_test_request',
      });
    }

    const { toolName, input = {} } = request.body;
    const tool = app.toolDefinitionRegistry.getTool(toolName);
    const provider = app.toolDefinitionRegistry.getProvider(toolName);

    if (!tool || !provider || !provider.execute) {
      return ToolTestResponseSchema.parse({
        success: false,
        error: !tool || !provider ? `Tool not found: ${toolName}` : `Tool provider does not support execution: ${toolName}`,
        durationMs: 0,
      });
    }
    if (tool.requiresApproval) {
      // The tester has no run to pause, so it would skip the approval the
      // tool asks for. Run gated tools from an agent instead (ctx-9gy9).
      return ToolTestResponseSchema.parse({
        success: false,
        error: `${toolName} asks for approval before each call, so it cannot run from the tool tester. Call it from an agent run.`,
        durationMs: 0,
      });
    }

    const executeFn: (toolName: string, args: unknown, ctx: ToolContext) => Promise<string> = provider.execute.bind(provider);
    const startedAt = Date.now();

    try {
      const result = await executeWithTimeout(
        executeFn(toolName, input, createToolTestContext()),
        TOOL_TEST_TIMEOUT_MS,
      );

      return ToolTestResponseSchema.parse({
        success: true,
        result,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      return ToolTestResponseSchema.parse({
        success: false,
        error: message,
        durationMs: Date.now() - startedAt,
      });
    }
  });

}
