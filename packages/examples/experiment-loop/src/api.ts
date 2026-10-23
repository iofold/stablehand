export class ApiError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly code: string | undefined,
    readonly body: string,
    readonly retryAfterSec: number | null,
  ) {
    super(`${method} ${path} -> HTTP ${status}${code ? ` (${code})` : ''}: ${body.slice(0, 300)}`);
    this.name = 'ApiError';
  }
}

export interface ApiClientOptions {
  /** Stablehand API origin, e.g. http://localhost:3002. */
  baseUrl: string;
  /** A scoped key (cmk_...) or the master token. */
  token?: string;
  fetchImpl?: typeof fetch;
}

export interface RequestOptions {
  json?: unknown;
  body?: FormData;
  headers?: Record<string, string>;
}

function readErrorCode(text: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && 'code' in parsed && typeof parsed.code === 'string') return parsed.code;
    return undefined;
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

export class StablehandApi {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: ApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = {
      ...(this.options.token ? { Authorization: `Bearer ${this.options.token}` } : {}),
      ...(options.json !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers ?? {}),
    };
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      ...(options.json !== undefined ? { body: JSON.stringify(options.json) } : {}),
      ...(options.body !== undefined ? { body: options.body } : {}),
    });
    const text = await res.text();
    if (!res.ok) {
      const retryAfter = res.headers.get('retry-after');
      throw new ApiError(method, path, res.status, readErrorCode(text), text, retryAfter ? Number(retryAfter) : null);
    }
    return (text ? JSON.parse(text) : null) as T;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  post<T>(path: string, json: unknown, headers?: Record<string, string>): Promise<T> {
    return this.request<T>('POST', path, { json, ...(headers ? { headers } : {}) });
  }

  patch<T>(path: string, json: unknown): Promise<T> {
    return this.request<T>('PATCH', path, { json });
  }

  async download(path: string): Promise<string> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      headers: this.options.token ? { Authorization: `Bearer ${this.options.token}` } : {},
    });
    const text = await res.text();
    if (!res.ok) throw new ApiError('GET', path, res.status, readErrorCode(text), text, null);
    return text;
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => worker()));
  return results;
}
