import { resolve } from './CatalogRegistry';
import type { ApiA2UIBlock } from '@stablehand/shared';
import { A2UIErrorBoundary } from './A2UIErrorBoundary';
import { normalizeA2UIComponentName } from '@/lib/a2ui';

interface A2UIBlockProps {
  block: ApiA2UIBlock;
}

export function A2UIBlock({ block }: A2UIBlockProps) {
  const componentName = normalizeA2UIComponentName(block.component);
  const Component = resolve(componentName);

  if (!Component) {
    return (
      <div
        data-testid="a2ui-block"
        className="my-2 rounded-lg border border-surface-700/50 bg-surface-800/60 p-4 text-sm animate-fade-in"
      >
        <div className="flex items-center gap-2 text-surface-400 mb-2">
          <span className="font-mono text-xs bg-surface-700/50 rounded px-1.5 py-0.5">
            {componentName}
          </span>
          <span className="text-[10px] uppercase tracking-wider text-surface-400">Unknown Component</span>
        </div>
        <pre className="bg-surface-900 rounded-md p-2 text-xs text-surface-400 overflow-x-auto">
          {JSON.stringify(block.props, null, 2)}
        </pre>
      </div>
    );
  }

  return (
    <div data-testid="a2ui-block" className="my-2 animate-fade-in">
      <A2UIErrorBoundary componentName={componentName}>
        <Component {...block.props} />
      </A2UIErrorBoundary>
    </div>
  );
}
