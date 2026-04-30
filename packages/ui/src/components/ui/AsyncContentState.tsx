import type { ReactNode } from 'react';

type AsyncContentStateProps = {
  loading: boolean;
  error?: ReactNode;
  empty: boolean;
  loadingFallback: ReactNode;
  emptyFallback: ReactNode;
  children: ReactNode;
};

export function AsyncContentState({
  loading,
  error,
  empty,
  loadingFallback,
  emptyFallback,
  children,
}: AsyncContentStateProps) {
  if (loading) return <>{loadingFallback}</>;
  if (error) return <>{error}</>;
  if (empty) return <>{emptyFallback}</>;
  return <>{children}</>;
}
