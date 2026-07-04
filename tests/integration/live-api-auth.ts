import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let cachedToken: string | undefined;
let tokenLoaded = false;

function unquote(value: string): string {
  const trimmed = value.trim();
  const quote = trimmed[0];
  if ((quote === '"' || quote === "'") && trimmed.endsWith(quote)) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function readTokenFromDotenv(): string | undefined {
  try {
    const content = readFileSync(resolve(process.cwd(), '.env'), 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      if (!trimmed.startsWith('CTXMILL_API_TOKEN=')) continue;

      const token = unquote(trimmed.slice('CTXMILL_API_TOKEN='.length));
      return token.length > 0 ? token : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function liveApiToken(): string | undefined {
  if (!tokenLoaded) {
    cachedToken = process.env.CTXMILL_API_TOKEN?.trim() || readTokenFromDotenv();
    tokenLoaded = true;
  }
  return cachedToken;
}

export function liveApiHeaders(headers?: HeadersInit): Headers {
  const nextHeaders = new Headers(headers);
  const token = liveApiToken();
  if (token && !nextHeaders.has('authorization')) {
    nextHeaders.set('authorization', `Bearer ${token}`);
  }
  return nextHeaders;
}

export function liveApiFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  return fetch(input, {
    ...init,
    headers: liveApiHeaders(init.headers),
  });
}
