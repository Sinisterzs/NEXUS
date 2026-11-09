import React, { useState, useEffect } from 'react';
import { UserStatus } from '../lib/types';
import { StatusIndicator } from './StatusIndicator';
import { useAppStore } from '../stores/useAppStore';
import { cn } from '../lib/utils';

export interface AvatarProps {
  name: string;
  avatarUrl?: string | null;
  status?: UserStatus;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
  showStatus?: boolean;
}

const sizeClasses = {
  xs: 'w-6 h-6 text-[10px]',
  sm: 'w-7 h-7 text-xs',
  md: 'w-9 h-9 text-sm',
  lg: 'w-11 h-11 text-base',
  xl: 'w-14 h-14 text-lg font-semibold',
};

const statusSizeMap: Record<'xs' | 'sm' | 'md' | 'lg' | 'xl', 'sm' | 'md' | 'lg'> = {
  xs: 'sm',
  sm: 'sm',
  md: 'md',
  lg: 'md',
  xl: 'lg',
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
  showStatus = true,
}) => {
  const [imgError, setImgError] = useState(false);
  const safeAvatarUrl = sanitizeAvatarUrl(avatarUrl);

  useEffect(() => {
    setImgError(false);
  }, [avatarUrl]);

  const initials = (name || '?')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase() || '?';

  return (
    <div className={cn('relative inline-flex shrink-0 select-none', className)}>
      <div
        className={cn(
          'rounded-lg bg-zinc-800/90 border border-zinc-700/60 flex items-center justify-center font-medium text-zinc-200 overflow-hidden shadow-inner',
          sizeClasses[size]
        )}
      >
        {safeAvatarUrl && !imgError ? (
          <img
            src={safeAvatarUrl}
            alt={name}
            onError={() => setImgError(true)}
            className="w-full h-full object-cover"
          />
        ) : (
          <span className="font-semibold text-zinc-300 tracking-tight">{initials}</span>
        )}
      </div>
      {status && showStatus && (
        <div className="absolute -bottom-0.5 -right-0.5">
          <StatusIndicator
            status={status}
            size={statusSizeMap[size]}
            className="ring-2 ring-zinc-950"
          />
        </div>
      )}
    </div>
  );
};

/**
 * Componente padronizado para exibir o avatar do usuário atualmente conectado.
 * Reutiliza a foto real do usuário autenticado persistida no store, com fallback para iniciais.
 */
export const CurrentUserAvatar: React.FC<{
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
  showStatus?: boolean;
}> = ({ size = 'sm', className, showStatus = true }) => {
  const currentUser = useAppStore((state) => state.currentUser);
  return (
    <Avatar
      name={currentUser.displayName || currentUser.username || 'Usuário'}
      avatarUrl={currentUser.avatarUrl}
      status={currentUser.status}
      size={size}
      className={className}
      showStatus={showStatus}
    />
  );
};
