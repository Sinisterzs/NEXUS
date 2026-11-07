import React from 'react';
import { cn } from '../lib/utils';

interface BadgeProps {
  count?: number;
  dot?: boolean;
  className?: string;
}

export const Badge: React.FC<BadgeProps> = ({ count, dot, className }) => {
  if (dot) {
    return (
      <span
        className={cn(
          'w-2 h-2 rounded-full bg-nexus-accent ring-2 ring-nexus-surface shrink-0',
          className
        )}
      />
    );
  }

  if (!count || count <= 0) return null;

  return (
    <span
      className={cn(
        'px-1.5 py-0.5 text-[10px] font-bold rounded-full bg-nexus-accent text-white leading-none tracking-tight shrink-0',
        className
      )}
    >
      {count > 99 ? '99+' : count}
    </span>
  );
};
