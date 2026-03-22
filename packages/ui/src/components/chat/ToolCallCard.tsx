import { useState } from 'react';
import { cn } from '@/lib/utils';
import type { ToolCallState } from '@/stores/conversation';

interface ToolCallCardProps {
  toolCall: ToolCallState;
}

export function ToolCallCard({ toolCall }: ToolCallCardProps) {
  const [expanded, setExpanded] = useState(false);

  let parsedArgsStr = '';
  let formattedArgs = '';
  try {
    if (toolCall.args) {
      const parsed = JSON.parse(toolCall.args);
      parsedArgsStr = JSON.stringify(parsed);
      formattedArgs = JSON.stringify(parsed, null, 2);
    }
  } catch {
    parsedArgsStr = toolCall.args || '';
    formattedArgs = toolCall.args || '';
  }

  const truncatedArgs = parsedArgsStr.length > 50 
    ? parsedArgsStr.substring(0, 50) + '...' 
    : parsedArgsStr;

  const isRunning = toolCall.status === 'running' || toolCall.status === 'pending';
  const isComplete = toolCall.status === 'complete';
  const isError = toolCall.status === 'error';

  let dotColor = 'bg-surface-600';
  let dotAnimation = '';

  if (isRunning) {
    dotColor = 'bg-yellow-500';
    dotAnimation = 'animate-pulse';
  } else if (isComplete) {
    dotColor = 'bg-green-500';
  } else if (isError) {
    dotColor = 'bg-red-500';
  }

  return (
    <div data-testid="tool-call-card" className="my-1 text-sm font-mono">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 text-left group hover:opacity-80 transition-opacity w-full"
      >
        <div className={cn('w-1.5 h-1.5 rounded-full flex-shrink-0', dotColor, dotAnimation)} />
        <span className={cn('truncate', expanded ? 'text-surface-400' : 'text-surface-400')}>
          {expanded ? '▾' : '▸'} <span data-testid="tool-call-name">{toolCall.name}</span>({truncatedArgs})
        </span>
        {toolCall.status === 'complete' && (
          <span data-testid="tool-call-complete" className="sr-only">complete</span>
        )}
      </button>

      {expanded && (
        <div className="mt-2 ml-3.5 space-y-2">
          {formattedArgs && (
            <div>
              <div className="text-[10px] text-surface-400 mb-1 uppercase tracking-wider">Arguments</div>
              <pre className="bg-surface-950 border border-surface-700 rounded-md p-2 text-xs font-mono text-surface-400 overflow-x-auto">
                {formattedArgs}
              </pre>
            </div>
          )}
          
          {toolCall.result && (
            <div>
              <div className="text-[10px] text-surface-400 mb-1 uppercase tracking-wider">Result</div>
              <pre className="bg-surface-950 border border-surface-700 rounded-md p-2 text-xs font-mono text-surface-400 overflow-x-auto max-h-48">
                {toolCall.result}
              </pre>
            </div>
          )}
          
          {toolCall.error && (
            <div>
              <div className="text-[10px] text-red-500/80 mb-1 uppercase tracking-wider">Error</div>
              <pre className="bg-surface-950 border border-red-900/50 rounded-md p-2 text-xs font-mono text-red-400 overflow-x-auto">
                {toolCall.error}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
