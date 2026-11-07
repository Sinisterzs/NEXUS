import React, { useState, useEffect } from 'react';
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
} from 'lucide-react';
import { useAppStore } from '../../stores/useAppStore';
import { callService } from '../../services/CallService';
import { callHistoryRepository, CallHistoryEntry } from '../../repositories/CallHistoryRepository';
import { Avatar } from '../../components/Avatar';
import { Tooltip } from '../../components/Tooltip';
import { EmptyState } from '../../components/EmptyState';

function formatDuration(totalSeconds: number): string {
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

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

export const CallsView: React.FC = () => {
  const voiceCallState = useAppStore((state) => state.voiceCallState);
  const activeCallPeer = useAppStore((state) => state.activeCallPeer);
  const incomingCall = useAppStore((state) => state.incomingCall);
  const callDurationSecs = useAppStore((state) => state.callDurationSecs);
  const isMicMuted = useAppStore((state) => state.isMicMuted);
  const isDeafened = useAppStore((state) => state.isDeafened);
  const isLocalSpeaking = useAppStore((state) => state.isLocalSpeaking);
  const isRemoteSpeaking = useAppStore((state) => state.isRemoteSpeaking);
  const isPeerMuted = useAppStore((state) => state.isPeerMuted);
  const callErrorMessage = useAppStore((state) => state.callErrorMessage);
  const setCallErrorMessage = useAppStore((state) => state.setCallErrorMessage);
  const currentUser = useAppStore((state) => state.currentUser);
  const setActiveTab = useAppStore((state) => state.setActiveTab);

  const [callHistory, setCallHistory] = useState<CallHistoryEntry[]>([]);
  const [isEnding, setIsEnding] = useState(false);

  // Carrega histórico de chamadas ao entrar ou quando estado voltar para idle
  useEffect(() => {
    if (voiceCallState === 'idle') {
      setIsEnding(false);
      setCallHistory(callHistoryRepository.getHistory());
    }
  }, [voiceCallState]);

  const handleClearHistory = () => {
    callHistoryRepository.clearHistory();
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
    // Executa encerramento com resposta visual imediata
    setTimeout(() => {
      callService.endCall();
    }, 50);
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
              className="px-2 py-0.5 rounded hover:bg-rose-500/20 text-xs font-bold transition-nexus"
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
                      {/* Ícone de Direção / Status */}
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

                      {/* Avatar e Dados do Amigo */}
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

                    {/* Botão de Retorno / Ligar Imediato */}
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
            Chamando via Tailscale...
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
            Negociando rota segura WebRTC via túnel privado Tailscale...
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

  // 5. Chamada Conectada / Ativa (Connected / Reconnecting)
  return (
    <div className="flex-1 flex flex-col bg-nexus-bg overflow-hidden relative select-none">
      {/* Top Header */}
      <div className="h-12 border-b border-nexus-border px-4 flex items-center justify-between bg-nexus-surface shrink-0 z-10">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <Radio className="w-4 h-4 text-emerald-400 animate-pulse" />
            <h2 className="text-xs font-bold text-nexus-text">
              Chamada com {activeCallPeer?.name || 'Amigo'}
            </h2>
          </div>
          <span className="text-[10px] text-nexus-muted border-l border-nexus-border pl-2 font-mono hidden sm:inline">
            Opus Áudio • WebRTC DTLS-SRTP (Tailscale)
          </span>
        </div>

        <div className="flex items-center gap-3">
          {/* Status Badge & Duration */}
          <div className="flex items-center gap-2 px-2.5 py-1 rounded bg-nexus-panel border border-nexus-border text-[11px] font-mono">
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
                ? 'Reconectando...'
                : formatDuration(callDurationSecs)}
            </span>
          </div>

          <Tooltip content="Configurações de Áudio" position="bottom">
            <button
              onClick={() => setActiveTab('settings')}
              className="p-1.5 rounded hover:bg-nexus-panel text-nexus-muted hover:text-nexus-text transition-nexus cursor-pointer"
            >
              <Sliders className="w-4 h-4" />
            </button>
          </Tooltip>
        </div>
      </div>

      {/* Main Call Stage - 2-Participant P2P Grid */}
      <div className="flex-1 flex flex-col items-center justify-center p-6 pb-24 overflow-y-auto">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 w-full max-w-3xl">
          {/* Tile 1: Usuário Local (Você) */}
          <div
            className={`bg-nexus-surface rounded-2xl border p-6 flex flex-col items-center justify-center relative shadow-sm transition-nexus ${
              isLocalSpeaking && !isMicMuted
                ? 'border-emerald-500 ring-2 ring-emerald-500/30'
                : isMicMuted
                ? 'border-rose-500/30 bg-rose-950/10'
                : 'border-nexus-border'
            }`}
          >
            <div className="relative mb-3">
              <Avatar
                name={currentUser?.displayName || currentUser?.username || 'Você'}
                size="xl"
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
              <span className="mt-2 px-2.5 py-0.5 rounded-full bg-rose-500/20 text-rose-400 border border-rose-500/40 text-[10px] font-mono font-semibold flex items-center gap-1.5">
                <MicOff className="w-3 h-3" />
                <span>Microfone silenciado</span>
              </span>
            ) : (
              <span
                className={`text-[10px] mt-2 font-mono font-medium ${
                  isLocalSpeaking ? 'text-emerald-400 font-bold' : 'text-nexus-muted'
                }`}
              >
                {isLocalSpeaking ? 'Falando...' : 'Conectado'}
              </span>
            )}
          </div>

          {/* Tile 2: Participante Remoto */}
          <div
            className={`bg-nexus-surface rounded-2xl border p-6 flex flex-col items-center justify-center relative shadow-sm transition-nexus ${
              isRemoteSpeaking && !isPeerMuted
                ? 'border-emerald-500 ring-2 ring-emerald-500/30'
                : isPeerMuted
                ? 'border-rose-500/30 bg-rose-950/10'
                : 'border-nexus-border'
            }`}
          >
            <div className="relative mb-3">
              <Avatar
                name={activeCallPeer?.name || 'Amigo'}
                size="xl"
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
              <span className="mt-2 px-2.5 py-0.5 rounded-full bg-rose-500/20 text-rose-400 border border-rose-500/40 text-[10px] font-mono font-semibold flex items-center gap-1.5">
                <MicOff className="w-3 h-3" />
                <span>Microfone silenciado pelo amigo</span>
              </span>
            ) : (
              <span
                className={`text-[10px] mt-2 font-mono font-medium ${
                  isRemoteSpeaking ? 'text-emerald-400 font-bold' : 'text-nexus-muted'
                }`}
              >
                {isRemoteSpeaking ? 'Falando...' : 'Conectado'}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Floating Centered Bottom Dock */}
      <div className="absolute bottom-5 left-1/2 -translate-x-1/2 z-30">
        <div className="flex items-center gap-3 px-5 py-2.5 rounded-2xl bg-nexus-surface/95 backdrop-blur-md border border-nexus-border shadow-2xl">
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

          <div className="w-[1px] h-6 bg-nexus-border mx-1" />

          {/* Encerrar Chamada - Com Feedback Visual Imediato */}
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
    </div>
  );
};
