import { resolve } from './CatalogRegistry';
import type { A2UIBlock as A2UIBlockType } from '@/stores/conversation';

interface A2UIBlockProps {
  block: A2UIBlockType;
}

export function A2UIBlock({ block }: A2UIBlockProps) {
  const Component = resolve(block.component);

  if (!Component) {
    return (
      <div
        data-testid="a2ui-block"
        className="my-2 rounded-lg border border-surface-700/50 bg-surface-800/60 p-4 text-sm animate-fade-in"
      >
        <div className="flex items-center gap-2 text-surface-400 mb-2">
          <span className="font-mono text-xs bg-surface-700/50 rounded px-1.5 py-0.5">
            {block.component}
          </span>
          <span className="text-[10px] uppercase tracking-wider text-surface-500">Unknown Component</span>
        </div>
        <pre className="bg-surface-900 rounded-md p-2 text-xs text-surface-400 overflow-x-auto">
          {JSON.stringify(block.props, null, 2)}
        </pre>
      </div>
    );
  }

  return (
    <div data-testid="a2ui-block" className="my-2 animate-fade-in">
      <Component {...block.props} />
    </div>
  );
}
