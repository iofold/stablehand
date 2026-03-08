import { useState } from 'react';
import {
  Loader2,
  CheckCircle2,
  XCircle,
  ChevronDown,
  ChevronRight,
  Terminal,
  Clock,
  Play,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ToolCallState } from '@/stores/conversation';

interface ToolCallCardProps {
  toolCall: ToolCallState;
}

export function ToolCallCard({ toolCall }: ToolCallCardProps) {
  const [expanded, setExpanded] = useState(false);

  let parsedArgs: string | undefined;
  try {
    if (toolCall.args) {
      parsedArgs = JSON.stringify(JSON.parse(toolCall.args), null, 2);
    }
  } catch {
    parsedArgs = toolCall.args;
  }

  const isRunning = toolCall.status === 'running' || toolCall.status === 'pending';
  const isComplete = toolCall.status === 'complete';
  const isError = toolCall.status === 'error';

  const statusConfig = {
    pending: {
      icon: <Clock className="h-3.5 w-3.5 text-surface-400" />,
      label: 'Queued',
      labelClass: 'text-surface-500',
      borderClass: 'border-surface-700/40',
      bgClass: 'bg-surface-800/40',
    },
    running: {
      icon: <Loader2 className="h-3.5 w-3.5 animate-spin text-brand-400" />,
      label: 'Running',
      labelClass: 'text-brand-400',
      borderClass: 'border-brand-500/20',
      bgClass: 'bg-brand-950/20',
    },
    complete: {
      icon: <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />,
      label: 'Complete',
      labelClass: 'text-emerald-400',
      borderClass: 'border-emerald-800/20',
      bgClass: 'bg-surface-800/30',
    },
    error: {
      icon: <XCircle className="h-3.5 w-3.5 text-red-400" />,
      label: 'Failed',
      labelClass: 'text-red-400',
      borderClass: 'border-red-800/30',
      bgClass: 'bg-red-950/10',
    },
  };

  const config = statusConfig[toolCall.status];

  return (
    <div
      data-testid="tool-call-card"
      className={cn(
        'ml-10 my-1 rounded-lg border text-sm animate-fade-in transition-colors',
        config.borderClass,
        config.bgClass,
      )}
    >
      {/* Header */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-surface-700/20 transition-colors rounded-lg group"
      >
        <div className={cn(
          'flex h-5 w-5 items-center justify-center rounded',
          isRunning ? 'bg-brand-600/15' : isError ? 'bg-red-600/10' : 'bg-surface-700/40',
        )}>
          <Terminal className={cn(
            'h-3 w-3',
            isRunning ? 'text-brand-400' : isError ? 'text-red-400' : 'text-surface-400',
          )} />
        </div>

        <div className="flex flex-1 items-center gap-2 min-w-0">
          <span
            data-testid="tool-call-name"
            className="font-mono text-xs text-surface-200 truncate"
          >
            {toolCall.name}
          </span>
          <span className={cn('text-[10px] font-medium', config.labelClass)}>
            {config.label}
          </span>
        </div>

        {config.icon}

        {toolCall.status === 'complete' && (
          <span data-testid="tool-call-complete" className="sr-only">complete</span>
        )}

        <div className="text-surface-600 group-hover:text-surface-400 transition-colors">
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
        </div>
      </button>

      {/* Expandable details */}
      {expanded && (
        <div className="border-t border-surface-700/30 px-3 py-2.5 space-y-2.5">
          {parsedArgs && (
            <div>
              <div className="flex items-center gap-1.5 mb-1.5">
                <Play className="h-2.5 w-2.5 text-surface-500" />
                <span className="text-[10px] font-medium uppercase tracking-wider text-surface-500">
                  Arguments
                </span>
              </div>
              <pre className="bg-surface-900/80 border border-surface-700/30 rounded-md p-2.5 text-xs text-surface-300 overflow-x-auto font-mono leading-relaxed">
                {parsedArgs}
              </pre>
            </div>
          )}
          {toolCall.result && (
            <div>
              <div className="flex items-center gap-1.5 mb-1.5">
                <CheckCircle2 className="h-2.5 w-2.5 text-emerald-500" />
                <span className="text-[10px] font-medium uppercase tracking-wider text-emerald-500/80">
                  Result
                </span>
              </div>
              <pre className="bg-surface-900/80 border border-surface-700/30 rounded-md p-2.5 text-xs text-surface-300 overflow-x-auto max-h-48 font-mono leading-relaxed">
                {toolCall.result}
              </pre>
            </div>
          )}
          {toolCall.error && (
            <div>
              <div className="flex items-center gap-1.5 mb-1.5">
                <XCircle className="h-2.5 w-2.5 text-red-400" />
                <span className="text-[10px] font-medium uppercase tracking-wider text-red-400">
                  Error
                </span>
              </div>
              <pre className="bg-red-950/30 border border-red-800/20 rounded-md p-2.5 text-xs text-red-300 overflow-x-auto font-mono leading-relaxed">
                {toolCall.error}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
