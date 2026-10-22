/**
 * A tiny stand-in for Granola's hosted MCP server, serving the synthetic
 * meetings in notes.json. It speaks MCP over Streamable HTTP (JSON responses,
 * no sessions) with the tool names Granola uses, so the notes-miner agent
 * works unchanged when you switch to the real server.
 *
 * No dependencies. Run it with:
 *   node --experimental-strip-types packages/examples/content-factory/notes-mcp/server.ts
 *
 * Environment:
 *   PORT              listen port (default 8787)
 *   HOST              listen address (default 0.0.0.0)
 *   NOTES_MCP_TOKEN   when set, requests must send `Authorization: Bearer <token>`
 */
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

interface Meeting {
  id: string;
  title: string;
  daysAgo: number;
  attendees: string[];
  privateNotes: string;
  summary: string;
  transcript: string;
}

interface NotesFile {
  notice: string;
  workspace: string;
  meetings: Meeting[];
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const DAY_MS = 24 * 60 * 60 * 1000;

const TOOLS = [
  {
    name: 'list_meetings',
    title: 'List meetings',
    description: 'List meeting notes in a time range, with id, title, date and attendees.',
    inputSchema: {
      type: 'object',
      properties: {
        time_range: {
          type: 'string',
          enum: ['this_week', 'last_week', 'last_30_days'],
          description: 'this_week = the last 7 days',
        },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'get_meetings',
    title: 'Get meetings',
    description: 'Read the private notes, summary and attendees of one or more meetings.',
    inputSchema: {
      type: 'object',
      properties: {
        meeting_ids: { type: 'array', items: { type: 'string' }, description: 'Ids from list_meetings' },
      },
      required: ['meeting_ids'],
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'get_meeting_transcript',
    title: 'Get meeting transcript',
    description: 'Read the raw transcript of one meeting.',
    inputSchema: {
      type: 'object',
      properties: { meeting_id: { type: 'string' } },
      required: ['meeting_id'],
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
];

export function loadNotes(path = fileURLToPath(new URL('./notes.json', import.meta.url))): NotesFile {
  return JSON.parse(readFileSync(path, 'utf8')) as NotesFile;
}

function meetingDate(meeting: Meeting, now: number): string {
  return new Date(now - meeting.daysAgo * DAY_MS).toISOString().slice(0, 10);
}

function inRange(meeting: Meeting, range: unknown): boolean {
  if (range === 'last_week') return meeting.daysAgo >= 7 && meeting.daysAgo < 14;
  if (range === 'last_30_days') return meeting.daysAgo < 30;
  return meeting.daysAgo < 7;
}

function text(value: unknown) {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}

function callTool(notes: NotesFile, name: unknown, args: Record<string, unknown>, now: number) {
  const byId = new Map(notes.meetings.map((meeting) => [meeting.id, meeting]));
  switch (name) {
    case 'list_meetings':
      return text({
        notice: notes.notice,
        meetings: notes.meetings
          .filter((meeting) => inRange(meeting, args.time_range))
          .map((meeting) => ({
            id: meeting.id,
            title: meeting.title,
            date: meetingDate(meeting, now),
            attendees: meeting.attendees,
          })),
      });
    case 'get_meetings': {
      const ids = Array.isArray(args.meeting_ids) ? args.meeting_ids : [];
      const found = ids.flatMap((id) => {
        const meeting = byId.get(String(id));
        return meeting
          ? [{
            id: meeting.id,
            title: meeting.title,
            date: meetingDate(meeting, now),
            attendees: meeting.attendees,
            private_notes: meeting.privateNotes,
            summary: meeting.summary,
          }]
          : [];
      });
      return found.length > 0
        ? text({ notice: notes.notice, meetings: found })
        : { isError: true, content: [{ type: 'text', text: 'No meetings with those ids' }] };
    }
    case 'get_meeting_transcript': {
      const meeting = byId.get(String(args.meeting_id));
      return meeting
        ? text(`${notes.notice}\n\n${meeting.title} (${meetingDate(meeting, now)})\n\n${meeting.transcript}`)
        : { isError: true, content: [{ type: 'text', text: `No meeting ${String(args.meeting_id)}` }] };
    }
    default:
      return { isError: true, content: [{ type: 'text', text: `Unknown tool ${String(name)}` }] };
  }
}

function handleMessage(notes: NotesFile, message: JsonRpcRequest): Record<string, unknown> | undefined {
  // Notifications (no id) get no response.
  if (message.id === undefined || message.id === null) return undefined;
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id: message.id, result });
  switch (message.method) {
    case 'initialize': {
      const requested = message.params?.protocolVersion;
      const protocolVersion = typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : SUPPORTED_PROTOCOL_VERSIONS[0];
      return reply({
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'content-factory-notes', version: '1.0.0' },
        instructions: notes.notice,
      });
    }
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'tools/call': {
      const args = (message.params?.arguments ?? {}) as Record<string, unknown>;
      return reply(callTool(notes, message.params?.name, args, Date.now()));
    }
    default:
      return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Method not found: ${String(message.method)}` } };
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function send(res: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    res.writeHead(status);
    res.end();
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

export interface NotesServerOptions {
  port?: number;
  host?: string;
  token?: string;
  notes?: NotesFile;
}

export interface NotesServerHandle {
  url: string;
  server: Server;
  close(): Promise<void>;
}

export async function startNotesServer(options: NotesServerOptions = {}): Promise<NotesServerHandle> {
  const notes = options.notes ?? loadNotes();
  const server = createServer((req, res) => {
    void (async () => {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (path === '/healthz') return send(res, 200, { ok: true });
      if (path !== '/mcp') return send(res, 404, { error: 'not found' });
      if (options.token && req.headers.authorization !== `Bearer ${options.token}`) {
        return send(res, 401, { error: 'unauthorized' });
      }
      if (req.method !== 'POST') {
        res.setHeader('allow', 'POST');
        return send(res, 405);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readBody(req));
      } catch {
        return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      }
      const messages = Array.isArray(parsed) ? parsed as JsonRpcRequest[] : [parsed as JsonRpcRequest];
      const replies = messages.flatMap((message) => {
        const reply = handleMessage(notes, message);
        return reply ? [reply] : [];
      });
      if (replies.length === 0) return send(res, 202);
      return send(res, 200, Array.isArray(parsed) ? replies : replies[0]);
    })().catch((error: unknown) => {
      if (!res.headersSent) send(res, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });
  await new Promise<void>((resolve) => server.listen(options.port ?? 8787, options.host ?? '0.0.0.0', resolve));
  const { port } = server.address() as AddressInfo;
  const host = options.host && options.host !== '0.0.0.0' ? options.host : '127.0.0.1';
  return {
    url: `http://${host}:${port}/mcp`,
    server,
    close: () => new Promise<void>((resolve, reject) => {
      server.closeAllConnections();
      server.close((error) => (error ? reject(error) : resolve()));
    }),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const handle = await startNotesServer({
    port: Number(process.env.PORT ?? 8787),
    host: process.env.HOST ?? '0.0.0.0',
    ...(process.env.NOTES_MCP_TOKEN ? { token: process.env.NOTES_MCP_TOKEN } : {}),
  });
  console.log(`notes MCP stand-in serving synthetic meetings at ${handle.url}`);
}
