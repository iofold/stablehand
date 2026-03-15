import { cn } from '@/lib/utils';

interface SkeletonProps {
  className?: string;
}

export function Skeleton({ className }: SkeletonProps) {
  return (
    <div
      data-testid="skeleton"
      className={cn('bg-surface-700/50 rounded-md animate-pulse', className)}
    />
  );
}
