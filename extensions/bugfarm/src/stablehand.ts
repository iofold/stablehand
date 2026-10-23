import { SUBSCRIBED_EVENTS } from './webhooks.js';

/**
 * The worker's connection to Stablehand, on a scoped key with one
 * capability: `webhooks:manage`. It registers a signed webhook on each floor
 * agent (Scout, Env builder, Writer, Reviewer, Publisher) and never needs the
 * master token.
 */

export interface StablehandLinkOptions {
  baseUrl: string;
  apiKey: string;
  webhookSecret: string;
  /** Where Stablehand delivers webhooks: `<publicUrl>/hooks/stablehand`. */
  publicUrl: string;
  agentIds: string[];
  fetchImpl?: typeof fetch;
  logger?: Pick<Console, 'log' | 'warn'>;
}

export interface LinkStatus {
  connected: boolean;
  missing: string[];
  keyScoped: boolean | null;
  webhookAgents: string[];
  failedAgents: string[];
  lastError: string | null;
}

export function missingLinkConfig(options: Pick<StablehandLinkOptions, 'baseUrl' | 'apiKey' | 'webhookSecret' | 'publicUrl'>): string[] {
  const missing: string[] = [];
  if (!options.baseUrl) missing.push('STABLEHAND_BASE_URL');
  if (!options.apiKey) missing.push('STABLEHAND_API_KEY');
  if (!options.webhookSecret) missing.push('BUGFARM_WEBHOOK_SECRET');
  if (!options.publicUrl) missing.push('BUGFARM_PUBLIC_URL');
  return missing;
}

interface WebhookRecord {
  id: string;
  url: string;
  events: string[];
}

export class StablehandLink {
  readonly status: LinkStatus;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: Pick<Console, 'log' | 'warn'>;
  private readonly hookUrl: string;

  constructor(private readonly options: StablehandLinkOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.logger = options.logger ?? console;
    this.hookUrl = `${options.publicUrl.replace(/\/+$/, '')}/hooks/stablehand`;
    this.status = {
      connected: false,
      missing: missingLinkConfig(options),
      keyScoped: null,
      webhookAgents: [],
      failedAgents: [],
      lastError: null,
    };
  }

  private async api(pathname: string, init?: RequestInit): Promise<Response> {
    return this.fetchImpl(`${this.options.baseUrl.replace(/\/+$/, '')}${pathname}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers,
      },
    });
  }

  /**
   * Probe the key the way EXTENDING.md asks: one route it needs and one
   * master-only route it must be refused. Then make sure every floor agent
   * delivers to this worker. Safe to call again; it only fills gaps.
   */
  async connect(): Promise<LinkStatus> {
    if (this.status.missing.length > 0) return this.status;
    try {
      const forbidden = await this.api('/api/keys');
      this.status.keyScoped = forbidden.status === 403;
      if (forbidden.status === 401) {
        this.status.lastError = 'Stablehand refused the key (401). Check STABLEHAND_API_KEY.';
        this.logger.warn(`[bugfarm] ${this.status.lastError}`);
        return this.status;
      }
      if (!this.status.keyScoped) {
        this.logger.warn(`[bugfarm] WARNING: /api/keys returned ${forbidden.status}. This key can do more than the worker needs; use a scoped key with webhooks:manage only.`);
      }
      const registered: string[] = [];
      const failed: string[] = [];
      for (const agentId of this.options.agentIds) {
        (await this.ensureWebhook(agentId) ? registered : failed).push(agentId);
      }
      this.status.webhookAgents = registered;
      this.status.failedAgents = failed;
      this.status.connected = failed.length === 0;
      this.status.lastError = failed.length > 0 ? `Could not register webhooks for ${failed.length} agent(s)` : null;
    } catch (err) {
      this.status.connected = false;
      this.status.lastError = `Stablehand is unreachable at ${this.options.baseUrl}: ${(err as Error).message}`;
    }
    return this.status;
  }

  private async ensureWebhook(agentId: string): Promise<boolean> {
    const path = `/api/agents/${encodeURIComponent(agentId)}/webhooks`;
    const list = await this.api(path);
    if (!list.ok) {
      this.logger.warn(`[bugfarm] listing webhooks for agent ${agentId} returned ${list.status}`);
      return false;
    }
    const body = await list.json() as { webhooks?: WebhookRecord[] } | WebhookRecord[];
    const hooks = Array.isArray(body) ? body : body.webhooks ?? [];
    const existing = hooks.find((hook) => hook.url === this.hookUrl);
    const wanted = [...SUBSCRIBED_EVENTS];
    if (existing) {
      // Secrets are write-only, so re-send ours: a rotated secret takes effect on restart.
      const patch = await this.api(`${path}/${encodeURIComponent(existing.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ events: wanted, secret: this.options.webhookSecret }),
      });
      return patch.ok;
    }
    const created = await this.api(path, {
      method: 'POST',
      body: JSON.stringify({ url: this.hookUrl, events: wanted, secret: this.options.webhookSecret }),
    });
    if (created.ok || created.status === 409) {
      this.logger.log(`[bugfarm] webhook registered for agent ${agentId}`);
      return true;
    }
    this.logger.warn(`[bugfarm] webhook registration for agent ${agentId} returned ${created.status}`);
    return false;
  }
}
