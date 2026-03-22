import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

interface A2UIErrorBoundaryProps {
  children: ReactNode;
  componentName: string;
}

interface A2UIErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class A2UIErrorBoundary extends Component<A2UIErrorBoundaryProps, A2UIErrorBoundaryState> {
  constructor(props: A2UIErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): A2UIErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[A2UIBlock] Render failed:', this.props.componentName, error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div
          data-testid="a2ui-block-error"
          className="my-2 rounded-lg border border-status-error/40 bg-status-error/5 p-4 text-sm animate-fade-in"
        >
          <div className="flex items-center gap-2 text-status-error mb-2">
            <span className="font-mono text-xs bg-status-error/10 rounded px-1.5 py-0.5">
              {this.props.componentName}
            </span>
            <span className="text-[10px] uppercase tracking-wider">Render Failed</span>
          </div>
          {this.state.error && (
            <p className="text-xs text-surface-300 break-words">{this.state.error.message}</p>
          )}
        </div>
      );
    }

    return this.props.children;
  }
}
