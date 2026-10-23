#!/usr/bin/env -S node --experimental-strip-types

/**
 * Deliver emails to the inbox agent: each .eml file becomes one
 * custom.inbox.email event on POST /api/triggers/emit, which starts one run.
 * This is what a mail provider's inbound webhook would do.
 *
 *   node --experimental-strip-types send-email.ts                 # the six first emails
 *   node --experimental-strip-types send-email.ts --follow-ups    # the two replies
 *   node --experimental-strip-types send-email.ts path/to/a.eml   # any plain-text .eml
 *
 * Environment:
 *   API_URL              Stablehand API (default http://localhost:3002)
 *   INBOX_WEBHOOK_KEY    the scoped key the seed printed (can only emit custom.inbox.*)
 *   STABLEHAND_API_TOKEN used when INBOX_WEBHOOK_KEY is not set
 *   INBOX_EVENT          event type (default custom.inbox.email)
 *   MAILPIT_COPY_TO      e.g. http://localhost:8025: also drop each email into
 *                        Mailpit, so its inbox shows both sides of the thread
 */

import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ── Reading plain-text .eml files ─────────────────────────────────────

export interface ParsedEmail {
  headers: Record<string, string>;
  body: string;
}

export interface InboxEmailPayload {
  messageId: string;
  /** The first message of the thread: the key that keeps a thread in one conversation. */
  threadId: string;
  from: string;
  fromName: string;
  fromAddress: string;
  to: string;
  subject: string;
  date: string;
  text: string;
  /** What the agent's reply must carry to land in the same thread in the customer's mail app. */
  reply: {
    to: string;
    subject: string;
    inReplyTo: string;
    references: string;
  };
}

/** Parse headers (unfolding continuation lines) and the body of a plain-text email. */
export function parseEml(raw: string): ParsedEmail {
  const text = raw.replace(/\r\n/g, '\n');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const body = split === -1 ? '' : text.slice(split + 2);
  const headers: Record<string, string> = {};
  let current: string | undefined;
  for (const line of head.split('\n')) {
    if (/^[ \t]/.test(line) && current) {
      headers[current] = `${headers[current]} ${line.trim()}`;
      continue;
    }
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    current = line.slice(0, colon).trim().toLowerCase();
    headers[current] = line.slice(colon + 1).trim();
  }
  return { headers, body: body.replace(/\s+$/, '\n') };
}

/** "Maya Lindqvist <maya@example.com>" -> name and address. */
export function parseAddress(value: string): { name: string; address: string } {
  const angle = /^(.*)<([^>]+)>\s*$/.exec(value.trim());
  if (angle) {
    return { name: (angle[1] ?? '').trim().replace(/^"|"$/g, ''), address: (angle[2] ?? '').trim() };
  }
  return { name: '', address: value.trim() };
}

/** Message-IDs in a References or In-Reply-To header, in order. */
export function messageIds(value: string | undefined): string[] {
  return value?.match(/<[^<>\s]+>/g) ?? [];
}

/**
 * The thread an email belongs to: the first id in References, else
 * In-Reply-To, else the email's own Message-ID.
 */
export function threadIdOf(headers: Record<string, string>): string {
  const [root] = messageIds(headers.references);
  if (root) return root;
  const [parent] = messageIds(headers['in-reply-to']);
  if (parent) return parent;
  const own = messageIds(headers['message-id'])[0];
  if (!own) throw new Error('email has no Message-ID header');
  return own;
}

export function toInboxPayload(email: ParsedEmail): InboxEmailPayload {
  const { headers } = email;
  const messageId = messageIds(headers['message-id'])[0];
  if (!messageId) throw new Error('email has no Message-ID header');
  const from = headers.from;
  if (!from) throw new Error('email has no From header');
  const sender = parseAddress(from);
  const subject = headers.subject ?? '(no subject)';
  const references = [...new Set([...messageIds(headers.references), messageId])];
  return {
    messageId,
    threadId: threadIdOf(headers),
    from,
    fromName: sender.name || sender.address,
    fromAddress: sender.address,
    to: headers.to ?? '',
    subject,
    date: headers.date ?? '',
    text: email.body,
    reply: {
      to: sender.address,
      subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
      inReplyTo: messageId,
      references: references.join(' '),
    },
  };
}

// ── Sending ───────────────────────────────────────────────────────────

const API_BASE = process.env.API_URL ?? 'http://localhost:3002';
const TOKEN = process.env.INBOX_WEBHOOK_KEY ?? process.env.STABLEHAND_API_TOKEN;
const EVENT_TYPE = process.env.INBOX_EVENT ?? 'custom.inbox.email';
const MAILPIT_COPY_TO = process.env.MAILPIT_COPY_TO;
const EMAILS_DIR = fileURLToPath(new URL('./emails/', import.meta.url));

async function bundledEmails(followUps: boolean): Promise<string[]> {
  const names = (await readdir(EMAILS_DIR)).filter((name) => name.endsWith('.eml')).sort();
  const picked: string[] = [];
  for (const name of names) {
    const path = join(EMAILS_DIR, name);
    const isReply = Boolean(parseEml(await readFile(path, 'utf8')).headers['in-reply-to']);
    if (isReply === followUps) picked.push(path);
  }
  return picked;
}

async function emit(payload: InboxEmailPayload): Promise<void> {
  const res = await fetch(`${API_BASE}/api/triggers/emit`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
    },
    body: JSON.stringify({ type: EVENT_TYPE, payload }),
  });
  if (!res.ok) {
    throw new Error(`POST /api/triggers/emit -> HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
}

/** Put the customer's email in Mailpit too. A failure here is reported and skipped. */
async function copyToMailpit(payload: InboxEmailPayload): Promise<void> {
  if (!MAILPIT_COPY_TO) return;
  const to = parseAddress(payload.to);
  const res = await fetch(`${MAILPIT_COPY_TO.replace(/\/$/, '')}/api/v1/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      From: { Email: payload.fromAddress, Name: payload.fromName },
      To: [{ Email: to.address, Name: to.name }],
      Subject: payload.subject,
      Text: payload.text,
      Headers: {
        'Message-ID': payload.messageId,
        ...(payload.reply.references !== payload.messageId
          ? { References: payload.reply.references.replace(` ${payload.messageId}`, '') }
          : {}),
      },
    }),
  });
  if (!res.ok) {
    console.warn(`  could not copy it to Mailpit (HTTP ${res.status}): ${(await res.text()).slice(0, 200)}`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const followUps = args.includes('--follow-ups');
  const paths = args.filter((arg) => !arg.startsWith('--'));
  const files = paths.length > 0 ? paths : await bundledEmails(followUps);
  if (files.length === 0) throw new Error('no .eml files to send');

  console.log(`Sending ${files.length} email(s) to ${API_BASE} as ${EVENT_TYPE}`);
  for (const file of files) {
    const payload = toInboxPayload(parseEml(await readFile(file, 'utf8')));
    await emit(payload);
    await copyToMailpit(payload);
    console.log(`  ${basename(file)}: "${payload.subject}" from ${payload.fromAddress} (thread ${payload.threadId})`);
  }
  console.log('Each email starts its own run. Open inbox-agent in the dashboard to review the drafts.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error('Send failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
