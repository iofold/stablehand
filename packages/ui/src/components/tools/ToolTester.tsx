import { useState, useEffect } from 'react';
import { Play, X, Loader2, CheckCircle2, XCircle, Clock } from 'lucide-react';
import { cn } from '@/lib/utils';
import { testTool } from '@/lib/api';

interface ToolTesterProps {
  toolName: string;
  inputSchema?: Record<string, unknown>;
  onClose: () => void;
}

function generateExampleInput(schema?: Record<string, unknown>): string {
  if (!schema || !schema.properties) return '{\n  \n}';
  
  const example: Record<string, unknown> = {};
  const props = schema.properties as Record<string, any>;
  
  for (const [key, value] of Object.entries(props)) {
    if (value.type === 'string') example[key] = '';
    else if (value.type === 'number' || value.type === 'integer') example[key] = 0;
    else if (value.type === 'boolean') example[key] = false;
    else if (value.type === 'array') example[key] = [];
    else if (value.type === 'object') example[key] = {};
    else example[key] = null;
  }
  
  return JSON.stringify(example, null, 2);
}

export function ToolTester({ toolName, inputSchema, onClose }: ToolTesterProps) {
  const [inputStr, setInputStr] = useState(() => generateExampleInput(inputSchema));
  const [isRunning, setIsRunning] = useState(false);
  const [result, setResult] = useState<{
    success: boolean;
    data?: string;
    error?: string;
    durationMs: number;
  } | null>(null);
  const [jsonError, setJsonError] = useState<string | null>(null);

  useEffect(() => {
    setInputStr(generateExampleInput(inputSchema));
    setResult(null);
    setJsonError(null);
  }, [toolName, inputSchema]);

  const handleRun = async () => {
    setJsonError(null);
    let parsedInput: Record<string, unknown> | undefined;
    
    if (inputStr.trim()) {
      try {
        parsedInput = JSON.parse(inputStr);
      } catch (e) {
        setJsonError((e as Error).message);
        return;
      }
    }

    setIsRunning(true);
    setResult(null);
    
    try {
      const res = await testTool(toolName, parsedInput);
      setResult({
        success: res.success,
        data: res.result,
        error: res.error,
        durationMs: res.durationMs,
      });
    } catch (e) {
      setResult({
        success: false,
        error: (e as Error).message || 'Failed to execute tool',
        durationMs: 0,
      });
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <div className="border-t border-surface-700 bg-surface-900/80 p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-surface-200 flex items-center gap-2">
          <Play className="h-4 w-4 text-accent-400" />
          Test Tool: <span className="font-mono text-accent-300">{toolName}</span>
        </h3>
        <button
          onClick={onClose}
          className="p-1 text-surface-400 hover:text-surface-200 hover:bg-surface-800 rounded transition-colors"
          title="Close tester"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="text-xs font-medium text-surface-400 uppercase tracking-wider">
            Input JSON
          </label>
          {jsonError && (
            <span className="text-xs text-red-400">{jsonError}</span>
          )}
        </div>
        <textarea
          value={inputStr}
          onChange={(e) => {
            setInputStr(e.target.value);
            setJsonError(null);
          }}
          className={cn(
            "w-full h-32 rounded-lg border bg-surface-950 p-3 text-sm font-mono text-surface-200 placeholder:text-surface-600 focus:outline-none focus:ring-1 focus:ring-accent-500/50 resize-y",
            jsonError ? "border-red-500/50 focus:ring-red-500/50" : "border-surface-700"
          )}
          placeholder="{\n  // Enter JSON input here\n}"
          spellCheck={false}
        />
      </div>

      <div className="flex justify-end">
        <button
          onClick={handleRun}
          disabled={isRunning}
          className="inline-flex items-center gap-2 rounded-lg bg-accent-600 px-4 py-2 text-sm font-medium text-white hover:bg-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500/50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {isRunning ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Running...
            </>
          ) : (
            <>
              <Play className="h-4 w-4" />
              Run Test
            </>
          )}
        </button>
      </div>

      {result && (
        <div className={cn(
          "mt-4 rounded-lg border p-4 space-y-3",
          result.success 
            ? "border-green-500/20 bg-green-500/5" 
            : "border-red-500/20 bg-red-500/5"
        )}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              {result.success ? (
                <CheckCircle2 className="h-4 w-4 text-green-500" />
              ) : (
                <XCircle className="h-4 w-4 text-red-500" />
              )}
              <span className={cn(
                "text-sm font-medium",
                result.success ? "text-green-400" : "text-red-400"
              )}>
                {result.success ? "Success" : "Error"}
              </span>
            </div>
            <div className="flex items-center gap-1.5 text-xs text-surface-400">
              <Clock className="h-3.5 w-3.5" />
              Completed in {result.durationMs}ms
            </div>
          </div>
          
          <div className="relative">
            <pre className={cn(
              "overflow-x-auto rounded bg-surface-950 p-3 text-xs font-mono leading-relaxed max-h-96",
              result.success ? "text-surface-300" : "text-red-300/90"
            )}>
              {result.success ? result.data : result.error}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
