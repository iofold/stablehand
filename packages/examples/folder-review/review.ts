#!/usr/bin/env -S node --experimental-strip-types

/**
 * Start a folder review or ask a follow-up question about one. Both are
 * events with the same reviewId, so they run in the same conversation.
 *
 *   node --experimental-strip-types review.ts start
 *   node --experimental-strip-types review.ts ask "Which contracts renew on their own?"
 *   node --experimental-strip-types review.ts ask --review q4-binder "..."
 *
 * Environment:
 *   API_URL               Stablehand API (default http://localhost:3002)
 *   STABLEHAND_API_TOKEN  API token, or a key that can emit custom.review.* events
 *   REVIEW_CONFIG         config file (default ./review.config.json)
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

interface ReviewConfig {
  reviewId: string;
  request: string;
  events: { start: string; question: string };
}

const API_BASE = process.env.API_URL ?? 'http://localhost:3002';
const API_TOKEN = process.env.STABLEHAND_API_TOKEN;
const CONFIG_PATH = process.env.REVIEW_CONFIG
  ?? fileURLToPath(new URL('./review.config.json', import.meta.url));

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

async function emit(type: string, payload: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${API_BASE}/api/triggers/emit`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(API_TOKEN ? { Authorization: `Bearer ${API_TOKEN}` } : {}),
    },
    body: JSON.stringify({ type, payload }),
  });
  if (!res.ok) {
    throw new Error(`POST /api/triggers/emit -> HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
}

async function main(): Promise<void> {
  const config = JSON.parse(await readFile(CONFIG_PATH, 'utf8')) as ReviewConfig;
  const args = process.argv.slice(2);
  const reviewFlag = args.indexOf('--review');
  const reviewId = reviewFlag >= 0 ? args[reviewFlag + 1] : config.reviewId;
  if (!reviewId) throw new Error('--review needs an id');
  const rest = reviewFlag >= 0
    ? args.filter((_arg, index) => index !== reviewFlag && index !== reviewFlag + 1)
    : args;
  const [command, ...words] = rest;

  if (command === 'start') {
    const request = words.join(' ').trim() || config.request;
    await emit(config.events.start, { reviewId, request, today: today() });
    console.log(`Started review ${reviewId}. Open folder-review in the dashboard to follow it.`);
    return;
  }
  if (command === 'ask') {
    const question = words.join(' ').trim();
    if (!question) throw new Error('usage: review.ts ask "your question"');
    await emit(config.events.question, { reviewId, question, today: today() });
    console.log(`Asked about review ${reviewId}. The answer appears in the same conversation.`);
    return;
  }
  throw new Error('usage: review.ts start ["what to look for"] | review.ts ask "question"   [--review <id>]');
}

main().catch((error: unknown) => {
  console.error('Review failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
