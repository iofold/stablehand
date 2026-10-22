import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { DatabaseRepository } from '../../database/repository.js';
import { McpConnectError, type McpServerManager } from '../../mcp/manager.js';

export interface McpOAuthRouteOptions {
  db: Pick<DatabaseRepository, 'getAgent'>;
  mcpServerManager: McpServerManager;
}

interface CallbackQuery {
  code?: string;
  state?: string;
  iss?: string;
  error?: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: system-ui, sans-serif; background: #0f1115; color: #e6e6e6; margin: 0; padding: 48px 16px; }
  main { max-width: 32rem; margin: 0 auto; }
  h1 { font-size: 1.25rem; margin: 0 0 12px; }
  p { line-height: 1.5; color: #b9bcc4; }
</style>
</head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p></main></body>
</html>`;
}

function sendPage(reply: FastifyReply, status: number, title: string, body: string) {
  return reply
    .status(status)
    .header('content-type', 'text/html; charset=utf-8')
    .header('cache-control', 'no-store')
    // Keep the code and state out of any Referer header.
    .header('referrer-policy', 'no-referrer')
    .send(page(title, body));
}

/**
 * The OAuth redirect target for MCP servers. It is public because the
 * provider's sign-in page sends the browser here without a Stablehand token;
 * the single-use, unguessable `state` is what authorizes it. The page shows
 * no tokens.
 */
export async function mcpOAuthRoutes(app: FastifyInstance, opts: McpOAuthRouteOptions): Promise<void> {
  app.get(
    '/oauth/callback',
    { config: { public: true } },
    async (request: FastifyRequest<{ Querystring: CallbackQuery }>, reply: FastifyReply) => {
      const { code, state, iss, error } = request.query;
      if (error) {
        return sendPage(reply, 400, 'Sign-in did not finish', `The provider answered "${error}". Start again from Connect on the agent's Tools tab.`);
      }
      if (!code || !state) {
        return sendPage(reply, 400, 'Sign-in did not finish', 'This page needs the code and state the provider sends back. Start again from Connect.');
      }
      try {
        const connected = await opts.mcpServerManager.finishConnect(
          { code, state, ...(iss ? { iss } : {}) },
          async (agentId) => (await opts.db.getAgent(agentId)) ?? undefined,
        );
        return sendPage(
          reply,
          200,
          `${connected.serverName} is connected`,
          `${connected.agentName} can now use ${connected.serverName}. You can close this tab.`,
        );
      } catch (caught) {
        if (caught instanceof McpConnectError) {
          return sendPage(reply, caught.status, 'Sign-in did not finish', caught.message);
        }
        request.log.error({ err: caught }, 'MCP OAuth callback failed');
        return sendPage(reply, 500, 'Sign-in did not finish', 'Stablehand could not store the sign-in. Check the orchestrator logs and try again.');
      }
    },
  );
}
