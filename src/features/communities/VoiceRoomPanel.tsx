import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  Loader2,
  Maximize2,
  MicOff,
  Minimize2,
  Monitor,
  RefreshCw,
  Users,
  Volume2,
  Wifi,
  X,
} from 'lucide-react';
import { useAppStore } from '../../stores/useAppStore';
import {
  CommunityChannelDto,
  RoomParticipantDto,
  VoiceRoomQualityPreset,
  VoiceRoomState,
} from '../../lib/types';
import type { ScreenReceiverState } from '../../services/MeshRoomService';
import {
  formatBitrateKbpsMetric,
  formatLatencyMsMetric,
  sanitizePositiveMetric,
} from '../../lib/streamMetrics';
import { cn } from '../../lib/utils';
import { bindScreenPlayback, updateScreenPlaybackAudio } from '../../services/ScreenPlayback';
import { Avatar } from '../../components/Avatar';
import {
  VoiceParticipantCard,
  VoiceParticipantLayoutMode,
} from '../../components/VoiceParticipantCard';
import {
  NativeLocalScreenPreview,
  NativeScreenShareBanner,
  ScreenSourcePickerModal,
} from '../../components/ScreenSourcePickerModal';

export interface VoiceRoomPanelProps {
  communityId: string;
  channel: CommunityChannelDto;
  canConnectVoice?: boolean;
}

interface AvailableVoiceStream {
  peerUserId: string;
  displayName: string;
  avatarUrl?: string;
  stream: MediaStream | null;
  receiverState: ScreenReceiverState | null;
  isReceiving: boolean;
}

const QUALITY_OPTIONS: Array<{ value: VoiceRoomQualityPreset; label: string }> = [
  { value: 'auto', label: 'Auto' },
  { value: '720p30', label: '720p 30fps' },
  { value: '720p60', label: '720p 60fps' },
  { value: '1080p30', label: '1080p 30fps' },
  { value: '1080p60', label: '1080p 60fps' },
];

function getParticipantLayoutMode(count: number): VoiceParticipantLayoutMode {
  if (count <= 1) return 'single';
  if (count === 2) return 'pair';
  if (count <= 4) return 'quad';
  return 'multi';
}

function getParticipantHeaderMaxWidthClass(
  mode: VoiceParticipantLayoutMode,
  count: number
): string {
  if (count === 0) return 'max-w-[420px] w-full mx-auto';
  switch (mode) {
    case 'single':
      return 'max-w-[420px] w-full mx-auto';
    case 'pair':
      return 'max-w-[780px] w-full mx-auto';
    case 'quad':
      return 'max-w-[860px] w-full mx-auto';
    case 'multi':
      return 'max-w-[1120px] w-full mx-auto';
  }
}

function getParticipantGridClassName(mode: VoiceParticipantLayoutMode): string {
  switch (mode) {
    case 'single':
      return 'grid grid-cols-1 max-w-[420px] w-full mx-auto gap-4';
    case 'pair':
      return 'grid grid-cols-1 sm:grid-cols-2 max-w-[780px] w-full mx-auto gap-4 sm:gap-5 items-stretch';
    case 'quad':
      return 'grid grid-cols-1 sm:grid-cols-2 max-w-[860px] w-full mx-auto gap-3.5 sm:gap-4 items-stretch';
    case 'multi':
      return 'grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 auto-rows-fr max-w-[1120px] w-full mx-auto gap-3 items-stretch';
  }
}

function getRoomStateMeta(state: VoiceRoomState): {
  label: string;
  badgeClass: string;
  spinning?: boolean;
} {
  switch (state) {
    case 'joining':
      return {
        label: 'Conectando...',
        badgeClass: 'bg-amber-500/15 border-amber-500/35 text-amber-300',
        spinning: true,
      };
    case 'connected':
      return {
        label: 'Conectado',
        badgeClass: 'bg-emerald-500/15 border-[#10b981]/40 text-emerald-300',
      };
    case 'reconnecting':
      return {
        label: 'Reconectando...',
        badgeClass: 'bg-amber-500/15 border-amber-500/35 text-amber-300',
        spinning: true,
      };
    case 'error':
      return {
        label: 'Erro',
        badgeClass: 'bg-[#e11d48]/15 border-[#e11d48]/45 text-rose-200',
      };
    default:
      return {
        label: 'Desconectado',
        badgeClass: 'bg-[#191d28] border-white/[0.08] text-zinc-400',
      };
  }
}

