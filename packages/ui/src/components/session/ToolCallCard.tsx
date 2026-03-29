import { useState } from 'react';
import type { ApiA2UIBlock } from '@ctxmill/shared';
import { cn } from '@/lib/utils';
import type { ToolCallState } from '@/stores/conversation';
import { A2UIBlock } from '@/components/a2ui/A2UIBlock';

interface ToolCallCardProps {
  toolCall: ToolCallState;
}

export function ToolCallCard({ toolCall }: ToolCallCardProps) {
  const [expanded, setExpanded] = useState(false);

  let parsedArgsStr = '';
  let formattedArgs = '';
  let a2uiBlock: ApiA2UIBlock | null = null;
  try {
    if (toolCall.args) {
      const parsed = JSON.parse(toolCall.args);
      parsedArgsStr = JSON.stringify(parsed);
      formattedArgs = JSON.stringify(parsed, null, 2);
      
      const isA2UIRender = toolCall.name === 'a2ui-render' || toolCall.name.endsWith('__a2ui-render');
      if (isA2UIRender && parsed && typeof parsed === 'object' && typeof parsed.component === 'string') {
        a2uiBlock = {
          id: toolCall.id,
          component: parsed.component,
          props: parsed.props || {},
        };
      }
    }
  } catch {
    console.debug('[ToolCallCard] Failed to parse tool call args as JSON');
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

  if (a2uiBlock) {
    return (
      <div data-testid="tool-call-card" className="my-1.5 rounded-lg border border-surface-700/50 bg-surface-800/40 px-3 py-2 text-sm font-mono">
        <div className="flex items-center gap-2 text-left w-full mb-2">
          <div className={cn('w-1.5 h-1.5 rounded-full flex-shrink-0', dotColor, dotAnimation)} />
          <span className="truncate text-surface-400">
            <span data-testid="tool-call-name">{toolCall.name}</span> ({a2uiBlock.component})
          </span>
          {toolCall.status === 'complete' && (
            <span data-testid="tool-call-complete" className="sr-only">complete</span>
          )}
        </div>
        <div className="mt-2">
          <A2UIBlock block={a2uiBlock} />
        </div>
      </div>
    );
  }

  return (
    <div data-testid="tool-call-card" className="my-1.5 rounded-lg border border-surface-700/50 bg-surface-800/40 px-3 py-2 text-sm font-mono">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 text-left group hover:opacity-80 transition-opacity w-full"
      >
        <div className={cn('w-1.5 h-1.5 rounded-full flex-shrink-0', dotColor, dotAnimation)} />
        <span className="truncate text-surface-400">
          {expanded ? '▾' : '▸'} <span data-testid="tool-call-name">{toolCall.name}</span>({truncatedArgs})
        </span>
        {!expanded && toolCall.result && (
          <span className="ml-auto flex-shrink-0 text-[10px] text-surface-500">result ↵</span>
        )}
        {!expanded && toolCall.error && (
          <span className="ml-auto flex-shrink-0 text-[10px] text-red-500/70">error ↵</span>
        )}
        {toolCall.status === 'complete' && (
          <span data-testid="tool-call-complete" className="sr-only">complete</span>
        )}
      </button>

      {expanded && (
        <div className="mt-2 space-y-2">
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
