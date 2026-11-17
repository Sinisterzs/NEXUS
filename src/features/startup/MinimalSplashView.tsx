import { useEffect, useState } from 'react';
import { NexusMark } from '../auth/AuthPrimitives';
import { WindowControls } from '../../components/WindowControls';

export const SPLASH_TIMING = {
  CONNECTING_DELAY_MS: 1200,
  PROLONGED_DELAY_MS: 6000,
  UNAVAILABLE_DELAY_MS: 10000,
} as const;

export const SPLASH_UPDATER_DEMO_STATES = [
  { id: 'initializing', label: 'Inicializando', text: null },
  { id: 'checking', label: 'Verificando atualizações', text: 'Verificando atualizações...' },
  { id: 'available', label: 'Atualização disponível', text: 'Nova versão disponível.' },
  { id: 'preparing', label: 'Preparando atualização', text: 'Preparando atualização...' },
  { id: 'completed', label: 'Atualização concluída', text: 'Atualização pronta. Reiniciando...' },
  { id: 'transient_error', label: 'Falha temporária na verificação', text: 'Não foi possível verificar atualizações agora.' },
  { id: 'up_to_date', label: 'Nenhuma atualização disponível', text: 'Conectando...' },
] as const;

export interface MinimalSplashViewProps {
  statusText?: string;
  onRetry?: () => void;
  retryLabel?: string;
  isConnectionPending?: boolean;
  demoMode?: boolean;
  updateRequired?: boolean;
  onUpdateNow?: () => void;
  onCloseApp?: () => void;
}

export function MinimalSplashView({
  statusText,
  onRetry,
  retryLabel = 'Tentar novamente',
  isConnectionPending = false,
  demoMode = false,
  updateRequired = false,
  onUpdateNow,
  onCloseApp,
}: MinimalSplashViewProps = {}) {
  const isDevDemo = Boolean((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV && demoMode);
  const [demoIndex, setDemoIndex] = useState(0);
  const [elapsedPhase, setElapsedPhase] = useState<'initial' | 'connecting' | 'prolonged' | 'unavailable'>(
    statusText && !isConnectionPending ? 'unavailable' : 'initial',
  );

  useEffect(() => {
    if (statusText && !isConnectionPending) {
      setElapsedPhase('unavailable');
      return;
    }

    const t1 = setTimeout(() => {
      setElapsedPhase((prev) => (prev === 'initial' ? 'connecting' : prev));
    }, SPLASH_TIMING.CONNECTING_DELAY_MS);

    const t2 = setTimeout(() => {
      setElapsedPhase((prev) => (prev === 'initial' || prev === 'connecting' ? 'prolonged' : prev));
    }, SPLASH_TIMING.PROLONGED_DELAY_MS);

    const t3 = setTimeout(() => {
      setElapsedPhase('unavailable');
    }, SPLASH_TIMING.UNAVAILABLE_DELAY_MS);

    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
    };
  }, [statusText, isConnectionPending]);

  const demoState = isDevDemo ? SPLASH_UPDATER_DEMO_STATES[demoIndex] : null;
  const resolvedText = isDevDemo
    ? demoState?.text ?? null
    : elapsedPhase === 'initial'
      ? null
      : elapsedPhase === 'connecting'
        ? 'Conectando...'
        : elapsedPhase === 'prolonged'
          ? 'A conexão está demorando mais que o normal...'
          : statusText || 'Servidor indisponível no momento.';

  const showRetry = !isDevDemo && Boolean(onRetry) && elapsedPhase === 'unavailable';

  return (
    <div className="relative flex flex-col items-center justify-center h-screen w-screen bg-black text-zinc-100 select-none">
      <div
        data-tauri-drag-region
        className="absolute top-0 left-0 right-0 h-9 flex items-center justify-end px-3 z-50"
      >
        <WindowControls />
      </div>

      <div className="flex flex-col items-center gap-4">
        <div className="w-16 h-16 flex items-center justify-center animate-pulse motion-reduce:animate-none">
          <NexusMark />
        </div>
        {updateRequired ? (
          <div className="flex flex-col items-center gap-3 max-w-sm text-center px-4">
            <h1 className="text-sm font-semibold text-white">Atualização necessária</h1>
            <p className="text-xs text-zinc-400">
              {statusText || 'Esta versão do NEXUS não é mais compatível com o servidor. Atualize para continuar.'}
            </p>
            <div className="flex flex-wrap items-center justify-center gap-2 mt-1">
              {onUpdateNow && (
                <button
                  type="button"
                  onClick={onUpdateNow}
                  className="px-4 py-1.5 rounded-lg bg-red-600 hover:bg-red-500 text-xs font-medium text-white transition-colors cursor-pointer"
                >
                  Atualizar agora
                </button>
              )}
              {onRetry && (
                <button
                  type="button"
                  onClick={onRetry}
                  className="px-4 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-xs font-medium text-zinc-200 transition-colors cursor-pointer"
                >
                  {retryLabel}
                </button>
              )}
              {onCloseApp && (
                <button
                  type="button"
                  onClick={onCloseApp}
                  className="px-4 py-1.5 rounded-lg border border-zinc-800 text-xs font-medium text-zinc-400 hover:text-zinc-200 transition-colors cursor-pointer"
                >
                  Fechar NEXUS
                </button>
              )}
            </div>
          </div>
        ) : resolvedText && (
          <p className="text-xs text-zinc-400 tracking-wide text-center px-4" role="status" aria-live="polite">
            {resolvedText}
          </p>
        )}
        {!updateRequired && showRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="mt-1 px-4 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-xs font-medium text-zinc-200 transition-colors cursor-pointer"
          >
            {retryLabel}
          </button>
        )}
        {isDevDemo && (
          <div className="mt-6 flex flex-wrap items-center justify-center gap-1.5 max-w-md px-4">
            {SPLASH_UPDATER_DEMO_STATES.map((st, idx) => (
              <button
                key={st.id}
                type="button"
                onClick={() => setDemoIndex(idx)}
                className={`px-2.5 py-1 rounded text-[11px] border transition-colors cursor-pointer ${
                  idx === demoIndex
                    ? 'bg-zinc-800 border-zinc-600 text-white'
                    : 'bg-zinc-950 border-zinc-800 text-zinc-400 hover:text-zinc-200'
                }`}
              >
                {idx + 1}. {st.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
