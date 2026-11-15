import React, { useEffect, useRef } from 'react';
import {
  Mic,
  MicOff,
  Headphones,
  Monitor,
  MonitorOff,
  Maximize2,
  PhoneOff,
  Volume2,
  PhoneCall,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import { useAppStore } from '../stores/useAppStore';
import { callService } from '../services/CallService';
import { screenCaptureService } from '../services/ScreenCaptureService';
import { Avatar } from './Avatar';
import { Tooltip } from './Tooltip';
import { ScreenSourcePickerModal } from './ScreenSourcePickerModal';
import { cn } from '../lib/utils';
import {
  formatLatencyMsMetric,
  formatSafeDurationSecs,
  sanitizeNonNegativeMetric,
} from '../lib/streamMetrics';

const DockCallDuration: React.FC = React.memo(() => {
  const secs = useAppStore((s) => s.callDurationSecs);
  return <>{formatSafeDurationSecs(secs)}</>;
});

export const FloatingCallDock: React.FC = () => {
  const activeTab = useAppStore((s) => s.activeTab);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const activeCommunityId = useAppStore((s) => s.activeCommunityId);
  const activeChannelId = useAppStore((s) => s.activeChannelId);
  const selectCommunity = useAppStore((s) => s.selectCommunity);
  const selectCommunityChannel = useAppStore((s) => s.selectCommunityChannel);
  const communities = useAppStore((s) => s.communities);
  const communitySnapshot = useAppStore((s) => s.communitySnapshot);
  const currentUser = useAppStore((s) => s.currentUser);
  const onlineUser = useAppStore((s) => s.onlineUser);

  // Voice Room state
  const voiceRoomState = useAppStore((s) => s.voiceRoomState);
  const activeVoiceCommunityId = useAppStore((s) => s.activeVoiceCommunityId);
  const activeVoiceChannelId = useAppStore((s) => s.activeVoiceChannelId);
  const voiceRoomParticipants = useAppStore((s) => s.voiceRoomParticipants);
  const communityVoiceRooms = useAppStore((s) => s.communityVoiceRooms);
  const voiceRoomMuted = useAppStore((s) => s.voiceRoomMuted);
  const voiceRoomDeafened = useAppStore((s) => s.voiceRoomDeafened);
  const voiceRoomScreenSharing = useAppStore((s) => s.voiceRoomScreenSharing);
  const voiceRoomCanSpeak = useAppStore((s) => s.voiceRoomCanSpeak);
  const voiceRoomCanScreenShare = useAppStore((s) => s.voiceRoomCanScreenShare);
  const voiceRoomQuality = useAppStore((s) => s.voiceRoomQuality);
  const voiceRoomMetrics = useAppStore((s) => s.voiceRoomMetrics);
  const voiceRoomError = useAppStore((s) => s.voiceRoomError);
  const nativeCaptureStatus = useAppStore((s) => s.nativeCaptureStatus);
  const joinVoiceChannel = useAppStore((s) => s.joinVoiceChannel);
  const leaveVoiceChannel = useAppStore((s) => s.leaveVoiceChannel);
  const toggleVoiceRoomMute = useAppStore((s) => s.toggleVoiceRoomMute);
  const toggleVoiceRoomDeafen = useAppStore((s) => s.toggleVoiceRoomDeafen);
  const startVoiceRoomScreenShare = useAppStore((s) => s.startVoiceRoomScreenShare);
  const stopVoiceRoomScreenShare = useAppStore((s) => s.stopVoiceRoomScreenShare);

  // 1:1 Call state
  const voiceCallState = useAppStore((s) => s.voiceCallState);
  const activeCallPeer = useAppStore((s) => s.activeCallPeer);
  const isMicMuted = useAppStore((s) => s.isMicMuted);
  const isDeafened = useAppStore((s) => s.isDeafened);
  const isLocalSpeaking = useAppStore((s) => s.isLocalSpeaking);
  const isRemoteSpeaking = useAppStore((s) => s.isRemoteSpeaking);
  const isScreenSharing = useAppStore((s) => s.isScreenSharing);
  const isRemoteScreenSharing = useAppStore((s) => s.isRemoteScreenSharing);
  const reconnectAttempt = useAppStore((s) => s.reconnectAttempt);
  const maxReconnectAttempts = useAppStore((s) => s.maxReconnectAttempts);

  // Global screen picker support
  const screenPickerTarget = useAppStore((s) => s.screenPickerTarget);
  const openScreenSourcePicker = useAppStore((s) => s.openScreenSourcePicker);
  const closeScreenSourcePicker = useAppStore((s) => s.closeScreenSourcePicker);
  const roomNameCacheRef = useRef<Record<string, string>>({});

  useEffect(() => {
    if (voiceRoomState === 'idle') {
      roomNameCacheRef.current = {};
    }
  }, [voiceRoomState]);

  useEffect(() => {
    if (
      (screenPickerTarget === 'room' && voiceRoomState !== 'connected') ||
      (screenPickerTarget === 'call' && voiceCallState !== 'connected')
    ) {
      closeScreenSourcePicker();
    }
  }, [screenPickerTarget, voiceRoomState, voiceCallState, closeScreenSourcePicker]);

  if (voiceRoomState === 'idle' && voiceCallState === 'idle') {
    return null;
  }

  const isRoomSession = voiceRoomState !== 'idle';

  // Hide dock while 1:1 call is still ringing incoming and user is not in a voice room (IncomingCallToast handles accept/decline)
  if (!isRoomSession && voiceCallState === 'incoming') {
    return null;
  }

  const selfUserId = onlineUser?.id || currentUser.id;
  const selfName =
    onlineUser?.displayName ||
    onlineUser?.username ||
    currentUser.displayName ||
    currentUser.username;
  const selfAvatar = onlineUser?.avatarUrl || currentUser.avatarUrl;

  const isViewingActiveVoiceRoom =
    activeTab === 'communities' &&
    Boolean(activeVoiceCommunityId) &&
    Boolean(activeVoiceChannelId) &&
    activeCommunityId === activeVoiceCommunityId &&
    activeChannelId === activeVoiceChannelId;

  const isSessionConnected = isRoomSession
    ? voiceRoomState === 'connected'
    : voiceCallState === 'connected';

  const lobbyParticipants =
    activeVoiceCommunityId && activeVoiceChannelId
      ? communityVoiceRooms[activeVoiceCommunityId]?.[activeVoiceChannelId] ?? []
      : [];
  const roomParticipants =
    voiceRoomParticipants.length > 0 ? voiceRoomParticipants : lobbyParticipants;
  const streamingParticipants =
    isRoomSession && isSessionConnected
      ? roomParticipants.filter((p) => p.is_screen_sharing)
      : [];

  const isLocalSharing =
    isSessionConnected &&
    (isRoomSession
      ? voiceRoomScreenSharing || Boolean(nativeCaptureStatus?.active)
      : isScreenSharing);

  const localInStreaming =
    isLocalSharing &&
    Boolean(selfUserId) &&
    streamingParticipants.some((p) => p.user_id === selfUserId);

  const streamingCount = !isSessionConnected
    ? 0
    : isRoomSession
    ? streamingParticipants.length + (isLocalSharing && !localInStreaming ? 1 : 0)
    : isScreenSharing || isRemoteScreenSharing
    ? 1
    : 0;

  const hasActiveStream = isSessionConnected && streamingCount > 0;

  const roomCommunityName = activeVoiceCommunityId
    ? communitySnapshot?.community.id === activeVoiceCommunityId
      ? communitySnapshot.community.name
      : communities.find((c) => c.id === activeVoiceCommunityId)?.name
    : undefined;

  const roomChannel =
    activeVoiceCommunityId && activeVoiceChannelId && communitySnapshot?.community.id === activeVoiceCommunityId
      ? communitySnapshot.channels.find((ch) => ch.id === activeVoiceChannelId)
      : undefined;

  if (activeVoiceChannelId && roomChannel?.name) {
    roomNameCacheRef.current[activeVoiceChannelId] = roomChannel.name;
  }
  const cachedRoomName = activeVoiceChannelId
    ? roomNameCacheRef.current[activeVoiceChannelId]
    : undefined;

  const displayTitle = isRoomSession
    ? roomChannel?.name || cachedRoomName || 'Canal de Voz'
    : activeCallPeer?.name || 'Chamada de Voz';

  const streamerName = isRoomSession
    ? streamingParticipants[0]?.display_name ||
      streamingParticipants[0]?.username ||
      (isLocalSharing ? selfName : undefined)
    : isSessionConnected && isRemoteScreenSharing
    ? activeCallPeer?.name
    : isLocalSharing
    ? selfName
    : undefined;

  const streamerAvatar = isRoomSession
    ? streamingParticipants[0]?.avatar_url ??
      (isLocalSharing ? selfAvatar : undefined)
    : isSessionConnected && isRemoteScreenSharing
    ? activeCallPeer?.avatarUrl
    : isLocalSharing
    ? selfAvatar
    : undefined;

  const isTransitioningState = isRoomSession
    ? voiceRoomState === 'joining' || voiceRoomState === 'reconnecting'
    : voiceCallState === 'calling' ||
      voiceCallState === 'connecting' ||
      voiceCallState === 'reconnecting';

  const isErrorState = isRoomSession && voiceRoomState === 'error';

  const handleOpenSession = () => {
    if (isRoomSession) {
      setActiveTab('communities');
      if (activeVoiceCommunityId && activeVoiceCommunityId !== activeCommunityId) {
        void selectCommunity(activeVoiceCommunityId).then(() => {
          if (activeVoiceChannelId) {
            void selectCommunityChannel(activeVoiceChannelId);
          }
        });
      } else if (activeVoiceChannelId && activeChannelId !== activeVoiceChannelId) {
        void selectCommunityChannel(activeVoiceChannelId);
      }
      return;
    }

    setActiveTab('calls');
  };

  const handleToggleMic = () => {
    if (isRoomSession) {
      toggleVoiceRoomMute();
    } else {
      callService.toggleMute();
    }
  };

  const handleToggleDeafen = () => {
    if (isRoomSession) {
      toggleVoiceRoomDeafen();
    } else {
      callService.toggleDeafen();
    }
  };

  const handleToggleScreenShare = async () => {
    if (isRoomSession) {
      if (voiceRoomScreenSharing) {
        await stopVoiceRoomScreenShare();
      } else if (screenCaptureService.isNativeCaptureSupported()) {
        await openScreenSourcePicker('room');
      } else {
        await startVoiceRoomScreenShare(voiceRoomQuality);
      }
      return;
    }

    if (isScreenSharing) {
      useAppStore.getState().stopScreenShare();
    } else if (screenCaptureService.isNativeCaptureSupported()) {
      await openScreenSourcePicker('call');
    } else {
      await useAppStore.getState().startScreenShare();
    }
  };

  const handleDisconnect = () => {
    if (isRoomSession) {
      void leaveVoiceChannel();
    } else {
      callService.endCall();
    }
  };

  const effectiveMuted = isRoomSession
    ? voiceRoomMuted
    : Boolean(isMicMuted || isDeafened);
  const micDisabled = isRoomSession && voiceRoomMuted && !voiceRoomCanSpeak;
  const selfParticipant = isRoomSession
    ? roomParticipants.find((p) => p.user_id === selfUserId)
    : undefined;
  const isSpeakingHighlight = isRoomSession
    ? Boolean(selfParticipant?.is_speaking && !effectiveMuted && voiceRoomState === 'connected')
    : Boolean(isLocalSpeaking && !effectiveMuted && voiceCallState === 'connected');

  const effectiveDeafened = isRoomSession ? voiceRoomDeafened : isDeafened;
  const effectiveScreenSharing = isRoomSession ? voiceRoomScreenSharing : isScreenSharing;
  const screenShareDisabled = isRoomSession
    ? !voiceRoomScreenSharing && (!voiceRoomCanScreenShare || voiceRoomState !== 'connected')
    : !isScreenSharing && voiceCallState !== 'connected';

  const showOpenButton = isRoomSession ? !isViewingActiveVoiceRoom : activeTab !== 'calls';

  const micTooltip = micDisabled
    ? 'Sem permissão para falar neste canal'
    : effectiveMuted
    ? 'Ativar microfone'
    : 'Silenciar microfone';

  const deafenTooltip = effectiveDeafened ? 'Ativar áudio' : 'Ensurdecer áudio';

  const screenTooltip = effectiveScreenSharing
    ? 'Parar compartilhamento de tela'
    : isRoomSession && !voiceRoomCanScreenShare
    ? 'Sem permissão para compartilhar tela neste canal'
    : (isRoomSession && voiceRoomState !== 'connected') ||
      (!isRoomSession && voiceCallState !== 'connected')
    ? 'Aguarde a conexão para compartilhar tela'
    : 'Compartilhar tela';

  const shouldRenderGlobalScreenPicker =
    (screenPickerTarget === 'room' && !isViewingActiveVoiceRoom) ||
    (screenPickerTarget === 'call' && activeTab !== 'calls');

  const avgRttMs = isRoomSession
    ? sanitizeNonNegativeMetric(voiceRoomMetrics?.avgRttMs)
    : null;

  const renderStatusLine = () => {
    if (isRoomSession) {
      if (voiceRoomState === 'joining') {
        return (
          <div className="flex items-center gap-1.5 text-[11px] text-amber-300 truncate">
            <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse motion-reduce:animate-none shrink-0" />
            <span className="truncate">Conectando à sala...</span>
          </div>
        );
      }
      if (voiceRoomState === 'reconnecting') {
        return (
          <div className="flex items-center gap-1.5 text-[11px] text-amber-300 truncate">
            <RefreshCw className="w-3 h-3 animate-spin motion-reduce:animate-none shrink-0" />
            <span className="truncate">Reconectando...</span>
          </div>
        );
      }
      if (voiceRoomState === 'error') {
        return (
          <div
            title={voiceRoomError || 'Erro na conexão'}
            className="flex items-center gap-1.5 text-[11px] text-rose-300 truncate"
          >
            <span className="w-2 h-2 rounded-full bg-[#E04F64] shrink-0" />
            <span className="truncate">{voiceRoomError || 'Erro na conexão'}</span>
          </div>
        );
      }
      return (
        <div className="flex items-center gap-1.5 text-[11px] text-zinc-300 truncate tabular-nums">
          <span className="w-2 h-2 rounded-full bg-[#10B981] shrink-0" />
          <span className="truncate">
            Conectado • {Math.max(1, roomParticipants.length)} em Voz
            {streamingCount > 0 ? ` • ${streamingCount} Transmitindo` : ''}
            {avgRttMs !== null && (
              <span className="hidden sm:inline text-zinc-400">
                {' '}
                • {formatLatencyMsMetric(avgRttMs)}
              </span>
            )}
          </span>
        </div>
      );
    }

    if (voiceCallState === 'calling') {
      return (
        <div className="flex items-center gap-1.5 text-[11px] text-amber-300 truncate">
          <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse motion-reduce:animate-none shrink-0" />
          <span className="truncate">Chamando...</span>
        </div>
      );
    }
    if (voiceCallState === 'connecting') {
      return (
        <div className="flex items-center gap-1.5 text-[11px] text-amber-300 truncate">
          <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse motion-reduce:animate-none shrink-0" />
          <span className="truncate">Conectando...</span>
        </div>
      );
    }
    if (voiceCallState === 'reconnecting') {
      const attemptLabel =
        reconnectAttempt > 0
          ? `Reconectando (${reconnectAttempt}/${maxReconnectAttempts})...`
          : 'Reconectando...';
      return (
        <div className="flex items-center gap-1.5 text-[11px] text-amber-300 truncate">
          <RefreshCw className="w-3 h-3 animate-spin motion-reduce:animate-none shrink-0" />
          <span className="truncate">{attemptLabel}</span>
        </div>
      );
    }

    return (
      <div className="flex items-center gap-1.5 text-[11px] text-zinc-300 truncate tabular-nums">
        <span className="w-2 h-2 rounded-full bg-[#10B981] shrink-0" />
        <span className="truncate">
          Conectado • <DockCallDuration />
          {isSessionConnected && (isScreenSharing || isRemoteScreenSharing)
            ? ' • Transmitindo'
            : ''}
        </span>
      </div>
    );
  };

  return (
    <>
      <div
        className="shrink-0 w-full px-3 pb-2.5 pt-1 bg-nexus-bg flex justify-center z-30 select-none"
        role="region"
        aria-label="Dock flutuante de chamada ativa"
      >
        <div className="w-full max-w-[740px] rounded-2xl border border-white/[0.1] bg-[#0E1018]/95 backdrop-blur-md shadow-[0_14px_40px_rgba(0,0,0,0.72)] ring-1 ring-[#C83E52]/20 px-2.5 py-2 flex items-center justify-between gap-2.5 sm:gap-3 animate-in fade-in slide-in-from-bottom-2 duration-200 motion-reduce:transition-none motion-reduce:animate-none">
          {/* Bloco Esquerdo: Mini-Stage / Status Tile + Informações */}
          <div className="flex items-center gap-2.5 min-w-0 flex-1">
            {hasActiveStream && (
              <button
                type="button"
                onClick={handleOpenSession}
                title={
                  streamerName
                    ? `Transmissão ao vivo de ${streamerName} • Abrir`
                    : 'Transmissão ao vivo • Abrir'
                }
                aria-label={
                  streamerName
                    ? `Abrir transmissão ao vivo de ${streamerName}`
                    : 'Abrir transmissão ao vivo'
                }
                className="hidden sm:flex w-20 sm:w-24 h-10 rounded-xl border border-[#C83E52]/40 bg-gradient-to-br from-[#2A101B] via-[#151726] to-[#0B0D14] relative overflow-hidden items-center justify-center gap-1.5 px-1.5 shrink-0 cursor-pointer hover:border-[#E04F64]/60 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nexus-accent/70"
              >
                {streamerName ? (
                  <Avatar
                    name={streamerName}
                    avatarUrl={streamerAvatar}
                    size="xs"
                    className="shrink-0 ring-1 ring-white/20"
                  />
                ) : (
                  <Monitor className="w-3.5 h-3.5 text-rose-200 shrink-0" />
                )}
                <span className="bg-[#C83E52] text-white text-[9px] font-extrabold uppercase px-1.5 py-0.5 rounded leading-none tracking-wider shrink-0">
                  LIVE
                </span>
              </button>
            )}

            <button
              type="button"
              onClick={handleOpenSession}
              title={
                isRoomSession
                  ? `${roomCommunityName ? `${roomCommunityName} · ` : ''}${displayTitle}`
                  : `Chamada com ${displayTitle}`
              }
              aria-label={isRoomSession ? `Abrir ${displayTitle}` : `Abrir chamada com ${displayTitle}`}
              className={cn(
                'w-9 h-9 rounded-xl border items-center justify-center shrink-0 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nexus-accent/70',
                hasActiveStream ? 'flex sm:hidden' : 'flex',
                hasActiveStream
                  ? 'border-[#C83E52]/40 bg-[#C83E52]/15 text-rose-200'
                  : isErrorState
                  ? 'border-rose-500/35 bg-rose-500/15 text-rose-300'
                  : isTransitioningState
                  ? 'border-amber-500/30 bg-amber-500/15 text-amber-300'
                  : !isRoomSession && isRemoteSpeaking && voiceCallState === 'connected'
                  ? 'border-emerald-500/50 bg-emerald-500/15 text-emerald-300'
                  : 'border-white/[0.08] bg-white/[0.04] hover:bg-white/[0.08] text-emerald-400'
              )}
            >
              {voiceRoomState === 'joining' ||
              voiceCallState === 'calling' ||
              voiceCallState === 'connecting' ? (
                <Loader2 className="w-4 h-4 animate-spin motion-reduce:animate-none" />
              ) : (isRoomSession && voiceRoomState === 'reconnecting') ||
                (!isRoomSession && voiceCallState === 'reconnecting') ? (
                <RefreshCw className="w-4 h-4 animate-spin motion-reduce:animate-none" />
              ) : isRoomSession ? (
                <Volume2 className="w-4 h-4" />
              ) : (
                <PhoneCall className="w-4 h-4" />
              )}
            </button>

            <button
              type="button"
              onClick={handleOpenSession}
              title={
                isRoomSession
                  ? `Abrir ${roomCommunityName ? `${roomCommunityName} / ` : ''}${displayTitle}`
                  : `Abrir chamada com ${displayTitle}`
              }
              className="min-w-0 flex-1 text-left rounded-lg px-1 py-0.5 hover:bg-white/[0.04] transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nexus-accent/70"
            >
              <div className="flex items-center gap-1.5 min-w-0">
                <span className="text-[13px] font-semibold text-white truncate">
                  {displayTitle}
                </span>
                {isRoomSession && roomCommunityName && (
                  <span className="hidden md:inline text-[11px] text-zinc-500 truncate">
                    · {roomCommunityName}
                  </span>
                )}
              </div>
              <div aria-live="polite" className="min-w-0">
                {renderStatusLine()}
              </div>
            </button>
          </div>

          {/* Controles Reais */}
          <div className="flex items-center gap-1.5 shrink-0">
            {isErrorState ? (
              <>
                <button
                  type="button"
                  onClick={() => {
                    if (activeVoiceCommunityId && activeVoiceChannelId) {
                      void joinVoiceChannel?.(activeVoiceCommunityId, activeVoiceChannelId);
                    }
                  }}
                  aria-label="Tentar novamente"
                  className="h-9 px-3 rounded-xl border border-amber-500/40 bg-amber-500/15 hover:bg-amber-500/25 text-amber-200 text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nexus-accent/70"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  <span>Tentar novamente</span>
                </button>
                <button
                  type="button"
                  onClick={() => void leaveVoiceChannel()}
                  aria-label="Dispensar"
                  className="h-9 px-3 rounded-xl bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.1] text-zinc-200 text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nexus-accent/70"
                >
                  <span>Dispensar</span>
                </button>
              </>
            ) : (
              <>
                <Tooltip content={micTooltip} position="top" portal>
                  <button
                    type="button"
                    onClick={handleToggleMic}
                    disabled={micDisabled}
                    aria-label={micTooltip}
                    aria-pressed={effectiveMuted}
                    className={cn(
                      'w-9 h-9 rounded-xl border flex items-center justify-center transition-colors cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nexus-accent/70',
                      effectiveMuted
                        ? 'bg-rose-500/20 border-rose-500/40 text-rose-300 hover:bg-rose-500/30'
                        : isSpeakingHighlight
                        ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/25'
                        : 'bg-white/[0.04] border-white/[0.08] text-zinc-200 hover:bg-white/[0.09]'
                    )}
                  >
                    {effectiveMuted ? (
                      <MicOff className="w-4 h-4" />
                    ) : (
                      <Mic className="w-4 h-4" />
                    )}
                  </button>
                </Tooltip>

                <Tooltip content={deafenTooltip} position="top" portal>
                  <button
                    type="button"
                    onClick={handleToggleDeafen}
                    aria-label={deafenTooltip}
                    aria-pressed={effectiveDeafened}
                    className={cn(
                      'w-9 h-9 rounded-xl border flex items-center justify-center transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nexus-accent/70',
                      effectiveDeafened
                        ? 'bg-rose-500/20 border-rose-500/40 text-rose-300 hover:bg-rose-500/30'
                        : 'bg-white/[0.04] border-white/[0.08] text-zinc-200 hover:bg-white/[0.09]'
                    )}
                  >
                    <Headphones className="w-4 h-4" />
                  </button>
                </Tooltip>

                <Tooltip content={screenTooltip} position="top" portal>
                  <button
                    type="button"
                    onClick={() => void handleToggleScreenShare()}
                    disabled={screenShareDisabled}
                    aria-label={screenTooltip}
                    aria-pressed={effectiveScreenSharing}
                    className={cn(
                      'w-9 h-9 rounded-xl border flex items-center justify-center transition-colors cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nexus-accent/70',
                      effectiveScreenSharing
                        ? 'bg-[#C83E52]/25 border-[#E04F64]/50 text-rose-100 hover:bg-[#C83E52]/35'
                        : 'bg-white/[0.04] border-white/[0.08] text-zinc-200 hover:bg-white/[0.09]'
                    )}
                  >
                    {effectiveScreenSharing ? (
                      <MonitorOff className="w-4 h-4" />
                    ) : (
                      <Monitor className="w-4 h-4" />
                    )}
                  </button>
                </Tooltip>

                {showOpenButton && (
                  <Tooltip
                    content={isRoomSession ? 'Abrir sala de voz' : 'Abrir tela da chamada'}
                    position="top"
                    portal
                  >
                    {isRoomSession ? (
                      <button
                        type="button"
                        onClick={handleOpenSession}
                        aria-label="Abrir sala de voz"
                        data-testid="dock-open-room-btn"
                        className="h-9 px-2.5 sm:px-3 rounded-xl border border-white/[0.08] bg-white/[0.06] hover:bg-white/[0.11] text-zinc-200 hover:text-white text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nexus-accent/70"
                      >
                        <Maximize2 className="w-3.5 h-3.5" />
                        <span className="hidden sm:inline">Abrir Sala</span>
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={handleOpenSession}
                        aria-label="Abrir tela da chamada"
                        className="w-9 h-9 rounded-xl border border-white/[0.08] bg-white/[0.04] hover:bg-white/[0.09] text-zinc-200 hover:text-white flex items-center justify-center transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nexus-accent/70"
                      >
                        <Maximize2 className="w-4 h-4" />
                      </button>
                    )}
                  </Tooltip>
                )}

                <Tooltip
                  content={isRoomSession ? 'Sair da sala de voz' : 'Encerrar chamada'}
                  position="top"
                  portal
                >
                  <button
                    type="button"
                    onClick={handleDisconnect}
                    aria-label={isRoomSession ? 'Sair da sala de voz' : 'Encerrar chamada'}
                    className="h-9 px-3 sm:px-3.5 rounded-xl bg-[#C83E52] hover:bg-[#E04F64] text-white text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nexus-accent/70"
                  >
                    <PhoneOff className="w-3.5 h-3.5" />
                    <span>Sair</span>
                  </button>
                </Tooltip>
              </>
            )}
          </div>
        </div>
      </div>

      {shouldRenderGlobalScreenPicker && <ScreenSourcePickerModal />}
    </>
  );
};
