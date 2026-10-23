#!/usr/bin/env -S node --experimental-strip-types

/**
 * Seed the inbox agent against a running Stablehand: the agent from agent/,
 * its send_email tool (asks for approval on every call), the trigger that
 * turns each custom.inbox.email event into a run and keeps a thread in one
 * conversation, a weekly budget, and a key that can only deliver emails.
 * Safe to re-run: it updates what exists.
 *
 * Environment:
 *   API_URL               Stablehand API (default http://localhost:3002)
 *   STABLEHAND_API_TOKEN  master API token (unless auth is disabled)
 *   INBOX_CONFIG          config file (default ./inbox.config.json)
 *   MAIL_PROVIDER         mailpit (default, a local test inbox) or resend
 *   MAILPIT_API           Mailpit as the orchestrator reaches it (default http://mailpit:8025)
 *   MAIL_API_KEY          Resend API key, stored as a tools-only secret
 *   REPLY_FROM_EMAIL      address replies come from (default from the config)
 *   REPLY_FROM_NAME       name replies come from (default from the config)
 *   INBOX_WEBHOOK_KEY=off skip creating the scoped key for delivering emails
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createWorkspaceArchive, loadManifestProject } from '@stablehand/manifest/node';

interface InboxConfig {
  campaign: string;
  eventType: string;
  replyFrom: { name: string; email: string };
  mail: { provider: string; mailpitUrl: string; resendUrl: string };
  budget: { weeklyUsd: number; weeklyRuns: number };
}

interface HttpToolDefinition {
  name: string;
  description: string;
  endpoint: string;
  method: 'POST';
  inputSchema: Record<string, unknown>;
  authentication?: { type: 'bearer'; secretName: string };
  requiresApproval: true;
  timeoutMs: number;
}

const API_BASE = process.env.API_URL ?? 'http://localhost:3002';
const API_TOKEN = process.env.STABLEHAND_API_TOKEN;
const CONFIG_PATH = process.env.INBOX_CONFIG
  ?? fileURLToPath(new URL('./inbox.config.json', import.meta.url));
const MANIFEST_PATH = fileURLToPath(new URL('./agent/agent.yaml', import.meta.url));
const WEBHOOK_KEY_NAME = 'inbox-webhook';

export const THREAD_KEY = '{{payload.threadId}}';

function headers(json = true): Record<string, string> {
  return {
    ...(API_TOKEN ? { Authorization: `Bearer ${API_TOKEN}` } : {}),
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  };
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { ...headers(init.body !== undefined && !(init.body instanceof Blob)), ...(init.headers ?? {}) },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${init.method ?? 'GET'} ${path} -> HTTP ${res.status}: ${text.slice(0, 400)}`);
  }
  return (text ? JSON.parse(text) : null) as T;
}

function post<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: 'POST', body: JSON.stringify(body) });
}

function patch<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
}

async function loadConfig(): Promise<InboxConfig> {
  return JSON.parse(await readFile(CONFIG_PATH, 'utf8')) as InboxConfig;
}

const ADDRESS = {
  type: 'object',
  properties: { Email: { type: 'string' }, Name: { type: 'string' } },
  required: ['Email'],
};

const REPLY_HEADERS_DESCRIPTION = 'In-Reply-To and References exactly as given in the task, so the reply lands in the same thread';

/** The send tool for the chosen provider. Every call waits for a person's approval. */
export function sendEmailTool(provider: string, config: InboxConfig, mailpitApi: string): HttpToolDefinition {
  if (provider === 'mailpit') {
    return {
      name: 'send_email',
      description: 'Send one approved reply. A person approves this exact message before it goes out. '
        + 'Delivers to Mailpit, a local test inbox. Example body: {"From": {"Email": "support@fernway.example", '
        + '"Name": "Fernway Support"}, "To": [{"Email": "customer@example.com"}], "Subject": "Re: ...", '
        + '"Text": "...", "Headers": {"In-Reply-To": "<id>", "References": "<id> <id>"}}',
      endpoint: `${mailpitApi.replace(/\/$/, '')}/api/v1/send`,
      method: 'POST',
      inputSchema: {
        type: 'object',
        properties: {
          From: ADDRESS,
          To: { type: 'array', items: ADDRESS },
          Subject: { type: 'string' },
          Text: { type: 'string', description: 'The approved reply, exactly as approved' },
          Headers: {
            type: 'object',
            description: REPLY_HEADERS_DESCRIPTION,
            properties: { 'In-Reply-To': { type: 'string' }, References: { type: 'string' } },
          },
        },
        required: ['From', 'To', 'Subject', 'Text'],
      },
      requiresApproval: true,
      timeoutMs: 15_000,
    };
  }
  if (provider === 'resend') {
    return {
      name: 'send_email',
      description: 'Send one approved reply. A person approves this exact message before it goes out. '
        + 'Delivers through the Resend email API. Example body: {"from": "Fernway Support <support@fernway.example>", '
        + '"to": ["customer@example.com"], "subject": "Re: ...", "text": "...", '
        + '"headers": {"In-Reply-To": "<id>", "References": "<id> <id>"}}',
      endpoint: config.mail.resendUrl,
      method: 'POST',
      inputSchema: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'Name <address>' },
          to: { type: 'array', items: { type: 'string' } },
          subject: { type: 'string' },
          text: { type: 'string', description: 'The approved reply, exactly as approved' },
          headers: {
            type: 'object',
            description: REPLY_HEADERS_DESCRIPTION,
            properties: { 'In-Reply-To': { type: 'string' }, References: { type: 'string' } },
          },
        },
        required: ['from', 'to', 'subject', 'text'],
      },
      authentication: { type: 'bearer', secretName: 'MAIL_API_KEY' },
      requiresApproval: true,
      timeoutMs: 15_000,
    };
  }
  throw new Error(`MAIL_PROVIDER must be mailpit or resend (got ${provider})`);
}

