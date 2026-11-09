import React from 'react';
import { WifiOff, RefreshCw, ExternalLink, ShieldAlert, Check } from 'lucide-react';
import { useAppStore } from '../stores/useAppStore';

export const ConnectionBanner: React.FC = () => {
  const authMode = useAppStore((state) => state.authMode);
  const backendAvailable = useAppStore((state) => state.backendAvailable);
  const networkStatus = useAppStore((state) => state.networkStatus);
  const checkSession = useAppStore((state) => state.checkSession);
  const openTailscale = useAppStore((state) => state.openTailscale);
  const approveServer = useAppStore((state) => state.approveServer);

  // If backend is fully available and connected, no banner needed
  if (backendAvailable && networkStatus.server_reachability === 'connected') {
    return null;
  }

  // 0. Server Needs User Approval (TOFU - Trust On First Use)
  if (networkStatus.server_reachability === 'needs_approval') {
    return (
      <div className="bg-sky-500/15 border-b border-sky-500/30 px-3 py-2 flex items-center justify-between text-xs text-sky-100 select-none animate-fadeIn">
        <div className="flex items-center gap-2">
          <ShieldAlert className="w-4 h-4 text-sky-400 shrink-0" />
          <span>
            Novo servidor NEXUS localizado (<code className="font-mono text-sky-200">{networkStatus.pending_server_identity?.server_id || networkStatus.server_url}</code>). Deseja autorizar este servidor?
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => approveServer()}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-sky-600 hover:bg-sky-500 text-white font-semibold text-[11px] cursor-pointer shadow transition-colors"
          >
            <Check className="w-3.5 h-3.5" />
            Aprovar e Conectar
          </button>
        </div>
      </div>
    );
  }

  // 1. Private Network Disconnected (Tailscale not running, stopped, or needs login)
  if (networkStatus.server_reachability === 'network_disconnected') {
    const isHttps = networkStatus.server_url.startsWith('https://');
    return (
      <div className="bg-rose-500/10 border-b border-rose-500/25 px-3 py-1.5 flex items-center justify-between text-xs text-rose-200 select-none animate-fadeIn">
        <div className="flex items-center gap-2">
          <WifiOff className="w-3.5 h-3.5 text-rose-400 shrink-0" />
          <span>
            {isHttps
              ? 'Sem conexão com a internet. Operando em modo offline com SQLite.'
              : networkStatus.tailscale_state === 'needs_login'
              ? 'Autenticação necessária no Tailscale. Abra o aplicativo para autorizar seu dispositivo.'
              : 'Rede privada Tailscale desconectada. Operando em modo offline com SQLite.'}
          </span>
        </div>
        <div className="flex items-center gap-3">
          {!isHttps && (
            <button
              onClick={() => openTailscale()}
              className="flex items-center gap-1 text-[11px] font-semibold text-rose-200 hover:text-white underline cursor-pointer"
            >
              <ExternalLink className="w-3 h-3" />
              {networkStatus.tailscale_state === 'needs_login' ? 'Entrar no Tailscale' : 'Abrir Tailscale'}
            </button>
          )}
          <button
            onClick={() => checkSession()}
            className="flex items-center gap-1 text-[11px] font-semibold text-rose-300 hover:text-white underline cursor-pointer"
          >
            <RefreshCw className="w-3 h-3" />
            {isHttps ? 'Tentar Reconectar' : 'Reconectar'}
          </button>
        </div>
      </div>
    );
  }

  // 2. Server Unreachable
  if (networkStatus.server_reachability === 'server_unreachable') {
    const isHttps = networkStatus.server_url.startsWith('https://');
    return (
      <div className="bg-amber-500/10 border-b border-amber-500/25 px-3 py-1.5 flex items-center justify-between text-xs text-amber-200 select-none animate-fadeIn">
        <div className="flex items-center gap-2">
          <WifiOff className="w-3.5 h-3.5 text-amber-400 shrink-0" />
          <span>
            {isHttps
              ? 'Servidor NEXUS indisponível pela internet. Suas mensagens e dados locais estão preservados no SQLite.'
              : 'Servidor NEXUS indisponível no computador principal. Suas mensagens e dados locais estão preservados no SQLite.'}
          </span>
        </div>
        <button
          onClick={() => checkSession()}
          className="flex items-center gap-1 text-[11px] font-semibold text-amber-200 hover:text-white underline cursor-pointer"
        >
          <RefreshCw className="w-3 h-3" />
          Tentar Reconectar
        </button>
      </div>
    );
  }

  // 3. Reconnecting state
  if (authMode === 'reconnecting' || networkStatus.server_reachability === 'connecting') {
    return (
      <div className="bg-amber-500/15 border-b border-amber-500/30 px-3 py-1.5 flex items-center justify-between text-xs text-amber-200 select-none animate-fadeIn">
        <div className="flex items-center gap-2">
          <RefreshCw className="w-3.5 h-3.5 text-amber-400 animate-spin" />
          <span>Restabelecendo conexão com o servidor NEXUS... Seus dados locais permanecem intactos.</span>
        </div>
        <button
          onClick={() => checkSession()}
          className="text-[11px] font-semibold underline hover:text-amber-100 cursor-pointer"
        >
          Reconectar agora
        </button>
      </div>
    );
  }

  return null;
};
