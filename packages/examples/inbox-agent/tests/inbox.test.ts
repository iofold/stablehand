import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { loadManifestProject } from '@stablehand/manifest/node';
import { describe, expect, it } from 'vitest';

import { interpolateTemplate } from '../../../stablehand/src/events/triggers.js';
import { sendEmailTool, taskTemplate, THREAD_KEY } from '../seed.ts';
import { parseEml, threadIdOf, toInboxPayload, type InboxEmailPayload } from '../send-email.ts';

interface SpanReport {
  ok: boolean;
  rows: Array<{ field: string; value: string; quote: string; line: number }>;
  issues: Array<{ field: string | null; problem: string }>;
  table?: { title: string; columns: Array<{ key: string; label: string }>; data: Array<Record<string, unknown>> };
}

const EMAILS_DIR = fileURLToPath(new URL('../emails/', import.meta.url));
const CONFIG = {
  campaign: 'inbox-agent',
  eventType: 'custom.inbox.email',
  replyFrom: { name: 'Fernway Support', email: 'support@fernway.example' },
  mail: { provider: 'mailpit', mailpitUrl: 'http://mailpit:8025', resendUrl: 'https://api.resend.com/emails' },
  budget: { weeklyUsd: 2, weeklyRuns: 60 },
};

async function checkSpans(email: string, fields: unknown): Promise<SpanReport> {
  const module = await import('../agent/tools/spans.mjs') as { checkSpans: (text: string, input: unknown) => SpanReport };
  return module.checkSpans(email, fields);
}

async function loadEmails(): Promise<Map<string, InboxEmailPayload>> {
  const names = (await readdir(EMAILS_DIR)).filter((name) => name.endsWith('.eml')).sort();
  const emails = new Map<string, InboxEmailPayload>();
  for (const name of names) {
    emails.set(name, toInboxPayload(parseEml(await readFile(`${EMAILS_DIR}${name}`, 'utf8'))));
  }
  return emails;
}

describe('inbox agent manifest', () => {
  it('compiles into a capped agent that can run in the background and in chat', async () => {
    const project = await loadManifestProject(fileURLToPath(new URL('../agent/agent.yaml', import.meta.url)));
    const input = project.agentCreateInput;
    expect(input.name).toBe('inbox-agent');
    expect(input.mode).toBe('both');
    expect(input.tools).toEqual(['edit_document']);
    expect(input.metadata).toMatchObject({ defaultTags: { campaign: 'inbox-agent' } });
    expect((input.harnessConfig as { limits?: { maxCostUsd?: number } }).limits?.maxCostUsd).toBe(0.25);
    expect(project.workspace.files.map((file) => file.destinationPath).sort()).toEqual([
      'playbook/replies.md',
      'tools/spans.mjs',
    ]);
  });
});

describe('synthetic emails', () => {
  it('ships eight invented emails on reserved example domains', async () => {
    const emails = await loadEmails();
    expect(emails.size).toBe(8);
    for (const [name, raw] of await Promise.all((await readdir(EMAILS_DIR)).map(async (file) => (
      [file, await readFile(`${EMAILS_DIR}${file}`, 'utf8')] as const
    )))) {
      expect(raw, name).toContain('X-Synthetic: Fernway demo');
      for (const address of raw.match(/[\w.+-]+@[\w.-]+/g) ?? []) {
        expect(address, `${name}: ${address}`).toMatch(/@(example\.(com|org|net)|[\w-]+\.example)$/);
      }
    }
  });

  it('keys replies to the first message of their thread', async () => {
    const emails = await loadEmails();
    const first = emails.get('01-late-delivery.eml')!;
    const reply = emails.get('07-late-delivery-reply.eml')!;
    expect(first.threadId).toBe(first.messageId);
    expect(reply.threadId).toBe(first.messageId);
    expect(emails.get('08-brake-repair-reply.eml')!.threadId).toBe(emails.get('04-brake-repair.eml')!.messageId);
    expect(new Set([...emails.values()].map((email) => email.threadId)).size).toBe(6);

    expect(reply.reply).toEqual({
      to: 'maya.lindqvist@example.com',
      subject: 'Re: Where is my bike? Order FW-10482',
      inReplyTo: '<fw10482.maya.2@example.com>',
      references: '<fw10482.maya@example.com> <reply.fw10482@fernway.example> <fw10482.maya.2@example.com>',
    });
    expect(first.reply.subject).toBe('Re: Where is my bike? Order FW-10482');
    expect(first.fromName).toBe('Maya Lindqvist');
  });

  it('reads folded headers and CRLF line endings', () => {
    const parsed = parseEml('Subject: a long\r\n subject line\r\nMessage-ID: <x@example.com>\r\nFrom: a@example.com\r\n\r\nBody\r\n');
    expect(parsed.headers.subject).toBe('a long subject line');
    expect(parsed.body).toBe('Body\n');
    expect(threadIdOf(parsed.headers)).toBe('<x@example.com>');
    expect(() => toInboxPayload(parseEml('From: a@example.com\n\nno id'))).toThrow('Message-ID');
  });
});

