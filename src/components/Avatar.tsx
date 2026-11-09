import React, { useState, useEffect } from 'react';
import { UserStatus } from '../lib/types';
import { StatusIndicator } from './StatusIndicator';
import { useAppStore } from '../stores/useAppStore';
import { cn } from '../lib/utils';

export interface AvatarProps {
  name: string;
  avatarUrl?: string | null;
  status?: UserStatus;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl';
  className?: string;
  shapeClassName?: string;
  showStatus?: boolean;
}

const sizeClasses = {
  xs: 'w-6 h-6 text-[10px]',
  sm: 'w-7 h-7 text-xs',
  md: 'w-9 h-9 text-sm',
  lg: 'w-11 h-11 text-base',
  xl: 'w-14 h-14 text-lg font-semibold',
  '2xl': 'w-16 h-16 text-xl font-bold',
};

const statusSizeMap: Record<'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl', 'sm' | 'md' | 'lg'> = {
  xs: 'sm',
  sm: 'sm',
  md: 'md',
  lg: 'md',
  xl: 'lg',
  '2xl': 'lg',
};

export function sanitizeAvatarUrl(url?: string | null): string | undefined {
  if (!url || typeof url !== 'string') return undefined;
  const trimmed = url.trim();
  if (trimmed.length === 0) return undefined;

  // Permitted image data URLs: strip whitespace / linebreaks inside payload and validate base64
  if (/^data:image\/(png|jpeg|jpg|webp|gif|svg\+xml);base64,/i.test(trimmed)) {
    const cleanDataUrl = trimmed.replace(/[\r\n\t\s]/g, '');
    const base64Part = cleanDataUrl.replace(/^data:image\/[^;]+;base64,/i, '');
    if (/^[A-Za-z0-9+/=]+$/.test(base64Part)) {
      return cleanDataUrl;
    }
  }

  // Strict rejection of script / dangerous protocols or control characters
  if (/[\x00-\x1f\x7f<>"'`]/.test(trimmed)) return undefined;
  if (/^javascript:/i.test(trimmed) || /^vbscript:/i.test(trimmed)) return undefined;

  // Permitted schemes: HTTPS, local dev HTTP, or relative paths
  if (
    trimmed.startsWith('https://') ||
    trimmed.startsWith('http://localhost') ||
    trimmed.startsWith('http://127.0.0.1') ||
    /^\/(?!\/)/.test(trimmed)
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
  shapeClassName,
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

  const defaultRounding =
    size === '2xl' ? 'rounded-2xl' : size === 'xl' || size === 'lg' ? 'rounded-xl' : 'rounded-lg';

  return (
    <div className={cn('relative inline-flex shrink-0 select-none', className)}>
      <div
        className={cn(
          shapeClassName || defaultRounding,
          'bg-zinc-800/90 border border-zinc-700/60 flex items-center justify-center font-medium text-zinc-200 overflow-hidden shadow-inner',
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
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl';
  className?: string;
  shapeClassName?: string;
  showStatus?: boolean;
}> = ({ size = 'sm', className, shapeClassName, showStatus = true }) => {
  const currentUser = useAppStore((state) => state.currentUser);
  const onlineUser = useAppStore((state) => state.onlineUser);
  const settingsAvatar = useAppStore((state) => state.settings?.profile?.avatarUrl);

  const effectiveAvatar =
    currentUser?.avatarUrl || onlineUser?.avatarUrl || settingsAvatar || undefined;

  return (
    <Avatar
      name={currentUser?.displayName || currentUser?.username || onlineUser?.displayName || onlineUser?.username || 'Usuário'}
      avatarUrl={effectiveAvatar}
      status={currentUser?.status}
      size={size}
      className={className}
      shapeClassName={shapeClassName}
      showStatus={showStatus}
    />
  );
};
