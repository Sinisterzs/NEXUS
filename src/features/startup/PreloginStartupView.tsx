import React, { useEffect, useState } from 'react';
import {
  Sparkles,
  Download,
  RefreshCw,
  CheckCircle2,
  AlertCircle,
  WifiOff,
  ArrowRight,
  ShieldCheck,
  FileText,
} from 'lucide-react';
import { WindowControls } from '../../components/WindowControls';
import {
  preloginUpdaterService,
  PreloginUpdaterState,
} from '../../services/PreloginUpdaterService';

interface PreloginStartupViewProps {
  onComplete: () => void;
  channelOverride?: 'stable' | 'beta';
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

export const PreloginStartupView: React.FC<PreloginStartupViewProps> = ({
  onComplete,
  channelOverride,
}) => {
  const [updaterState, setUpdaterState] = useState<PreloginUpdaterState>(
    preloginUpdaterService.getState()
  );
  const [showFullChangelog, setShowFullChangelog] = useState(false);
  const [hasStarted, setHasStarted] = useState(false);

  useEffect(() => {
    const unsubscribe = preloginUpdaterService.addListener((newState) => {
      setUpdaterState(newState);
    });

    if (!hasStarted) {
      setHasStarted(true);
      preloginUpdaterService.runStartupSequence({
        channelOverride,
        onProceed: () => {
          onComplete();
        },
      });
    }

    return () => {
      unsubscribe();
    };
  }, [onComplete, channelOverride, hasStarted]);

  const {
    status,
    channel,
    currentVersion,
    updateInfo,
    downloadProgress,
    downloadedBytes,
    totalBytes,
    errorMessage,
  } = updaterState;

  const handleConfirmUpdate = async () => {
    await preloginUpdaterService.confirmUpdate(() => {
      onComplete();
    });
  };

  const handleSkipOrProceed = () => {
    preloginUpdaterService.skipUpdate(() => {
      onComplete();
    });
  };

  const handleRetry = async () => {
    await preloginUpdaterService.retry(() => {
      onComplete();
    });
  };

  return (
    <div className="relative flex flex-col items-center justify-center h-screen w-screen bg-nexus-bg text-nexus-text select-none overflow-hidden font-sans">
      {/* Top Titlebar / WindowControls */}
      <div className="absolute top-0 left-0 right-0 h-9 flex items-center justify-between px-3 z-50 bg-nexus-bg/60 backdrop-blur-md border-b border-nexus-border/30">
        <div className="flex items-center gap-2 select-none pointer-events-none">
          <div className="w-4 h-4 rounded-md bg-nexus-accent flex items-center justify-center text-[10px] font-black text-white shadow-sm">
            N
          </div>
          <span className="text-[11px] font-bold tracking-wider text-nexus-muted">
            NEXUS STARTUP
          </span>
          <span className="text-[10px] px-1.5 py-0.2 rounded bg-nexus-panel text-nexus-muted border border-nexus-border/50 uppercase font-mono">
            {channel === 'beta' ? 'Canal Beta' : 'Canal Estável'}
          </span>
        </div>
        <WindowControls />
      </div>

      {/* Background Ambient Glow */}
      <div className="absolute -top-32 -left-32 w-96 h-96 bg-nexus-accent/10 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute -bottom-32 -right-32 w-96 h-96 bg-cyan-500/10 rounded-full blur-3xl pointer-events-none" />

      {/* Central Content Card */}
      <div className="z-10 flex flex-col items-center max-w-md w-full px-6 py-8 rounded-3xl bg-nexus-surface/80 border border-nexus-border/60 shadow-2xl backdrop-blur-xl">
        {/* Animated Brand Emblem */}
        <div className="relative mb-5">
          <div className="w-16 h-16 rounded-2xl bg-gradient-to-tr from-nexus-panel to-nexus-surface border border-nexus-accent/30 flex items-center justify-center shadow-lg shadow-nexus-accent/10">
            {status === 'checking' || status === 'starting' ? (
              <RefreshCw className="w-7 h-7 text-nexus-accent animate-spin" />
            ) : status === 'downloading' ? (
              <Download className="w-7 h-7 text-cyan-400 animate-pulse" />
            ) : status === 'installing' || status === 'restarting' ? (
              <ShieldCheck className="w-7 h-7 text-nexus-accent animate-pulse" />
            ) : status === 'up_to_date' ? (
              <CheckCircle2 className="w-7 h-7 text-emerald-400" />
            ) : status === 'update_found' ? (
              <Sparkles className="w-7 h-7 text-amber-400 animate-bounce" />
            ) : status === 'connection_error' ? (
              <WifiOff className="w-7 h-7 text-amber-400" />
            ) : (
              <AlertCircle className="w-7 h-7 text-rose-400" />
            )}
          </div>
          {(status === 'downloading' || status === 'checking') && (
            <div className="absolute -inset-1 rounded-2xl bg-nexus-accent/20 blur-sm -z-10 animate-pulse" />
          )}
        </div>

        {/* Status Headings & Descriptions */}
        <div className="text-center w-full mb-6">
          {status === 'starting' && (
            <>
              <h2 className="text-sm font-bold text-nexus-text">Iniciando NEXUS...</h2>
              <p className="text-xs text-nexus-muted mt-1 font-mono">Preparando ambiente seguro</p>
            </>
          )}

          {status === 'checking' && (
            <>
              <h2 className="text-sm font-bold text-nexus-text">Verificando Atualizações...</h2>
              <p className="text-xs text-nexus-muted mt-1 font-mono">
                Consultando o canal {channel === 'beta' ? 'Beta / Nightly' : 'Estável'}
              </p>
            </>
          )}

          {status === 'up_to_date' && (
            <>
              <h2 className="text-sm font-bold text-emerald-400">NEXUS Atualizado</h2>
              <p className="text-xs text-nexus-muted mt-1">
                Você já está usando a versão mais recente ({currentVersion}).
              </p>
            </>
          )}

          {status === 'update_found' && (
            <>
              <div className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-amber-500/10 border border-amber-500/20 text-amber-400 text-[10px] font-bold uppercase tracking-wider mb-2">
                <Sparkles className="w-3 h-3" />
                Nova Versão Disponível
              </div>
              <h2 className="text-base font-bold text-nexus-text">
                Atualização v{updateInfo?.version || 'Nova'}
              </h2>
              <p className="text-xs text-nexus-muted mt-0.5 font-mono">
                Versão atual instalada: v{currentVersion}
              </p>
            </>
          )}

          {status === 'downloading' && (
            <>
              <h2 className="text-sm font-bold text-cyan-400">
                Baixando Atualização (v{updateInfo?.version || ''})
              </h2>
              <p className="text-xs text-nexus-muted mt-1 font-mono">
                {totalBytes > 0
                  ? `${formatBytes(downloadedBytes)} de ${formatBytes(totalBytes)}`
                  : 'Obtendo arquivos de atualização...'}
              </p>
            </>
          )}

          {status === 'installing' && (
            <>
              <h2 className="text-sm font-bold text-nexus-text">Instalando Atualização...</h2>
              <p className="text-xs text-nexus-muted mt-1">
                Validando integridade e aplicando novos binários
              </p>
            </>
          )}

          {status === 'restarting' && (
            <>
              <h2 className="text-sm font-bold text-nexus-accent">Reiniciando o NEXUS...</h2>
              <p className="text-xs text-nexus-muted mt-1 font-mono">
                O aplicativo será reiniciado para concluir a instalação
              </p>
            </>
          )}

          {status === 'connection_error' && (
            <>
              <h2 className="text-sm font-bold text-amber-400">Modo Offline / Sem Conexão</h2>
              <p className="text-xs text-nexus-muted mt-1">
                Não foi possível consultar os servidores de atualização.
              </p>
              {errorMessage && (
                <p className="text-[10px] text-nexus-muted/80 mt-1 font-mono max-w-xs mx-auto truncate">
                  {errorMessage}
                </p>
              )}
            </>
          )}

          {status === 'install_error' && (
            <>
              <h2 className="text-sm font-bold text-rose-400">Falha na Atualização</h2>
              <p className="text-xs text-nexus-muted mt-1">
                Não foi possível concluir o download ou a instalação.
              </p>
              {errorMessage && (
                <p className="text-[10px] text-rose-300/80 mt-1 font-mono max-w-xs mx-auto break-words">
                  {errorMessage}
                </p>
              )}
            </>
          )}
        </div>

        {/* Progress Bar (Visible during downloading and installing) */}
        {(status === 'downloading' || status === 'installing') && (
          <div className="w-full space-y-2 mb-4">
            <div className="w-full h-2 bg-nexus-panel rounded-full overflow-hidden p-0.5 border border-nexus-border/40">
              <div
                className={`h-full rounded-full transition-all duration-300 ${
                  status === 'installing'
                    ? 'bg-nexus-accent animate-pulse w-full'
                    : 'bg-cyan-400'
                }`}
                style={{
                  width: status === 'installing' ? '100%' : `${downloadProgress}%`,
                }}
              />
            </div>
            <div className="flex justify-between text-[11px] text-nexus-muted font-mono">
              <span>{status === 'installing' ? 'Instalando...' : 'Progresso do download'}</span>
              <span className="font-bold text-nexus-text">
                {status === 'installing' ? '100%' : `${downloadProgress}%`}
              </span>
            </div>
          </div>
        )}

        {/* Changelog Card (Nightly/Beta confirmation view) */}
        {status === 'update_found' && updateInfo?.changelog && (
          <div className="w-full mb-5 rounded-2xl bg-nexus-panel/70 border border-nexus-border/50 p-3.5 text-left text-xs">
            <div className="flex items-center gap-1.5 text-nexus-muted mb-1.5 font-semibold text-[11px]">
              <FileText className="w-3.5 h-3.5 text-nexus-accent" />
              <span>Notas da Versão (Changelog)</span>
            </div>
            <div
              className={`text-nexus-text/90 font-mono text-[11px] leading-relaxed whitespace-pre-wrap overflow-y-auto ${
                showFullChangelog ? 'max-h-48' : 'max-h-24'
              }`}
            >
              {updateInfo.changelog}
            </div>
            {updateInfo.changelog.length > 150 && (
              <button
                type="button"
                onClick={() => setShowFullChangelog(!showFullChangelog)}
                className="mt-2 text-[10px] text-nexus-accent hover:underline font-semibold cursor-pointer"
              >
                {showFullChangelog ? 'Mostrar menos' : 'Ver changelog completo'}
              </button>
            )}
          </div>
        )}

        {/* Interactive Action Controls */}
        <div className="w-full flex flex-col gap-2.5">
          {status === 'update_found' && (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleConfirmUpdate}
                className="flex-1 flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl bg-nexus-accent hover:bg-nexus-accent-hover text-white text-xs font-bold transition-all shadow-lg shadow-nexus-accent/20 cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" />
                Atualizar Agora
              </button>
              <button
                type="button"
                onClick={handleSkipOrProceed}
                className="py-2.5 px-4 rounded-xl bg-nexus-panel hover:bg-nexus-surface border border-nexus-border text-nexus-muted hover:text-nexus-text text-xs font-semibold transition-colors cursor-pointer"
              >
                Lembrar Mais Tarde
              </button>
            </div>
          )}

          {status === 'connection_error' && (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleSkipOrProceed}
                className="flex-1 flex items-center justify-center gap-1.5 py-2.5 px-4 rounded-xl bg-nexus-accent hover:bg-nexus-accent-hover text-white text-xs font-bold transition-all cursor-pointer"
              >
                Continuar Offline
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={handleRetry}
                className="py-2.5 px-3 rounded-xl bg-nexus-panel hover:bg-nexus-surface border border-nexus-border text-nexus-text text-xs font-semibold transition-colors cursor-pointer"
              >
                Tentar Novamente
              </button>
            </div>
          )}

