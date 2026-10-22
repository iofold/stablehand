/**
 * A real MCP server over Streamable HTTP for tests: the SDK's own server
 * classes, stateless mode, plus an optional bearer check or a minimal OAuth
 * 2.1 authorization server (protected-resource metadata, AS metadata,
 * dynamic client registration, PKCE S256, refresh). Nothing is mocked on the
 * client side, so tests exercise the same client code production runs.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

export type TestMcpAuth =
  | { type: 'none' }
  | { type: 'bearer'; token: string }
  | { type: 'oauth' };

export interface TestMcpCall {
  name: string;
  arguments: Record<string, unknown>;
  authorization?: string;
}

export interface TestMcpServerHandle {
  /** MCP endpoint, e.g. http://127.0.0.1:PORT/mcp */
  url: string;
  origin: string;
  calls: TestMcpCall[];
  /** Every Authorization header the MCP endpoint saw. */
  authorizationHeaders: string[];
  oauth: {
    registrations: number;
    issuedAccessTokens: string[];
    refreshes: number;
    /** Plays the browser: follows the sign-in URL and returns the redirect it gets. */
    authorize(authorizationUrl: string): Promise<URL>;
    /** Expire every issued access token (refresh tokens stay valid). */
    expireAccessTokens(): void;
  };
  close(): Promise<void>;
}

const NOTES = [
  { id: 'n1', title: 'Pricing review', body: 'We will drop the annual discount from 20% to 15%.' },
  { id: 'n2', title: 'Hiring sync', body: 'Two offers out; one accepted.' },
];