/** The run's task: the email and the headers its reply must carry. */
export function taskTemplate(replyFrom: { name: string; email: string }): string {
  return [
    'New email in the support inbox.',
    '',
    'From: {{payload.from}}',
    'Date: {{payload.date}}',
    'Subject: {{payload.subject}}',
    'Message-ID: {{payload.messageId}}',
    '',
    'Reply with these values:',
    `from: ${replyFrom.name} <${replyFrom.email}>`,
    'to: {{payload.reply.to}}',
    'subject: {{payload.reply.subject}}',
    'In-Reply-To: {{payload.reply.inReplyTo}}',
    'References: {{payload.reply.references}}',
    '',
    '----- email body -----',
    '{{payload.text}}',
    '----- end of email body -----',
  ].join('\n');
}

async function upsertAgent(): Promise<{ id: string; name: string }> {
  const project = await loadManifestProject(MANIFEST_PATH);
  const payload = project.agentCreateInput;
  const listed = await request<Array<{ id: string; name: string }>>('/api/agents');
  const existingId = listed.find((agent) => agent.name === payload.name)?.id;
  const saved = existingId
    ? await patch<{ id: string }>(`/api/agents/${existingId}`, payload)
    : await post<{ id: string }>('/api/agents', payload);
  console.log(`  ${existingId ? 'updated' : 'created'} ${payload.name}`);
  if (project.workspace.fileCount > 0) {
    const archive = await createWorkspaceArchive(project.workspace);
    await request(`/api/agents/${saved.id}/workspace`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/gzip', 'Content-Encoding': 'gzip' },
      body: new Blob([new Uint8Array(archive)]),
    });
    console.log(`    workspace: ${project.workspace.fileCount} files (playbook, quote checker)`);
  }
  return { id: saved.id, name: payload.name };
}

async function ensureTrigger(agentId: string, eventType: string, template: string): Promise<void> {
  const triggers = await request<Array<{ id: string; agentId: string; eventType: string }>>('/api/triggers');
  const existing = triggers.find((trigger) => trigger.agentId === agentId && trigger.eventType === eventType);
  const body = { taskTemplate: template, conversationKey: THREAD_KEY, enabled: true };
  const saved = existing
    ? await request<{ conversationKey?: string }>(`/api/triggers/${existing.id}`, { method: 'PUT', body: JSON.stringify(body) })
    : await post<{ conversationKey?: string }>('/api/triggers', { agentId, eventType, ...body });
  if (saved.conversationKey !== THREAD_KEY) {
    throw new Error('this Stablehand ignored the trigger\'s conversationKey, so replies would start new conversations. '
      + 'Update Stablehand to a version with trigger conversation keys.');
  }
  console.log(`  ${eventType} -> inbox-agent, one conversation per ${THREAD_KEY}`);
}

