import React from 'react';
import {
  AlertCircle,
  Headphones,
  Loader2,
  Mic,
  MicOff,
  Monitor,
  RefreshCw,
  Volume2,
} from 'lucide-react';
import { RoomParticipantDto, VoiceRoomPeerStatus } from '../lib/types';
import { formatLatencyMsMetric, sanitizeNonNegativeMetric } from '../lib/streamMetrics';
import { cn } from '../lib/utils';
import { Avatar } from './Avatar';

export type VoiceParticipantLayoutMode = 'single' | 'pair' | 'quad' | 'multi';

export interface VoiceParticipantCardProps {
  participant: RoomParticipantDto;
  isSelf?: boolean;
  peerStatus?: VoiceRoomPeerStatus;
  volume?: number;
  rttMs?: number | null;
  onVolumeChange?: (volume: number) => void;
  compact?: boolean;
  layoutMode?: VoiceParticipantLayoutMode;
  cardBackground?: string;
  className?: string;
}

interface CardProportionPreset {
  containerClass: string;
  surfaceClass: string;
  avatarSize: 'sm' | 'lg' | 'xl' | '2xl';
  avatarRounding: string;
  ringRounding: string;
  nameClass: string;
}

const CARD_PROPORTIONS: Record<VoiceParticipantLayoutMode, CardProportionPreset> = {
  single: {
    containerClass: 'p-5 sm:p-6 rounded-2xl gap-4',
    surfaceClass: 'bg-gradient-to-b from-[#161a26] to-[#12151e] shadow-[0_14px_36px_rgba(0,0,0,0.42)]',
    avatarSize: '2xl',
    avatarRounding: 'rounded-2xl',
    ringRounding: 'rounded-2xl',
    nameClass: 'text-base sm:text-[17px] font-bold text-white truncate',
  },
  pair: {
    containerClass: 'h-full justify-between p-4 sm:p-5 rounded-2xl gap-3.5',
    surfaceClass: 'bg-[#13161f] shadow-[0_10px_28px_rgba(0,0,0,0.38)]',
    avatarSize: 'xl',
    avatarRounding: 'rounded-xl',
    ringRounding: 'rounded-xl',
    nameClass: 'text-[15px] font-bold text-white truncate',
  },
  quad: {
    containerClass: 'h-full justify-between p-4 sm:p-[18px] rounded-2xl gap-3',
    surfaceClass: 'bg-[#13161f] shadow-[0_8px_24px_rgba(0,0,0,0.35)]',
    avatarSize: 'xl',
    avatarRounding: 'rounded-xl',
    ringRounding: 'rounded-xl',
    nameClass: 'text-sm sm:text-[15px] font-semibold text-white truncate',
  },
  multi: {
    containerClass: 'h-full justify-between p-3.5 rounded-2xl gap-2.5',
    surfaceClass: 'bg-[#13161f] shadow-[0_8px_24px_rgba(0,0,0,0.35)]',
    avatarSize: 'lg',
    avatarRounding: 'rounded-xl',
    ringRounding: 'rounded-xl',
    nameClass: 'text-[13.5px] font-semibold text-white truncate',
  },
};

const COMPACT_PROPORTION: CardProportionPreset = {
  containerClass: 'rounded-xl px-3 py-2 gap-2',
  surfaceClass: 'bg-[#13161f] shadow-[0_8px_24px_rgba(0,0,0,0.35)]',
  avatarSize: 'sm',
  avatarRounding: 'rounded-lg',
  ringRounding: 'rounded-xl',
  nameClass: 'text-xs font-semibold text-zinc-100 truncate',
};

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
        toneClass: 'text-rose-300 bg-[#e11d48]/15 border-[#e11d48]/40',
        icon: 'error',
      };
    default:
      return null;
  }
}

/**
 * Displays a participant inside a community voice channel using real VAD speaking state,
 * real P2P connection status, sanitized RTT metrics, and individual remote audio volume.
 */
