import { useMemo, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { ApiA2UIBlock } from '@stablehand/shared';
import { cn } from '@/lib/utils';
import type { ToolCallState } from '@/stores/conversation';
import { A2UIBlock } from '@/components/a2ui/A2UIBlock';
import { formatEventDuration } from '@/lib/format';
import {
  a2uiDisplayName,
  isA2UIRenderToolName,
  isMissingToolName,
  summarizeToolArgs,
  toolDisplayName,
} from '@/lib/tool-display';

interface ToolCallCardProps {
  toolCall: ToolCallState;
}

interface ParsedArgs {
  value: unknown;
  formatted: string;
}

function parseArgs(args: string | undefined): ParsedArgs {
  if (!args) return { value: undefined, formatted: '' };
  try {
    const value: unknown = JSON.parse(args);
    return { value, formatted: JSON.stringify(value, null, 2) };
  } catch {
    // Arguments still streaming (partial JSON) or plain text: show as sent.
    return { value: undefined, formatted: args };
  }
}

function toA2UIBlock(id: string, name: string, value: unknown): ApiA2UIBlock | null {
  if (!isA2UIRenderToolName(name)) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.component !== 'string') return null;
  const props = record.props && typeof record.props === 'object' && !Array.isArray(record.props)
    ? record.props as Record<string, unknown>
    : {};
  return { id, component: record.component, props };
}

function DetailBlock({ label, children, tone = 'default' }: {
  label: string;
  children: string;
  tone?: 'default' | 'error';
}) {
  return (
    <div>
      <div className={cn(
        'mb-1 text-[10px] uppercase tracking-wider',
        tone === 'error' ? 'text-red-400/80' : 'text-surface-500',
      )}
      >
        {label}
      </div>
      <pre className={cn(
        'max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md border bg-surface-950 p-2 font-mono text-xs',
        tone === 'error' ? 'border-red-900/50 text-red-400' : 'border-surface-700 text-surface-400',
      )}
      >
        {children}
      </pre>
    </div>
  );
}

export function ToolCallCard({ toolCall }: ToolCallCardProps) {
  // null = follow the default (open only when the call failed).
  const [expandedOverride, setExpandedOverride] = useState<boolean | null>(null);
  const parsed = useMemo(() => parseArgs(toolCall.args), [toolCall.args]);
  const a2uiBlock = useMemo(
    () => toA2UIBlock(toolCall.id, toolCall.name, parsed.value),
    [toolCall.id, toolCall.name, parsed.value],
  );

  const isRunning = toolCall.status === 'running' || toolCall.status === 'pending';
  const isComplete = toolCall.status === 'complete';
  const isError = toolCall.status === 'error';
  const expanded = expandedOverride ?? isError;

  const label = a2uiBlock ? a2uiDisplayName(a2uiBlock.component) : toolDisplayName(toolCall.name);
  const summary = a2uiBlock ? undefined : summarizeToolArgs(parsed.value);
  const duration = formatEventDuration(toolCall.durationMs);
  const rawName = isMissingToolName(toolCall.name) ? 'Not recorded' : toolCall.name;

  const dotClass = isRunning
    ? 'bg-yellow-500 animate-pulse'
    : isComplete
      ? 'bg-green-500'
      : isError
        ? 'bg-red-500'
        : 'bg-surface-600';

  return (
    <div
      data-testid="tool-call-card"
      className="my-1.5 rounded-lg border border-surface-700/50 bg-surface-800/40 px-3 py-2 text-sm"
    >
      <button
        type="button"
        onClick={() => setExpandedOverride(!expanded)}
        aria-expanded={expanded}
        className="group flex w-full min-w-0 items-center gap-2 text-left"
      >
        <span className={cn('h-1.5 w-1.5 flex-shrink-0 rounded-full', dotClass)} />
        <span
          data-testid="tool-call-name"
          title={rawName}
          className="flex-shrink-0 font-medium text-surface-200"
        >
          {label}
        </span>
        {summary && (
          <span className="min-w-0 truncate text-surface-400">{summary}</span>
        )}
        <span className="ml-auto flex flex-shrink-0 items-center gap-2 pl-2">
          {isError && !expanded && (
            <span className="text-[11px] font-medium text-red-400">Failed</span>
          )}
          {duration && (
            <span className="text-[11px] tabular-nums text-surface-500">{duration}</span>
          )}
          <ChevronRight
            aria-hidden
            className={cn(
              'h-3.5 w-3.5 text-surface-500 transition-transform group-hover:text-surface-300',
              expanded && 'rotate-90',
            )}
          />
        </span>
        {isComplete && (
          <span data-testid="tool-call-complete" className="sr-only">complete</span>
        )}
      </button>

      {a2uiBlock && (
        <div className="mt-2">
          <A2UIBlock block={a2uiBlock} />
        </div>
      )}

      {expanded && (
        <div className="mt-2 space-y-2">
          <div className="flex items-baseline gap-2 text-[11px]">
            <span className="uppercase tracking-wider text-surface-500">Tool</span>
            <span className="break-all font-mono text-surface-400">{rawName}</span>
          </div>
          {parsed.formatted && <DetailBlock label="Arguments">{parsed.formatted}</DetailBlock>}
          {toolCall.result && !a2uiBlock && <DetailBlock label="Result">{toolCall.result}</DetailBlock>}
          {toolCall.error && <DetailBlock label="Error" tone="error">{toolCall.error}</DetailBlock>}
        </div>
      )}
    </div>
  );
}
