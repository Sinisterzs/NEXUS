import React, { useState } from 'react';
import { WifiOff, RefreshCw, ExternalLink, Loader2, Save, CheckCircle2, AlertTriangle, ShieldCheck } from 'lucide-react';
import { useAppStore } from '../../stores/useAppStore';
import { networkManager } from '../../services/NetworkManager';
import { APP_VERSION } from '../../version';
import { WindowControls } from '../../components/WindowControls';

export const ServerOfflineView: React.FC = () => {
  const networkStatus = useAppStore((state) => state.networkStatus);
  const checkSession = useAppStore((state) => state.checkSession);
  const openTailscale = useAppStore((state) => state.openTailscale);
  const setServerAddress = useAppStore((state) => state.setServerAddress);
  const authStatus = useAppStore((state) => state.authStatus);

  const [addressInput, setAddressInput] = useState(
    networkStatus.server_url || 'https://nexus-api.dynv6.net'
  );
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [feedback, setFeedback] = useState<{ text: string; isError: boolean } | null>(null);

  const isTailscaleNeedsLogin = networkStatus.tailscale_state === 'needs_login';
  const isNetworkDisconnected = networkStatus.server_reachability === 'network_disconnected';
  const hasStoredSession = authStatus === 'offline';

  const handleReconnect = async () => {
    setIsReconnecting(true);
    setFeedback(null);
    try {
      await checkSession();
    } finally {
      setIsReconnecting(false);
    }
  };

  const handleTestConnection = async () => {
    setIsTesting(true);
    setFeedback(null);
    try {
      const res = await networkManager.probeServer(addressInput.trim());
      if (res.status === 'connected') {
        setFeedback({
          text: `Servidor respondeu com sucesso! Latência: ${res.latency_ms}ms`,
          isError: false,
        });
      } else {
        setFeedback({
          text: `Servidor não respondeu: ${res.error || 'Timeout de conexão'}`,
          isError: true,
        });
      }
    } catch (err: any) {
      setFeedback({
        text: err?.message || 'Falha ao testar conexão com o servidor.',
        isError: true,
      });
    } finally {
      setIsTesting(false);
    }
  };

  const handleSaveAddress = async () => {
    try {
      await setServerAddress(addressInput.trim());
      setFeedback({
        text: 'Novo endereço salvo! Reconectando...',
        isError: false,
      });
      await checkSession();
    } catch (err: any) {
      setFeedback({
        text: err?.message || 'Falha ao salvar endereço.',
        isError: true,
      });
    }
  };

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-nexus-bg text-nexus-text select-none">
      {/* Header Drag Region */}
      <header
        data-tauri-drag-region
        className="h-10 w-full bg-[#0B0C0E] border-b border-[#1E2026] flex items-center justify-between px-3 shrink-0 text-xs"
      >
        <div className="flex items-center gap-2">
          <div className="w-5 h-5 rounded bg-gradient-to-br from-rose-600 to-rose-700 flex items-center justify-center text-white font-black text-[11px] shadow-sm shadow-rose-900/40">
            N
          </div>
          <span className="font-bold text-xs tracking-wider text-zinc-100">NEXUS</span>
          <span className="text-[10px] px-1.5 py-0.2 rounded bg-zinc-900 text-zinc-400 border border-zinc-800 font-mono">
            v{APP_VERSION}
          </span>
        </div>

        <div className="flex items-center gap-3 h-full">
          <div className="flex items-center gap-2 text-[11px] text-amber-300 font-medium">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
            <span>Servidor Indisponível</span>
          </div>
          <div className="h-4 w-[1px] bg-zinc-800 mx-1 shrink-0" />
          <WindowControls />
        </div>
      </header>

      {/* Main Content Area */}
      <div className="flex-1 flex items-center justify-center p-4 overflow-y-auto">
        <div className="relative w-full max-w-lg bg-nexus-surface border border-nexus-border/80 rounded-2xl shadow-2xl shadow-black/80 p-6 space-y-5 animate-fadeIn">
          {/* Top highlight bar */}
          <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-amber-500 via-rose-500 to-amber-500 rounded-t-2xl" />

          {/* Icon & Title */}
          <div className="text-center pt-2">
            <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-amber-500/10 border border-amber-500/30 text-amber-400 mb-3">
              <WifiOff className="w-7 h-7" />
            </div>
            <h2 className="text-lg font-bold text-nexus-text">Servidor NEXUS Indisponível</h2>
            <p className="text-xs text-nexus-muted mt-1 max-w-md mx-auto">
              {networkStatus.server_url.startsWith('https://')
                ? 'Não foi possível conectar ao servidor NEXUS pela internet. Verifique sua conexão com a internet ou tente novamente.'
                : isTailscaleNeedsLogin
                ? 'Sua rede privada Tailscale precisa de autenticação para alcançar o backend.'
                : isNetworkDisconnected
                ? 'A rede privada Tailscale está desconectada ou desativada no seu computador.'
                : 'Não foi possível conectar ao servidor NEXUS no endereço configurado.'}
            </p>
          </div>

          {/* Stored session badge */}
          {hasStoredSession && (
            <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-xs flex items-center gap-2.5">
              <ShieldCheck className="w-4 h-4 shrink-0 text-emerald-400" />
              <span className="leading-relaxed">
                <strong>Sessão salva:</strong> Suas credenciais e dados locais estão preservados com segurança e serão restaurados automaticamente assim que o servidor responder.
              </span>
            </div>
          )}

          {/* Feedback Alert */}
          {feedback && (
            <div
              className={`p-3 rounded-xl text-xs flex items-start gap-2.5 ${
                feedback.isError
                  ? 'bg-rose-500/10 border border-rose-500/30 text-rose-300'
                  : 'bg-emerald-500/10 border border-emerald-500/30 text-emerald-300'
              }`}
            >
              {feedback.isError ? (
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-rose-400" />
              ) : (
                <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5 text-emerald-400" />
              )}
              <span className="leading-relaxed">{feedback.text}</span>
            </div>
          )}

          {/* Server Address Configuration Box */}
          <div className="p-4 rounded-xl bg-nexus-panel/60 border border-nexus-border/60 space-y-3">
            <div>
              <label className="block text-[11px] font-semibold text-nexus-text mb-1">
                {networkStatus.server_url.startsWith('https://')
                  ? 'Endereço do Servidor (HTTPS)'
                  : 'Endereço do Servidor (MagicDNS ou IP Tailscale)'}
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={addressInput}
                  onChange={(e) => {
                    setAddressInput(e.target.value);
                    setFeedback(null);
                  }}
                  placeholder="https://nexus-api.dynv6.net"
                  className="flex-1 bg-nexus-bg text-nexus-text text-xs px-3 py-2 rounded-xl border border-nexus-border focus:border-nexus-accent focus:outline-none font-mono"
                />
                <button
                  type="button"
                  disabled={isTesting}
                  onClick={handleTestConnection}
                  className="px-3 py-2 rounded-xl bg-nexus-surface hover:bg-nexus-panel border border-nexus-border text-xs font-semibold text-nexus-text transition-colors cursor-pointer disabled:opacity-50 flex items-center gap-1.5"
                >
                  {isTesting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Testar'}
                </button>
                <button
                  type="button"
                  onClick={handleSaveAddress}
                  className="px-3 py-2 rounded-xl bg-nexus-accent hover:bg-rose-700 text-xs font-semibold text-white transition-colors cursor-pointer flex items-center gap-1.5"
                >
                  <Save className="w-3.5 h-3.5" />
                  <span>Salvar</span>
                </button>
              </div>
            </div>

            {!networkStatus.server_url.startsWith('https://') && (
              <div className="flex items-center justify-between text-[11px] text-nexus-muted pt-1">
                <span>Status Tailscale: <strong>{networkStatus.tailscale_installed ? (networkStatus.tailscale_state === 'running' ? 'Ativo' : networkStatus.tailscale_state) : 'Não instalado'}</strong></span>
                <span>IP Local: <code className="font-mono text-nexus-text">{networkStatus.tailscale_ips[0] || 'Nenhum'}</code></span>
              </div>
            )}
          </div>

          {/* Action Buttons */}
          <div className="flex flex-col sm:flex-row gap-3 pt-2">
            <button
              type="button"
              disabled={isReconnecting}
              onClick={handleReconnect}
              className="flex-1 py-2.5 px-4 rounded-xl bg-nexus-accent hover:bg-rose-700 active:scale-[0.99] text-white text-xs font-bold shadow-md shadow-nexus-accent/20 transition-all flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isReconnecting ? 'animate-spin' : ''}`} />
              <span>{isReconnecting ? 'Reconectando...' : 'Tentar Reconectar'}</span>
            </button>

            {networkStatus.server_url.startsWith('https://') ? (
              addressInput.trim() !== 'https://nexus-api.dynv6.net' ? (
                <button
                  type="button"
                  onClick={async () => {
                    setAddressInput('https://nexus-api.dynv6.net');
                    await setServerAddress('https://nexus-api.dynv6.net');
                    await checkSession();
                  }}
                  className="py-2.5 px-4 rounded-xl bg-nexus-panel hover:bg-nexus-surface border border-nexus-border text-xs font-semibold text-nexus-text transition-colors flex items-center justify-center gap-2 cursor-pointer"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  <span>Restaurar Padrão (HTTPS)</span>
                </button>
              ) : null
            ) : networkStatus.tailscale_installed ? (
              <button
                type="button"
                onClick={() => openTailscale()}
                className="py-2.5 px-4 rounded-xl bg-nexus-panel hover:bg-nexus-surface border border-nexus-border text-xs font-semibold text-nexus-text transition-colors flex items-center justify-center gap-2 cursor-pointer"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                <span>Abrir Tailscale</span>
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
};
