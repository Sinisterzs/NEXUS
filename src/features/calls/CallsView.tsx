import { bindScreenPlayback } from '../../services/ScreenPlayback';
import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Mic,
  MicOff,
  Headphones,
  PhoneOff,
  Phone,
  PhoneIncoming,
  PhoneOutgoing,
  PhoneMissed,
  Radio,
  Sliders,
  AlertCircle,
  Loader2,
  Trash2,
  ScreenShare,
  ScreenShareOff,
  Monitor,
  Maximize2,
  Minimize2,
  Volume2,
  VolumeX,
  Activity,
  ChevronUp,
  GripHorizontal,
  Sparkles,
  X,
  PanelLeftClose,
  PanelLeftOpen,
} from 'lucide-react';
import { useAppStore } from '../../stores/useAppStore';
import { callService } from '../../services/CallService';
import { audioDeviceService, AudioDeviceInfo } from '../../services/AudioDeviceService';
import { WebRtcTransportDiagnostics } from '../../services/WebRtcService';
import { callHistoryRepository, CallHistoryEntry } from '../../repositories/CallHistoryRepository';
import { ScreenShareQualityPreset } from '../../lib/types';
import { SCREEN_CAPTURE_SELECTION_NOTICE } from '../../lib/screenCapturePolicy';
import { Avatar } from '../../components/Avatar';
import { Tooltip } from '../../components/Tooltip';
import { EmptyState } from '../../components/EmptyState';
import {
  NativeScreenShareBanner,
  NativeLocalScreenPreview,
  ScreenSourcePickerModal,
} from '../../components/ScreenSourcePickerModal';
import { screenCaptureService } from '../../services/ScreenCaptureService';
import {
  CallLayoutMode,
  CALL_LAYOUT_PRESETS,
} from '../../lib/callsLayout';

