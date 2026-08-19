import type { FastifyInstance } from 'fastify';

import { builtinToolNames } from '../../tool/builtin/index.js';
import { resolveToolLocation } from '../../tool/metadata.js';
import type { ToolContext } from '@ctxmill/sandbox-daemon';
import {
  CatalogToolListResponseSchema,
  ToolTestResponseSchema,
  type CatalogTool as CatalogToolResponse,
  type ToolTestResponse as TestToolResponse,
} from '@ctxmill/contracts';

interface TestToolRequestBody {
  toolName: string;
  input?: Record<string, unknown>;
}

const TOOL_TEST_TIMEOUT_MS = 30_000;

function detectToolSource(name: string): 'local' | 'mcp' | 'composio' {
  if (name.startsWith('composio.')) {
    return 'composio';
  }

  return name.includes(':') ? 'mcp' : 'local';
}

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
          seen.set(name, {
            name,
            description: `Tool registered by agent ${agent.name ?? agent.id}`,
            source: detectToolSource(name),
            requiresApproval: false,
          });
        }
      }
    }

    // Enrich with actual tool definitions from the registry
    if (app.toolDefinitionRegistry) {
      const registryTools = app.toolDefinitionRegistry.listAll();

      for (const toolDef of registryTools) {
        const entry: CatalogToolResponse = {
          name: toolDef.name,
          description: toolDef.description,
          source: detectToolSource(toolDef.name),
          requiresApproval: toolDef.requiresApproval ?? false,
          secrets: toolDef.secrets,
          builtin: builtinToolNames.has(toolDef.name),
          location: resolveToolLocation(toolDef),
        };

        if (toolDef.input !== undefined) {
          if (typeof toolDef.input === 'object' && toolDef.input !== null && 'toJSON' in toolDef.input) {
            entry.inputSchema = (toolDef.input as { toJSON(): Record<string, unknown> }).toJSON();
          } else if (typeof toolDef.input === 'object' && toolDef.input !== null) {
            entry.inputSchema = toolDef.input as Record<string, unknown>;
          }
        }

        seen.set(toolDef.name, entry);
      }
    }

    return CatalogToolListResponseSchema.parse(Array.from(seen.values()));
  });

  app.post<{ Body: unknown }>('/tools/test', async (request, reply): Promise<TestToolResponse> => {
    if (!isTestToolRequestBody(request.body)) {
      reply.code(400);

      return ToolTestResponseSchema.parse({
        success: false,
        error: 'Invalid request body: toolName must be a string and input must be an object when provided',
        durationMs: 0,
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
