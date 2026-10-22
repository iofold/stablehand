import { Plus, Trash2 } from 'lucide-react';
import { McpServerDefinitionSchema, type McpServerDefinition } from '@stablehand/contracts';
import { cn } from '@/lib/utils';

export type McpAuthChoice = 'none' | 'bearer' | 'header' | 'oauth';
export type McpApprovalChoice = 'hints' | 'all' | 'none' | 'listed';

/** One editable row. Secret names are typed bare; `$secret:` is added on save. */
export interface McpServerDraft {
  name: string;
  url: string;
  auth: McpAuthChoice;
  secretName: string;
  headerName: string;
  tools: string;
  approval: McpApprovalChoice;
  approvalList: string;
}

export function emptyMcpServerDraft(): McpServerDraft {
  return {
    name: '',
    url: '',
    auth: 'none',
    secretName: '',
    headerName: '',
    tools: '',
    approval: 'hints',
    approvalList: '',
  };
}

function splitList(value: string): string[] {
  return value.split(',').map((entry) => entry.trim()).filter(Boolean);
}

function bareSecretName(reference: string): string {
  return reference.replace(/^\$secret:/, '');
}

export function mcpServerToDraft(server: McpServerDefinition): McpServerDraft {
  const draft = emptyMcpServerDraft();
  draft.name = server.name;
  draft.url = server.url;
  draft.tools = (server.tools ?? []).join(', ');
  const auth = server.auth ?? { type: 'none' as const };
  draft.auth = auth.type;
  if (auth.type === 'bearer') draft.secretName = bareSecretName(auth.token);
  if (auth.type === 'header') {
    draft.secretName = bareSecretName(auth.value);
    draft.headerName = auth.name;
  }
  if (server.requireApproval === true) draft.approval = 'all';
  else if (server.requireApproval === false) draft.approval = 'none';
  else if (Array.isArray(server.requireApproval)) {
    draft.approval = 'listed';
    draft.approvalList = server.requireApproval.join(', ');
  }
  return draft;
}

/** Builds the API definition, or returns the first problem in plain words. */
export function draftToMcpServer(draft: McpServerDraft): { server?: McpServerDefinition; error?: string } {
  const candidate: Record<string, unknown> = {
    name: draft.name.trim(),
    url: draft.url.trim(),
  };
  const secret = `$secret:${draft.secretName.trim()}`;
  if (draft.auth === 'bearer') candidate.auth = { type: 'bearer', token: secret };
  if (draft.auth === 'header') candidate.auth = { type: 'header', name: draft.headerName.trim(), value: secret };
  if (draft.auth === 'oauth') candidate.auth = { type: 'oauth' };
  const tools = splitList(draft.tools);
  if (tools.length > 0) candidate.tools = tools;
  if (draft.approval === 'all') candidate.requireApproval = true;
  if (draft.approval === 'none') candidate.requireApproval = false;
  if (draft.approval === 'listed') candidate.requireApproval = splitList(draft.approvalList);

  const parsed = McpServerDefinitionSchema.safeParse(candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path.join('.') ?? '';
    const label = draft.name.trim() || 'MCP server';
    return { error: `${label}: ${field ? `${field}: ` : ''}${issue?.message ?? 'invalid'}` };
  }
  return { server: parsed.data };
}

const AUTH_LABELS: Record<McpAuthChoice, string> = {
  none: 'No sign-in',
  bearer: 'Bearer token from a secret',
  header: 'Header from a secret',
  oauth: 'OAuth sign-in (connect after saving)',
};

const APPROVAL_LABELS: Record<McpApprovalChoice, string> = {
  hints: 'Ask before tools the server marks destructive',
  all: 'Ask before every call',
  none: 'Never ask',
  listed: 'Ask before the tools I list',
};