          {status === 'install_error' && (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleRetry}
                className="flex-1 flex items-center justify-center gap-1.5 py-2.5 px-4 rounded-xl bg-nexus-accent hover:bg-nexus-accent-hover text-white text-xs font-bold transition-all cursor-pointer"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Tentar Novamente
              </button>
              <button
                type="button"
                onClick={handleSkipOrProceed}
                className="py-2.5 px-4 rounded-xl bg-nexus-panel hover:bg-nexus-surface border border-nexus-border text-nexus-muted hover:text-nexus-text text-xs font-semibold transition-colors cursor-pointer"
              >
                Avançar mesmo assim
              </button>
            </div>
          )}

          {status === 'up_to_date' && (
            <button
              type="button"
              onClick={handleSkipOrProceed}
              className="w-full flex items-center justify-center gap-1.5 py-2.5 px-4 rounded-xl bg-nexus-panel hover:bg-nexus-surface border border-nexus-border text-nexus-text text-xs font-semibold transition-colors cursor-pointer"
            >
              Continuar para o NEXUS
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Discrete Bottom Skip Link - Ensures non-blocking offline usage */}
      {(status === 'checking' || status === 'starting') && (
        <button
          type="button"
          onClick={handleSkipOrProceed}
          className="mt-4 text-[11px] text-nexus-muted/60 hover:text-nexus-muted transition-colors cursor-pointer font-mono"
        >
          Pular verificação e abrir versão instalada (v{currentVersion})
        </button>
      )}

      {/* Footer Branding */}
      <div className="absolute bottom-3 text-center text-[10px] text-nexus-muted/40 font-mono pointer-events-none">
        NEXUS SECURE LAUNCHER • V{currentVersion}
      </div>
    </div>
  );
};
