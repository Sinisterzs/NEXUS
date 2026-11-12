import React, { useEffect, useRef, useState } from 'react';
import {
  Volume2,
  Mic,
  MicOff,
  Headphones,
  PhoneOff,
  Monitor,
  MonitorOff,
  Users,
  AlertCircle,
  X,
  Loader2,
  Wifi,
  RefreshCw,
  Maximize2,
  Minimize2,
} from 'lucide-react';
import { useAppStore } from '../../stores/useAppStore';
import {
  CommunityChannelDto,
  RoomParticipantDto,
  VoiceRoomQualityPreset,
  VoiceRoomState,
} from '../../lib/types';
import { VoiceParticipantCard } from '../../components/VoiceParticipantCard';
import {
  NativeScreenShareBanner,
  ScreenSourcePickerModal,
} from '../../components/ScreenSourcePickerModal';
import { screenCaptureService } from '../../services/ScreenCaptureService';
import { cn } from '../../lib/utils';

export interface VoiceRoomPanelProps {
  communityId: string;
  channel: CommunityChannelDto;
  canConnectVoice?: boolean;
}

const QUALITY_OPTIONS: Array<{ value: VoiceRoomQualityPreset; label: string }> = [
  { value: 'auto', label: 'Auto' },
  { value: '720p30', label: '720p 30fps' },
  { value: '720p60', label: '720p 60fps' },
  { value: '1080p30', label: '1080p 30fps' },
  { value: '1080p60', label: '1080p 60fps' },
];

function getRoomStateMeta(state: VoiceRoomState): {
  label: string;
  badgeClass: string;
  spinning?: boolean;
} {
  switch (state) {
    case 'joining':
      return {
        label: 'Conectando à sala...',
        badgeClass: 'bg-amber-500/15 border-amber-500/30 text-amber-300',
        spinning: true,
      };
    case 'connected':
      return {
        label: 'Conectado',
        badgeClass: 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300',
      };
    case 'reconnecting':
      return {
        label: 'Reconectando...',
        badgeClass: 'bg-amber-500/15 border-amber-500/30 text-amber-300',
        spinning: true,
      };
    case 'error':
      return {
        label: 'Erro de conexão',
        badgeClass: 'bg-rose-500/15 border-rose-500/30 text-rose-300',
      };
    default:
      return {
        label: 'Desconectado',
        badgeClass: 'bg-nexus-panel border-nexus-border text-nexus-muted',
      };
  }
}

interface RemoteVideoTileProps {
  peerUserId: string;
  stream: MediaStream;
  displayName: string;
  isFocused: boolean;
  onToggleFocus: () => void;
}

const RemoteVideoTile: React.FC<RemoteVideoTileProps> = ({
  peerUserId,
  stream,
  displayName,
  isFocused,
  onToggleFocus,
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    if (el.srcObject !== stream) {
      el.srcObject = stream;
    }
    return () => {
      if (el.srcObject === stream) {
        el.srcObject = null;
      }
    };
  }, [stream]);

  return (
    <div
      data-peer-stream={peerUserId}
      className={cn(
        'relative rounded-xl overflow-hidden bg-black/80 border border-nexus-border group',
        isFocused ? 'col-span-full aspect-video max-h-[460px]' : 'aspect-video'
      )}
    >
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className="w-full h-full object-contain bg-black"
      />
      <div className="absolute inset-x-0 bottom-0 px-3 py-2 bg-gradient-to-t from-black/80 via-black/40 to-transparent flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-indigo-500/30 border border-indigo-400/40 text-[10px] font-semibold text-indigo-200 shrink-0">
            <Monitor className="w-3 h-3" />
            <span>Ao vivo</span>
          </span>
          <span className="text-xs font-medium text-white truncate">{displayName}</span>
        </div>

        <button
          type="button"
          onClick={onToggleFocus}
          className="p-1.5 rounded-md bg-black/50 hover:bg-black/75 text-white/90 hover:text-white transition-colors cursor-pointer shrink-0"
          title={isFocused ? 'Restaurar grade' : 'Expandir transmissão'}
        >
          {isFocused ? (
            <Minimize2 className="w-3.5 h-3.5" />
          ) : (
            <Maximize2 className="w-3.5 h-3.5" />
          )}
        </button>
      </div>
    </div>
  );
};