const TOOLS = [
  {
    name: 'list_notes',
    title: 'List notes',
    description: 'List this week\'s meeting notes.',
    inputSchema: {
      type: 'object',
      properties: { week: { type: 'string', enum: ['this_week', 'last_week'] } },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_note',
    description: 'Read one meeting note by id.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Note id' } },
      required: ['id'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'delete_note',
    description: 'Delete a meeting note.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
    annotations: { destructiveHint: true },
  },
  {
    name: 'echo_args',
    description: 'Return the arguments it received.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        limit: { type: 'number' },
        nested: { type: 'object', properties: { flag: { type: 'boolean' } } },
      },
      required: ['text'],
    },
  },
  {
    name: 'broken',
    description: 'Always reports an error.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'apify/rag-web-browser',
    description: 'A tool whose name has a slash, like Apify actor tools.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
  },
];

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function base64UrlSha256(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

function buildMcpServer(calls: TestMcpCall[], authorization: string | undefined): Server {
  const server = new Server({ name: 'test-notes', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    calls.push({ name: request.params.name, arguments: args, ...(authorization ? { authorization } : {}) });
    switch (request.params.name) {
      case 'list_notes':
        return { content: [{ type: 'text', text: JSON.stringify(NOTES.map(({ id, title }) => ({ id, title }))) }] };
      case 'get_note': {
        const note = NOTES.find((candidate) => candidate.id === args.id);
        return note
          ? { content: [{ type: 'text', text: `${note.title}: ${note.body}` }] }
          : { isError: true, content: [{ type: 'text', text: `No note ${String(args.id)}` }] };
      }
      case 'delete_note':
        return { content: [{ type: 'text', text: `deleted ${String(args.id)}` }] };
      case 'echo_args':
        return { content: [{ type: 'text', text: JSON.stringify(args) }] };
      case 'broken':
        return { isError: true, content: [{ type: 'text', text: 'boom: upstream refused' }] };
      case 'apify/rag-web-browser':
        return {
          content: [
            { type: 'text', text: `results for ${String(args.query)}` },
            { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
          ],
        };
      default:
        return { isError: true, content: [{ type: 'text', text: `unknown tool ${request.params.name}` }] };
    }
  });
  return server;
}

export async function startTestMcpServer(auth: TestMcpAuth = { type: 'none' }): Promise<TestMcpServerHandle> {
  const calls: TestMcpCall[] = [];
  const authorizationHeaders: string[] = [];
  const clients = new Map<string, { redirectUris: string[] }>();
  const codes = new Map<string, { challenge: string; clientId: string; redirectUri: string }>();
  const accessTokens = new Set<string>();
  const refreshTokens = new Set<string>();
  const issuedAccessTokens: string[] = [];
  const oauthStats = { registrations: 0, refreshes: 0 };
  let origin = '';

  const issueTokens = () => {
    const access = `at_${randomBytes(12).toString('hex')}`;
    const refresh = `rt_${randomBytes(12).toString('hex')}`;
    accessTokens.add(access);
    refreshTokens.add(refresh);
    issuedAccessTokens.push(access);
    return { access_token: access, token_type: 'Bearer', expires_in: 3600, refresh_token: refresh };
  };

  const httpServer = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', origin);

      if (auth.type === 'oauth') {
        if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
          return json(res, 200, { resource: `${origin}/mcp`, authorization_servers: [origin] });
        }
        if (url.pathname === '/.well-known/oauth-authorization-server') {
          return json(res, 200, {
            issuer: origin,
            authorization_endpoint: `${origin}/authorize`,
            token_endpoint: `${origin}/token`,
            registration_endpoint: `${origin}/register`,
            response_types_supported: ['code'],
            grant_types_supported: ['authorization_code', 'refresh_token'],
            code_challenge_methods_supported: ['S256'],
            token_endpoint_auth_methods_supported: ['none'],
          });
        }
        if (url.pathname === '/register' && req.method === 'POST') {
          const body = JSON.parse(await readBody(req)) as { redirect_uris?: string[] };
          const clientId = `client_${randomBytes(6).toString('hex')}`;
          clients.set(clientId, { redirectUris: body.redirect_uris ?? [] });
          oauthStats.registrations += 1;
          return json(res, 201, { ...body, client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000) });
        }
        if (url.pathname === '/authorize') {
          const clientId = url.searchParams.get('client_id') ?? '';
          const redirectUri = url.searchParams.get('redirect_uri') ?? '';
          const client = clients.get(clientId);
          if (!client || !client.redirectUris.includes(redirectUri)) {
            return json(res, 400, { error: 'invalid_request' });
          }
          if (url.searchParams.get('code_challenge_method') !== 'S256') {
            return json(res, 400, { error: 'invalid_request', error_description: 'S256 required' });
          }
          const code = `code_${randomBytes(8).toString('hex')}`;
          codes.set(code, { challenge: url.searchParams.get('code_challenge') ?? '', clientId, redirectUri });
          const location = new URL(redirectUri);
          location.searchParams.set('code', code);
          location.searchParams.set('state', url.searchParams.get('state') ?? '');
          location.searchParams.set('iss', origin);
          res.writeHead(302, { location: location.toString() });
          return res.end();
        }
        if (url.pathname === '/token' && req.method === 'POST') {
          const form = new URLSearchParams(await readBody(req));
          if (form.get('grant_type') === 'authorization_code') {
            const pending = codes.get(form.get('code') ?? '');
            codes.delete(form.get('code') ?? '');
            if (
              !pending
              || pending.clientId !== form.get('client_id')
              || pending.redirectUri !== form.get('redirect_uri')
              || base64UrlSha256(form.get('code_verifier') ?? '') !== pending.challenge
            ) {
              return json(res, 400, { error: 'invalid_grant' });
            }
            return json(res, 200, issueTokens());
          }
          if (form.get('grant_type') === 'refresh_token') {
            const refresh = form.get('refresh_token') ?? '';
            if (!refreshTokens.has(refresh)) {
              return json(res, 400, { error: 'invalid_grant' });
            }
            refreshTokens.delete(refresh);
            oauthStats.refreshes += 1;
            return json(res, 200, issueTokens());
          }
          return json(res, 400, { error: 'unsupported_grant_type' });
        }
      }

      if (url.pathname !== '/mcp') {
        return json(res, 404, { error: 'not found' });
      }

      const authorization = req.headers.authorization;
      if (authorization) authorizationHeaders.push(authorization);
      if (auth.type === 'bearer' && authorization !== `Bearer ${auth.token}`) {
        return json(res, 401, { error: 'unauthorized' });
      }
      if (auth.type === 'oauth') {
        const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
        if (!accessTokens.has(token)) {
          return json(res, 401, { error: 'invalid_token' }, {
            'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
          });
        }
      }

      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' });
        return res.end();
      }
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      const mcp = buildMcpServer(calls, authorization);
      res.on('close', () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    })().catch((error: unknown) => {
      if (!res.headersSent) {
        json(res, 500, { error: error instanceof Error ? error.message : String(error) });
      }
    });
  });

  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = httpServer.address() as AddressInfo;
  origin = `http://127.0.0.1:${port}`;

  return {
    url: `${origin}/mcp`,
    origin,
    calls,
    authorizationHeaders,
    oauth: {
      get registrations() {
        return oauthStats.registrations;
      },
      get refreshes() {
        return oauthStats.refreshes;
      },
      issuedAccessTokens,
      async authorize(authorizationUrl: string): Promise<URL> {
        const response = await fetch(authorizationUrl, { redirect: 'manual' });
        const location = response.headers.get('location');
        if (response.status !== 302 || !location) {
          throw new Error(`authorize did not redirect: ${response.status} ${await response.text()}`);
        }
        return new URL(location);
      },
      expireAccessTokens() {
        accessTokens.clear();
      },
    },
    close: () => new Promise<void>((resolve, reject) => {
      httpServer.closeAllConnections();
      httpServer.close((error) => (error ? reject(error) : resolve()));
    }),
  };
}
