import React, { useState } from 'react';
import { ShieldAlert, Check, ExternalLink, Loader2, Copy, CheckCheck } from 'lucide-react';
import { useAppStore } from '../../stores/useAppStore';
import { APP_VERSION } from '../../version';

export const ServerApprovalView: React.FC = () => {
  const networkStatus = useAppStore((state) => state.networkStatus);
  const approveServer = useAppStore((state) => state.approveServer);
  const openTailscale = useAppStore((state) => state.openTailscale);

  const [isApproving, setIsApproving] = useState(false);
  const [copied, setCopied] = useState(false);

  const pending = networkStatus.pending_server_identity;
  const serverId = pending?.server_id || networkStatus.approved_server_id || 'Não identificado';
  const publicKey = pending?.public_key || 'Desconhecida';
  const endpoint = pending?.bound_endpoint || networkStatus.server_url || 'https://nexus-api.dynv6.net';

  const handleApprove = async () => {
    setIsApproving(true);
    try {
      await approveServer();
    } finally {
      setIsApproving(false);
    }
  };

  const handleCopyId = () => {
    if (serverId) {
      navigator.clipboard.writeText(serverId);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-nexus-bg text-nexus-text select-none">
      {/* Header Drag Region */}
      <header
        data-tauri-drag-region
        className="h-10 w-full bg-nexus-surface border-b border-nexus-border flex items-center justify-between px-3 shrink-0 text-xs"
      >
        <div className="flex items-center gap-2 font-bold tracking-wider text-nexus-text">
          <div className="w-5 h-5 rounded bg-nexus-accent flex items-center justify-center text-white font-extrabold text-[11px] shadow-sm">
            N
          </div>
          <span className="font-semibold text-sm tracking-wide">NEXUS</span>
          <span className="text-[10px] px-1.5 py-0.2 rounded bg-nexus-panel text-nexus-muted border border-nexus-border font-mono">
            v{APP_VERSION}
          </span>
        </div>

        <div className="flex items-center gap-2 text-[11px] text-sky-300 font-medium">
          <span className="w-2 h-2 rounded-full bg-sky-400 animate-pulse" />
          <span>Aprovação de Servidor</span>
        </div>
      </header>

      {/* Main Content Area */}
      <div className="flex-1 flex items-center justify-center p-4 overflow-y-auto">
        <div className="relative w-full max-w-lg bg-nexus-surface border border-nexus-border/80 rounded-2xl shadow-2xl shadow-black/80 p-6 space-y-5 animate-fadeIn">
          {/* Top highlight bar */}
          <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-sky-500 via-blue-500 to-sky-500 rounded-t-2xl" />

          {/* Icon & Title */}
          <div className="text-center pt-2">
            <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-sky-500/10 border border-sky-500/30 text-sky-400 mb-3 shadow-inner">
              <ShieldAlert className="w-7 h-7" />
            </div>
            <h2 className="text-lg font-bold text-nexus-text">Autorização de Novo Servidor NEXUS</h2>
            <p className="text-xs text-nexus-muted mt-1 max-w-md mx-auto">
              Um novo servidor foi localizado na rede privada. Por segurança contra servidores não autorizados, nenhuma credencial ou sessão será transmitida antes da sua confirmação explícita.
            </p>
          </div>

          {/* Cryptographic Identity Box */}
          <div className="p-4 rounded-xl bg-nexus-panel/70 border border-nexus-border/70 space-y-3 font-mono text-xs">
            <div>
              <span className="text-[10px] text-nexus-muted uppercase tracking-wider block">ID do Servidor (Hash Ed25519)</span>
              <div className="flex items-center justify-between gap-2 mt-0.5">
                <span className="text-nexus-text font-semibold break-all text-[11px]" title={serverId}>
                  {serverId}
                </span>
                <button
                  type="button"
                  onClick={handleCopyId}
                  className="p-1.5 rounded-lg bg-nexus-surface hover:bg-nexus-bg text-nexus-muted hover:text-nexus-text transition-colors shrink-0"
                  title="Copiar ID completo"
                >
                  {copied ? <CheckCheck className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                </button>
              </div>
            </div>

            <div className="pt-2 border-t border-nexus-border/50">
              <span className="text-[10px] text-nexus-muted uppercase tracking-wider block">Chave Pública Ed25519</span>
              <span className="text-nexus-muted text-[11px] break-all block mt-0.5">
                {publicKey}
              </span>
            </div>

            <div className="pt-2 border-t border-nexus-border/50">
              <span className="text-[10px] text-nexus-muted uppercase tracking-wider block">Endereço do Servidor</span>
              <span className="text-nexus-text text-[11px] block mt-0.5">
                {endpoint}
              </span>
            </div>
          </div>

          {/* Action Buttons */}
          <div className="flex flex-col sm:flex-row gap-3 pt-2">
            <button
              type="button"
              disabled={isApproving}
              onClick={handleApprove}
              className="flex-1 py-2.5 px-4 rounded-xl bg-sky-600 hover:bg-sky-500 active:scale-[0.99] text-white text-xs font-bold shadow-md shadow-sky-600/25 transition-all flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
            >
              {isApproving ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>Aprovando servidor...</span>
                </>
              ) : (
                <>
                  <Check className="w-4 h-4" />
                  <span>Aprovar Servidor e Continuar</span>
                </>
              )}
            </button>

            <button
              type="button"
              onClick={() => openTailscale()}
              className="py-2.5 px-4 rounded-xl bg-nexus-panel hover:bg-nexus-surface border border-nexus-border text-xs font-semibold text-nexus-text transition-colors flex items-center justify-center gap-2 cursor-pointer"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              <span>Abrir Tailscale</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
