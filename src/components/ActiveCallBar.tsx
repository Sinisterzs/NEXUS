import React, { useState } from 'react';
import {
  Mic,
  MicOff,
  Headphones,
  PhoneOff,
  Radio,
  Maximize2,
  Loader2,
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
      <div className="flex items-center gap-3 px-4 py-2 rounded-2xl bg-nexus-surface/95 backdrop-blur-md border border-emerald-500/40 shadow-2xl shadow-black/60 ring-1 ring-emerald-500/20">
        {/* Status & Peer Info */}
        <div
          onClick={() => setActiveTab('calls')}
          className="flex items-center gap-3 cursor-pointer group pr-2 border-r border-nexus-border/60"
        >
          <div className="relative">
            <Avatar name={activeCallPeer?.name || 'Amigo'} size="sm" />
            <span
              className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border border-nexus-surface ${
                voiceCallState === 'reconnecting'
                  ? 'bg-amber-400 animate-ping'
                  : 'bg-emerald-500 animate-pulse'
              }`}
            />
          </div>

          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-nexus-text group-hover:text-emerald-400 transition-colors truncate max-w-[120px] sm:max-w-[160px]">
                {activeCallPeer?.name || 'Amigo'}
              </span>
              {isPeerMuted && (
                <span className="p-0.5 rounded bg-rose-500/20 text-rose-400 text-[10px]" title="Amigo silenciado">
                  <MicOff className="w-2.5 h-2.5" />
                </span>
              )}
            </div>
            <div className="flex items-center gap-1.5 text-[10px] font-mono text-emerald-400">
              <Radio className="w-2.5 h-2.5 animate-pulse" />
              <span>
                {voiceCallState === 'reconnecting'
                  ? 'Reconectando...'
                  : voiceCallState === 'calling'
                  ? 'Chamando...'
                  : formatDuration(callDurationSecs)}
              </span>
            </div>
          </div>
        </div>

        {/* Quick Audio Controls */}
        <div className="flex items-center gap-1.5">
          <Tooltip content={isMicMuted ? 'Ativar microfone' : 'Silenciar'} position="top">
            <button
              onClick={() => callService.toggleMute()}
              className={`p-2 rounded-xl transition-all active:scale-95 cursor-pointer ${
                isMicMuted
                  ? 'bg-rose-600 text-white shadow-sm shadow-rose-950/50'
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

          {/* Botão de Retornar à Tela Cheia da Chamada */}
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
