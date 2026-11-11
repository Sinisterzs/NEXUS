import React, { useState } from 'react';
import {
  Mic,
  MicOff,
  Headphones,
  PhoneOff,
  Radio,
  Maximize2,
  Loader2,
  ScreenShare,
  Monitor,
} from 'lucide-react';
import { useAppStore } from '../stores/useAppStore';
import { callService } from '../services/CallService';
import { Avatar } from './Avatar';
import { Tooltip } from './Tooltip';

function formatDuration(totalSeconds: number): string {
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export const ActiveCallBar: React.FC = () => {
  const voiceCallState = useAppStore((state) => state.voiceCallState);
  const activeCallPeer = useAppStore((state) => state.activeCallPeer);
  const activeTab = useAppStore((state) => state.activeTab);
  const callDurationSecs = useAppStore((state) => state.callDurationSecs);
  const isMicMuted = useAppStore((state) => state.isMicMuted);
  const isDeafened = useAppStore((state) => state.isDeafened);
  const isPeerMuted = useAppStore((state) => state.isPeerMuted);
  const isLocalSpeaking = useAppStore((state) => state.isLocalSpeaking);
  const isRemoteSpeaking = useAppStore((state) => state.isRemoteSpeaking);
  const isScreenSharing = useAppStore((state) => state.isScreenSharing);
  const isRemoteScreenSharing = useAppStore((state) => state.isRemoteScreenSharing);
  const reconnectAttempt = useAppStore((state) => state.reconnectAttempt);
  const maxReconnectAttempts = useAppStore((state) => state.maxReconnectAttempts);
  const isSidebarCollapsed = useAppStore((state) => state.isSidebarCollapsed);
  const setActiveTab = useAppStore((state) => state.setActiveTab);

  const [isEnding, setIsEnding] = useState(false);

  // Exibe a barra apenas quando há uma chamada ativa e o usuário NÃO está na aba 'calls'
  if (voiceCallState === 'idle' || activeTab === 'calls') {
    return null;
  }

  const handleEndCall = () => {
    setIsEnding(true);
    setTimeout(() => {
      callService.endCall();
      setIsEnding(false);
    }, 50);
  };

  const peerName = activeCallPeer?.name || 'Amigo';
  const durationText =
    voiceCallState === 'reconnecting'
      ? `Reconectando (${Math.max(1, reconnectAttempt)}/${maxReconnectAttempts})...`
      : voiceCallState === 'calling'
      ? 'Chamando...'
      : voiceCallState === 'connecting'
      ? 'Conectando...'
      : formatDuration(callDurationSecs);

  // 1. Modo Compacto na Barra Lateral Recolhida (w-16 / 64px)
  if (isSidebarCollapsed) {
    return (
      <div
        className="w-full py-2.5 px-1 border-t border-emerald-500/30 bg-gradient-to-b from-emerald-950/30 to-[#080b10] flex flex-col items-center gap-1.5 shrink-0 select-none transition-all duration-150 animate-in fade-in"
        role="region"
        aria-label="Controles da chamada ativa"
      >
        {/* Avatar com status de voz pulsante */}
        <Tooltip
          content={`Chamada com ${peerName} (${durationText}) • Clique para abrir`}
          position="right"
        >
          <button
            type="button"
            onClick={() => setActiveTab('calls')}
            className="relative cursor-pointer group focus:outline-none focus:ring-1 focus:ring-emerald-400 rounded-full"
            aria-label={`Retornar à chamada com ${peerName}`}
          >
            <Avatar
              name={peerName}
              size="sm"
              className={
                isRemoteSpeaking && !isPeerMuted
                  ? 'ring-2 ring-emerald-400 shadow-[0_0_8px_rgba(16,185,129,0.5)]'
                  : ''
              }
            />
            <span
              className={`absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full border border-[#090b10] ${
                voiceCallState === 'reconnecting'
                  ? 'bg-amber-400 animate-ping'
                  : 'bg-emerald-500 animate-pulse'
              }`}
            />
          </button>
        </Tooltip>

        {/* Controles verticais compactos */}
        <div className="flex flex-col items-center gap-1">
          <Tooltip content={isMicMuted ? 'Ativar microfone' : 'Silenciar microfone'} position="right">
            <button
              type="button"
              onClick={() => callService.toggleMute()}
              aria-label={isMicMuted ? 'Ativar microfone' : 'Silenciar microfone'}
              aria-pressed={isMicMuted}
              className={`w-9 h-9 shrink-0 flex items-center justify-center rounded-lg transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 ${
                isMicMuted
                  ? 'bg-rose-600/80 text-white hover:bg-rose-600'
                  : isLocalSpeaking
                  ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                  : 'text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-200'
              }`}
            >
              {isMicMuted ? <MicOff className="w-3.5 h-3.5" /> : <Mic className="w-3.5 h-3.5" />}
            </button>
          </Tooltip>

          <Tooltip content={isDeafened ? 'Ativar áudio' : 'Desativar áudio'} position="right">
            <button
              type="button"
              onClick={() => callService.toggleDeafen()}
              aria-label={isDeafened ? 'Ativar áudio' : 'Desativar áudio'}
              aria-pressed={isDeafened}
              className={`w-9 h-9 shrink-0 flex items-center justify-center rounded-lg transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 ${
                isDeafened
                  ? 'bg-rose-600/80 text-white hover:bg-rose-600'
                  : 'text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-200'
              }`}
            >
              <Headphones className="w-3.5 h-3.5" />
            </button>
          </Tooltip>

          <Tooltip content="Abrir tela da chamada" position="right">
            <button
              type="button"
              onClick={() => setActiveTab('calls')}
              aria-label="Abrir tela da chamada"
              className="p-1.5 rounded-lg text-emerald-400 hover:bg-emerald-500/20 transition-colors cursor-pointer"
            >
              <Maximize2 className="w-3.5 h-3.5" />
            </button>
          </Tooltip>

          <Tooltip content="Desligar chamada" position="right">
            <button
              type="button"
              onClick={handleEndCall}
              disabled={isEnding}
              aria-label="Desligar chamada"
              className="p-1.5 rounded-lg bg-rose-600/30 hover:bg-rose-600 text-rose-300 hover:text-white transition-colors cursor-pointer"
            >
              {isEnding ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <PhoneOff className="w-3.5 h-3.5" />
              )}
            </button>
          </Tooltip>
        </div>
      </div>
    );
  }

  // 2. Modo Expandido na Barra Lateral Normal (w-60 / 240px)
  return (
    <div
      className="w-full border-t border-emerald-500/25 bg-gradient-to-b from-[#0e171b]/95 to-[#080a0f] p-2.5 shrink-0 select-none transition-all duration-150 animate-in fade-in"
      role="region"
      aria-label="Chamada ativa na barra lateral"
    >
      {/* Top Status Banner: Indicador de Voz Conectada + Duração */}
      <div className="flex items-center justify-between pb-1.5 mb-1.5 border-b border-white/[0.06] text-[10px] font-mono">
        <div className="flex items-center gap-1.5 min-w-0">
          <Radio
            className={`w-3 h-3 shrink-0 ${
              voiceCallState === 'reconnecting'
                ? 'text-amber-400 animate-ping'
                : 'text-emerald-400 animate-pulse'
            }`}
          />
          <span
            className={`truncate font-semibold ${
              voiceCallState === 'reconnecting' ? 'text-amber-400' : 'text-emerald-400'
            }`}
          >
            {voiceCallState === 'reconnecting' ? 'Reconectando...' : 'Voz Conectada'}
          </span>
        </div>

        <span className="text-zinc-400 font-mono shrink-0 pl-1">{durationText}</span>
      </div>

      {/* Peer Card: Clicável para retornar à tela de chamada */}
      <div
        onClick={() => setActiveTab('calls')}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setActiveTab('calls');
          }
        }}
        className="flex items-center gap-2.5 p-1.5 rounded-xl hover:bg-white/[0.05] cursor-pointer group transition-colors"
        title="Clique para abrir a tela da chamada"
      >
        <div className="relative shrink-0">
          <Avatar
            name={peerName}
            size="sm"
            className={
              isRemoteSpeaking && !isPeerMuted
                ? 'ring-2 ring-emerald-400 shadow-[0_0_8px_rgba(16,185,129,0.5)]'
                : ''
            }
          />
          <span
            className={`absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full border border-[#090b10] ${
              voiceCallState === 'reconnecting'
                ? 'bg-amber-400 animate-ping'
                : 'bg-emerald-500 animate-pulse'
            }`}
          />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-bold text-zinc-100 group-hover:text-emerald-300 transition-colors truncate">
              {peerName}
            </span>
            {isPeerMuted && (
              <span
                className="p-0.5 rounded bg-rose-500/20 text-rose-400 text-[9px]"
                title="Amigo silenciado"
              >
                <MicOff className="w-2.5 h-2.5" />
              </span>
            )}
          </div>

          <div className="flex items-center gap-1.5 text-[10px] text-zinc-400">
            {(isScreenSharing || isRemoteScreenSharing) && (
              <span
                className="px-1.5 py-0.2 rounded bg-nexus-accent/20 text-nexus-accent border border-nexus-accent/30 text-[9px] font-mono font-bold flex items-center gap-1"
                title={
                  isScreenSharing
                    ? 'Você está compartilhando tela'
                    : 'Assistindo transmissão de tela'
                }
              >
                <Monitor className="w-2.5 h-2.5" />
                <span>{isScreenSharing ? 'Transmitindo' : 'Tela'}</span>
              </span>
            )}
            {isLocalSpeaking && !isMicMuted && voiceCallState === 'connected' && (
              <span className="text-[9px] text-emerald-300 font-medium">• Falando</span>
            )}
          </div>
        </div>
      </div>

      {/* Controles Rápidos da Chamada */}
      <div className="flex items-center justify-between gap-1 mt-2 pt-2 border-t border-white/[0.06]">
        {/* Microfone */}
        <Tooltip content={isMicMuted ? 'Ativar microfone' : 'Silenciar'} position="top">
          <button
            type="button"
            onClick={() => callService.toggleMute()}
            aria-label={isMicMuted ? 'Ativar microfone' : 'Silenciar'}
            aria-pressed={isMicMuted}
            className={`w-9 h-9 shrink-0 flex items-center justify-center rounded-lg transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 ${
              isMicMuted
                ? 'bg-rose-600 text-white shadow-xs shadow-rose-950/50'
                : isLocalSpeaking
                ? 'bg-emerald-500/20 border border-emerald-500/40 text-emerald-300'
                : 'text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-200'
            }`}
          >
            {isMicMuted ? <MicOff className="w-3.5 h-3.5" /> : <Mic className="w-3.5 h-3.5" />}
          </button>
        </Tooltip>

        {/* Áudio/Fones */}
        <Tooltip content={isDeafened ? 'Ativar áudio' : 'Desativar áudio'} position="top">
          <button
            type="button"
            onClick={() => callService.toggleDeafen()}
            aria-label={isDeafened ? 'Ativar áudio' : 'Desativar áudio'}
            aria-pressed={isDeafened}
            className={`w-9 h-9 shrink-0 flex items-center justify-center rounded-lg transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 ${
              isDeafened
                ? 'bg-rose-600 text-white shadow-xs shadow-rose-950/50'
                : 'text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-200'
            }`}
          >
            <Headphones className="w-3.5 h-3.5" />
          </button>
        </Tooltip>

        {/* Parar Compartilhamento de Tela (se ativo) */}
        {isScreenSharing && (
          <Tooltip content="Parar compartilhamento de tela" position="top">
            <button
              type="button"
              onClick={() => useAppStore.getState().stopScreenShare()}
              aria-label="Parar compartilhamento de tela"
              className="p-1.5 rounded-lg bg-nexus-accent/20 hover:bg-rose-600/30 text-nexus-accent hover:text-rose-300 transition-colors cursor-pointer"
            >
              <ScreenShare className="w-3.5 h-3.5" />
            </button>
          </Tooltip>
        )}

        {/* Retornar à Tela da Chamada */}
        <Tooltip content="Abrir tela de chamada" position="top">
          <button
            type="button"
            onClick={() => setActiveTab('calls')}
            aria-label="Abrir tela de chamada"
            className="p-1.5 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] text-zinc-300 hover:text-emerald-300 transition-colors cursor-pointer"
          >
            <Maximize2 className="w-3.5 h-3.5" />
          </button>
        </Tooltip>

        {/* Desligar Chamada */}
        <Tooltip content="Desligar" position="top">
          <button
            type="button"
            onClick={handleEndCall}
            disabled={isEnding}
            aria-label="Desligar chamada"
            className={`p-1.5 rounded-lg bg-rose-600 hover:bg-rose-700 text-white transition-colors cursor-pointer shadow-xs shadow-rose-950/40 ${
              isEnding ? 'opacity-70 cursor-wait' : ''
            }`}
          >
            {isEnding ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <PhoneOff className="w-3.5 h-3.5" />
            )}
          </button>
        </Tooltip>
      </div>
    </div>
  );
};
