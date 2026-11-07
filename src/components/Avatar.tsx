import React from 'react';
import { UserStatus } from '../lib/types';
import { StatusIndicator } from './StatusIndicator';
import { cn } from '../lib/utils';

interface AvatarProps {
  name: string;
  avatarUrl?: string;
  status?: UserStatus;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
}

const sizeClasses = {
  sm: 'w-7 h-7 text-xs',
  md: 'w-9 h-9 text-sm',
  lg: 'w-11 h-11 text-base',
  xl: 'w-14 h-14 text-lg font-semibold',
};

export const Avatar: React.FC<AvatarProps> = ({
  name,
  avatarUrl,
  status,
  size = 'md',
  className,
}) => {
  const initials = name
    .split(' ')
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();

  return (
    <div className={cn('relative inline-flex shrink-0 select-none', className)}>
      <div
        className={cn(
          'rounded-md bg-nexus-panel border border-nexus-border flex items-center justify-center font-medium text-nexus-text overflow-hidden',
          sizeClasses[size]
        )}
      >
        {avatarUrl ? (
          <img src={avatarUrl} alt={name} className="w-full h-full object-cover" />
        ) : (
          <span>{initials}</span>
        )}
      </div>
      {status && (
        <div className="absolute -bottom-0.5 -right-0.5">
          <StatusIndicator status={status} size={size === 'sm' ? 'sm' : 'md'} />
        </div>
      )}
    </div>
  );
};