function getReceiverStatusLabel(receiverState: ScreenReceiverState | null): string {
  switch (receiverState) {
    case 'failed':
      return 'A conexão direta da tela falhou';
    case 'waiting_video':
      return 'Conectado, aguardando vídeo...';
    case 'connecting':
      return 'Conectando à transmissão...';
    default:
      return 'Transmissão disponível — aguardando vídeo...';
  }
}

interface StreamStagePlayerProps {
  stream: MediaStream;
  displayName: string;
  audioMuted: boolean;
  audioVolume: number;
  focusMode: boolean;
}

const StreamStagePlayer: React.FC<StreamStagePlayerProps> = ({
  stream,
  displayName,
  audioMuted,
  audioVolume,
  focusMode,
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [playBlocked, setPlayBlocked] = useState(false);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    setPlayBlocked(false);
    setPlaying(false);
    return bindScreenPlayback(el, stream, audioMuted, audioVolume, () => setPlayBlocked(true));
  }, [stream]);

  useEffect(() => {
    if (videoRef.current) {
      updateScreenPlaybackAudio(videoRef.current, audioMuted, audioVolume);
    }
  }, [stream, audioMuted, audioVolume]);

  return (
    <div
      className={cn(
        'relative w-full shrink-0 bg-[#06070a] flex items-center justify-center overflow-hidden',
        focusMode
          ? 'h-[clamp(240px,56vh,680px)]'
          : 'aspect-video max-h-[460px]'
      )}
    >
      <video
        ref={videoRef}
        onPlaying={() => setPlaying(true)}
        onWaiting={() => setPlaying(false)}
        onStalled={() => setPlaying(false)}
        onEmptied={() => setPlaying(false)}
        autoPlay
        playsInline
        muted={audioMuted}
        aria-label={`Transmissão de tela de ${displayName}`}
        className="w-full h-full object-contain bg-[#06070a]"
      />

      {playBlocked && (
        <button
          type="button"
          onClick={() => {
            void videoRef.current?.play().then(() => setPlayBlocked(false)).catch(() => {});
          }}
          className="absolute top-3 left-3 px-3 py-2 rounded-xl bg-[#13161f]/95 hover:bg-[#191d28] border border-white/15 text-xs font-medium text-white cursor-pointer transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e11d48]/70"
        >
          Reproduzir compartilhamento
        </button>
      )}

      {!playing && !playBlocked && (
        <div className="pointer-events-none absolute top-3 left-3 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[#0d0e13]/85 border border-white/[0.08] text-[11px] text-zinc-300">
          <Loader2 className="w-3 h-3 text-zinc-400 motion-safe:animate-spin motion-reduce:animate-none" />
          <span>Aguardando quadros...</span>
        </div>
      )}
    </div>
  );
};

/**
 * Redesigned community voice channel stage and participant view (NEXUS UI 3.0).
 * Defers global call actions (mic, deafen, screen share, disconnect) to FloatingCallDock.
 */
