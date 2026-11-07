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

export function sanitizeAvatarUrl(url?: string | null): string | undefined {
  if (!url || typeof url !== 'string') return undefined;
  const trimmed = url.trim();
  if (trimmed.length === 0) return undefined;

  // Strict rejection of script / dangerous protocols or control characters
  if (/[\x00-\x1f\x7f<>"'`]/.test(trimmed)) return undefined;
  if (/^javascript:/i.test(trimmed) || /^vbscript:/i.test(trimmed)) return undefined;

  // Permitted schemes: HTTPS, local dev HTTP, image data URLs, or relative paths
  if (
    trimmed.startsWith('https://') ||
    trimmed.startsWith('http://localhost') ||
    trimmed.startsWith('http://127.0.0.1') ||
    /^\/(?!\/)/.test(trimmed) ||
    /^data:image\/(png|jpeg|jpg|webp|gif);base64,/i.test(trimmed)
  ) {
    return trimmed;
  }

  return undefined;
}

export const Avatar: React.FC<AvatarProps> = ({
  name,
  avatarUrl,
  status,
  size = 'md',
  className,
}) => {
  const safeAvatarUrl = sanitizeAvatarUrl(avatarUrl);
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
        {safeAvatarUrl ? (
          <img src={safeAvatarUrl} alt={name} className="w-full h-full object-cover" />
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