async function ensureBudget(config: InboxConfig): Promise<void> {
  const name = `${config.campaign} weekly budget`;
  const doc = {
    selector: { campaign: config.campaign },
    window: 'rolling-7d',
    limits: { costUsd: config.budget.weeklyUsd, turns: config.budget.weeklyRuns },
    actions: [
      { threshold: 0.5, action: 'warn' },
      { threshold: 1, action: 'block' },
    ],
  };
  const { policies } = await request<{ policies: Array<{ id: string; name: string }> }>('/api/budgets');
  const existing = policies.find((policy) => policy.name === name);
  if (existing) {
    await patch(`/api/budgets/${existing.id}`, { doc, enabled: true });
  } else {
    await post('/api/budgets', { name, enabled: true, doc });
  }
  console.log(`  ${name}: $${config.budget.weeklyUsd} and ${config.budget.weeklyRuns} runs per rolling 7 days, warn at 50%, block at 100%`);
}

async function ensureWebhookKey(eventType: string): Promise<void> {
  if (process.env.INBOX_WEBHOOK_KEY === 'off') return;
  const prefix = eventType.slice(0, eventType.lastIndexOf('.') + 1);
  const capability = `triggers:emit:${prefix}*`;
  const { keys } = await request<{ keys: Array<{ name: string; status: string }> }>('/api/keys');
  const mine = keys.filter((key) => key.name === WEBHOOK_KEY_NAME || key.name.startsWith(`${WEBHOOK_KEY_NAME}-`));
  if (mine.some((key) => key.status === 'active')) {
    console.log(`  ${WEBHOOK_KEY_NAME} exists; its secret was shown once when it was created.`);
    return;
  }
  // Key names stay taken after revocation, so pick a fresh one when needed.
  const name = mine.length > 0 ? `${WEBHOOK_KEY_NAME}-${Date.now()}` : WEBHOOK_KEY_NAME;
  const created = await post<{ token: string }>('/api/keys', {
    name,
    capabilities: [capability],
    note: 'Delivers emails to the inbox agent (created by its seed). Can emit custom.inbox.* events and nothing else.',
    expiresAt: null,
  });
  console.log(`  created ${name}: it can deliver ${prefix}* events and nothing else. Shown once:`);
  console.log(`INBOX_WEBHOOK_KEY=${created.token}`);
}

async function seed(): Promise<void> {
  const config = await loadConfig();
  const provider = process.env.MAIL_PROVIDER ?? config.mail.provider;
  const mailpitApi = process.env.MAILPIT_API ?? config.mail.mailpitUrl;
  const replyFrom = {
    name: process.env.REPLY_FROM_NAME ?? config.replyFrom.name,
    email: process.env.REPLY_FROM_EMAIL ?? config.replyFrom.email,
  };
  const tool = sendEmailTool(provider, config, mailpitApi);
  console.log(`\nSeeding the inbox agent against ${API_BASE}\n`);

  console.log('Agent');
  const agent = await upsertAgent();

  console.log('\nSending');
  if (provider === 'resend') {
    const key = process.env.MAIL_API_KEY;
    if (!key) throw new Error('MAIL_PROVIDER=resend needs MAIL_API_KEY');
    await post(`/api/agents/${agent.id}/secrets`, { key: 'MAIL_API_KEY', value: key, scope: 'tools' });
    console.log('  stored MAIL_API_KEY (tools only, never in the sandbox)');
  }
  await patch(`/api/agents/${agent.id}`, { httpTools: [tool] });
  console.log(`  send_email -> ${tool.endpoint}, asks for approval on every call`);
  console.log(`  replies come from ${replyFrom.name} <${replyFrom.email}>`);

  console.log('\nTrigger');
  await ensureTrigger(agent.id, config.eventType, taskTemplate(replyFrom));

  console.log('\nBudget');
  await ensureBudget(config);

  console.log('\nKey for delivering emails');
  await ensureWebhookKey(config.eventType);

  console.log('\nSeed complete. Deliver the sample emails with send-email.ts; each one starts a run.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  seed().catch((error: unknown) => {
    console.error('Seed failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