export const VoiceParticipantCard: React.FC<VoiceParticipantCardProps> = ({
  participant,
  isSelf = false,
  peerStatus,
  volume = 100,
  rttMs = null,
  onVolumeChange,
  compact = false,
  layoutMode,
  cardBackground,
  className,
}) => {
  const displayName = participant.display_name || participant.username || 'Usuário';
  const isSpeaking = Boolean(participant.is_speaking && !participant.is_muted);
  const cannotSpeak = participant.can_speak === false;
  const statusBadge = getPeerStatusBadge(peerStatus, isSelf);
  const hasValidRtt = !isSelf && sanitizeNonNegativeMetric(rttMs) !== null;
  const preset = compact
    ? COMPACT_PROPORTION
    : CARD_PROPORTIONS[layoutMode ?? 'multi'];
  const isSingleLayout = !compact && layoutMode === 'single';
  const ownAudioStateLabel = participant.is_deafened
    ? 'Áudio ensurdecido'
    : participant.is_muted
    ? 'Microfone mutado'
    : 'Microfone ativo';

  return (
    <div
      data-participant-id={participant.user_id}
      data-speaking={isSpeaking ? 'true' : 'false'}
      data-compact={compact ? 'true' : 'false'}
      data-layout-mode={layoutMode}
      style={cardBackground ? { background: cardBackground } : undefined}
      className={cn(
        'relative min-w-0 border transition-all duration-200 ease-out motion-reduce:transition-none flex flex-col',
        preset.containerClass,
        !cardBackground && preset.surfaceClass,
        isSpeaking
          ? 'border-[#10b981]/65 ring-1 ring-[#10b981]/25 shadow-[0_8px_24px_rgba(16,185,129,0.12)]'
          : 'border-white/[0.08] hover:border-white/[0.14]',
        className
      )}
    >
      <div className="flex flex-col gap-2.5 min-w-0">
        <div className="flex items-center justify-between gap-2.5 min-w-0">
          <div className="flex items-center gap-2.5 sm:gap-3 min-w-0 flex-1">
            <div
              className={cn(
                'p-0.5 transition-all duration-200 ease-out motion-reduce:transition-none shrink-0',
                preset.ringRounding,
                isSpeaking
                  ? 'ring-2 ring-[#10b981]/85 shadow-[0_0_10px_rgba(16,185,129,0.28)]'
                  : 'ring-1 ring-white/[0.06]'
              )}
            >
              <Avatar
                name={displayName}
                avatarUrl={participant.avatar_url}
                size={preset.avatarSize}
                shapeClassName={preset.avatarRounding}
                showStatus={false}
              />
            </div>

            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 min-w-0 flex-wrap">
                <span className={preset.nameClass}>
                  {displayName}
                </span>

                {isSelf && (
                  <span className="px-1.5 py-0.5 rounded-md bg-[#191d28] border border-white/[0.08] text-[10px] font-medium text-zinc-300 shrink-0">
                    Você
                  </span>
                )}

                {isSpeaking && (
                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-emerald-500/15 border border-[#10b981]/45 text-[10px] font-semibold text-emerald-300 shrink-0">
                    <span className="w-1.5 h-1.5 rounded-full bg-[#10b981] shrink-0" />
                    <span>Falando</span>
                  </span>
                )}

                {participant.is_screen_sharing && (
                  <span
                    className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-[#e11d48]/15 border border-[#e11d48]/45 text-[10px] font-semibold text-rose-200 shrink-0"
                    title="Transmitindo tela"
                  >
                    <Monitor className="w-2.5 h-2.5 text-[#e11d48]" />
                    <span>Ao vivo</span>
                  </span>
                )}
              </div>

              <div className="flex items-center gap-2 mt-0.5 min-w-0">
                <span className="text-[11px] text-zinc-400 font-mono truncate">
                  @{participant.username}
                </span>
                {hasValidRtt && (
                  <span className="text-[11px] text-zinc-400 tabular-nums shrink-0">
                    • {formatLatencyMsMetric(rttMs)}
                  </span>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            {participant.is_muted ? (
              <span
                title={cannotSpeak ? 'Sem permissão para falar neste canal' : 'Microfone mutado'}
                aria-label={cannotSpeak ? 'Sem permissão para falar neste canal' : 'Microfone mutado'}
                className={cn(
                  'p-1.5 rounded-lg border',
                  cannotSpeak
                    ? 'bg-amber-500/15 border-amber-500/30 text-amber-300'
                    : 'bg-[#e11d48]/15 border-[#e11d48]/35 text-rose-300'
                )}
              >
                <MicOff className="w-3.5 h-3.5" />
              </span>
            ) : (
              <span
                title={isSpeaking ? 'Falando' : 'Microfone ativo'}
                aria-label={isSpeaking ? 'Falando' : 'Microfone ativo'}
                className={cn(
                  'p-1.5 rounded-lg border transition-colors duration-200 motion-reduce:transition-none',
                  isSpeaking
                    ? 'bg-emerald-500/20 border-[#10b981]/50 text-emerald-300'
                    : 'bg-[#191d28] border-white/[0.08] text-zinc-400'
                )}
              >
                <Mic className="w-3.5 h-3.5" />
              </span>
            )}

            {participant.is_deafened && (
              <span
                title="Áudio ensurdecido (não ouve a sala)"
                aria-label="Áudio ensurdecido"
                className="p-1.5 rounded-lg bg-[#e11d48]/15 border border-[#e11d48]/35 text-rose-300 relative"
              >
                <Headphones className="w-3.5 h-3.5" />
                <span className="absolute inset-0 flex items-center justify-center pointer-events-none">
                  <span className="w-4 h-0.5 bg-[#e11d48] rotate-45 rounded-full" />
                </span>
              </span>
            )}
          </div>
        </div>

        {statusBadge && (
          <div
            className={cn(
              'inline-flex items-center gap-1.5 self-start px-2 py-0.5 rounded-md border text-[10px] font-medium',
              statusBadge.toneClass
            )}
          >
            {statusBadge.icon === 'spinner' && (
              <Loader2 className="w-3 h-3 motion-safe:animate-spin motion-reduce:animate-none" />
            )}
            {statusBadge.icon === 'reconnect' && (
              <RefreshCw className="w-3 h-3 motion-safe:animate-spin motion-reduce:animate-none" />
            )}
            {statusBadge.icon === 'error' && <AlertCircle className="w-3 h-3" />}
            <span>{statusBadge.label}</span>
          </div>
        )}
      </div>

      {!isSelf && onVolumeChange && (
        <div
          className={cn(
            'flex items-center gap-2 min-w-0',
            isSingleLayout
              ? 'rounded-xl bg-[#0d0e13]/60 border border-white/[0.06] px-3.5 py-2.5'
              : 'pt-2.5 border-t border-white/[0.06] min-h-[30px]'
          )}
        >
          <Volume2 className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
          <input
            type="range"
            min={0}
            max={200}
            step={1}
            value={volume}
            onChange={(e) => onVolumeChange(Number(e.target.value))}
            aria-label={`Volume de ${displayName}`}
            className="min-w-0 flex-1 h-1.5 accent-[#e11d48] cursor-pointer rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e11d48]/70"
          />
          <span className="text-[11px] font-medium text-zinc-300 tabular-nums w-10 text-right shrink-0">
            {volume}%
          </span>
        </div>
      )}

      {!compact && isSelf && (
        <div
          className={cn(
            'flex items-center justify-between gap-2 text-[11px] text-zinc-400 min-w-0',
            isSingleLayout
              ? 'rounded-xl bg-[#0d0e13]/60 border border-white/[0.06] px-3.5 py-2.5'
              : 'pt-2.5 border-t border-white/[0.06] min-h-[30px]'
          )}
        >
          <span className="truncate">{ownAudioStateLabel}</span>
          {participant.is_screen_sharing && (
            <span className="inline-flex items-center gap-1.5 text-rose-200 font-medium shrink-0">
              <span className="w-1.5 h-1.5 rounded-full bg-[#e11d48] shrink-0" />
              <span>Transmitindo tela</span>
            </span>
          )}
        </div>
      )}
    </div>
  );
};
