import React from 'react';
import { WifiOff, RefreshCw, ExternalLink } from 'lucide-react';
import { useAppStore } from '../stores/useAppStore';

export const ConnectionBanner: React.FC = () => {
  const authMode = useAppStore((state) => state.authMode);
  const backendAvailable = useAppStore((state) => state.backendAvailable);
  const networkStatus = useAppStore((state) => state.networkStatus);
  const checkSession = useAppStore((state) => state.checkSession);
  const openTailscale = useAppStore((state) => state.openTailscale);

  // If backend is fully available and connected, no banner needed
  if (backendAvailable && networkStatus.server_reachability === 'connected') {
    return null;
  }

  // 1. Private Network Disconnected (Tailscale not running, stopped, or needs login)
  if (networkStatus.server_reachability === 'network_disconnected') {
    return (
      <div className="bg-rose-500/10 border-b border-rose-500/25 px-3 py-1.5 flex items-center justify-between text-xs text-rose-200 select-none animate-fadeIn">
        <div className="flex items-center gap-2">
          <WifiOff className="w-3.5 h-3.5 text-rose-400 shrink-0" />
          <span>
            {networkStatus.tailscale_state === 'needs_login'
              ? 'Autenticação necessária no Tailscale. Abra o aplicativo para autorizar seu dispositivo.'
              : 'Rede privada Tailscale desconectada. Operando em modo offline com SQLite.'}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => openTailscale()}
            className="flex items-center gap-1 text-[11px] font-semibold text-rose-200 hover:text-white underline cursor-pointer"
          >
            <ExternalLink className="w-3 h-3" />
            {networkStatus.tailscale_state === 'needs_login' ? 'Entrar no Tailscale' : 'Abrir Tailscale'}
          </button>
          <button
            onClick={() => checkSession()}
            className="flex items-center gap-1 text-[11px] font-semibold text-rose-300 hover:text-white underline cursor-pointer"
          >
            <RefreshCw className="w-3 h-3" />
            Reconectar
          </button>
        </div>
      </div>
    );
  }

  // 2. Server Unreachable (Tailscale is OK, but host backend is offline)
  if (networkStatus.server_reachability === 'server_unreachable') {
    return (
      <div className="bg-amber-500/10 border-b border-amber-500/25 px-3 py-1.5 flex items-center justify-between text-xs text-amber-200 select-none animate-fadeIn">
        <div className="flex items-center gap-2">
          <WifiOff className="w-3.5 h-3.5 text-amber-400 shrink-0" />
          <span>
            Servidor NEXUS indisponível no computador principal. Suas mensagens e dados locais estão preservados no SQLite.
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