describe('quote checker', () => {
  it('finds each quote and the line it starts on, across line breaks and quote styles', async () => {
    const email = (await loadEmails()).get('01-late-delivery.eml')!.text;
    const report = await checkSpans(email, [
      { field: 'Needed by', value: 'Monday 26 October', quote: 'I need the bike for my commute from Monday 26 October' },
      { field: 'Order number', value: 'FW-10482', quote: 'order FW-10482' },
      { field: 'Tracking status', value: 'preparing', quote: 'tracking page still says “preparing”' },
      { field: 'Promised delivery', value: '5 working days', quote: 'delivery within 5 working\ndays' },
    ]);
    expect(report.issues).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.rows.map((row) => [row.field, row.line])).toEqual([
      ['Order number', 3],
      ['Promised delivery', 4],
      ['Tracking status', 5],
      ['Needed by', 7],
    ]);
    expect(report.table).toMatchObject({
      columns: [
        { key: 'field', label: 'Field' },
        { key: 'value', label: 'Value' },
        { key: 'quote', label: 'Quoted from the email' },
        { key: 'line', label: 'Line' },
      ],
    });
    expect(report.table?.data[0]).toEqual({ field: 'Order number', value: 'FW-10482', quote: '"order FW-10482"', line: 3 });
  });

  it('refuses quotes the email does not contain and empty entries', async () => {
    const email = (await loadEmails()).get('02-charged-twice.eml')!.text;
    const report = await checkSpans(email, [
      { field: 'Amount', value: '39.00 EUR', quote: 'charged 39.00 EUR twice' },
      { field: 'Invoice', value: 'INV-9999', quote: 'invoice INV-9999' },
      { field: 'Card', value: '', quote: 'card' },
      { field: 'Plan', value: 'City 2', quote: '' },
    ]);
    expect(report.ok).toBe(false);
    expect(report.rows.map((row) => row.field)).toEqual(['Amount']);
    expect(report.issues.map((issue) => issue.field)).toEqual(['Invoice', 'Card', 'Plan']);
    expect((await checkSpans(email, { not: 'a list' })).ok).toBe(false);
  });
});

describe('seed definitions', () => {
  it('builds a send tool that always asks first, for Mailpit or an HTTP mail API', () => {
    const mailpit = sendEmailTool('mailpit', CONFIG, 'http://mailpit:8025/');
    expect(mailpit).toMatchObject({
      name: 'send_email',
      endpoint: 'http://mailpit:8025/api/v1/send',
      method: 'POST',
      requiresApproval: true,
    });
    expect(mailpit.authentication).toBeUndefined();
    expect(Object.keys((mailpit.inputSchema as { properties: Record<string, unknown> }).properties))
      .toEqual(['From', 'To', 'Subject', 'Text', 'Headers']);

    const resend = sendEmailTool('resend', CONFIG, 'unused');
    expect(resend).toMatchObject({
      endpoint: 'https://api.resend.com/emails',
      authentication: { type: 'bearer', secretName: 'MAIL_API_KEY' },
      requiresApproval: true,
    });
    expect(() => sendEmailTool('smtp', CONFIG, 'unused')).toThrow('mailpit or resend');
  });

  it('renders a task with the email body and the headers the reply must carry', async () => {
    const reply = (await loadEmails()).get('07-late-delivery-reply.eml')!;
    const task = interpolateTemplate(taskTemplate(CONFIG.replyFrom), reply as unknown as Record<string, unknown>);
    expect(task).not.toContain('{{');
    expect(task).toContain('from: Fernway Support <support@fernway.example>');
    expect(task).toContain('to: maya.lindqvist@example.com');
    expect(task).toContain('In-Reply-To: <fw10482.maya.2@example.com>');
    expect(task).toContain('References: <fw10482.maya@example.com> <reply.fw10482@fernway.example> <fw10482.maya.2@example.com>');
    expect(task).toContain('Could the courier bring the bike to my office');
    expect(THREAD_KEY).toBe('{{payload.threadId}}');
  });
});
