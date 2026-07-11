import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface StatItem {
  label: ReactNode;
  value: ReactNode;
}

interface StatsRowProps {
  items: StatItem[];
  prominent?: boolean;
}

export function StatsRow({ items, prominent = false }: StatsRowProps) {
  return (
    <div className="mt-6 flex flex-col items-stretch divide-y divide-surface-700 sm:flex-row sm:divide-x sm:divide-y-0">
      {items.map((item, index) => (
        <div key={index} className="flex-1 p-4 first:pl-0">
          <p className="text-label">{item.label}</p>
          <p
            className={cn(
              'mt-1 tabular-nums text-surface-100',
              prominent ? 'text-3xl font-bold' : 'text-2xl font-semibold',
            )}
          >
            {item.value}
          </p>
        </div>
      ))}
    </div>
  );
}