function formatDuration(totalSeconds: number): string {
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

/**
 * Subcomponente isolado e memoizado para o cronômetro da chamada.
 * Evita que o CallsView inteiro (~1500 linhas) sofra re-render a cada 1 segundo (Problem 4).
 */
const CallDurationBadge: React.FC<{
  voiceCallState: string;
  reconnectAttempt: number;
  maxReconnectAttempts: number;
}> = React.memo(({ voiceCallState, reconnectAttempt, maxReconnectAttempts }) => {
  const callDurationSecs = useAppStore((state) => state.callDurationSecs);
  return (
    <div className="flex items-center gap-2 px-2.5 py-1 rounded-lg bg-nexus-panel border border-nexus-border text-[11px] font-mono select-none">
      <span
        className={`w-2 h-2 rounded-full ${
          voiceCallState === 'reconnecting'
            ? 'bg-amber-400 animate-ping'
            : 'bg-emerald-500 animate-pulse'
        }`}
      />
      <span
        className={
          voiceCallState === 'reconnecting'
            ? 'text-amber-400 font-bold'
            : 'text-emerald-400 font-bold'
        }
      >
        {voiceCallState === 'reconnecting'
          ? `Reconectando (${Math.max(1, reconnectAttempt)}/${maxReconnectAttempts})...`
          : formatDuration(callDurationSecs)}
      </span>
    </div>
  );
});

function formatHistoryTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const isToday =
    date.getDate() === now.getDate() &&
    date.getMonth() === now.getMonth() &&
    date.getFullYear() === now.getFullYear();

  const timeStr = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  if (isToday) {
    return `Hoje às ${timeStr}`;
  }

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday =
    date.getDate() === yesterday.getDate() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getFullYear() === yesterday.getFullYear();

  if (isYesterday) {
    return `Ontem às ${timeStr}`;
  }

  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${day}/${month} às ${timeStr}`;
}

const QUALITY_PRESET_OPTIONS: {
  id: ScreenShareQualityPreset;
  label: string;
  shortLabel: string;
  desc: string;
}[] = [
  { id: 'auto', label: 'Automático (Adaptativo)', shortLabel: 'Auto', desc: 'Até 1080p / 30 FPS' },
  { id: '720p30', label: '720p • 30 FPS', shortLabel: '720p30', desc: 'Equilíbrio e baixo uso de CPU' },
  { id: '720p60', label: '720p • 60 FPS', shortLabel: '720p60', desc: 'Fluidez para jogos com menor banda' },
  { id: '1080p30', label: '1080p • 30 FPS', shortLabel: '1080p30', desc: 'Alta nitidez para texto e código' },
  { id: '1080p60', label: '1080p • 60 FPS', shortLabel: '1080p60', desc: 'Alta fluidez para vídeos e jogos' },
];

export const CallsView: React.FC = () => {
  const voiceCallState = useAppStore((state) => state.voiceCallState);
  const activeCallPeer = useAppStore((state) => state.activeCallPeer);
  const incomingCall = useAppStore((state) => state.incomingCall);
  const isMicMuted = useAppStore((state) => state.isMicMuted);
  const isDeafened = useAppStore((state) => state.isDeafened);
  const isLocalSpeaking = useAppStore((state) => state.isLocalSpeaking);
  const isRemoteSpeaking = useAppStore((state) => state.isRemoteSpeaking);
  const isPeerMuted = useAppStore((state) => state.isPeerMuted);
  const callErrorMessage = useAppStore((state) => state.callErrorMessage);
  const setCallErrorMessage = useAppStore((state) => state.setCallErrorMessage);
  const callDeviceNotice = useAppStore((state) => state.callDeviceNotice);
  const setCallDeviceNotice = useAppStore((state) => state.setCallDeviceNotice);
  const reconnectAttempt = useAppStore((state) => state.reconnectAttempt);
  const maxReconnectAttempts = useAppStore((state) => state.maxReconnectAttempts);
  const currentUser = useAppStore((state) => state.currentUser);
  const onlineUser = useAppStore((state) => state.onlineUser);
  const authStatus = useAppStore((state) => state.authStatus);
  const setActiveTab = useAppStore((state) => state.setActiveTab);
  const isSidebarCollapsed = useAppStore((state) => state.isSidebarCollapsed);
  const setSidebarCollapsed = useAppStore((state) => state.setSidebarCollapsed);
  const callLayoutMode = useAppStore((state) => state.callLayoutMode);
  const setCallLayoutMode = useAppStore((state) => state.setCallLayoutMode);
  const settings = useAppStore((state) => state.settings);
  const updateAudioVideo = useAppStore((state) => state.updateAudioVideo);
  const setParticipantVolume = useAppStore((state) => state.setParticipantVolume);
  const setCallStageSplitRatio = useAppStore((state) => state.setCallStageSplitRatio);

  // Screen Sharing State (Local & Quality)
  const isScreenSharing = useAppStore((state) => state.isScreenSharing);
  const isStartingScreenShare = useAppStore((state) => state.isStartingScreenShare);
  const screenStream = useAppStore((state) => state.screenStream);
  const screenShareLabel = useAppStore((state) => state.screenShareLabel);
  const screenShareError = useAppStore((state) => state.screenShareError);
  const screenShareQuality = useAppStore((state) => state.screenShareQuality);
  const screenEffectiveWidth = useAppStore((state) => state.screenEffectiveWidth);
  const screenEffectiveHeight = useAppStore((state) => state.screenEffectiveHeight);
  const screenQualityFallbackNotice = useAppStore((state) => state.screenQualityFallbackNotice);
  const screenCaptureNotice = useAppStore((state) => state.screenCaptureNotice);
  const toggleScreenShare = useAppStore((state) => state.toggleScreenShare);
  const stopScreenShare = useAppStore((state) => state.stopScreenShare);
  const clearScreenShareError = useAppStore((state) => state.clearScreenShareError);
  const screenPickerTarget = useAppStore((state) => state.screenPickerTarget);
  const nativeCaptureStatus = useAppStore((state) => state.nativeCaptureStatus);
  const nativeScreenStats = useAppStore((state) => state.nativeScreenStats);
  const openScreenSourcePicker = useAppStore((state) => state.openScreenSourcePicker);
  const isNativeCaptureSupported = screenCaptureService.isNativeCaptureSupported();

  const handleToggleScreenShare = () => {
    if (isScreenSharing) {
      toggleScreenShare();
    } else if (isNativeCaptureSupported) {
      void openScreenSourcePicker('call');
    } else {
      toggleScreenShare();
    }
  };

  // Remote Screen Share State (WebRTC)
  const isRemoteScreenSharing = useAppStore((state) => state.isRemoteScreenSharing);
  const remoteScreenStream = useAppStore((state) => state.remoteScreenStream);
  const isRemoteScreenMuted = useAppStore((state) => state.isRemoteScreenMuted);

  const previewVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const fullscreenContainerRef = useRef<HTMLDivElement | null>(null);
  const stageAreaRef = useRef<HTMLDivElement | null>(null);

  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isDraggingSplitter, setIsDraggingSplitter] = useState(false);
  const [activePopover, setActivePopover] = useState<'none' | 'audio' | 'quality'>('none');
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [diagnostics, setDiagnostics] = useState<WebRtcTransportDiagnostics | null>(null);
  const [inputDevices, setInputDevices] = useState<AudioDeviceInfo[]>([]);
  const [outputDevices, setOutputDevices] = useState<AudioDeviceInfo[]>([]);
  const [activeStageSource, setActiveStageSource] = useState<'remote' | 'local'>('remote');

  const peerId = activeCallPeer?.id || '';
  const peerVolume = peerId
    ? (settings.audioVideo.participantVolumes?.[peerId] ?? 100)
    : 100;
  const stageSplitRatio = settings.audioVideo.callStageSplitRatio ?? 65;
  const hasAnyScreenStage = Boolean(
    (isRemoteScreenSharing && remoteScreenStream) || (isScreenSharing && screenStream)
  );

  // Seleciona automaticamente a fonte principal do palco (prioriza tela remota quando ativa)
  useEffect(() => {
    if (isRemoteScreenSharing && remoteScreenStream) {
      setActiveStageSource('remote');
    } else if (isScreenSharing && screenStream) {
      setActiveStageSource('local');
    }
  }, [isRemoteScreenSharing, remoteScreenStream, isScreenSharing, screenStream]);

  // Carrega dispositivos de áudio para troca rápida em chamada
  useEffect(() => {
    let mounted = true;
    audioDeviceService.getAvailableDevices().then((dev) => {
      if (mounted) {
        setInputDevices(dev.inputs);
        setOutputDevices(dev.outputs);
      }
    });
    const unsubscribe = audioDeviceService.onDeviceChange((dev) => {
      if (mounted) {
        setInputDevices(dev.inputs);
        setOutputDevices(dev.outputs);
      }
    });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  // Polling leve e adaptativo de telemetria WebRTC: a cada 2s quando transmissão está no palco ou diagnósticos abertos
  useEffect(() => {
    if (voiceCallState !== 'connected' && voiceCallState !== 'reconnecting') {
      return;
    }

    const shouldPoll = showDiagnostics || hasAnyScreenStage;
    if (!shouldPoll) {
      return;
    }

    let cancelled = false;
    const pollStats = async () => {
      try {
        const stats = await callService.getTransportDiagnostics();
        if (!cancelled && stats) {
          setDiagnostics(stats);
        }
      } catch {
        // Ignora erros transitórios de coleta
      }
    };

    pollStats();
    const timer = setInterval(pollStats, 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [showDiagnostics, hasAnyScreenStage, voiceCallState]);

  const handleModeSelect = useCallback((mode: CallLayoutMode) => {
    setCallLayoutMode(mode);
    const preset = CALL_LAYOUT_PRESETS[mode];
    setCallStageSplitRatio(preset.ratio);
    if (mode === 'cinema' && !isSidebarCollapsed) {
      setSidebarCollapsed(true);
    }
  }, [setCallLayoutMode, setCallStageSplitRatio, isSidebarCollapsed, setSidebarCollapsed]);

  // Atualiza elemento HTML5 video com a faixa remota de vídeo
  useEffect(() => {
    const element = remoteVideoRef.current;
    if (element && remoteScreenStream) return bindScreenPlayback(element, remoteScreenStream);
  }, [remoteScreenStream, activeStageSource, isFullscreen]);

  // Atualiza elemento HTML5 video com a faixa da prévia local
  useEffect(() => {
    if (previewVideoRef.current) {
      if (screenStream) {
        previewVideoRef.current.srcObject = screenStream;
        previewVideoRef.current.play().catch((err) => {
          console.warn('[CallsView] Falha ao reproduzir elemento de vídeo local:', err);
        });
      } else {
        previewVideoRef.current.srcObject = null;
      }
    }
  }, [screenStream, activeStageSource, isFullscreen]);

  // Sincronização de Tela Cheia (DOM Fullscreen API + Tauri Window Fullscreen)
  const exitFullscreenCleanly = useCallback(async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen().catch(() => {});
      }
    } catch {}
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      const win = getCurrentWindow();
      const winFs = await win.isFullscreen().catch(() => false);
      if (winFs) {
        await win.setFullscreen(false).catch(() => {});
      }
    } catch {}
    setIsFullscreen(false);
  }, []);

  const toggleFullscreen = useCallback(async () => {
    if (isFullscreen) {
      await exitFullscreenCleanly();
      return;
    }

    let enteredDomFullscreen = false;
    if (fullscreenContainerRef.current && typeof fullscreenContainerRef.current.requestFullscreen === 'function') {
      try {
        await fullscreenContainerRef.current.requestFullscreen();
        enteredDomFullscreen = true;
      } catch {
        enteredDomFullscreen = false;
      }
    }

    if (!enteredDomFullscreen) {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        await getCurrentWindow().setFullscreen(true);
      } catch {}
    }
    setIsFullscreen(true);
  }, [isFullscreen, exitFullscreenCleanly]);

  useEffect(() => {
    const handleFsChange = () => {
      if (!document.fullscreenElement && isFullscreen) {
        exitFullscreenCleanly();
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isFullscreen) {
        exitFullscreenCleanly();
      }
    };
    document.addEventListener('fullscreenchange', handleFsChange);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('fullscreenchange', handleFsChange);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isFullscreen, exitFullscreenCleanly]);

  // Sai de tela cheia automaticamente se a transmissão de tela encerrar
  useEffect(() => {
    if (!hasAnyScreenStage && isFullscreen) {
      exitFullscreenCleanly();
    }
  }, [hasAnyScreenStage, isFullscreen, exitFullscreenCleanly]);

  // Handler de arraste do divisor (splitter) para redimensionar o painel de transmissão
  useEffect(() => {
    if (!isDraggingSplitter) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!stageAreaRef.current) return;
      const rect = stageAreaRef.current.getBoundingClientRect();
      if (rect.height <= 0) return;
      const relativeY = e.clientY - rect.top;
      const rawPercent = Math.round((relativeY / rect.height) * 100);
      const clamped = Math.max(30, Math.min(85, rawPercent));
      setCallStageSplitRatio(clamped);
    };

    const handleMouseUp = () => {
      setIsDraggingSplitter(false);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDraggingSplitter, setCallStageSplitRatio]);

  const [callHistory, setCallHistory] = useState<CallHistoryEntry[]>([]);
  const [isEnding, setIsEnding] = useState(false);

  const currentAccountId =
    authStatus === 'authenticated' && onlineUser?.id ? onlineUser.id : 'offline_demo';

  // Carrega histórico de chamadas ao entrar ou quando estado voltar para idle
  useEffect(() => {
    if (voiceCallState === 'idle') {
      setIsEnding(false);
      setActivePopover('none');
      setShowDiagnostics(false);
      setCallHistory(callHistoryRepository.getHistory(currentAccountId));
    }
  }, [voiceCallState, currentAccountId]);

  const handleClearHistory = () => {
    callHistoryRepository.clearHistory(currentAccountId);
    setCallHistory([]);
  };

  const handleCallBack = (entry: CallHistoryEntry) => {
    callService.startCall({
      id: entry.peerId,
      name: entry.peerName,
      username: entry.peerUsername,
      avatarUrl: entry.peerAvatarUrl,
    });
  };

  const handleEndCall = () => {
    setIsEnding(true);
    if (isFullscreen) {
      exitFullscreenCleanly();
    }
    setTimeout(() => {
      callService.endCall();
    }, 50);
  };

  const handlePeerVolumeChange = (newVolume: number) => {
    if (!peerId) return;
    setParticipantVolume(peerId, newVolume);
    callService.setParticipantVolume(peerId, newVolume);
  };

  const handleQualitySelect = async (preset: ScreenShareQualityPreset) => {
    await callService.setScreenShareQuality(preset);
    setActivePopover('none');
  };

  // 1. Histórico de Chamadas (Quando estado está Idle)
  if (voiceCallState === 'idle') {
    return (
      <div className="flex-1 flex flex-col bg-nexus-bg overflow-hidden select-none">
        {/* Header do Histórico */}
        <div className="h-12 border-b border-nexus-border px-6 flex items-center justify-between bg-nexus-surface shrink-0">
          <div className="flex items-center gap-2">
            <Radio className="w-4 h-4 text-nexus-accent" />
            <h2 className="text-xs font-bold text-nexus-text uppercase tracking-wider">
              Histórico de Chamadas
            </h2>
            {callHistory.length > 0 && (
              <span className="text-[10px] text-nexus-muted font-mono ml-2">
                ({callHistory.length} {callHistory.length === 1 ? 'registro' : 'registros'})
              </span>
            )}
          </div>

          {callHistory.length > 0 && (
            <button
              onClick={handleClearHistory}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-nexus-muted hover:text-rose-400 hover:bg-rose-500/10 text-xs transition-nexus cursor-pointer"
              title="Limpar todo o histórico de chamadas"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>Limpar</span>
            </button>
          )}
        </div>

        {/* Mensagem de Erro Temporária */}
        {callErrorMessage && (
          <div className="m-4 p-3.5 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-400 text-xs flex items-center justify-between gap-3 shadow-sm">
            <div className="flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{callErrorMessage}</span>
            </div>
            <button
              onClick={() => setCallErrorMessage(null)}
              className="px-2 py-0.5 rounded hover:bg-rose-500/20 text-xs font-bold transition-nexus cursor-pointer"
            >
              OK
            </button>
          </div>
        )}

        {/* Lista de Chamadas Recentes */}
        <div className="flex-1 overflow-y-auto p-6">
          {callHistory.length === 0 ? (
            <EmptyState
              icon={Radio}
              title="Nenhuma chamada recente"
              description="Suas chamadas de voz P2P criptografadas via Tailscale aparecerão aqui com data, duração e botão de retorno rápido. Inicie uma conversa com seus amigos na aba Mensagens."
              actionText="Ir para Mensagens"
              onAction={() => setActiveTab('messages')}
            />
          ) : (
            <div className="max-w-3xl mx-auto space-y-2">
              {callHistory.map((entry) => {
                const isIncoming = entry.direction === 'incoming';
                const isMissed = entry.status === 'missed' || entry.status === 'rejected';

                return (
                  <div
                    key={entry.id}
                    className="flex items-center justify-between p-3.5 rounded-xl bg-nexus-surface border border-nexus-border hover:border-nexus-border/80 transition-nexus"
                  >
                    <div className="flex items-center gap-3.5 min-w-0">
                      <div
                        className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${
                          isMissed
                            ? 'bg-rose-500/15 text-rose-400 border border-rose-500/30'
                            : isIncoming
                            ? 'bg-blue-500/15 text-blue-400 border border-blue-500/30'
                            : 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30'
                        }`}
                      >
                        {isMissed ? (
                          <PhoneMissed className="w-4 h-4" />
                        ) : isIncoming ? (
                          <PhoneIncoming className="w-4 h-4" />
                        ) : (
                          <PhoneOutgoing className="w-4 h-4" />
                        )}
                      </div>

                      <div className="flex items-center gap-3 min-w-0">
                        <Avatar name={entry.peerName} size="md" />
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-bold text-nexus-text truncate">
                              {entry.peerName}
                            </span>
                            <span className="text-[10px] text-nexus-muted font-mono truncate">
                              @{entry.peerUsername}
                            </span>
                          </div>

                          <div className="flex items-center gap-2 text-[11px] text-nexus-muted mt-0.5 font-mono">
                            <span>{formatHistoryTimestamp(entry.timestamp)}</span>
                            <span>•</span>
                            <span
                              className={
                                isMissed
                                  ? 'text-rose-400 font-medium'
                                  : 'text-emerald-400 font-medium'
                              }
                            >
                              {entry.status === 'completed'
                                ? `Duração: ${formatDuration(entry.durationSecs)}`
                                : entry.status === 'missed'
                                ? 'Não atendida'
                                : entry.status === 'rejected'
                                ? 'Recusada'
                                : 'Cancelada'}
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>

                    <button
                      onClick={() => handleCallBack(entry)}
                      className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-emerald-600/90 hover:bg-emerald-500 text-white font-semibold text-xs transition-nexus shadow-sm shadow-emerald-950/30 shrink-0 cursor-pointer active:scale-95 ml-3"
                      title={`Ligar para ${entry.peerName}`}
                    >
                      <Phone className="w-3.5 h-3.5" />
                      <span className="hidden sm:inline">Ligar</span>
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    );
  }

  // 2. Chamando amigo (Outgoing Ringing)
  if (voiceCallState === 'calling') {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-8 bg-nexus-bg select-none">
        <div className="flex flex-col items-center max-w-sm text-center">
          <div className="relative mb-6">
            <Avatar
              name={activeCallPeer?.name || 'Amigo'}
              size="xl"
              className="ring-4 ring-emerald-500 ring-offset-4 ring-offset-nexus-bg"
            />
            <span className="absolute inset-0 rounded-full border-2 border-emerald-500 animate-ping" />
          </div>

          <h3 className="text-base font-bold text-nexus-text">
            {activeCallPeer?.name || 'Amigo'}
          </h3>
          <p className="text-xs text-emerald-400 font-mono mt-1 animate-pulse">
            Chamando...
          </p>
          <p className="text-[11px] text-nexus-muted mt-2">
            Aguardando resposta do destinatário (expira em 45 segundos).
          </p>

          <button
            onClick={() => callService.cancelCall()}
            className="mt-8 px-6 py-2.5 rounded-xl bg-rose-600 hover:bg-rose-700 active:scale-95 text-white font-semibold text-xs flex items-center gap-2 transition-nexus shadow-lg shadow-rose-950/40 cursor-pointer"
          >
            <PhoneOff className="w-4 h-4" />
            <span>Cancelar Chamada</span>
          </button>
        </div>
      </div>
    );
  }

  // 3. Chamada Recebida (Incoming)
  if (voiceCallState === 'incoming' && incomingCall) {
    const callerName = incomingCall.caller.displayName || incomingCall.caller.username;
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-8 bg-nexus-bg select-none">
        <div className="flex flex-col items-center max-w-sm text-center">
          <div className="relative mb-6">
            <Avatar
              name={callerName}
              size="xl"
              className="ring-4 ring-emerald-500 ring-offset-4 ring-offset-nexus-bg"
            />
            <span className="absolute inset-0 rounded-full border-2 border-emerald-500 animate-ping" />
          </div>

          <h3 className="text-base font-bold text-nexus-text">{callerName}</h3>
          <p className="text-xs text-emerald-400 font-mono mt-1 animate-pulse">
            Chamada de voz recebida...
          </p>

          <div className="flex items-center gap-4 mt-8">
            <button
              onClick={() => callService.rejectCall()}
              className="px-6 py-2.5 rounded-xl bg-rose-500/20 hover:bg-rose-500/30 active:scale-95 text-rose-400 font-semibold text-xs flex items-center gap-2 transition-nexus cursor-pointer"
            >
              <PhoneOff className="w-4 h-4" />
              <span>Recusar</span>
            </button>

            <button
              onClick={() => callService.acceptCall()}
              className="px-6 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 active:scale-95 text-white font-semibold text-xs flex items-center gap-2 transition-nexus shadow-lg shadow-emerald-950/40 cursor-pointer"
            >
              <Phone className="w-4 h-4" />
              <span>Atender Chamada</span>
            </button>
          </div>
        </div>
      </div>
    );
  }

  // 4. Conectando WebRTC (Connecting)
  if (voiceCallState === 'connecting') {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-8 bg-nexus-bg select-none">
        <div className="flex flex-col items-center max-w-sm text-center">
          <div className="w-16 h-16 rounded-2xl bg-nexus-surface border border-nexus-border flex items-center justify-center mb-4">
            <Loader2 className="w-8 h-8 text-nexus-accent animate-spin" />
          </div>

          <h3 className="text-sm font-bold text-nexus-text">
            Estabelecendo Conexão P2P
          </h3>
          <p className="text-xs text-nexus-muted mt-1">
            Negociando transporte seguro WebRTC DTLS-SRTP...
          </p>

          <button
            onClick={handleEndCall}
            className="mt-6 px-4 py-2 rounded-xl bg-nexus-panel hover:bg-nexus-border active:scale-95 text-nexus-text text-xs transition-nexus cursor-pointer"
          >
            Cancelar
          </button>
        </div>
      </div>
    );
  }

  // 5. Chamada Conectada / Em Reconexão (Connected / Reconnecting)
  const showingRemoteVideo =
    activeStageSource === 'remote' && isRemoteScreenSharing && Boolean(remoteScreenStream);
  const showingLocalVideo =
    activeStageSource === 'local' && isScreenSharing && Boolean(screenStream);

  return (
    <div className="flex-1 flex flex-col bg-nexus-bg overflow-hidden relative select-none">
      {/* Top Header */}
      <div className="h-12 border-b border-nexus-border px-4 flex items-center justify-between bg-nexus-surface shrink-0 z-20">
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <Radio
              className={`w-4 h-4 shrink-0 ${
                voiceCallState === 'reconnecting'
                  ? 'text-amber-400 animate-ping'
                  : 'text-emerald-400 animate-pulse'
              }`}
            />
            <h2 className="text-xs font-bold text-nexus-text truncate">
              Chamada com {activeCallPeer?.name || 'Amigo'}
            </h2>
          </div>
          <span className="text-[10px] text-nexus-muted border-l border-nexus-border pl-2 font-mono hidden md:inline truncate">
            Opus Áudio • WebRTC DTLS-SRTP
          </span>
        </div>

        <div className="flex items-center gap-2">
          {/* Status Badge & Duration (Isolado para performance) */}
          <CallDurationBadge
            voiceCallState={voiceCallState}
            reconnectAttempt={reconnectAttempt}
            maxReconnectAttempts={maxReconnectAttempts}
          />

          {/* Toggle Diagnósticos de Mídia */}
          <Tooltip content="Diagnósticos de Rede e Mídia WebRTC" position="bottom">
            <button
              onClick={() => setShowDiagnostics((prev) => !prev)}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs transition-nexus cursor-pointer ${
                showDiagnostics
                  ? 'bg-nexus-accent/20 border-nexus-accent/50 text-nexus-text font-semibold'
                  : 'bg-nexus-panel border-nexus-border text-nexus-muted hover:text-nexus-text'
              }`}
            >
              <Activity className="w-3.5 h-3.5" />
              <span className="hidden sm:inline text-[11px]">Diagnósticos</span>
            </button>
          </Tooltip>

          <Tooltip content="Configurações de Áudio & Vídeo" position="bottom">
            <button
              onClick={() => setActiveTab('settings')}
              className="p-1.5 rounded-lg hover:bg-nexus-panel text-nexus-muted hover:text-nexus-text transition-nexus cursor-pointer"
            >
              <Sliders className="w-4 h-4" />
            </button>
          </Tooltip>
        </div>
      </div>

      {/* Painel Opcional de Diagnósticos de Mídia (Sob Demanda) */}
      {showDiagnostics && (
        <div className="bg-[#0b0d13]/95 border-b border-nexus-border px-5 py-3 z-20 animate-fadeIn">
          <div className="max-w-5xl mx-auto flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Activity className="w-3.5 h-3.5 text-nexus-accent" />
                <span className="text-[11px] font-bold text-nexus-text uppercase tracking-wider">
                  Telemetria WebRTC em Tempo Real
                </span>
                <span className="text-[10px] text-nexus-muted font-mono">
                  (RTT indica transporte de ida e volta, não latência unidirecional de voz)
                </span>
              </div>
              <button
                onClick={() => setShowDiagnostics(false)}
                className="text-nexus-muted hover:text-nexus-text p-0.5 rounded cursor-pointer"
                title="Fechar diagnósticos"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
              {/* Card 1: Estado / Rota ICE */}
              <div className="p-2 rounded-lg bg-nexus-surface border border-nexus-border">
                <span className="text-[9px] text-nexus-muted uppercase font-mono block">
                  Estado / Rota ICE
                </span>
                <span className="text-xs font-mono font-bold text-emerald-400 truncate block mt-0.5">
                  {diagnostics
                    ? `${diagnostics.iceConnectionState} (${diagnostics.networkClassification})`
                    : 'Coletando...'}
                </span>
              </div>

              {/* Card 2: RTT & Jitter */}
              <div className="p-2 rounded-lg bg-nexus-surface border border-nexus-border">
                <span className="text-[9px] text-nexus-muted uppercase font-mono block">
                  RTT & Jitter
                </span>
                <span className="text-xs font-mono font-bold text-nexus-text block mt-0.5">
                  {diagnostics?.rttMs !== null && diagnostics?.rttMs !== undefined
                    ? `${diagnostics.rttMs} ms`
                    : '—'}
                  {diagnostics?.jitterMs !== null && diagnostics?.jitterMs !== undefined
                    ? ` • Jitter: ${diagnostics.jitterMs} ms`
                    : ''}
                </span>
              </div>

              {/* Card 3: Perda de Pacotes & Quedas */}
              <div className="p-2 rounded-lg bg-nexus-surface border border-nexus-border">
                <span className="text-[9px] text-nexus-muted uppercase font-mono block">
                  Perda de Pacotes
                </span>
                <span
                  className={`text-xs font-mono font-bold block mt-0.5 ${
                    (diagnostics?.packetLossPercent ?? 0) > 3 ? 'text-amber-400' : 'text-nexus-text'
                  }`}
                >
                  {diagnostics
                    ? `${diagnostics.packetLossPercent ?? 0}% (${diagnostics.packetsLostInbound} pkts)`
                    : '—'}
                  {(diagnostics as any)?.framesDropped !== null && (diagnostics as any)?.framesDropped !== undefined
                    ? ` • ${(diagnostics as any).framesDropped} qdrs`
                    : ''}
                </span>
              </div>

              {/* Card 4: Bitrate (Áudio / Vídeo) */}
              <div className="p-2 rounded-lg bg-nexus-surface border border-nexus-border">
                <span className="text-[9px] text-nexus-muted uppercase font-mono block">
                  Bitrate (Áudio / Vídeo)
                </span>
                <span className="text-xs font-mono font-bold text-nexus-text block mt-0.5">
                  {diagnostics
                    ? `${diagnostics.audioBitrateKbps ?? 0} / ${diagnostics.videoBitrateKbps ?? 0} kbps`
                    : '—'}
                  {(diagnostics as any)?.bitrateRampStage && (diagnostics as any).bitrateRampStage !== 'idle'
                    ? ` (${(diagnostics as any).bitrateRampStage})`
                    : ''}
                </span>
              </div>

              {/* Card 5: Resoluções Multi-Estágio */}
              <div className="p-2 rounded-lg bg-nexus-surface border border-nexus-border">
                <span className="text-[9px] text-nexus-muted uppercase font-mono block">
                  Resoluções (Ped / Cap / Env / Rec)
                </span>
                <span className="text-xs font-mono font-bold text-nexus-text truncate block mt-0.5">
                  {(() => {
                    const d = diagnostics as any;
                    const req = d?.requestedWidth ? `${d.requestedWidth}x${d.requestedHeight}` : null;
                    const cap = d?.capturedWidth ? `${d.capturedWidth}x${d.capturedHeight}` : screenEffectiveWidth ? `${screenEffectiveWidth}x${screenEffectiveHeight}` : null;
                    const enc = d?.encodedWidth ? `${d.encodedWidth}x${d.encodedHeight}` : null;
                    const rec = d?.receivedWidth ? `${d.receivedWidth}x${d.receivedHeight}` : diagnostics?.videoWidth ? `${diagnostics.videoWidth}x${diagnostics.videoHeight}` : null;

                    if (!cap && !rec) return 'Somente Voz';
                    return [
                      req && `Ped: ${req}`,
                      cap && `Cap: ${cap}`,
                      enc && `Env: ${enc}`,
                      rec && `Rec: ${rec}`,
                    ]
                      .filter(Boolean)
                      .join(' • ') || '—';
                  })()}
                </span>
              </div>

              {/* Card 6: FPS Separados (Captura / Envio / Recepção / Renderização) */}
              <div className="p-2 rounded-lg bg-nexus-surface border border-nexus-border">
                <span className="text-[9px] text-nexus-muted uppercase font-mono block">
                  FPS Separados (Cap / Env / Rec / Dec)
                </span>
                <span className="text-xs font-mono font-bold text-emerald-400 truncate block mt-0.5">
                  {(() => {
                    const d = diagnostics as any;
                    const cap = d?.capturedFps ?? null;
                    const sent = d?.sentFps ?? d?.encodedFps ?? null;
                    const rec = d?.receivedFps ?? null;
                    const dec = d?.decodedFps ?? null;
                    const eff = d?.videoFps ?? null;

                    if (cap === null && sent === null && rec === null && dec === null && eff === null) {
                      return hasAnyScreenStage ? 'Medindo FPS...' : 'Somente Voz';
                    }

                    const items = [
                      cap !== null && `Cap: ${Math.round(cap)}`,
                      sent !== null && `Env: ${Math.round(sent)}`,
                      rec !== null && `Rec: ${Math.round(rec)}`,
                      dec !== null && `Dec: ${Math.round(dec)}`,
                      eff !== null && `Efet: ${Math.round(eff)}`,
                    ].filter(Boolean);

                    return items.join(' | ') || 'Medindo...';
                  })()}
                </span>
              </div>

              {/* Card 7: Codec & Aceleração */}
              <div className="p-2 rounded-lg bg-nexus-surface border border-nexus-border">
                <span className="text-[9px] text-nexus-muted uppercase font-mono block">
                  Codec & Aceleração
                </span>
                <span className="text-xs font-mono font-bold text-nexus-text truncate block mt-0.5">
                  {(() => {
                    const d = diagnostics as any;
                    const codec = d?.videoCodec || (hasAnyScreenStage ? 'H.264 / VP8' : 'Opus Áudio');
                    const hw = d?.powerEfficientEncoder ? ' • GPU/HW' : '';
                    const impl = d?.encoderImplementation ? ` (${d.encoderImplementation})` : '';
                    return `${codec}${hw}${impl}`;
                  })()}
                </span>
              </div>

              {/* Card 8: Limitação de Qualidade */}
              <div className="p-2 rounded-lg bg-nexus-surface border border-nexus-border">
                <span className="text-[9px] text-nexus-muted uppercase font-mono block">
                  Adaptação / Limitação
                </span>
                <span className="text-xs font-mono font-bold text-nexus-text truncate block mt-0.5">
                  {(() => {
                    const d = diagnostics as any;
                    const reason = d?.qualityLimitationReason || 'none';
                    if (reason === 'none') return 'Sem restrições (ideal)';
                    if (reason === 'cpu') return 'Limitado por CPU';
                    if (reason === 'bandwidth') return 'Limitado por banda';
                    return `Restrição: ${reason}`;
                  })()}
                </span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Avisos de Fallback de Dispositivo / Qualidade / Erro de Captura / Status Nativo */}
      {(callDeviceNotice ||
        screenQualityFallbackNotice ||
        (screenCaptureNotice && !nativeCaptureStatus?.active && !isNativeCaptureSupported) ||
        screenShareError ||
        nativeCaptureStatus?.active) && (
        <div className="px-6 pt-3 space-y-2 shrink-0 z-10 max-w-5xl w-full mx-auto">
          {nativeCaptureStatus?.active && (
            <NativeScreenShareBanner
              status={nativeCaptureStatus}
              stats={nativeScreenStats}
              onStop={stopScreenShare}
            />
          )}

          {callDeviceNotice && (
            <div className="p-2.5 rounded-xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-between text-xs text-amber-300 font-mono">
              <div className="flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-amber-400 shrink-0" />
                <span>{callDeviceNotice}</span>
              </div>
              <button
                onClick={() => setCallDeviceNotice(null)}
                className="p-1 rounded hover:bg-amber-500/20 text-amber-300 cursor-pointer ml-3"
                title="Fechar aviso"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {screenCaptureNotice && !nativeCaptureStatus?.active && !isNativeCaptureSupported && (
            <div role="status" className="p-2.5 rounded-xl bg-amber-500/10 border border-amber-500/30 text-xs text-amber-200">
              {screenCaptureNotice}
            </div>
          )}

          {screenQualityFallbackNotice && (
            <div className="p-2.5 rounded-xl bg-blue-500/10 border border-blue-500/30 flex items-center justify-between text-xs text-blue-300 font-mono">
              <div className="flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-blue-400 shrink-0" />
                <span>{screenQualityFallbackNotice}</span>
              </div>
            </div>
          )}

          {screenShareError && (
            <div className="p-2.5 rounded-xl bg-rose-950/40 border border-rose-500/40 flex items-center justify-between text-xs text-rose-300 font-mono">
              <div className="flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
                <span>{screenShareError}</span>
              </div>
              <button
                onClick={clearScreenShareError}
                className="p-1 rounded hover:bg-rose-900/40 text-rose-400 hover:text-white transition-nexus cursor-pointer ml-3 shrink-0"
                title="Fechar aviso"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>
      )}

      {/* Main Call Stage — Redimensionável quando há transmissão ativa */}
      <div
        ref={stageAreaRef}
        className={`flex-1 flex flex-col items-center ${nativeCaptureStatus?.active ? 'justify-start' : 'justify-center'} min-h-0 overflow-y-auto ${
          callLayoutMode === 'cinema' && hasAnyScreenStage && !isFullscreen
            ? 'p-1 sm:p-2 pb-2'
            : 'p-4 sm:p-6 pb-24'
        }`}
      >
        {nativeCaptureStatus?.active && <div className="w-full max-w-5xl shrink-0 mb-4">
          <NativeLocalScreenPreview status={nativeCaptureStatus} />
        </div>}
        {hasAnyScreenStage && (
          <div
            ref={fullscreenContainerRef}
            style={
              isFullscreen
                ? undefined
                : callLayoutMode === 'cinema'
                ? {
                    height: '100%',
                    width: '100%',
                    maxHeight: '100%',
                  }
                : {
                    height: `${stageSplitRatio}%`,
                    minHeight: '240px',
                    maxHeight: '82vh',
                  }
            }
            className={
              isFullscreen
                ? 'fixed inset-0 z-50 bg-black flex flex-col animate-fadeIn'
                : callLayoutMode === 'cinema'
                ? 'w-full h-full flex-1 min-h-0 bg-black/95 border border-white/10 rounded-xl overflow-hidden shadow-2xl flex flex-col relative transition-all duration-200'
                : callLayoutMode === 'balanced'
                ? 'w-full max-w-6xl bg-nexus-surface/95 border border-nexus-border rounded-2xl overflow-hidden shadow-2xl flex flex-col shrink-0 transition-colors'
                : 'w-full max-w-5xl bg-nexus-surface/95 border border-nexus-border rounded-2xl overflow-hidden shadow-2xl flex flex-col shrink-0 transition-colors'
            }
          >
            {/* Header do Palco de Transmissão */}
            <div className="px-4 py-2 bg-nexus-surface border-b border-nexus-border flex flex-wrap items-center justify-between gap-2 shrink-0">
              <div className="flex items-center gap-2.5 min-w-0">
                <div
                  className={`p-1.5 rounded-lg border ${
                    showingRemoteVideo
                      ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
                      : 'bg-nexus-accent/15 text-nexus-accent border-nexus-accent/30'
                  }`}
                >
                  {showingRemoteVideo ? (
                    <ScreenShare className="w-4 h-4" />
                  ) : (
                    <Monitor className="w-4 h-4" />
                  )}
                </div>

                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-nexus-text truncate">
                      {showingRemoteVideo
                        ? `Tela de ${activeCallPeer?.name || 'Amigo'}`
                        : screenShareLabel || 'Sua Transmissão de Tela'}
                    </span>
                    <span
                      className={`px-2 py-0.5 rounded-full text-[10px] font-mono font-semibold flex items-center gap-1 ${
                        showingRemoteVideo
                          ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40'
                          : 'bg-nexus-accent/20 text-nexus-accent border border-nexus-accent/40'
                      }`}
                    >
                      <span
                        className={`w-1.5 h-1.5 rounded-full animate-pulse ${
                          showingRemoteVideo ? 'bg-emerald-400' : 'bg-nexus-accent'
                        }`}
                      />
                      {showingRemoteVideo ? 'Ao Vivo' : 'Transmitindo'}
                    </span>
                  </div>
                </div>

                {/* Alternador caso ambos estejam compartilhando tela simultaneamente */}
                {isRemoteScreenSharing && remoteScreenStream && isScreenSharing && screenStream && (
                  <div className="flex items-center gap-1 ml-2 bg-nexus-bg p-0.5 rounded-lg border border-nexus-border">
                    <button
                      onClick={() => setActiveStageSource('remote')}
                      className={`px-2 py-0.5 rounded text-[10px] font-semibold cursor-pointer ${
                        activeStageSource === 'remote'
                          ? 'bg-nexus-panel text-emerald-400'
                          : 'text-nexus-muted hover:text-nexus-text'
                      }`}
                    >
                      Tela de {activeCallPeer?.name || 'Amigo'}
                    </button>
                    <button
                      onClick={() => setActiveStageSource('local')}
                      className={`px-2 py-0.5 rounded text-[10px] font-semibold cursor-pointer ${
                        activeStageSource === 'local'
                          ? 'bg-nexus-panel text-nexus-accent'
                          : 'text-nexus-muted hover:text-nexus-text'
                      }`}
                    >
                      Minha Prévia
                    </button>
                  </div>
                )}
              </div>

              {/* Controles de Modos (Compacto / Equilibrado / Cinema), Barra Lateral e Tela Cheia */}
              <div className="flex items-center gap-1.5">
                {!isFullscreen && (
                  <div className="flex items-center gap-1 bg-nexus-bg px-1.5 py-0.5 rounded-lg border border-nexus-border mr-1">
                    {(['compact', 'balanced', 'cinema'] as const).map((modeKey) => {
                      const preset = CALL_LAYOUT_PRESETS[modeKey];
                      const isSelected = callLayoutMode === modeKey;
                      return (
                        <button
                          key={modeKey}
                          type="button"
                          onClick={() => handleModeSelect(modeKey)}
                          className={`px-2 py-0.5 rounded text-[10px] font-mono transition-colors cursor-pointer ${
                            isSelected
                              ? 'bg-nexus-panel text-nexus-text font-bold shadow-xs'
                              : 'text-nexus-muted hover:text-nexus-text'
                          }`}
                          title={`${preset.label}: ${preset.description}`}
                          aria-pressed={isSelected}
                        >
                          {preset.label}
                        </button>
                      );
                    })}
                  </div>
                )}

                {/* Alternador rápido de barra lateral no modo cinema */}
                {callLayoutMode === 'cinema' && !isFullscreen && (
                  <Tooltip
                    content={isSidebarCollapsed ? 'Expandir barra lateral' : 'Recolher barra lateral'}
                    position="bottom"
                  >
                    <button
                      type="button"
                      onClick={() => setSidebarCollapsed(!isSidebarCollapsed)}
                      className="p-1 rounded-lg bg-nexus-panel hover:bg-nexus-border text-nexus-muted hover:text-nexus-text border border-nexus-border transition-colors cursor-pointer"
                      aria-label="Alternar barra lateral"
                    >
                      {isSidebarCollapsed ? (
                        <PanelLeftOpen className="w-3.5 h-3.5 text-nexus-accent" />
                      ) : (
                        <PanelLeftClose className="w-3.5 h-3.5" />
                      )}
                    </button>
                  </Tooltip>
                )}

                {isScreenSharing && (
                  <button
                    onClick={stopScreenShare}
                    className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-rose-600/20 hover:bg-rose-600/30 text-rose-400 border border-rose-500/30 text-[11px] font-semibold transition-all active:scale-95 cursor-pointer"
                    title="Parar compartilhamento de tela"
                  >
                    <ScreenShareOff className="w-3.5 h-3.5" />
                    <span className="hidden sm:inline">Parar</span>
                  </button>
                )}

                <button
                  onClick={toggleFullscreen}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-nexus-panel hover:bg-nexus-border text-nexus-text border border-nexus-border text-[11px] font-semibold transition-all active:scale-95 cursor-pointer"
                  title={isFullscreen ? 'Sair da tela cheia (Esc)' : 'Tela cheia real'}
                >
                  {isFullscreen ? (
                    <>
                      <Minimize2 className="w-3.5 h-3.5" />
                      <span>Sair da Tela Cheia</span>
                    </>
                  ) : (
                    <>
                      <Maximize2 className="w-3.5 h-3.5" />
                      <span className="hidden sm:inline">Tela Cheia</span>
                    </>
                  )}
                </button>
              </div>
            </div>

            {/* Área de Vídeo */}
            <div className="relative bg-black flex-1 flex items-center justify-center overflow-hidden min-h-0">
              {showingRemoteVideo ? (
                <>
                  <video
                    ref={remoteVideoRef}
                    autoPlay
                    playsInline
                    className="w-full h-full object-contain"
                  />
                  {isRemoteScreenMuted && (
                    <div className="absolute inset-0 bg-black/75 backdrop-blur-sm flex flex-col items-center justify-center p-4">
                      <div className="p-3 rounded-full bg-nexus-surface/80 border border-nexus-border mb-2">
                        <Monitor className="w-6 h-6 text-amber-400 animate-pulse" />
                      </div>
                      <span className="text-xs font-bold text-nexus-text">
                        Transmissão temporariamente pausada
                      </span>
                      <span className="text-[11px] text-nexus-muted font-mono mt-1">
                        Aguardando retomada pelo participante...
                      </span>
                    </div>
                  )}
                </>
              ) : showingLocalVideo ? (
                <video
                  ref={previewVideoRef}
                  autoPlay
                  muted
                  playsInline
                  className="w-full h-full object-contain"
                />
              ) : null}

              {/* Strip de Participantes Compacta em Modo Cinema */}
              {callLayoutMode === 'cinema' && !isFullscreen && (
                <div className="absolute top-3 right-3 z-30 flex items-center gap-2 px-2.5 py-1.5 rounded-xl bg-black/65 backdrop-blur-md border border-white/10 shadow-lg select-none">
                  <div className="flex items-center gap-1.5">
                    <Avatar
                      name={currentUser?.displayName || currentUser?.username || 'Você'}
                      size="xs"
                      className={isLocalSpeaking && !isMicMuted ? 'ring-2 ring-emerald-500' : ''}
                    />
                    <span className="text-[10px] font-bold text-zinc-300 max-w-[80px] truncate">
                      {currentUser?.displayName || currentUser?.username || 'Você'}
                    </span>
                  </div>
                  <span className="text-zinc-600">|</span>
                  <div className="flex items-center gap-1.5">
                    <Avatar
                      name={activeCallPeer?.name || 'Amigo'}
                      size="xs"
                      className={isRemoteSpeaking && !isPeerMuted ? 'ring-2 ring-emerald-500' : ''}
                    />
                    <span className="text-[10px] font-bold text-zinc-300 max-w-[80px] truncate">
                      {activeCallPeer?.name || 'Amigo'}
                    </span>
                    {isPeerMuted && <MicOff className="w-2.5 h-2.5 text-rose-400" />}
                  </div>
                </div>
              )}

              {/* Badge de Resolução e FPS Separados */}
              <div className="absolute bottom-2.5 right-2.5 px-2.5 py-1 rounded-lg bg-black/80 backdrop-blur text-[10px] text-zinc-200 font-mono border border-white/10 flex items-center gap-1.5 shadow-lg select-none">
                <span>
                  {(() => {
                    const d = diagnostics as any;
                    if (showingLocalVideo) {
                      const w = screenEffectiveWidth || d?.videoWidth;
                      const h = screenEffectiveHeight || d?.videoHeight;
                      const cap = d?.capturedFps;
                      const sent = d?.sentFps ?? d?.encodedFps;
                      if (!w || !h) return `Preset: ${screenShareQuality.toUpperCase()}`;
                      if (sent !== null && sent !== undefined) {
                        return `${w}×${h} • Cap: ${cap !== null && cap !== undefined ? Math.round(cap) : '—'} | Env: ${Math.round(sent)} FPS`;
                      }
                      if (cap !== null && cap !== undefined) {
                        return `${w}×${h} • Cap: ${Math.round(cap)} FPS`;
                      }
                      return `${w}×${h} • Medindo FPS...`;
                    }

                    if (showingRemoteVideo) {
                      const w = d?.videoWidth;
                      const h = d?.videoHeight;
                      const dec = d?.decodedFps;
                      const rec = d?.receivedFps;
                      const eff = d?.videoFps;
                      if (!w || !h) return 'Aguardando vídeo...';
                      if (dec !== null && dec !== undefined) {
                        return `${w}×${h} • ${Math.round(dec)} FPS (Dec)`;
                      }
                      if (rec !== null && rec !== undefined) {
                        return `${w}×${h} • ${Math.round(rec)} FPS (Rec)`;
                      }
                      if (eff !== null && eff !== undefined) {
                        return `${w}×${h} • ${Math.round(eff)} FPS`;
                      }
                      return `${w}×${h} • Medindo FPS...`;
                    }

                    return `Preset: ${screenShareQuality.toUpperCase()}`;
                  })()}
                </span>
              </div>

              {/* Controles Flutuantes Discretos em Cinema ou Tela Cheia */}
              {(isFullscreen || callLayoutMode === 'cinema') && (
                <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-30 flex items-center gap-2 px-3.5 py-2 rounded-2xl bg-[#0b0d13]/85 hover:bg-[#0b0d13]/95 backdrop-blur-md border border-white/15 shadow-2xl transition-all duration-200 select-none">
                  <Tooltip content={isMicMuted ? 'Ativar microfone' : 'Silenciar'} position="top">
                    <button
                      onClick={() => callService.toggleMute()}
                      className={`p-2 rounded-xl border transition-all cursor-pointer ${
                        isMicMuted
                          ? 'bg-rose-600 text-white border-rose-500'
                          : 'bg-nexus-panel border-nexus-border text-nexus-text hover:bg-nexus-border'
                      }`}
                    >
                      {isMicMuted ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
                    </button>
                  </Tooltip>

                  <Tooltip content={isDeafened ? 'Ativar áudio' : 'Desativar áudio'} position="top">
                    <button
                      onClick={() => callService.toggleDeafen()}
                      className={`p-2 rounded-xl border transition-all cursor-pointer ${
                        isDeafened
                          ? 'bg-rose-600 text-white border-rose-500'
                          : 'bg-nexus-panel border-nexus-border text-nexus-text hover:bg-nexus-border'
                      }`}
                    >
                      <Headphones className="w-4 h-4" />
                    </button>
                  </Tooltip>

                  <Tooltip
                    content={
                      isScreenSharing
                        ? 'Parar compartilhamento'
                        : isNativeCaptureSupported
                        ? 'Compartilhar tela'
                        : SCREEN_CAPTURE_SELECTION_NOTICE
                    }
                    position="top"
                  >
                    <button
                      onClick={handleToggleScreenShare}
                      disabled={isStartingScreenShare}
                      className={`p-2 rounded-xl border transition-all cursor-pointer ${
                        isScreenSharing
                          ? 'bg-nexus-accent text-white border-nexus-accent'
                          : 'bg-nexus-panel border-nexus-border text-nexus-text hover:bg-nexus-border'
                      }`}
                    >
                      {isStartingScreenShare ? (
                        <Loader2 className="w-4 h-4 animate-spin text-nexus-accent" />
                      ) : isScreenSharing ? (
                        <ScreenShareOff className="w-4 h-4" />
                      ) : (
                        <ScreenShare className="w-4 h-4" />
                      )}
                    </button>
                  </Tooltip>

                  {!isFullscreen && (
                    <Tooltip content="Restaurar modo normal" position="top">
                      <button
                        onClick={() => handleModeSelect('balanced')}
                        className="px-2.5 py-1.5 rounded-xl bg-nexus-panel hover:bg-nexus-border text-nexus-text border border-nexus-border text-xs font-semibold flex items-center gap-1.5 cursor-pointer"
                      >
                        <Minimize2 className="w-3.5 h-3.5" />
                        <span className="hidden sm:inline">Restaurar</span>
                      </button>
                    </Tooltip>
                  )}

                  <Tooltip content={isFullscreen ? 'Sair da tela cheia (Esc)' : 'Tela cheia'} position="top">
                    <button
                      onClick={toggleFullscreen}
                      className="p-2 rounded-xl bg-nexus-panel hover:bg-nexus-border text-nexus-text border border-nexus-border transition-all cursor-pointer"
                    >
                      {isFullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
                    </button>
                  </Tooltip>

                  <Tooltip content="Desligar" position="top">
                    <button
                      onClick={handleEndCall}
                      disabled={isEnding}
                      className="p-2 rounded-xl bg-rose-600 hover:bg-rose-700 text-white cursor-pointer transition-all active:scale-95 shadow-md shadow-rose-950/40"
                    >
                      <PhoneOff className="w-4 h-4" />
                    </button>
                  </Tooltip>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Divisor Redimensionável (Splitter) entre Palco de Tela e Cards de Participantes */}
        {hasAnyScreenStage && !isFullscreen && callLayoutMode !== 'cinema' && (
          <div
            onMouseDown={() => setIsDraggingSplitter(true)}
            className="w-full max-w-6xl py-2 flex items-center justify-center cursor-row-resize group shrink-0"
            title="Arraste para redimensionar o palco de transmissão"
          >
            <div className="w-24 h-1.5 rounded-full bg-nexus-border group-hover:bg-nexus-accent/70 transition-colors flex items-center justify-center">
              <GripHorizontal className="w-3.5 h-3.5 text-nexus-muted opacity-0 group-hover:opacity-100 transition-opacity" />
            </div>
          </div>
        )}

        {/* Participantes no Modo Equilibrado: Faixa Compacta para economizar altura vertical */}
        {hasAnyScreenStage && !isFullscreen && callLayoutMode === 'balanced' && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 w-full max-w-6xl mt-1">
            {/* Tile Local Compacto */}
            <div
              className={`p-3 rounded-xl bg-nexus-surface border flex items-center gap-3 transition-nexus shadow-xs ${
                isLocalSpeaking && !isMicMuted
                  ? 'border-emerald-500 ring-1 ring-emerald-500/30'
                  : isMicMuted
                  ? 'border-rose-500/30 bg-rose-950/10'
                  : 'border-nexus-border'
              }`}
            >
              <div className="relative shrink-0">
                <Avatar
                  name={currentUser?.displayName || currentUser?.username || 'Você'}
                  size="sm"
                  className={isLocalSpeaking && !isMicMuted ? 'ring-2 ring-emerald-500' : ''}
                />
                {isMicMuted && (
                  <span className="absolute -bottom-1 -right-1 p-0.5 rounded-full bg-rose-600 text-white border border-nexus-surface">
                    <MicOff className="w-2.5 h-2.5" />
                  </span>
                )}
              </div>
              <div className="min-w-0 flex-1">
                <span className="text-xs font-bold text-nexus-text block truncate">
                  {currentUser?.displayName || currentUser?.username || 'Você'} (Você)
                </span>
                <span
                  className={`text-[10px] font-mono ${
                    isMicMuted
                      ? 'text-rose-400'
                      : isLocalSpeaking
                      ? 'text-emerald-400 font-bold'
                      : 'text-nexus-muted'
                  }`}
                >
                  {isMicMuted ? 'Microfone silenciado' : isLocalSpeaking ? 'Falando...' : 'Conectado'}
                </span>
              </div>
            </div>

            {/* Tile Remoto Compacto com Volume Integrado */}
            <div
              className={`p-3 rounded-xl bg-nexus-surface border flex items-center justify-between gap-3 transition-nexus shadow-xs ${
                isRemoteSpeaking && !isPeerMuted
                  ? 'border-emerald-500 ring-1 ring-emerald-500/30'
                  : isPeerMuted
                  ? 'border-rose-500/30 bg-rose-950/10'
                  : 'border-nexus-border'
              }`}
            >
              <div className="flex items-center gap-3 min-w-0">
                <div className="relative shrink-0">
                  <Avatar
                    name={activeCallPeer?.name || 'Amigo'}
                    size="sm"
                    className={isRemoteSpeaking && !isPeerMuted ? 'ring-2 ring-emerald-500' : ''}
                  />
                  {isPeerMuted && (
                    <span className="absolute -bottom-1 -right-1 p-0.5 rounded-full bg-rose-600 text-white border border-nexus-surface">
                      <MicOff className="w-2.5 h-2.5" />
                    </span>
                  )}
                </div>
                <div className="min-w-0">
                  <span className="text-xs font-bold text-nexus-text block truncate">
                    {activeCallPeer?.name || 'Amigo'}
                  </span>
                  <span
                    className={`text-[10px] font-mono ${
                      isPeerMuted
                        ? 'text-rose-400'
                        : isRemoteSpeaking
                        ? 'text-emerald-400 font-bold'
                        : 'text-nexus-muted'
                    }`}
                  >
                    {isPeerMuted ? 'Amigo silenciado' : isRemoteSpeaking ? 'Falando...' : 'Conectado'}
                  </span>
                </div>
              </div>

              {/* Volume individual compacto */}
              {peerId && (
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => handlePeerVolumeChange(peerVolume === 0 ? 100 : 0)}
                    className="text-nexus-muted hover:text-nexus-text cursor-pointer"
                    title={peerVolume === 0 ? 'Restaurar volume (100%)' : 'Silenciar amigo'}
                  >
                    {peerVolume === 0 ? (
                      <VolumeX className="w-3.5 h-3.5 text-rose-400" />
                    ) : (
                      <Volume2 className="w-3.5 h-3.5 text-nexus-accent" />
                    )}
                  </button>
                  <input
                    type="range"
                    min="0"
                    max="200"
                    step="5"
                    value={peerVolume}
                    onChange={(e) => handlePeerVolumeChange(Number(e.target.value))}
                    aria-label={`Volume de ${activeCallPeer?.name || 'participante'}`}
                    className="w-16 sm:w-20 h-1.5 accent-nexus-accent cursor-pointer"
                  />
                  <span className="text-[10px] font-mono font-bold text-nexus-text w-8 text-right">
                    {peerVolume}%
                  </span>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Grid de Participantes Completo: Usado em Modo Compacto ou quando NÃO há transmissão ativa */}
        {(!hasAnyScreenStage || callLayoutMode === 'compact') && (
          <div
            className={`grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-6 w-full ${
              hasAnyScreenStage ? 'max-w-5xl mt-1' : 'max-w-3xl'
            }`}
          >
            {/* Tile 1: Usuário Local (Você) */}
            <div
              className={`bg-nexus-surface rounded-2xl border ${
                hasAnyScreenStage ? 'p-4' : 'p-6'
              } flex flex-col items-center justify-center relative shadow-sm transition-nexus ${
                isLocalSpeaking && !isMicMuted
                  ? 'border-emerald-500 ring-2 ring-emerald-500/30'
                  : isMicMuted
                  ? 'border-rose-500/30 bg-rose-950/10'
                  : 'border-nexus-border'
              }`}
            >
              <div className="relative mb-2.5">
                <Avatar
                  name={currentUser?.displayName || currentUser?.username || 'Você'}
                  size={hasAnyScreenStage ? 'lg' : 'xl'}
                  className={isLocalSpeaking && !isMicMuted ? 'ring-2 ring-emerald-500' : ''}
                />
                {isMicMuted && (
                  <span className="absolute -bottom-1 -right-1 p-1 rounded-full bg-rose-600 text-white shadow-md border-2 border-nexus-surface">
                    <MicOff className="w-3.5 h-3.5" />
                  </span>
                )}
              </div>

              <span className="text-xs font-bold text-nexus-text">
                {currentUser?.displayName || currentUser?.username || 'Você'} (Você)
              </span>

              {isMicMuted ? (
                <span className="mt-1.5 px-2.5 py-0.5 rounded-full bg-rose-500/20 text-rose-400 border border-rose-500/40 text-[10px] font-mono font-semibold flex items-center gap-1.5">
                  <MicOff className="w-3 h-3" />
                  <span>Microfone silenciado</span>
                </span>
              ) : (
                <span
                  className={`text-[10px] mt-1.5 font-mono font-medium ${
                    isLocalSpeaking ? 'text-emerald-400 font-bold' : 'text-nexus-muted'
                  }`}
                >
                  {isLocalSpeaking ? 'Falando...' : 'Conectado'}
                </span>
              )}
            </div>

            {/* Tile 2: Participante Remoto + Volume Individual (0% a 200%) */}
            <div
              className={`bg-nexus-surface rounded-2xl border ${
                hasAnyScreenStage ? 'p-4' : 'p-6'
              } flex flex-col items-center justify-center relative shadow-sm transition-nexus ${
                isRemoteSpeaking && !isPeerMuted
                  ? 'border-emerald-500 ring-2 ring-emerald-500/30'
                  : isPeerMuted
                  ? 'border-rose-500/30 bg-rose-950/10'
                  : 'border-nexus-border'
              }`}
            >
              <div className="relative mb-2.5">
                <Avatar
                  name={activeCallPeer?.name || 'Amigo'}
                  size={hasAnyScreenStage ? 'lg' : 'xl'}
                  className={isRemoteSpeaking && !isPeerMuted ? 'ring-2 ring-emerald-500' : ''}
                />
                {isPeerMuted && (
                  <span className="absolute -bottom-1 -right-1 p-1 rounded-full bg-rose-600 text-white shadow-md border-2 border-nexus-surface">
                    <MicOff className="w-3.5 h-3.5" />
                  </span>
                )}
              </div>

              <span className="text-xs font-bold text-nexus-text">
                {activeCallPeer?.name || 'Amigo'}
              </span>

              {isPeerMuted ? (
                <span className="mt-1.5 px-2.5 py-0.5 rounded-full bg-rose-500/20 text-rose-400 border border-rose-500/40 text-[10px] font-mono font-semibold flex items-center gap-1.5">
                  <MicOff className="w-3 h-3" />
                  <span>Silenciado pelo amigo</span>
                </span>
              ) : (
                <span
                  className={`text-[10px] mt-1.5 font-mono font-medium ${
                    isRemoteSpeaking ? 'text-emerald-400 font-bold' : 'text-nexus-muted'
                  }`}
                >
                  {isRemoteSpeaking ? 'Falando...' : 'Conectado'}
                </span>
              )}

              {/* Controle Individual de Volume do Participante (0% a 200%) */}
              {peerId && (
                <div className="w-full max-w-[240px] mt-3 pt-2.5 border-t border-nexus-border/60 flex flex-col gap-1">
                  <div className="flex items-center justify-between text-[10px] font-mono">
                    <button
                      type="button"
                      onClick={() => handlePeerVolumeChange(peerVolume === 0 ? 100 : 0)}
                      className="flex items-center gap-1 text-nexus-muted hover:text-nexus-text cursor-pointer"
                      title={peerVolume === 0 ? 'Restaurar volume para 100%' : 'Silenciar participante localmente'}
                    >
                      {peerVolume === 0 ? (
                        <VolumeX className="w-3.5 h-3.5 text-rose-400" />
                      ) : (
                        <Volume2 className="w-3.5 h-3.5 text-nexus-accent" />
                      )}
                      <span>Volume Individual</span>
                    </button>
                    <div className="flex items-center gap-1.5">
                      <span
                        className={`font-bold ${
                          peerVolume > 100
                            ? 'text-amber-400'
                            : peerVolume === 0
                            ? 'text-rose-400'
                            : 'text-nexus-text'
                        }`}
                      >
                        {peerVolume}%
                      </span>
                      {peerVolume !== 100 && (
                        <button
                          type="button"
                          onClick={() => handlePeerVolumeChange(100)}
                          className="text-[9px] px-1 py-0.2 rounded bg-nexus-panel hover:bg-nexus-border text-nexus-muted hover:text-nexus-text cursor-pointer"
                          title="Redefinir para 100%"
                        >
                          100%
                        </button>
                      )}
                    </div>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="200"
                    step="5"
                    value={peerVolume}
                    onChange={(e) => handlePeerVolumeChange(Number(e.target.value))}
                    aria-label={`Volume de ${activeCallPeer?.name || 'participante'}`}
                    className="w-full h-1.5 accent-nexus-accent cursor-pointer"
                  />
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Popovers de Troca Rápida de Dispositivos de Áudio e Qualidade de Tela */}
      {activePopover !== 'none' && (
        <div className="absolute bottom-20 left-1/2 -translate-x-1/2 z-40 w-[340px] sm:w-[380px] rounded-2xl bg-[#0d0f16]/95 backdrop-blur-xl border border-nexus-border shadow-2xl p-4 animate-fadeIn">
          {activePopover === 'audio' && (
            <div className="space-y-3">
              <div className="flex items-center justify-between border-b border-nexus-border pb-2">
                <span className="text-xs font-bold text-nexus-text flex items-center gap-1.5">
                  <Volume2 className="w-3.5 h-3.5 text-nexus-accent" />
                  Dispositivos de Áudio na Chamada
                </span>
                <button
                  onClick={() => setActivePopover('none')}
                  className="text-nexus-muted hover:text-nexus-text cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>

              <div>
                <label className="text-[10px] font-semibold text-nexus-muted uppercase block mb-1">
                  Microfone (Entrada)
                </label>
                <select
                  value={settings.audioVideo.inputDevice}
                  onChange={(e) => {
                    const devId = e.target.value;
                    updateAudioVideo({ inputDevice: devId });
                    callService.switchInputDevice(devId);
                  }}
                  className="w-full bg-nexus-bg border border-nexus-border rounded-lg p-2 text-xs text-nexus-text focus:outline-none cursor-pointer"
                >
                  <option value="default">Microfone Padrão do Sistema</option>
                  {inputDevices
                    .filter((d) => d.deviceId !== 'default')
                    .map((d) => (
                      <option key={d.deviceId} value={d.deviceId}>
                        {d.label}
                      </option>
                    ))}
                </select>
              </div>

              <div>
                <label className="text-[10px] font-semibold text-nexus-muted uppercase block mb-1">
                  Saída de Áudio (Fones / Alto-falantes)
                </label>
                <select
                  value={settings.audioVideo.outputDevice}
                  onChange={(e) => {
                    const devId = e.target.value;
                    updateAudioVideo({ outputDevice: devId });
                    callService.switchOutputDevice(devId);
                  }}
                  className="w-full bg-nexus-bg border border-nexus-border rounded-lg p-2 text-xs text-nexus-text focus:outline-none cursor-pointer"
                >
                  <option value="default">Saída Padrão do Sistema</option>
                  {outputDevices
                    .filter((d) => d.deviceId !== 'default')
                    .map((d) => (
                      <option key={d.deviceId} value={d.deviceId}>
                        {d.label}
                      </option>
                    ))}
                </select>
              </div>

              <div>
                <div className="flex justify-between text-[10px] font-mono text-nexus-muted mb-1">
                  <span>Volume Geral de Saída</span>
                  <span className="text-nexus-text font-bold">
                    {settings.audioVideo.outputVolume}%
                  </span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={settings.audioVideo.outputVolume}
                  onChange={(e) => {
                    const vol = Number(e.target.value);
                    updateAudioVideo({ outputVolume: vol });
                    callService.setOutputVolume(vol);
                  }}
                  className="w-full accent-nexus-accent cursor-pointer"
                />
              </div>
            </div>
          )}

          {activePopover === 'quality' && (
            <div className="space-y-2.5">
              <p className="text-xs text-nexus-muted">
                {isNativeCaptureSupported
                  ? 'Selecione a qualidade da transmissão de tela.'
                  : SCREEN_CAPTURE_SELECTION_NOTICE}
              </p>
              <div className="flex items-center justify-between border-b border-nexus-border pb-2">
                <span className="text-xs font-bold text-nexus-text flex items-center gap-1.5">
                  <Monitor className="w-3.5 h-3.5 text-nexus-accent" />
                  Qualidade de Compartilhamento de Tela
                </span>
                <button
                  onClick={() => setActivePopover('none')}
                  className="text-nexus-muted hover:text-nexus-text cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>

              <div className="space-y-1.5">
                {QUALITY_PRESET_OPTIONS.map((opt) => {
                  const isSelected = screenShareQuality === opt.id;
                  return (
                    <button
                      key={opt.id}
                      onClick={() => handleQualitySelect(opt.id)}
                      className={`w-full p-2.5 rounded-xl border text-left flex items-center justify-between transition-all cursor-pointer ${
                        isSelected
                          ? 'bg-nexus-accent/15 border-nexus-accent text-nexus-text'
                          : 'bg-nexus-bg border-nexus-border text-nexus-muted hover:text-nexus-text'
                      }`}
                    >
                      <div>
                        <div className="text-xs font-bold">{opt.label}</div>
                        <div className="text-[10px] opacity-80">{opt.desc}</div>
                      </div>
                      {isSelected && (
                        <span className="px-2 py-0.5 rounded bg-nexus-accent text-white text-[10px] font-mono font-bold">
                          Ativo
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Floating Centered Bottom Dock (Apenas em modos com dock normal e fora da tela cheia) */}
      {!isFullscreen && callLayoutMode !== 'cinema' && (
        <div className="absolute bottom-5 left-1/2 -translate-x-1/2 z-30">
          <div className="flex items-center gap-2.5 px-4 py-2.5 rounded-2xl bg-nexus-surface/95 backdrop-blur-md border border-nexus-border shadow-2xl">
          {/* Microfone */}
          <Tooltip content={isMicMuted ? 'Ativar microfone' : 'Silenciar microfone'} position="top">
            <button
              onClick={() => callService.toggleMute()}
              aria-label={isMicMuted ? 'Ativar microfone' : 'Silenciar microfone'}
              className={`p-3 rounded-xl border transition-all active:scale-95 cursor-pointer ${
                isMicMuted
                  ? 'bg-rose-600 text-white border-rose-500 shadow-lg shadow-rose-950/50'
                  : 'bg-nexus-panel border-nexus-border text-nexus-text hover:bg-nexus-border'
              }`}
            >
              {isMicMuted ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
            </button>
          </Tooltip>

          {/* Áudio de Saída / Fone */}
          <Tooltip content={isDeafened ? 'Ativar áudio' : 'Desativar áudio'} position="top">
            <button
              onClick={() => callService.toggleDeafen()}
              aria-label={isDeafened ? 'Ativar áudio' : 'Desativar áudio'}
              className={`p-3 rounded-xl border transition-all active:scale-95 cursor-pointer ${
                isDeafened
                  ? 'bg-rose-600 text-white border-rose-500 shadow-lg shadow-rose-950/50'
                  : 'bg-nexus-panel border-nexus-border text-nexus-text hover:bg-nexus-border'
              }`}
            >
              <Headphones className="w-4 h-4" />
            </button>
          </Tooltip>

          {/* Seletor Rápido de Dispositivos de Áudio */}
          <Tooltip content="Trocar Microfone / Saída de Áudio" position="top">
            <button
              onClick={() =>
                setActivePopover((prev) => (prev === 'audio' ? 'none' : 'audio'))
              }
              aria-label="Selecionar dispositivos de áudio"
              className={`p-3 rounded-xl border transition-all active:scale-95 cursor-pointer ${
                activePopover === 'audio'
                  ? 'bg-nexus-accent/20 border-nexus-accent text-nexus-text'
                  : 'bg-nexus-panel border-nexus-border text-nexus-muted hover:text-nexus-text'
              }`}
            >
              <ChevronUp className="w-4 h-4" />
            </button>
          </Tooltip>

          <div className="w-[1px] h-6 bg-nexus-border mx-0.5" />

          {/* Compartilhar Tela / Parar Compartilhamento */}
          <Tooltip
            content={
              isStartingScreenShare
                ? 'Iniciando captura...'
                : isScreenSharing
                ? 'Parar compartilhamento'
                : isNativeCaptureSupported
                ? 'Compartilhar tela'
                : SCREEN_CAPTURE_SELECTION_NOTICE
            }
            position="top"
          >
            <button
              onClick={handleToggleScreenShare}
              disabled={isStartingScreenShare}
              aria-label={isScreenSharing ? 'Parar compartilhamento' : 'Compartilhar tela'}
              className={`p-3 rounded-xl border transition-all active:scale-95 cursor-pointer flex items-center justify-center ${
                isScreenSharing
                  ? 'bg-nexus-accent text-white border-nexus-accent shadow-lg'
                  : isStartingScreenShare
                  ? 'bg-nexus-panel border-nexus-border text-nexus-muted cursor-wait'
                  : 'bg-nexus-panel border-nexus-border text-nexus-text hover:bg-nexus-border hover:text-white'
              }`}
            >
              {isStartingScreenShare ? (
                <Loader2 className="w-4 h-4 animate-spin text-nexus-accent" />
              ) : isScreenSharing ? (
                <ScreenShareOff className="w-4 h-4" />
              ) : (
                <ScreenShare className="w-4 h-4" />
              )}
            </button>
          </Tooltip>

          {/* Seletor de Qualidade de Transmissão (720p/1080p • 30/60 FPS) */}
          <Tooltip content="Qualidade da Transmissão de Tela" position="top">
            <button
              onClick={() =>
                setActivePopover((prev) => (prev === 'quality' ? 'none' : 'quality'))
              }
              aria-label="Qualidade da transmissão de tela"
              className={`px-2.5 py-2 rounded-xl border text-[10px] font-mono font-bold transition-all active:scale-95 cursor-pointer ${
                activePopover === 'quality'
                  ? 'bg-nexus-accent/20 border-nexus-accent text-nexus-text'
                  : 'bg-nexus-panel border-nexus-border text-nexus-muted hover:text-nexus-text'
              }`}
            >
              {QUALITY_PRESET_OPTIONS.find((o) => o.id === screenShareQuality)?.shortLabel || 'Auto'}
            </button>
          </Tooltip>

          <div className="w-[1px] h-6 bg-nexus-border mx-0.5" />

          {/* Encerrar Chamada */}
          <Tooltip content="Desligar chamada" position="top">
            <button
              onClick={handleEndCall}
              disabled={isEnding}
              aria-label="Desligar chamada"
              className={`p-3 rounded-xl bg-rose-600 hover:bg-rose-700 text-white transition-all shadow-md shadow-rose-950/40 cursor-pointer active:scale-90 flex items-center justify-center ${
                isEnding ? 'opacity-70 scale-95 cursor-wait' : ''
              }`}
            >
              {isEnding ? (
                <Loader2 className="w-4 h-4 animate-spin text-white" />
              ) : (
                <PhoneOff className="w-4 h-4" />
              )}
            </button>
          </Tooltip>
        </div>
      </div>
      )}

      {screenPickerTarget === 'call' && <ScreenSourcePickerModal />}
    </div>
  );
};