export const VoiceRoomPanel: React.FC<VoiceRoomPanelProps> = ({
  communityId,
  channel,
  canConnectVoice = true,
}) => {
  const voiceRoomState = useAppStore((s) => s.voiceRoomState ?? 'idle');
  const activeVoiceCommunityId = useAppStore((s) => s.activeVoiceCommunityId ?? null);
  const activeVoiceChannelId = useAppStore((s) => s.activeVoiceChannelId ?? null);
  const voiceRoomMaxParticipants = useAppStore((s) => s.voiceRoomMaxParticipants);
  const voiceRoomCanSpeak = useAppStore((s) => s.voiceRoomCanSpeak ?? true);
  const voiceRoomParticipants = useAppStore((s) => s.voiceRoomParticipants ?? []);
  const voiceRoomDeafened = useAppStore((s) => s.voiceRoomDeafened ?? false);
  const voiceRoomQuality = useAppStore((s) => s.voiceRoomQuality ?? 'auto');
  const voiceRoomPeerStatuses = useAppStore((s) => s.voiceRoomPeerStatuses ?? {});
  const voiceRoomRemoteStreams = useAppStore((s) => s.voiceRoomRemoteStreams ?? {});
  const voiceRoomParticipantVolumes = useAppStore((s) => s.voiceRoomParticipantVolumes ?? {});
  const voiceRoomMetrics = useAppStore((s) => s.voiceRoomMetrics ?? null);
  const screenReceivers = useAppStore((s) => s.voiceRoomScreenReceivers ?? {});
  const retryScreen = useAppStore((s) => s.retryVoiceRoomScreen);
  const voiceRoomError = useAppStore((s) => s.voiceRoomError ?? null);
  const communityVoiceRooms = useAppStore((s) => s.communityVoiceRooms ?? {});
  const currentUserId = useAppStore((s) => s.onlineUser?.id || s.currentUser?.id || '');

  const activeTextChannelId = useAppStore((s) => s.activeTextChannelId ?? null);
  const communitySnapshot = useAppStore((s) => s.communitySnapshot ?? null);
  const preferredVoiceStreamPeerId = useAppStore(
    (s) => s.preferredVoiceStreamPeerId ?? null
  );
  const setPreferredVoiceStreamPeerId = useAppStore(
    (s) => s.setPreferredVoiceStreamPeerId
  );
  const returnToCommunityTextChannel = useAppStore(
    (s) => s.returnToCommunityTextChannel
  );

  const joinVoiceChannel = useAppStore((s) => s.joinVoiceChannel);
  const setVoiceRoomParticipantVolume = useAppStore((s) => s.setVoiceRoomParticipantVolume);
  const setVoiceRoomQuality = useAppStore((s) => s.setVoiceRoomQuality);
  const clearVoiceRoomError = useAppStore((s) => s.clearVoiceRoomError);
  const screenPickerTarget = useAppStore((s) => s.screenPickerTarget ?? null);
  const nativeCaptureStatus = useAppStore((s) => s.nativeCaptureStatus ?? null);
  const nativeScreenStats = useAppStore((s) => s.nativeScreenStats ?? null);

  const [selectedStreamPeerId, setSelectedStreamPeerId] = useState<string | null>(null);
  const [focusMode, setFocusMode] = useState(false);
  const [focusParticipantsExpanded, setFocusParticipantsExpanded] = useState(false);

  const isThisChannelActive =
    activeVoiceCommunityId === communityId &&
    activeVoiceChannelId === channel.id &&
    voiceRoomState !== 'idle';
  const isJoiningThisChannel = isThisChannelActive && voiceRoomState === 'joining';
  const isConnectedOtherChannel =
    voiceRoomState !== 'idle' &&
    Boolean(activeVoiceChannelId) &&
    !isThisChannelActive;

  const lobbyParticipants: RoomParticipantDto[] =
    communityVoiceRooms[communityId]?.[channel.id] || [];
  const displayedParticipants: RoomParticipantDto[] = isThisChannelActive
    ? voiceRoomParticipants.length > 0
      ? voiceRoomParticipants
      : lobbyParticipants
    : lobbyParticipants;

  const availableStreams = useMemo<AvailableVoiceStream[]>(() => {
    if (!isThisChannelActive) return [];

    const orderedIds: string[] = [];
    const seen = new Set<string>();
    const addCandidate = (peerId: string) => {
      if (!peerId || peerId === currentUserId || seen.has(peerId)) return;
      seen.add(peerId);
      orderedIds.push(peerId);
    };

    for (const participant of displayedParticipants) {
      if (participant.is_screen_sharing && participant.user_id !== currentUserId) {
        addCandidate(participant.user_id);
      }
    }
    for (const peerId of Object.keys(voiceRoomRemoteStreams)) {
      addCandidate(peerId);
    }
    for (const [peerId, receiverState] of Object.entries(screenReceivers)) {
      if (receiverState && receiverState !== 'closed') {
        addCandidate(peerId);
      }
    }

    return orderedIds.map((peerUserId) => {
      const participant = displayedParticipants.find((p) => p.user_id === peerUserId);
      const stream = voiceRoomRemoteStreams[peerUserId] ?? null;
      const receiverState = screenReceivers[peerUserId] ?? null;
      return {
        peerUserId,
        displayName: participant?.display_name || participant?.username || 'Participante',
        avatarUrl: participant?.avatar_url ?? undefined,
        stream,
        receiverState,
        isReceiving: Boolean(stream),
      };
    });
  }, [
    isThisChannelActive,
    displayedParticipants,
    currentUserId,
    voiceRoomRemoteStreams,
    screenReceivers,
  ]);

  useEffect(() => {
    if (
      preferredVoiceStreamPeerId &&
      availableStreams.some((item) => item.peerUserId === preferredVoiceStreamPeerId)
    ) {
      setSelectedStreamPeerId(preferredVoiceStreamPeerId);
    }
  }, [preferredVoiceStreamPeerId, availableStreams]);

  useEffect(() => {
    if (availableStreams.length === 0) {
      setFocusMode(false);
      setFocusParticipantsExpanded(false);
    }
  }, [availableStreams.length]);

  useEffect(() => {
    if (!focusMode) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setFocusMode(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [focusMode]);

  const activeStream = useMemo<AvailableVoiceStream | null>(() => {
    if (availableStreams.length === 0) return null;
    if (preferredVoiceStreamPeerId) {
      const preferred = availableStreams.find(
        (item) => item.peerUserId === preferredVoiceStreamPeerId
      );
      if (preferred) return preferred;
    }
    if (selectedStreamPeerId) {
      const selected = availableStreams.find(
        (item) => item.peerUserId === selectedStreamPeerId
      );
      if (selected) return selected;
    }
    return availableStreams.find((item) => item.isReceiving) ?? availableStreams[0];
  }, [availableStreams, preferredVoiceStreamPeerId, selectedStreamPeerId]);

  const handleSelectStream = (peerUserId: string) => {
    setSelectedStreamPeerId(peerUserId);
    setPreferredVoiceStreamPeerId?.(peerUserId);
  };

  const handleRetryReceiver = (peerUserId: string) => {
    const retried = retryScreen?.(peerUserId) ?? false;
    if (!retried) {
      useAppStore.setState({
        voiceRoomError:
          'Aguarde 10 segundos para tentar novamente. Após três tentativas, peça ao transmissor para reiniciar a tela.',
      });
    }
  };

  const statusMeta = isThisChannelActive
    ? getRoomStateMeta(voiceRoomState)
    : getRoomStateMeta('idle');

  const activeTextChannel = useMemo(() => {
    const channels = communitySnapshot?.channels;
    if (!Array.isArray(channels)) return null;
    if (activeTextChannelId) {
      const matched = channels.find(
        (ch) => ch.id === activeTextChannelId && ch.channel_type === 'text'
      );
      if (matched) return matched;
    }
    return channels.find((ch) => ch.channel_type === 'text') ?? null;
  }, [communitySnapshot, activeTextChannelId]);

  const safeMaxParticipants = sanitizePositiveMetric(voiceRoomMaxParticipants);
  const layoutMode = getParticipantLayoutMode(displayedParticipants.length);
  const hasActiveStreamStage = Boolean(isThisChannelActive && activeStream);
  const joinDisabled = !canConnectVoice || isJoiningThisChannel;

  return (
    <div
      data-testid="voice-room-panel"
      className="flex-1 min-w-0 flex flex-col overflow-hidden bg-[#0d0e13]"
    >
      {/* Room Header (always visible, including Focus Mode) */}
      <header className="px-4 sm:px-5 py-3.5 border-b border-white/[0.08] bg-[#13161f]/95 backdrop-blur-md flex flex-wrap items-center justify-between gap-3 shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <button
            type="button"
            data-testid="voice-room-back-to-chat"
            onClick={() => returnToCommunityTextChannel?.()}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#191d28] hover:bg-white/[0.08] border border-white/[0.08] text-xs font-medium text-zinc-200 hover:text-white transition-colors motion-reduce:transition-none cursor-pointer shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e11d48]/70"
            title={
              activeTextChannel
                ? `Voltar para #${activeTextChannel.name} sem sair da sala de voz`
                : 'Voltar ao chat de texto sem sair da sala de voz'
            }
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>Voltar ao chat</span>
          </button>

          <div className="w-9 h-9 rounded-xl bg-[#191d28] border border-white/[0.08] flex items-center justify-center shrink-0">
            <Volume2 className="w-4 h-4 text-emerald-400" />
          </div>

          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="text-[15px] font-bold text-white truncate">{channel.name}</h3>

              <span
                className={cn(
                  'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-[11px] font-semibold shrink-0',
                  statusMeta.badgeClass
                )}
              >
                {statusMeta.spinning ? (
                  voiceRoomState === 'reconnecting' ? (
                    <RefreshCw className="w-3 h-3 motion-safe:animate-spin motion-reduce:animate-none" />
                  ) : (
                    <Loader2 className="w-3 h-3 motion-safe:animate-spin motion-reduce:animate-none" />
                  )
                ) : (
                  <Wifi className="w-3 h-3" />
                )}
                <span>{statusMeta.label}</span>
              </span>

              {hasActiveStreamStage && (
                <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-[#e11d48]/15 border border-[#e11d48]/45 text-[11px] font-semibold text-rose-200 shrink-0">
                  <span className="w-1.5 h-1.5 rounded-full bg-[#e11d48]" />
                  <span>
                    {availableStreams.length}{' '}
                    {availableStreams.length === 1 ? 'transmissão' : 'transmissões'}
                  </span>
                </span>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-0.5 text-[11px] text-zinc-400">
              <span className="inline-flex items-center gap-1">
                <Users className="w-3 h-3" />
                <span>
                  {displayedParticipants.length}
                  {isThisChannelActive && safeMaxParticipants !== null
                    ? ` / ${safeMaxParticipants}`
                    : ''}{' '}
                  participante(s)
                </span>
              </span>

              {isThisChannelActive && voiceRoomMetrics && (
                <span className="inline-flex items-center gap-2 tabular-nums text-[11px] text-zinc-400">
                  <span>RTT: {formatLatencyMsMetric(voiceRoomMetrics.avgRttMs, '—')}</span>
                  <span>↑ {formatBitrateKbpsMetric(voiceRoomMetrics.totalUploadKbps, '—')}</span>
                  <span>↓ {formatBitrateKbpsMetric(voiceRoomMetrics.totalDownloadKbps, '—')}</span>
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap shrink-0">
          {!isThisChannelActive ? (
            <button
              type="button"
              disabled={joinDisabled}
              onClick={() => void joinVoiceChannel(communityId, channel.id)}
              className="px-4 py-2 rounded-xl bg-[#e11d48] hover:bg-[#be123c] disabled:opacity-45 disabled:cursor-not-allowed text-white text-xs font-semibold flex items-center gap-2 transition-colors motion-reduce:transition-none cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e11d48]/70"
            >
              <Volume2 className="w-4 h-4" />
              <span>
                {!canConnectVoice
                  ? 'Sem permissão'
                  : isConnectedOtherChannel
                  ? 'Trocar para esta sala'
                  : 'Entrar na Sala'}
              </span>
            </button>
          ) : (
            <>
              {voiceRoomState === 'error' && (
                <button
                  type="button"
                  disabled={!canConnectVoice}
                  onClick={() => void joinVoiceChannel(communityId, channel.id)}
                  className="px-3.5 py-2 rounded-xl bg-[#e11d48] hover:bg-[#be123c] disabled:opacity-45 disabled:cursor-not-allowed text-white text-xs font-semibold flex items-center gap-1.5 transition-colors motion-reduce:transition-none cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e11d48]/70"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  <span>Tentar novamente</span>
                </button>
              )}

              <div className="flex items-center gap-2">
                <label
                  htmlFor="voice-room-quality"
                  className="text-[11px] text-zinc-400 whitespace-nowrap"
                >
                  Qualidade:
                </label>
                <select
                  id="voice-room-quality"
                  value={voiceRoomQuality}
                  onChange={(e) =>
                    void setVoiceRoomQuality(e.target.value as VoiceRoomQualityPreset)
                  }
                  className="px-2.5 py-1.5 rounded-xl bg-[#191d28] border border-white/[0.08] text-xs text-zinc-100 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e11d48]/70"
                >
                  {QUALITY_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
            </>
          )}
        </div>
      </header>

      {/* Error / Permission Banner */}
      {voiceRoomError && (
        <div
          role="alert"
          className="px-4 py-2.5 bg-[#e11d48]/10 border-b border-[#e11d48]/30 flex items-center justify-between gap-2 text-xs text-rose-200 shrink-0"
        >
          <div className="flex items-center gap-2 min-w-0">
            <AlertCircle className="w-4 h-4 text-[#e11d48] shrink-0" />
            <span className="truncate">{voiceRoomError}</span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {voiceRoomState === 'error' && canConnectVoice && (
              <button
                type="button"
                onClick={() => void joinVoiceChannel(communityId, channel.id)}
                className="px-2.5 py-1 rounded-lg bg-[#e11d48]/20 hover:bg-[#e11d48]/35 border border-[#e11d48]/40 text-[11px] font-semibold text-white cursor-pointer transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e11d48]/70"
              >
                Tentar novamente
              </button>
            )}
            <button
              type="button"
              onClick={clearVoiceRoomError}
              className="p-1 rounded-lg hover:bg-white/[0.08] text-rose-200 hover:text-white cursor-pointer shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e11d48]/70"
              title="Fechar aviso"
              aria-label="Fechar aviso"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      {!canConnectVoice && !isThisChannelActive && (
        <div className="px-4 py-2 bg-amber-500/10 border-b border-amber-500/30 flex items-center gap-2 text-xs text-amber-300 shrink-0">
          <AlertCircle className="w-4 h-4 text-amber-400 shrink-0" />
          <span>Você não tem permissão para se conectar a este canal de voz.</span>
        </div>
      )}

      {isThisChannelActive && nativeCaptureStatus?.active && !focusMode && (
        <NativeScreenShareBanner
          status={nativeCaptureStatus}
          stats={nativeScreenStats}
          className="mx-4 sm:mx-5 mt-3 shrink-0"
        />
      )}

      {/* Main Content */}
      <div className="flex-1 min-h-0 min-w-0 overflow-y-auto overflow-x-hidden flex flex-col gap-4 px-4 sm:px-6 pt-4 sm:pt-6 pb-24 sm:pb-28">
        {isThisChannelActive && nativeCaptureStatus?.active && !focusMode && (
          <div className="shrink-0">
            <NativeLocalScreenPreview status={nativeCaptureStatus} />
          </div>
        )}

        {/* Featured Stream Stage */}
        {hasActiveStreamStage && activeStream && (
          <section
            data-testid="voice-room-stream-stage"
            data-focus-mode={focusMode ? 'true' : 'false'}
            className={cn(
              'rounded-2xl border border-white/[0.08] bg-[#13161f] overflow-hidden shadow-[0_18px_48px_rgba(0,0,0,0.45)] flex flex-col min-w-0 shrink-0',
              focusMode && 'ring-1 ring-[#e11d48]/30'
            )}
          >
            {/* Stage Toolbar */}
            <div className="px-4 py-2.5 border-b border-white/[0.08] bg-[#191d28]/90 flex flex-wrap items-center justify-between gap-2.5">
              <div className="flex items-center gap-2.5 min-w-0">
                <Avatar
                  name={activeStream.displayName}
                  avatarUrl={activeStream.avatarUrl}
                  size="xs"
                  shapeClassName="rounded-lg"
                  showStatus={false}
                />
                <span className="text-[13px] font-semibold text-white truncate">
                  {activeStream.displayName}
                </span>
                {activeStream.isReceiving ? (
                  <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-[#e11d48]/20 border border-[#e11d48]/45 text-[10px] font-bold uppercase tracking-wider text-rose-100 shrink-0">
                    <span className="w-1.5 h-1.5 rounded-full bg-[#e11d48]" />
                    <span>Ao vivo</span>
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-[#13161f] border border-white/[0.08] text-[11px] font-medium text-zinc-300 shrink-0">
                    <Monitor className="w-3 h-3 text-zinc-400" />
                    <span>
                      {activeStream.receiverState === 'failed'
                        ? 'Falha'
                        : activeStream.receiverState === 'waiting_video'
                        ? 'Aguardando vídeo'
                        : activeStream.receiverState === 'connecting'
                        ? 'Conectando...'
                        : 'Disponível'}
                    </span>
                  </span>
                )}
              </div>

              <button
                type="button"
                data-testid="stream-focus-toggle"
                aria-pressed={focusMode}
                onClick={() => setFocusMode((prev) => !prev)}
                className={cn(
                  'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border text-xs font-medium transition-colors motion-reduce:transition-none cursor-pointer shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e11d48]/70',
                  focusMode
                    ? 'bg-[#e11d48]/20 border-[#e11d48]/45 text-rose-100 hover:bg-[#e11d48]/30'
                    : 'bg-[#13161f] border-white/[0.08] text-zinc-200 hover:bg-white/[0.06] hover:text-white'
                )}
              >
                {focusMode ? (
                  <>
                    <Minimize2 className="w-3.5 h-3.5" />
                    <span>Restaurar layout</span>
                  </>
                ) : (
                  <>
                    <Maximize2 className="w-3.5 h-3.5" />
                    <span>Focar transmissão</span>
                  </>
                )}
              </button>
            </div>

            {/* Stage Canvas */}
            {activeStream.stream ? (
              <StreamStagePlayer
                stream={activeStream.stream}
                displayName={activeStream.displayName}
                audioMuted={voiceRoomDeafened}
                audioVolume={(voiceRoomParticipantVolumes[activeStream.peerUserId] ?? 100) / 100}
                focusMode={focusMode}
              />
            ) : (
              <div
                className={cn(
                  'w-full bg-[#06070a] flex flex-col items-center justify-center p-6 text-center gap-3',
                  focusMode ? 'h-[clamp(240px,56vh,680px)]' : 'min-h-[260px]'
                )}
              >
                <div className="w-12 h-12 rounded-2xl bg-[#13161f] border border-white/[0.08] flex items-center justify-center">
                  {activeStream.receiverState === 'failed' ? (
                    <AlertCircle className="w-5 h-5 text-[#e11d48]" />
                  ) : (
                    <Monitor className="w-5 h-5 text-zinc-400" />
                  )}
                </div>
                <div className="space-y-1 max-w-md">
                  <p className="text-sm font-semibold text-white">{activeStream.displayName}</p>
                  <p className="text-xs text-zinc-400">
                    {getReceiverStatusLabel(activeStream.receiverState)}
                  </p>
                </div>
                {activeStream.receiverState === 'failed' && (
                  <button
                    type="button"
                    onClick={() => handleRetryReceiver(activeStream.peerUserId)}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-[#e11d48] hover:bg-[#be123c] text-white text-xs font-semibold transition-colors motion-reduce:transition-none cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e11d48]/70"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    <span>Reconectar vídeo</span>
                  </button>
                )}
              </div>
            )}

            {/* Multi-stream Selector Bar */}
            {availableStreams.length >= 2 && (
              <div
                data-testid="stream-selector-bar"
                className="px-3.5 py-2.5 border-t border-white/[0.08] bg-[#0d0e13]/90 flex flex-wrap items-center gap-2"
              >
                <span className="text-[11px] font-medium text-zinc-400 mr-1 shrink-0">
                  Transmissões ({availableStreams.length}):
                </span>
                {availableStreams.map((item) => {
                  const isSelected = activeStream.peerUserId === item.peerUserId;
                  return (
                    <button
                      key={item.peerUserId}
                      type="button"
                      aria-pressed={isSelected}
                      onClick={() => handleSelectStream(item.peerUserId)}
                      className={cn(
                        'inline-flex items-center gap-2 px-2.5 py-1.5 rounded-xl border text-xs font-medium transition-colors motion-reduce:transition-none cursor-pointer max-w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e11d48]/70',
                        isSelected
                          ? 'bg-[#191d28] border-[#e11d48]/55 text-white'
                          : 'bg-[#13161f] border-white/[0.08] text-zinc-300 hover:bg-white/[0.05] hover:text-white'
                      )}
                    >
                      <span className="truncate max-w-[140px]">{item.displayName}</span>
                      {item.isReceiving ? (
                        <span className="px-1.5 py-0.5 rounded-md bg-emerald-500/15 border border-[#10b981]/40 text-[10px] font-semibold text-emerald-300 shrink-0">
                          Recebendo
                        </span>
                      ) : item.receiverState === 'failed' ? (
                        <span className="px-1.5 py-0.5 rounded-md bg-[#e11d48]/15 border border-[#e11d48]/40 text-[10px] font-semibold text-rose-200 shrink-0">
                          Falha
                        </span>
                      ) : (
                        <span className="px-1.5 py-0.5 rounded-md bg-[#191d28] border border-white/[0.08] text-[10px] font-medium text-zinc-300 shrink-0">
                          Disponível
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </section>
        )}

        {/* Participants Grid / Compact Strip */}
        <section
          className={cn(
            'space-y-3 min-w-0 shrink-0',
            !hasActiveStreamStage && 'my-auto w-full flex flex-col justify-center'
          )}
        >
          <div
            className={cn(
              'flex flex-wrap items-center justify-between gap-2',
              !hasActiveStreamStage &&
                getParticipantHeaderMaxWidthClass(layoutMode, displayedParticipants.length)
            )}
          >
            <h4 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
              Participantes na sala ({displayedParticipants.length})
            </h4>

            <div className="flex items-center gap-2.5">
              {isThisChannelActive && !voiceRoomCanSpeak && (
                <span className="text-[11px] text-amber-300">
                  Modo ouvinte (sem permissão para falar)
                </span>
              )}

              {hasActiveStreamStage && focusMode && displayedParticipants.length > 0 && (
                <button
                  type="button"
                  onClick={() => setFocusParticipantsExpanded((prev) => !prev)}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-[#13161f] hover:bg-[#191d28] border border-white/[0.08] text-[11px] font-medium text-zinc-300 hover:text-white transition-colors motion-reduce:transition-none cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e11d48]/70"
                >
                  {focusParticipantsExpanded ? (
                    <>
                      <ChevronUp className="w-3.5 h-3.5" />
                      <span>Recolher participantes</span>
                    </>
                  ) : (
                    <>
                      <ChevronDown className="w-3.5 h-3.5" />
                      <span>Expandir participantes</span>
                    </>
                  )}
                </button>
              )}
            </div>
          </div>

          {displayedParticipants.length === 0 ? (
            <div
              className={cn(
                'rounded-2xl border border-dashed border-white/[0.08] bg-[#13161f]/75 p-8 text-center space-y-3',
                !hasActiveStreamStage && 'max-w-[420px] w-full mx-auto'
              )}
            >
              <div className="w-11 h-11 rounded-2xl bg-[#191d28] border border-white/[0.08] flex items-center justify-center mx-auto">
                {isJoiningThisChannel ? (
                  <Loader2 className="w-5 h-5 text-amber-300 motion-safe:animate-spin motion-reduce:animate-none" />
                ) : (
                  <Volume2 className="w-5 h-5 text-zinc-400" />
                )}
              </div>
              <div className="space-y-1">
                <p className="text-sm font-semibold text-zinc-100">
                  {isJoiningThisChannel
                    ? 'Conectando à sala de voz...'
                    : 'Ninguém conectado no momento'}
                </p>
                <p className="text-xs text-zinc-400">
                  {isJoiningThisChannel
                    ? 'Estabelecendo sinalização e preparando participantes.'
                    : 'Clique em "Entrar na Sala" para iniciar a chamada de voz em grupo.'}
                </p>
              </div>
              {!isThisChannelActive && canConnectVoice && (
                <button
                  type="button"
                  disabled={joinDisabled}
                  onClick={() => void joinVoiceChannel(communityId, channel.id)}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-[#e11d48] hover:bg-[#be123c] disabled:opacity-45 disabled:cursor-not-allowed text-white text-xs font-semibold transition-colors motion-reduce:transition-none cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e11d48]/70"
                >
                  <Volume2 className="w-4 h-4" />
                  <span>Entrar na Sala</span>
                </button>
              )}
            </div>
          ) : (
            <div
              data-testid="voice-participants-grid"
              data-layout-mode={layoutMode}
              data-participant-count={displayedParticipants.length}
              className={cn(
                hasActiveStreamStage
                  ? focusMode && !focusParticipantsExpanded
                    ? 'flex flex-wrap gap-2'
                    : 'grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 auto-rows-fr gap-2.5 items-stretch'
                  : getParticipantGridClassName(layoutMode)
              )}
            >
              {hasActiveStreamStage && focusMode && !focusParticipantsExpanded
                ? displayedParticipants.map((participant) => {
                    const isSelf = participant.user_id === currentUserId;
                    const displayName =
                      participant.display_name || participant.username || 'Usuário';
                    const isSpeaking = Boolean(
                      participant.is_speaking && !participant.is_muted
                    );
                    return (
                      <div
                        key={participant.user_id}
                        data-participant-id={participant.user_id}
                        data-speaking={isSpeaking ? 'true' : 'false'}
                        className={cn(
                          'inline-flex items-center gap-2 px-2.5 py-1.5 rounded-xl border bg-[#13161f] text-xs max-w-full transition-colors motion-reduce:transition-none',
                          isSpeaking
                            ? 'border-[#10b981]/70 text-white shadow-[0_0_12px_rgba(16,185,129,0.18)]'
                            : 'border-white/[0.08] text-zinc-200'
                        )}
                      >
                        <Avatar
                          name={displayName}
                          avatarUrl={participant.avatar_url}
                          size="xs"
                          shapeClassName="rounded-md"
                          showStatus={false}
                        />
                        <span className="font-medium truncate max-w-[130px]">
                          {displayName}
                        </span>
                        {isSelf && (
                          <span className="text-[10px] text-zinc-400 shrink-0">Você</span>
                        )}
                        {isSpeaking && (
                          <span className="w-2 h-2 rounded-full bg-[#10b981] shrink-0" />
                        )}
                        {participant.is_muted && (
                          <MicOff className="w-3 h-3 text-rose-400 shrink-0" />
                        )}
                      </div>
                    );
                  })
                : displayedParticipants.map((participant) => {
                    const isSelf = participant.user_id === currentUserId;
                    const peerStatus = isSelf
                      ? undefined
                      : voiceRoomPeerStatuses[participant.user_id];
                    const volume = voiceRoomParticipantVolumes[participant.user_id] ?? 100;
                    const rttMs =
                      !isSelf && voiceRoomMetrics?.peers[participant.user_id]
                        ? voiceRoomMetrics.peers[participant.user_id].rttMs
                        : null;

                    return (
                      <VoiceParticipantCard
                        key={participant.user_id}
                        participant={participant}
                        isSelf={isSelf}
                        peerStatus={peerStatus}
                        volume={volume}
                        rttMs={rttMs}
                        compact={hasActiveStreamStage}
                        layoutMode={!hasActiveStreamStage ? layoutMode : undefined}
                        onVolumeChange={
                          !isSelf && isThisChannelActive
                            ? (val) => setVoiceRoomParticipantVolume(participant.user_id, val)
                            : undefined
                        }
                      />
                    );
                  })}
            </div>
          )}
        </section>
      </div>

      {isThisChannelActive && screenPickerTarget === 'room' && <ScreenSourcePickerModal />}
    </div>
  );
};
