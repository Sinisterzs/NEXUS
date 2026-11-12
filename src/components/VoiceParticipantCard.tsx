import React from 'react';
import {
  Mic,
  MicOff,
  Headphones,
  Monitor,
  Volume2,
  Loader2,
  AlertCircle,
  RefreshCw,
} from 'lucide-react';
import { RoomParticipantDto, VoiceRoomPeerStatus } from '../lib/types';
import { Avatar } from './Avatar';
import { cn } from '../lib/utils';

export interface VoiceParticipantCardProps {
  participant: RoomParticipantDto;
  isSelf?: boolean;
  peerStatus?: VoiceRoomPeerStatus;
  volume?: number;
  rttMs?: number | null;
  onVolumeChange?: (volume: number) => void;
  cardBackground?: string;
  className?: string;
}

function getPeerStatusBadge(
  peerStatus?: VoiceRoomPeerStatus,
  isSelf?: boolean
): { label: string; toneClass: string; icon?: 'spinner' | 'reconnect' | 'error' } | null {
  if (isSelf || !peerStatus || peerStatus === 'connected') return null;

  switch (peerStatus) {
    case 'new':
    case 'connecting':
      return {
        label: 'Conectando...',
        toneClass: 'text-amber-300 bg-amber-500/15 border-amber-500/30',
        icon: 'spinner',
      };
    case 'reconnecting':
    case 'disconnected':
      return {
        label: 'Reconectando...',
        toneClass: 'text-amber-300 bg-amber-500/15 border-amber-500/30',
        icon: 'reconnect',
      };
    case 'failed':
    case 'closed':
      return {
        label: 'Falha na conexão',
        toneClass: 'text-rose-300 bg-rose-500/15 border-rose-500/30',
        icon: 'error',
      };
    default:
      return null;
  }
}

export const VoiceParticipantCard: React.FC<VoiceParticipantCardProps> = ({
  participant,
  isSelf = false,
  peerStatus,
  volume = 100,
  rttMs = null,
  onVolumeChange,
  cardBackground,
  className,
}) => {
  const displayName = participant.display_name || participant.username || 'Usuário';
  const isSpeaking = Boolean(participant.is_speaking && !participant.is_muted);
  const cannotSpeak = participant.can_speak === false;
  const statusBadge = getPeerStatusBadge(peerStatus, isSelf);

  return (
    <div
      style={cardBackground ? { background: cardBackground } : undefined}
      className={cn(
        'rounded-xl border px-3 py-2.5 transition-colors flex flex-col gap-2',
        !cardBackground && 'bg-nexus-surface/90',
        isSpeaking
          ? 'border-emerald-500/70 ring-1 ring-emerald-500/35'
          : 'border-nexus-border hover:border-nexus-border/80',
        className
      )}
    >
      <div className="flex items-center justify-between gap-2.5 min-w-0">
        <div className="flex items-center gap-2.5 min-w-0">
          <div
            className={cn(
              'rounded-xl p-0.5 transition-shadow shrink-0',
              isSpeaking
                ? 'ring-2 ring-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.35)]'
                : 'ring-1 ring-transparent'
            )}
          >
            <Avatar
              name={displayName}
              avatarUrl={participant.avatar_url}
              size="md"
              showStatus={false}
            />
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 min-w-0">
              <span className="text-xs font-semibold text-nexus-text truncate">
                {displayName}
              </span>
              {isSelf && (
                <span className="px-1.5 py-0.5 rounded bg-nexus-panel border border-nexus-border text-[9px] font-medium text-nexus-muted shrink-0">
                  Você
                </span>
              )}
              {participant.is_screen_sharing && (
                <span
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-indigo-500/20 border border-indigo-500/40 text-[9px] font-semibold text-indigo-300 shrink-0"
                  title="Transmitindo tela"
                >
                  <Monitor className="w-2.5 h-2.5" />
                  <span>Ao vivo</span>
                </span>
              )}
            </div>

            <div className="flex items-center gap-2 mt-0.5">
              <span className="text-[10px] text-nexus-muted truncate">
                @{participant.username}
              </span>
              {!isSelf && rttMs !== null && Number.isFinite(rttMs) && (
                <span className="text-[10px] text-nexus-muted tabular-nums shrink-0">
                  {Math.round(rttMs)} ms
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {participant.is_muted ? (
            <span
              title={cannotSpeak ? 'Sem permissão para falar neste canal' : 'Microfone mutado'}
              className={cn(
                'p-1 rounded-md border',
                cannotSpeak
                  ? 'bg-amber-500/15 border-amber-500/30 text-amber-300'
                  : 'bg-rose-500/15 border-rose-500/30 text-rose-300'
              )}
            >
              <MicOff className="w-3.5 h-3.5" />
            </span>
          ) : (
            <span
              title={isSpeaking ? 'Falando' : 'Microfone ativo'}
              className={cn(
                'p-1 rounded-md border',
                isSpeaking
                  ? 'bg-emerald-500/20 border-emerald-500/40 text-emerald-300'
                  : 'bg-nexus-panel/70 border-nexus-border text-nexus-muted'
              )}
            >
              <Mic className="w-3.5 h-3.5" />
            </span>
          )}

          {participant.is_deafened && (
            <span
              title="Áudio ensurdecido (não ouve a sala)"
              className="p-1 rounded-md bg-rose-500/15 border border-rose-500/30 text-rose-300 relative"
            >
              <Headphones className="w-3.5 h-3.5" />
              <span className="absolute inset-0 flex items-center justify-center">
                <span className="w-4 h-0.5 bg-rose-400 rotate-45 rounded-full" />
              </span>
            </span>
          )}
        </div>
      </div>

      {statusBadge && (
        <div
          className={cn(
            'inline-flex items-center gap-1.5 self-start px-2 py-0.5 rounded border text-[10px] font-medium',
            statusBadge.toneClass
          )}
        >
          {statusBadge.icon === 'spinner' && <Loader2 className="w-3 h-3 animate-spin" />}
          {statusBadge.icon === 'reconnect' && <RefreshCw className="w-3 h-3 animate-spin" />}
          {statusBadge.icon === 'error' && <AlertCircle className="w-3 h-3" />}
          <span>{statusBadge.label}</span>
        </div>
      )}

      {!isSelf && onVolumeChange && (
        <div className="flex items-center gap-2 pt-1 border-t border-nexus-border/50">
          <Volume2 className="w-3.5 h-3.5 text-nexus-muted shrink-0" />
          <input
            type="range"
            min={0}
            max={200}
            step={1}
            value={volume}
            onChange={(e) => onVolumeChange(Number(e.target.value))}
            aria-label={`Volume de ${displayName}`}
            className="flex-1 h-1.5 accent-nexus-accent cursor-pointer"
          />
          <span className="text-[10px] font-medium text-nexus-muted tabular-nums w-9 text-right shrink-0">
            {volume}%
          </span>
        </div>
      )}
    </div>
  );
};
