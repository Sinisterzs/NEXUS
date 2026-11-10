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

  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 select-none animate-in fade-in slide-in-from-bottom-4 duration-200">
      <div className="flex items-center gap-3 px-4 py-2 rounded-2xl bg-[#0e1017]/95 backdrop-blur-md border border-emerald-500/40 shadow-2xl shadow-black/70 ring-1 ring-emerald-500/20">
        {/* Status & Peer Info */}
        <div
          onClick={() => setActiveTab('calls')}
          className="flex items-center gap-3 cursor-pointer group pr-3 border-r border-white/[0.08]"
        >
          <div className="relative">
            <Avatar
              name={activeCallPeer?.name || 'Amigo'}
              size="sm"
              className={
                isRemoteSpeaking && !isPeerMuted
                  ? 'ring-2 ring-emerald-400 shadow-[0_0_10px_rgba(16,185,129,0.5)]'
                  : ''
              }
            />
            <span
              className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border border-nexus-surface ${
                voiceCallState === 'reconnecting'
                  ? 'bg-amber-400 animate-ping'
                  : 'bg-emerald-500 animate-pulse'
              }`}
            />
          </div>

          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="text-xs font-bold text-nexus-text group-hover:text-emerald-400 transition-colors truncate max-w-[120px] sm:max-w-[160px]">
                {activeCallPeer?.name || 'Amigo'}
              </span>
              {isPeerMuted && (
                <span
                  className="p-0.5 rounded bg-rose-500/20 text-rose-400 text-[10px]"
                  title="Amigo silenciado"
                >
                  <MicOff className="w-2.5 h-2.5" />
                </span>
              )}
              {(isScreenSharing || isRemoteScreenSharing) && (
                <span
                  className="px-1.5 py-0.5 rounded bg-nexus-accent/20 text-nexus-accent border border-nexus-accent/30 text-[9px] font-mono font-bold flex items-center gap-1"
                  title={
                    isScreenSharing
                      ? 'Você está compartilhando a tela'
                      : 'Assistindo transmissão de tela'
                  }
                >
                  <Monitor className="w-2.5 h-2.5" />
                  <span>{isScreenSharing ? 'Transmitindo' : 'Tela'}</span>
                </span>
              )}
            </div>
            <div className="flex items-center gap-1.5 text-[10px] font-mono">
              <Radio
                className={`w-2.5 h-2.5 ${
                  voiceCallState === 'reconnecting'
                    ? 'text-amber-400 animate-ping'
                    : 'text-emerald-400 animate-pulse'
                }`}
              />
              <span
                className={
                  voiceCallState === 'reconnecting' ? 'text-amber-400 font-semibold' : 'text-emerald-400'
                }
              >
                {voiceCallState === 'reconnecting'
                  ? `Reconectando (${Math.max(1, reconnectAttempt)}/${maxReconnectAttempts})...`
                  : voiceCallState === 'calling'
                  ? 'Chamando...'
                  : voiceCallState === 'connecting'
                  ? 'Conectando P2P...'
                  : formatDuration(callDurationSecs)}
              </span>
              {isLocalSpeaking && !isMicMuted && voiceCallState === 'connected' && (
                <span className="text-[9px] text-emerald-300/90 font-sans ml-1">• Voz ativa</span>
              )}
            </div>
          </div>
        </div>

        {/* Quick Audio & Screen Controls */}
        <div className="flex items-center gap-1.5">
          <Tooltip content={isMicMuted ? 'Ativar microfone' : 'Silenciar'} position="top">
            <button
              onClick={() => callService.toggleMute()}
              className={`p-2 rounded-xl transition-all active:scale-95 cursor-pointer ${
                isMicMuted
                  ? 'bg-rose-600 text-white shadow-sm shadow-rose-950/50'
                  : isLocalSpeaking
                  ? 'bg-emerald-500/20 border border-emerald-500/40 text-emerald-300'
                  : 'bg-nexus-panel hover:bg-nexus-border text-nexus-text'
              }`}
            >
              {isMicMuted ? <MicOff className="w-3.5 h-3.5" /> : <Mic className="w-3.5 h-3.5" />}
            </button>
          </Tooltip>

          <Tooltip content={isDeafened ? 'Ativar áudio' : 'Desativar áudio'} position="top">
            <button
              onClick={() => callService.toggleDeafen()}
              className={`p-2 rounded-xl transition-all active:scale-95 cursor-pointer ${
                isDeafened
                  ? 'bg-rose-600 text-white shadow-sm shadow-rose-950/50'
                  : 'bg-nexus-panel hover:bg-nexus-border text-nexus-text'
              }`}
            >
              <Headphones className="w-3.5 h-3.5" />
            </button>
          </Tooltip>

          {isScreenSharing && (
            <Tooltip content="Parar compartilhamento de tela" position="top">
              <button
                onClick={() => useAppStore.getState().stopScreenShare()}
                className="p-2 rounded-xl bg-nexus-accent/20 hover:bg-rose-600/30 border border-nexus-accent/40 text-nexus-accent hover:text-rose-300 transition-all active:scale-95 cursor-pointer"
              >
                <ScreenShare className="w-3.5 h-3.5" />
              </button>
            </Tooltip>
          )}

          {/* Botão de Retornar à Tela da Chamada */}
          <Tooltip content="Abrir tela da chamada" position="top">
            <button
              onClick={() => setActiveTab('calls')}
              className="p-2 rounded-xl bg-nexus-panel hover:bg-nexus-border text-nexus-text transition-all active:scale-95 cursor-pointer"
            >
              <Maximize2 className="w-3.5 h-3.5" />
            </button>
          </Tooltip>

          {/* Desligar Chamada */}
          <Tooltip content="Desligar" position="top">
            <button
              onClick={handleEndCall}
              disabled={isEnding}
              className={`p-2 rounded-xl bg-rose-600 hover:bg-rose-700 text-white transition-all active:scale-95 shadow-md shadow-rose-950/40 cursor-pointer ml-1 ${
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
    </div>
  );
};
