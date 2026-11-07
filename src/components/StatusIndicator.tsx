import React from 'react';
import { UserStatus } from '../lib/types';
import { cn } from '../lib/utils';

interface StatusIndicatorProps {
  status: UserStatus;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

const statusColors: Record<UserStatus, string> = {
  online: 'bg-emerald-500',
  idle: 'bg-amber-500',
  dnd: 'bg-rose-500',
  invisible: 'bg-zinc-400',
  offline: 'bg-slate-500',
};

const sizeClasses = {
  sm: 'w-2 h-2',
  md: 'w-2.5 h-2.5',
  lg: 'w-3 h-3',
};

export const StatusIndicator: React.FC<StatusIndicatorProps> = ({
  status,
  size = 'md',
  className,
}) => {
  return (
    <span
      className={cn(
        'rounded-full ring-2 ring-nexus-surface shrink-0',
        statusColors[status],
        sizeClasses[size],
        className
      )}
      title={`Status: ${status}`}
    />
  );
};