export function McpServersEditor({
  value,
  onChange,
  error,
}: {
  value: McpServerDraft[];
  onChange: (next: McpServerDraft[]) => void;
  error?: string;
}) {
  const update = (index: number, patch: Partial<McpServerDraft>) => {
    onChange(value.map((draft, i) => (i === index ? { ...draft, ...patch } : draft)));
  };

  return (
    <div data-testid="mcp-servers-editor">
      <div className="mb-1.5 flex items-center justify-between">
        <div className="text-label">MCP servers</div>
        <button
          type="button"
          onClick={() => onChange([...value, emptyMcpServerDraft()])}
          className="flex items-center gap-1.5 rounded-md border border-accent-500/20 bg-accent-500/10 px-2.5 py-1 text-xs font-medium text-accent-400 transition-colors hover:bg-accent-500/20 hover:text-accent-300"
        >
          <Plus className="h-3.5 w-3.5" />
          Add server
        </button>
      </div>
      <p className="mb-2 text-xs text-surface-500">
        Stablehand connects to each server for this agent and keeps its tokens. The agent sees the
        server&apos;s tools as <span className="font-mono">name__tool</span>; tokens never enter its sandbox.
      </p>
      {value.length === 0 && <p className="text-xs text-surface-500">No MCP servers</p>}
      <div className="space-y-3">
        {value.map((draft, index) => (
          <div
            key={index}
            data-testid="mcp-server-row"
            className="space-y-2 rounded-lg border border-surface-700 bg-surface-800/50 p-3"
          >
            <div className="flex gap-2">
              <input
                aria-label="MCP server name"
                placeholder="granola"
                value={draft.name}
                onChange={(e) => update(index, { name: e.target.value })}
                className="input-base w-36 font-mono"
              />
              <input
                aria-label="MCP server URL"
                placeholder="https://mcp.granola.ai/mcp"
                value={draft.url}
                onChange={(e) => update(index, { url: e.target.value })}
                className="input-base min-w-0 flex-1 font-mono"
              />
              <button
                type="button"
                onClick={() => onChange(value.filter((_, i) => i !== index))}
                className="p-1 text-surface-400 transition-colors hover:text-red-400"
                aria-label={`Remove MCP server ${draft.name || index + 1}`}
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
            <div className="flex flex-wrap gap-2">
              <select
                aria-label="Sign-in"
                value={draft.auth}
                onChange={(e) => update(index, { auth: e.target.value as McpAuthChoice })}
                className="input-base w-auto text-xs"
              >
                {(Object.keys(AUTH_LABELS) as McpAuthChoice[]).map((choice) => (
                  <option key={choice} value={choice}>{AUTH_LABELS[choice]}</option>
                ))}
              </select>
              {draft.auth === 'header' && (
                <input
                  aria-label="Header name"
                  placeholder="x-api-key"
                  value={draft.headerName}
                  onChange={(e) => update(index, { headerName: e.target.value })}
                  className="input-base w-32 font-mono text-xs"
                />
              )}
              {(draft.auth === 'bearer' || draft.auth === 'header') && (
                <input
                  aria-label="Secret name"
                  placeholder="APIFY_TOKEN"
                  value={draft.secretName}
                  onChange={(e) => update(index, { secretName: e.target.value })}
                  className="input-base w-40 font-mono text-xs"
                  title="Store the value under Secrets as a tools-only secret"
                />
              )}
            </div>
            <input
              aria-label="Allowed tools"
              placeholder="Allowed tools, comma separated (empty = all), e.g. list_*, get_meetings"
              value={draft.tools}
              onChange={(e) => update(index, { tools: e.target.value })}
              className="input-base font-mono text-xs"
            />
            <div className="flex flex-wrap gap-2">
              <select
                aria-label="Approval"
                value={draft.approval}
                onChange={(e) => update(index, { approval: e.target.value as McpApprovalChoice })}
                className="input-base w-auto text-xs"
              >
                {(Object.keys(APPROVAL_LABELS) as McpApprovalChoice[]).map((choice) => (
                  <option key={choice} value={choice}>{APPROVAL_LABELS[choice]}</option>
                ))}
              </select>
              {draft.approval === 'listed' && (
                <input
                  aria-label="Tools that ask first"
                  placeholder="call-actor, delete_*"
                  value={draft.approvalList}
                  onChange={(e) => update(index, { approvalList: e.target.value })}
                  className={cn('input-base min-w-0 flex-1 font-mono text-xs')}
                />
              )}
            </div>
          </div>
        ))}
      </div>
      {error && <p className="mt-1 text-xs text-red-400">{error}</p>}
    </div>
  );
}
