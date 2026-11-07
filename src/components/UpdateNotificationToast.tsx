import React, { useEffect, useState } from 'react';
import { Download, RefreshCw, X, Sparkles } from 'lucide-react';
import { updateService, UpdateState } from '../services/UpdateService';

export const UpdateNotificationToast: React.FC = () => {
  const [state, setState] = useState<UpdateState>(updateService.getState());

  useEffect(() => {
    const unsub = updateService.addListener((newState) => {
      setState(newState);
    });

    // Verificação silenciosa de atualização 4 segundos após o app carregar
    const timer = setTimeout(() => {
      updateService.checkForUpdates(true).catch(() => {});
    }, 4000);

    return () => {
      unsub();
      clearTimeout(timer);
    };
  }, []);

  if (state.status !== 'available' && state.status !== 'downloading' && state.status !== 'installing') {
    return null;
  }

  const { updateInfo, downloadProgress, status } = state;
  const version = updateInfo?.version || 'nova';

  const handleUpdate = async () => {
    try {
      await updateService.downloadAndInstall();
    } catch {
      // Erro gerenciado no estado
    }
  };

  const handleDismiss = () => {
    updateService.dismissUpdate();
  };

  return (
    <div className="fixed bottom-6 left-6 z-[9990] animate-in fade-in slide-in-from-bottom-4 duration-300">
      <div className="w-88 p-4 rounded-2xl bg-nexus-surface/95 backdrop-blur-xl border border-nexus-accent/40 shadow-2xl shadow-nexus-accent/15 flex flex-col gap-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-nexus-accent/20 border border-nexus-accent/30 flex items-center justify-center text-nexus-accent shrink-0">
              <Sparkles className="w-4 h-4" />
            </div>
            <div>
              <h4 className="text-xs font-bold text-nexus-text">
                Atualização Disponível (v{version})
              </h4>
              <p className="text-[11px] text-nexus-muted">
                {status === 'downloading'
                  ? `Baixando nova versão (${downloadProgress}%)...`
                  : status === 'installing'
                  ? 'Instalando e reiniciando o NEXUS...'
                  : 'Uma nova versão do NEXUS está pronta para você.'}
              </p>
            </div>
          </div>

          {status === 'available' && (
            <button
              onClick={handleDismiss}
              className="text-nexus-muted hover:text-nexus-text p-1 rounded-lg transition-colors cursor-pointer"
              title="Lembrar mais tarde"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {/* Barra de progresso durante o download */}
        {status === 'downloading' && (
          <div className="space-y-1.5 pt-1">
            <div className="h-1.5 w-full bg-nexus-border rounded-full overflow-hidden">
              <div
                className="h-full bg-nexus-accent transition-all duration-300"
                style={{ width: `${downloadProgress}%` }}
              />
            </div>
            <div className="flex justify-between text-[10px] text-nexus-muted font-mono">
              <span>Baixando atualização</span>
              <span>{downloadProgress}%</span>
            </div>
          </div>
        )}

        {status === 'installing' && (
          <div className="flex items-center gap-2 text-xs text-nexus-accent font-medium pt-1">
            <RefreshCw className="w-3.5 h-3.5 animate-spin" />
            <span>Aplicando nova versão e reiniciando...</span>
          </div>
        )}

        {/* Botão de ação */}
        {status === 'available' && (
          <div className="flex items-center gap-2 pt-1 border-t border-nexus-border/60">
            <button
              onClick={handleDismiss}
              className="flex-1 py-1.5 px-3 rounded-xl bg-nexus-panel hover:bg-nexus-surface text-nexus-muted hover:text-nexus-text text-xs font-semibold transition-nexus cursor-pointer"
            >
              Depois
            </button>

            <button
              onClick={handleUpdate}
              className="flex-1 py-1.5 px-3 rounded-xl bg-nexus-accent hover:bg-rose-700 text-white text-xs font-semibold flex items-center justify-center gap-1.5 transition-nexus shadow-lg shadow-nexus-accent/30 cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Atualizar Agora</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
