import type { ReactNode } from 'react';
import { ShieldCheck } from 'lucide-react';
import type { CatalogTool } from '@/lib/api';
import { cn } from '@/lib/utils';

type ToolBadgeData = Partial<Pick<
  CatalogTool,
  'builtin' | 'location' | 'requiresApproval' | 'source'
>> & { source?: string };

export function sourceBadgeClass(source?: string): string {
  switch (source) {
    case 'local':
      return 'bg-accent-500/10 border-accent-500/20 text-accent-400';
    case 'mcp':
      return 'bg-violet-500/10 border-violet-500/20 text-violet-400';
    case 'composio':
      return 'bg-amber-500/10 border-amber-500/20 text-amber-400';
    default:
      return 'bg-surface-700/30 border-surface-600/30 text-surface-400';
  }
}

export function locationBadgeClass(location?: string): string {
  switch (location) {
    case 'orchestrator':
      return 'bg-blue-500/10 border-blue-500/20 text-blue-400';
    case 'daemon':
      return 'bg-purple-500/10 border-purple-500/20 text-purple-400';
    case 'sandbox':
    default:
      return 'bg-surface-700/30 border-surface-600/30 text-surface-400';
  }
}

export function ToolBadges({
  tool,
  compact = false,
  extraBadges,
}: {
  tool: ToolBadgeData;
  compact?: boolean;
  extraBadges?: ReactNode;
}) {
  const badgeClass = compact
    ? 'px-2 py-0.5 text-[10px] uppercase'
    : 'px-2 py-0.5 text-[11px]';
  return (
    <>
      {tool.builtin ? (
        <span className={cn('inline-flex shrink-0 rounded-md border border-sky-500/20 bg-sky-500/10 font-medium text-sky-400', badgeClass)}>
          builtin
        </span>
      ) : null}
      {extraBadges}
      {tool.location ? (
        <span className={cn('inline-flex shrink-0 rounded-md border font-medium', badgeClass, locationBadgeClass(tool.location))}>
          {tool.location}
        </span>
      ) : null}
      <span className={cn('inline-flex shrink-0 rounded-md border font-medium', badgeClass, sourceBadgeClass(tool.source))}>
        {tool.source || 'unknown'}
      </span>
      {tool.requiresApproval ? (
        <span className={cn('inline-flex shrink-0 items-center gap-1 rounded-md border border-orange-500/20 bg-orange-500/10 font-medium text-orange-400', compact ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-0.5 text-[11px]')}>
          <ShieldCheck className="h-3 w-3" />
          {compact ? 'approval' : 'requires approval'}
        </span>
      ) : null}
    </>
  );
}

export function ToolDetailsPanel({
  tool,
  compact = false,
  showEmpty = true,
  className,
}: {
  tool: Pick<CatalogTool, 'inputSchema' | 'secrets'>;
  compact?: boolean;
  showEmpty?: boolean;
  className?: string;
}) {
  const hasSecrets = Boolean(tool.secrets?.length);
  if (!tool.inputSchema && !hasSecrets && !showEmpty) {
    return null;
  }

  return (
    <div className={cn('space-y-3', className)}>
      {tool.inputSchema ? (
        <div>
          <p className={cn('font-medium uppercase text-surface-500', compact ? 'mb-1.5 text-[10px]' : 'mb-2 text-[11px]')}>
            Input Schema
          </p>
          <pre className={cn('overflow-x-auto border bg-surface-950 font-mono leading-relaxed text-surface-300', compact ? 'max-h-40 rounded-md border-surface-800 p-2.5 text-[11px]' : 'max-h-60 rounded-lg border-surface-700 p-3 text-xs')}>
            {JSON.stringify(tool.inputSchema, null, 2)}
          </pre>
        </div>
      ) : null}
      {hasSecrets ? (
        <div>
          <p className={cn('font-medium uppercase text-surface-500', compact ? 'mb-1.5 text-[10px]' : 'mb-2 text-[11px]')}>
            Secrets
          </p>
          <div className="flex flex-wrap gap-1.5">
            {tool.secrets?.map((secret) => (
              <span key={secret} className={cn('inline-flex border bg-surface-800 font-mono text-surface-300', compact ? 'rounded border-surface-700 px-1.5 py-0.5 text-[10px]' : 'rounded-md border-surface-600 px-2 py-0.5 text-[11px]')}>
                {secret}
              </span>
            ))}
          </div>
        </div>
      ) : null}
      {!tool.inputSchema && !hasSecrets && showEmpty ? (
        <p className={cn('text-xs text-surface-500', compact && 'italic')}>No additional details available.</p>
      ) : null}
    </div>
  );
}
