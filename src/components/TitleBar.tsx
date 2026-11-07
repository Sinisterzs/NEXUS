import React from 'react';
import { Search, LogIn, LogOut } from 'lucide-react';
import { useAppStore } from '../stores/useAppStore';

const tabTitles = {
  home: 'Início',
  messages: 'Mensagens',
  communities: 'Comunidades',
  calls: 'Chamadas',
  settings: 'Configurações',
};

interface TitleBarProps {
  backendReady?: boolean;
}

const NetworkStatusBadge: React.FC = () => {
  const networkStatus = useAppStore((state) => state.networkStatus);
  const checkSession = useAppStore((state) => state.checkSession);
  const openTailscale = useAppStore((state) => state.openTailscale);

  const reachability = networkStatus.server_reachability;

  if (reachability === 'connected') {
    return (
      <div
        title={`Conectado ao servidor via ${networkStatus.is_magic_dns ? 'MagicDNS' : 'Tailscale'} (${networkStatus.server_url})${networkStatus.server_latency_ms ? ` • ${networkStatus.server_latency_ms}ms` : ''}`}
        className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-nexus-panel border border-emerald-500/30 text-[10px] text-emerald-300 font-medium select-none"
      >
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shadow-sm shadow-emerald-400/50" />
        <span>Servidor conectado</span>
      </div>
    );
  }

  if (reachability === 'connecting') {
    return (
      <div
        title="Verificando conectividade com o servidor NEXUS..."
        className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-nexus-panel border border-amber-500/30 text-[10px] text-amber-300 font-medium select-none"
      >
        <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
        <span>Conectando...</span>
      </div>
    );
  }

  if (reachability === 'network_disconnected') {
    return (
      <button
        onClick={() => openTailscale()}
        title="Rede privada Tailscale desconectada. Clique para abrir o Tailscale."
        className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-rose-500/15 border border-rose-500/40 text-[10px] text-rose-300 hover:text-white hover:bg-rose-500/25 transition-colors cursor-pointer select-none"
      >
        <span className="w-1.5 h-1.5 rounded-full bg-rose-400" />
        <span>Rede privada desconectada</span>
      </button>
    );
  }

  // server_unreachable
  return (
    <button
      onClick={() => checkSession()}
      title="Rede ativa, mas o servidor NEXUS está inacessível. Clique para tentar reconectar."
      className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-amber-500/15 border border-amber-500/40 text-[10px] text-amber-200 hover:text-white hover:bg-amber-500/25 transition-colors cursor-pointer select-none"
    >
      <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
      <span>Servidor indisponível</span>
    </button>
  );
};

export const TitleBar: React.FC<TitleBarProps> = ({ backendReady }) => {
  const activeTab = useAppStore((state) => state.activeTab);
  const authMode = useAppStore((state) => state.authMode);
  const onlineUser = useAppStore((state) => state.onlineUser);
  const openAuthModal = useAppStore((state) => state.openAuthModal);
  const logoutOnline = useAppStore((state) => state.logoutOnline);

  return (
    <header
      data-tauri-drag-region
      className="h-10 w-full bg-nexus-surface border-b border-nexus-border flex items-center justify-between px-3 shrink-0 select-none text-xs"
    >
      {/* Left: Brand & Breadcrumb */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2 font-bold tracking-wider text-nexus-text">
          <div className="w-5 h-5 rounded bg-nexus-accent flex items-center justify-center text-white font-extrabold text-[11px] shadow-sm">
            N
          </div>
          <span className="font-semibold text-sm tracking-wide">NEXUS</span>
          <span className="text-[10px] px-1.5 py-0.2 rounded bg-nexus-panel text-nexus-muted border border-nexus-border font-mono">
            v0.1.1
          </span>
        </div>

        <span className="text-nexus-border">/</span>

        <div className="text-nexus-muted font-medium flex items-center gap-1.5">
          <span>{tabTitles[activeTab]}</span>
        </div>
      </div>

      {/* Center: Search / Quick jump placeholder */}
      <div className="flex-1 max-w-sm mx-4">
        <div className="relative flex items-center">
          <Search className="w-3.5 h-3.5 absolute left-2.5 text-nexus-muted pointer-events-none" />
          <input
            type="text"
            readOnly
            placeholder="Pesquisar canais, amigos ou mensagens (Ctrl+K)"
            className="w-full bg-nexus-bg text-nexus-text text-xs pl-8 pr-3 py-1 rounded border border-nexus-border hover:border-nexus-muted focus:border-nexus-accent focus:outline-none transition-colors cursor-pointer"
          />
        </div>
      </div>

      {/* Right: Online Auth & Connection Status */}
      <div className="flex items-center gap-2.5 text-nexus-muted">
        <NetworkStatusBadge />

        {authMode === 'authenticated' && onlineUser ? (
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-nexus-panel border border-emerald-500/30 text-[11px]">
              <span className="w-2 h-2 rounded-full bg-emerald-400 shadow-sm shadow-emerald-400/50" />
              <span className="text-[11px] font-semibold text-nexus-text truncate max-w-[120px]">
                {onlineUser.username}
              </span>
              <span className="text-[9px] font-mono px-1 py-0.2 rounded bg-emerald-500/20 text-emerald-300">
                ONLINE
              </span>
            </div>
            <button
              onClick={() => logoutOnline()}
              title="Encerrar sessão online"
              className="p-1 rounded hover:bg-nexus-panel text-nexus-muted hover:text-rose-400 transition-colors cursor-pointer"
            >
              <LogOut className="w-3.5 h-3.5" />
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <button
              onClick={openAuthModal}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-nexus-accent/15 border border-nexus-accent/40 text-[11px] font-semibold text-white hover:bg-nexus-accent hover:border-nexus-accent transition-all cursor-pointer shadow-sm"
            >
              <LogIn className="w-3 h-3 text-nexus-accent group-hover:text-white" />
              <span>Entrar / Cadastrar</span>
            </button>
            <div className="flex items-center gap-1 px-2 py-0.5 rounded bg-nexus-panel border border-nexus-border text-[10px] font-mono text-nexus-muted">
              <span className={`w-1.5 h-1.5 rounded-full ${backendReady ? 'bg-emerald-400' : 'bg-amber-400/80'}`} />
              <span>{backendReady ? 'Demo' : 'Desktop'}</span>
            </div>
          </div>
        )}
      </div>
    </header>
  );
};
