import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  McpServerConnectInputSchema,
  McpServerConnectResponseSchema,
  McpServerStatusListResponseSchema,
} from '@stablehand/contracts';

import { McpConnectError } from '../../../mcp/manager.js';
import { getRequestAgent, safeError } from './helpers.js';
import type { AgentSubRouteOptions } from './types.js';

export const MCP_OAUTH_CALLBACK_PATH = '/api/mcp/oauth/callback';

function firstHeader(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw?.split(',')[0]?.trim() || undefined;
}

/**
 * The one redirect URI for this deployment. STABLEHAND_PUBLIC_URL wins; else
 * the origin the browser reports; else the forwarded host of this request.
 */
export function resolveMcpRedirectUri(
  request: FastifyRequest,
  redirectOrigin: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = env.STABLEHAND_PUBLIC_URL?.trim();
  const proto = firstHeader(request.headers['x-forwarded-proto']) ?? request.protocol;
  const host = firstHeader(request.headers['x-forwarded-host']) ?? request.headers.host;
  const base = configured || redirectOrigin || `${proto}://${host}`;
  const url = new URL(base);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new McpConnectError('The redirect origin must be an http(s) URL', 400);
  }
  const prefix = configured ? url.pathname.replace(/\/+$/, '') : '';
  return `${url.origin}${prefix}${MCP_OAUTH_CALLBACK_PATH}`;
}

function sendConnectError(reply: FastifyReply, error: unknown) {
  if (error instanceof McpConnectError) {
    return reply.status(error.status).send({ error: error.message, code: 'mcp_connect_failed' });
  }
  return reply.status(500).send(safeError('MCP server request failed', error));
}

type ServerParams = { Params: { id: string; server: string } };

/**
 * MCP server status and the OAuth connect flow for one agent. Status and
 * refresh follow the agent capabilities; connecting and disconnecting an
 * account handle credentials and stay master-only, like secrets.
 */
export async function mcpServerRoutes(
  app: FastifyInstance,
  opts: AgentSubRouteOptions,
): Promise<void> {
  const { mcpServerManager, loadAgent } = opts;

  app.get(
    '/:id/mcp-servers',
    { preHandler: [loadAgent], config: { capability: 'agents:read' } },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      if (!mcpServerManager) {
        return reply.send(McpServerStatusListResponseSchema.parse({ servers: [] }));
      }
      const servers = await mcpServerManager.status(getRequestAgent(request));
      return reply.send(McpServerStatusListResponseSchema.parse({ servers }));
    },
  );

  app.post(
    '/:id/mcp-servers/:server/refresh',
    { preHandler: [loadAgent], config: { capability: 'agents:write' } },
    async (request: FastifyRequest<ServerParams>, reply: FastifyReply) => {
      if (!mcpServerManager) {
        return reply.status(501).send({ error: 'MCP servers are not enabled on this orchestrator' });
      }
      const agent = getRequestAgent(request);
      try {
        await mcpServerManager.refreshServer(agent.id, request.params.server);
      } catch (error) {
        return sendConnectError(reply, error);
      }
      const servers = await mcpServerManager.status(agent);
      return reply.send(McpServerStatusListResponseSchema.parse({ servers }));
    },
  );

  app.post(
    '/:id/mcp-servers/:server/connect',
    { preHandler: [loadAgent] },
    async (request: FastifyRequest<ServerParams & { Body: unknown }>, reply: FastifyReply) => {
      if (!mcpServerManager) {
        return reply.status(501).send({ error: 'MCP servers are not enabled on this orchestrator' });
      }
      const parsed = McpServerConnectInputSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Invalid connect request', details: parsed.error.issues });
      }
      try {
        const redirectUri = resolveMcpRedirectUri(request, parsed.data.redirectOrigin);
        const started = await mcpServerManager.startConnect(
          getRequestAgent(request),
          request.params.server,
          redirectUri,
        );
        return reply.send(McpServerConnectResponseSchema.parse(started));
      } catch (error) {
        return sendConnectError(reply, error);
      }
    },
  );

  app.delete(
    '/:id/mcp-servers/:server/connection',
    { preHandler: [loadAgent] },
    async (request: FastifyRequest<ServerParams>, reply: FastifyReply) => {
      if (!mcpServerManager) {
        return reply.status(501).send({ error: 'MCP servers are not enabled on this orchestrator' });
      }
      try {
        await mcpServerManager.disconnect(getRequestAgent(request), request.params.server);
      } catch (error) {
        return sendConnectError(reply, error);
      }
      return reply.status(204).send();
    },
  );
}