export const VoiceRoomPanel: React.FC<VoiceRoomPanelProps> = ({
  communityId,
  channel,
  canConnectVoice = true,
}) => {
  const voiceRoomState = useAppStore((s) => s.voiceRoomState);
  const activeVoiceCommunityId = useAppStore((s) => s.activeVoiceCommunityId);
  const activeVoiceChannelId = useAppStore((s) => s.activeVoiceChannelId);
  const voiceRoomMaxParticipants = useAppStore((s) => s.voiceRoomMaxParticipants);
  const voiceRoomCanSpeak = useAppStore((s) => s.voiceRoomCanSpeak);
  const voiceRoomCanScreenShare = useAppStore((s) => s.voiceRoomCanScreenShare);
  const voiceRoomParticipants = useAppStore((s) => s.voiceRoomParticipants);
  const voiceRoomMuted = useAppStore((s) => s.voiceRoomMuted);
  const voiceRoomDeafened = useAppStore((s) => s.voiceRoomDeafened);
  const voiceRoomScreenSharing = useAppStore((s) => s.voiceRoomScreenSharing);
  const voiceRoomQuality = useAppStore((s) => s.voiceRoomQuality);
  const voiceRoomPeerStatuses = useAppStore((s) => s.voiceRoomPeerStatuses);
  const voiceRoomRemoteStreams = useAppStore((s) => s.voiceRoomRemoteStreams);
  const voiceRoomParticipantVolumes = useAppStore((s) => s.voiceRoomParticipantVolumes);
  const voiceRoomMetrics = useAppStore((s) => s.voiceRoomMetrics);
  const voiceRoomError = useAppStore((s) => s.voiceRoomError);
  const communityVoiceRooms = useAppStore((s) => s.communityVoiceRooms);
  const currentUserId = useAppStore((s) => s.onlineUser?.id || s.currentUser.id);

  const joinVoiceChannel = useAppStore((s) => s.joinVoiceChannel);
  const leaveVoiceChannel = useAppStore((s) => s.leaveVoiceChannel);
  const toggleVoiceRoomMute = useAppStore((s) => s.toggleVoiceRoomMute);
  const toggleVoiceRoomDeafen = useAppStore((s) => s.toggleVoiceRoomDeafen);
  const setVoiceRoomParticipantVolume = useAppStore((s) => s.setVoiceRoomParticipantVolume);
  const startVoiceRoomScreenShare = useAppStore((s) => s.startVoiceRoomScreenShare);
  const stopVoiceRoomScreenShare = useAppStore((s) => s.stopVoiceRoomScreenShare);
  const setVoiceRoomQuality = useAppStore((s) => s.setVoiceRoomQuality);
  const clearVoiceRoomError = useAppStore((s) => s.clearVoiceRoomError);
  const screenPickerTarget = useAppStore((s) => s.screenPickerTarget);
  const nativeCaptureStatus = useAppStore((s) => s.nativeCaptureStatus);
  const nativeScreenStats = useAppStore((s) => s.nativeScreenStats);
  const openScreenSourcePicker = useAppStore((s) => s.openScreenSourcePicker);

  const [focusedPeerId, setFocusedPeerId] = useState<string | null>(null);

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

  const remoteStreamEntries = isThisChannelActive
    ? Object.entries(voiceRoomRemoteStreams)
    : [];

  useEffect(() => {
    if (focusedPeerId && !voiceRoomRemoteStreams[focusedPeerId]) {
      setFocusedPeerId(null);
    }
  }, [focusedPeerId, voiceRoomRemoteStreams]);

  const statusMeta = isThisChannelActive
    ? getRoomStateMeta(voiceRoomState)
    : getRoomStateMeta('idle');

  const handleToggleScreenShare = async () => {
    if (voiceRoomScreenSharing) {
      await stopVoiceRoomScreenShare();
    } else if (screenCaptureService.isNativeCaptureSupported()) {
      await openScreenSourcePicker('room');
    } else {
      await startVoiceRoomScreenShare(voiceRoomQuality);
    }
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-nexus-bg">
      {/* Room Header / Status & Metrics Bar */}
      <div className="px-5 py-3.5 border-b border-nexus-border bg-nexus-surface/60 flex flex-wrap items-center justify-between gap-3 shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-10 h-10 rounded-xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center shrink-0">
            <Volume2 className="w-5 h-5 text-emerald-400" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="text-sm font-bold text-nexus-text truncate">{channel.name}</h3>
              <span
                className={cn(
                  'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-[10px] font-semibold',
                  statusMeta.badgeClass
                )}
              >
                {statusMeta.spinning ? (
                  voiceRoomState === 'reconnecting' ? (
                    <RefreshCw className="w-3 h-3 animate-spin" />
                  ) : (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  )
                ) : (
                  <Wifi className="w-3 h-3" />
                )}
                <span>{statusMeta.label}</span>
              </span>
            </div>
            <div className="flex items-center gap-3 mt-0.5 text-[11px] text-nexus-muted">
              <span className="inline-flex items-center gap-1">
                <Users className="w-3 h-3" />
                <span>
                  {displayedParticipants.length}
                  {isThisChannelActive ? ` / ${voiceRoomMaxParticipants}` : ''} participante(s)
                </span>
              </span>

              {isThisChannelActive && voiceRoomMetrics && (
                <span className="inline-flex items-center gap-2 tabular-nums text-[10px] text-nexus-muted">
                  <span>
                    RTT:{' '}
                    {voiceRoomMetrics.avgRttMs !== null
                      ? `${Math.round(voiceRoomMetrics.avgRttMs)} ms`
                      : '--'}
                  </span>
                  <span>↑ {Math.round(voiceRoomMetrics.totalUploadKbps)} kbps</span>
                  <span>↓ {Math.round(voiceRoomMetrics.totalDownloadKbps)} kbps</span>
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {!isThisChannelActive ? (
            <button
              type="button"
              disabled={!canConnectVoice || isJoiningThisChannel}
              onClick={() => void joinVoiceChannel(communityId, channel.id)}
              className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-45 disabled:cursor-not-allowed text-white text-xs font-semibold flex items-center gap-2 transition-colors cursor-pointer"
            >
              <Volume2 className="w-4 h-4" />
              <span>
                {!canConnectVoice
                  ? 'Sem permissão'
                  : isConnectedOtherChannel
                  ? 'Trocar para este canal'
                  : 'Entrar no canal'}
              </span>
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void leaveVoiceChannel()}
              className="px-3.5 py-2 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer"
            >
              <PhoneOff className="w-3.5 h-3.5" />
              <span>Sair</span>
            </button>
          )}
        </div>
      </div>

      {/* Error / Permission Banner */}
      {voiceRoomError && (
        <div className="px-4 py-2.5 bg-rose-500/10 border-b border-rose-500/30 flex items-center justify-between gap-2 text-xs text-rose-300 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
            <span className="truncate">{voiceRoomError}</span>
          </div>
          <button
            type="button"
            onClick={clearVoiceRoomError}
            className="p-0.5 hover:text-white cursor-pointer shrink-0"
            title="Fechar aviso"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {!canConnectVoice && !isThisChannelActive && (
        <div className="px-4 py-2 bg-amber-500/10 border-b border-amber-500/30 flex items-center gap-2 text-xs text-amber-300 shrink-0">
          <AlertCircle className="w-4 h-4 text-amber-400 shrink-0" />
          <span>Você não tem permissão para se conectar a este canal de voz.</span>
        </div>
      )}

      {isThisChannelActive && nativeCaptureStatus?.active && (
        <NativeScreenShareBanner
          status={nativeCaptureStatus}
          stats={nativeScreenStats}
          onStop={() => void stopVoiceRoomScreenShare()}
          className="mx-5 mt-3 shrink-0"
        />
      )}

      {/* Main Content */}
      <div className="flex-1 overflow-y-auto p-5 space-y-5">
        {/* Remote Screen Share Grid (supports multiple simultaneous streamers) */}
        {remoteStreamEntries.length > 0 && (
          <section className="space-y-2.5">
            <div className="flex items-center justify-between">
              <h4 className="text-[11px] font-bold uppercase tracking-wider text-nexus-muted">
                Transmissões de tela ({remoteStreamEntries.length})
              </h4>
            </div>
            <div
              className={cn(
                'grid gap-3',
                remoteStreamEntries.length === 1 || focusedPeerId
                  ? 'grid-cols-1'
                  : 'grid-cols-1 lg:grid-cols-2'
              )}
            >
              {remoteStreamEntries.map(([peerUserId, stream]) => {
                const participant = displayedParticipants.find((p) => p.user_id === peerUserId);
                const name =
                  participant?.display_name || participant?.username || 'Participante';
                return (
                  <RemoteVideoTile
                    key={peerUserId}
                    peerUserId={peerUserId}
                    stream={stream}
                    displayName={name}
                    isFocused={focusedPeerId === peerUserId}
                    onToggleFocus={() =>
                      setFocusedPeerId((prev) => (prev === peerUserId ? null : peerUserId))
                    }
                  />
                );
              })}
            </div>
          </section>
        )}

        {/* Participants List */}
        <section className="space-y-2.5">
          <div className="flex items-center justify-between">
            <h4 className="text-[11px] font-bold uppercase tracking-wider text-nexus-muted">
              Participantes na sala ({displayedParticipants.length})
            </h4>
            {isThisChannelActive && !voiceRoomCanSpeak && (
              <span className="text-[10px] text-amber-300">
                Modo ouvinte (sem permissão para falar)
              </span>
            )}
          </div>

          {displayedParticipants.length === 0 ? (
            <div className="rounded-xl border border-dashed border-nexus-border bg-nexus-surface/40 p-8 text-center">
              <Volume2 className="w-7 h-7 text-nexus-muted/70 mx-auto mb-2" />
              <p className="text-xs font-medium text-nexus-text">
                Ninguém conectado no momento
              </p>
              <p className="text-[11px] text-nexus-muted mt-1">
                Clique em &quot;Entrar no canal&quot; para iniciar a chamada de voz em grupo.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
              {displayedParticipants.map((participant) => {
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

      {/* Bottom Controls Bar (visible when connected or joining this room) */}
      {isThisChannelActive && (
        <div className="px-5 py-3 border-t border-nexus-border bg-nexus-surface/80 flex flex-wrap items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={toggleVoiceRoomMute}
              disabled={voiceRoomMuted && !voiceRoomCanSpeak}
              title={
                voiceRoomMuted && !voiceRoomCanSpeak
                  ? 'Sem permissão para falar neste canal'
                  : voiceRoomMuted
                  ? 'Ativar microfone'
                  : 'Mutar microfone'
              }
              className={cn(
                'px-3 py-2 rounded-lg border text-xs font-medium flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed',
                voiceRoomMuted
                  ? 'bg-rose-500/15 border-rose-500/35 text-rose-300 hover:bg-rose-500/25'
                  : 'bg-nexus-panel border-nexus-border text-nexus-text hover:bg-nexus-bg'
              )}
            >
              {voiceRoomMuted ? (
                <MicOff className="w-4 h-4" />
              ) : (
                <Mic className="w-4 h-4 text-emerald-400" />
              )}
              <span>{voiceRoomMuted ? 'Mutado' : 'Microfone'}</span>
            </button>

            <button
              type="button"
              onClick={toggleVoiceRoomDeafen}
              title={voiceRoomDeafened ? 'Voltar a ouvir a sala' : 'Ensurdecer áudio da sala'}
              className={cn(
                'px-3 py-2 rounded-lg border text-xs font-medium flex items-center gap-1.5 transition-colors cursor-pointer',
                voiceRoomDeafened
                  ? 'bg-rose-500/15 border-rose-500/35 text-rose-300 hover:bg-rose-500/25'
                  : 'bg-nexus-panel border-nexus-border text-nexus-text hover:bg-nexus-bg'
              )}
            >
              <Headphones className="w-4 h-4" />
              <span>{voiceRoomDeafened ? 'Ensurdecido' : 'Ouvir'}</span>
            </button>

            <button
              type="button"
              onClick={() => void handleToggleScreenShare()}
              disabled={!voiceRoomScreenSharing && !voiceRoomCanScreenShare}
              title={
                !voiceRoomCanScreenShare
                  ? 'Sem permissão para compartilhar tela neste canal'
                  : voiceRoomScreenSharing
                  ? 'Parar compartilhamento de tela'
                  : 'Compartilhar tela'
              }
              className={cn(
                'px-3 py-2 rounded-lg border text-xs font-medium flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed',
                voiceRoomScreenSharing
                  ? 'bg-indigo-500/20 border-indigo-400/40 text-indigo-200 hover:bg-indigo-500/30'
                  : 'bg-nexus-panel border-nexus-border text-nexus-text hover:bg-nexus-bg'
              )}
            >
              {voiceRoomScreenSharing ? (
                <MonitorOff className="w-4 h-4" />
              ) : (
                <Monitor className="w-4 h-4" />
              )}
              <span>{voiceRoomScreenSharing ? 'Parar tela' : 'Compartilhar tela'}</span>
            </button>
          </div>

          <div className="flex items-center gap-2">
            <label
              htmlFor="voice-room-quality"
              className="text-[11px] text-nexus-muted whitespace-nowrap"
            >
              Qualidade:
            </label>
            <select
              id="voice-room-quality"
              value={voiceRoomQuality}
              onChange={(e) => void setVoiceRoomQuality(e.target.value as VoiceRoomQualityPreset)}
              className="px-2.5 py-1.5 rounded-lg bg-nexus-panel border border-nexus-border text-xs text-nexus-text focus:outline-none focus:border-nexus-accent cursor-pointer"
            >
              {QUALITY_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      {screenPickerTarget === 'room' && <ScreenSourcePickerModal />}
    </div>
  );
};
