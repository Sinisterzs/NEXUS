import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { TitleBar } from '../components/TitleBar';
import { WindowControls } from '../components/WindowControls';
import { ConnectionBanner } from '../components/ConnectionBanner';
import { FloatingCallDock } from '../components/FloatingCallDock';
import { IncomingCallToast } from '../components/IncomingCallToast';
import { UpdateNotificationToast } from '../components/UpdateNotificationToast';
import { AuthModal } from '../features/auth/AuthModal';
import { Sidebar } from './Sidebar';
import { HomeView } from '../features/home/HomeView';
import { MessagesView } from '../features/messages/MessagesView';
import { CommunitiesView } from '../features/communities/CommunitiesView';
import { CallsView } from '../features/calls/CallsView';
import { SettingsView } from '../features/settings/SettingsView';
import { AuthView } from '../features/auth/AuthView';
import { ProfileOnboardingView } from '../features/auth/ProfileOnboardingView';
import { MinimalSplashView } from '../features/startup/MinimalSplashView';
import { preloginUpdaterService } from '../services/PreloginUpdaterService';
import { useAppStore } from '../stores/useAppStore';
import { callService } from '../services/CallService';
import { gatewayClient } from '../services/GatewayClient';
import {
  ActiveMediaSessionSummary,
  cleanupBeforeWindowClose,
  destroyMainWindow,
  getActiveMediaSessionSummary,
} from '../lib/windowLifecycle';

export const App: React.FC = () => {
  const activeTab = useAppStore((state) => state.activeTab);
  const setActiveTab = useAppStore((state) => state.setActiveTab);
  const isInitialized = useAppStore((state) => state.isInitialized);
  const initializeStore = useAppStore((state) => state.initializeStore);
  const appearance = useAppStore((state) => state.settings.appearance);
  const authStatus = useAppStore((state) => state.authStatus);
  const onlineUser = useAppStore((state) => state.onlineUser);
  const networkStatus = useAppStore((state) => state.networkStatus);
  const isAuthModalOpen = useAppStore((state) => state.isAuthModalOpen);
  const closeAuthModal = useAppStore((state) => state.closeAuthModal);
  const checkSession = useAppStore((state) => state.checkSession);
  const [rustBackendReady, setRustBackendReady] = useState(false);
  const [startupTimedOut, setStartupTimedOut] = useState(false);
  const [preloginCompleted, setPreloginCompleted] = useState(false);
  const [preloginState, setPreloginState] = useState(preloginUpdaterService.getState());
  const pendingProfileOnboarding = useAppStore((s) => s.pendingProfileOnboarding);

  useEffect(() => {
    const unsub = preloginUpdaterService.addListener(setPreloginState);
    preloginUpdaterService.runStartupSequence({
      onProceed: () => setPreloginCompleted(true),
    });
    return unsub;
  }, []);
  const [closeConfirmSummary, setCloseConfirmSummary] = useState<ActiveMediaSessionSummary | null>(
    null
  );
  const [isClosingWindow, setIsClosingWindow] = useState(false);
  const isClosingRef = useRef(false);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    void import('@tauri-apps/api/window')
      .then(async ({ getCurrentWindow }) => {
        const win = getCurrentWindow();
        const stop = await win.onCloseRequested(async (event) => {
          if (disposed || isClosingRef.current) {
            return;
          }
          event.preventDefault();
          const summary = getActiveMediaSessionSummary(useAppStore.getState());
          if (summary.hasActiveSession) {
            setCloseConfirmSummary(summary);
            return;
          }
          isClosingRef.current = true;
          await cleanupBeforeWindowClose();
          await destroyMainWindow();
        });
        if (disposed) {
          stop();
        } else {
          unlisten = stop;
        }
      })
      .catch(() => {});

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!closeConfirmSummary) return;
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isClosingWindow) {
        e.preventDefault();
        e.stopPropagation();
        setCloseConfirmSummary(null);
      }
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [closeConfirmSummary, isClosingWindow]);

  const handleCancelWindowClose = () => {
    if (isClosingWindow) return;
    setCloseConfirmSummary(null);
  };

  const handleConfirmWindowClose = async () => {
    if (isClosingRef.current) return;
    isClosingRef.current = true;
    setIsClosingWindow(true);
    await cleanupBeforeWindowClose();
    await destroyMainWindow();
  };

  useEffect(() => {
    if (!preloginCompleted) return;
    // Safety timer for startup splash (7 seconds) to prevent infinite loading
    const timer = setTimeout(() => {
      setStartupTimedOut(true);
    }, 7000);
    return () => clearTimeout(timer);
  }, [preloginCompleted]);

  useEffect(() => {
    // Apply appearance attributes to document element in real-time
    document.documentElement.setAttribute('data-theme', appearance.theme || 'nexus-dark');
    document.documentElement.setAttribute('data-font-size', appearance.fontSize || 'base');
    document.documentElement.setAttribute('data-compact', String(Boolean(appearance.compactMode)));
  }, [appearance.theme, appearance.fontSize, appearance.compactMode]);

  useEffect(() => {
    // Clean disconnection on app window close / refresh
    const handleBeforeUnload = () => {
      gatewayClient.disconnect();
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, []);

  useEffect(() => {
    if (Boolean((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV) && typeof window !== 'undefined') {
      (window as any).__NEXUS_STORE__ = useAppStore;
    }
    // Global voice call coordinator initialization (idempotent)
    callService.init();
  }, []);

  useEffect(() => {
    if (!preloginCompleted) return;

    // Startup sequence: Tauri handshake, load preferences, SQLite ready
    async function startup() {
      let overrideTab: any = null;
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const info = await invoke<{ status: string }>('get_app_info');
        if (info?.status === 'ready') {
          setRustBackendReady(true);
        }
        const initialTab = await invoke<string>('get_initial_tab');
        if (['home', 'messages', 'communities', 'calls', 'settings'].includes(initialTab)) {
          overrideTab = initialTab;
        }
      } catch {
        setRustBackendReady(false);
      } finally {
        await initializeStore(overrideTab);
      }
    }

    startup();
  }, [preloginCompleted, initializeStore]);

  useEffect(() => {
    // Global keyboard navigation shortcuts (Ctrl+1 through Ctrl+5)
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey) {
        if (e.key === '1') { e.preventDefault(); setActiveTab('home'); }
        else if (e.key === '2') { e.preventDefault(); setActiveTab('messages'); }
        else if (e.key === '3') { e.preventDefault(); setActiveTab('communities'); }
        else if (e.key === '4') { e.preventDefault(); setActiveTab('calls'); }
        else if (e.key === '5') { e.preventDefault(); setActiveTab('settings'); }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [setActiveTab]);

  const renderScreen = () => {
    // 0. Pre-login Auto Updater (executa ANTES de qualquer tentativa de restauração de sessão ou AuthView)
    if (
      Boolean((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV) &&
      typeof window !== 'undefined' &&
      new URLSearchParams(window.location.search).get('splashDemo') === '1'
    ) {
      return <MinimalSplashView demoMode />;
    }

    if (preloginState.status === 'update_required' || (preloginState.status === 'install_error' && !preloginCompleted)) {
      return (
        <MinimalSplashView
          updateRequired
          statusText={preloginState.errorMessage || undefined}
          onUpdateNow={
            preloginState.updateInfo
              ? () => void preloginUpdaterService.runStartupSequence({ onProceed: () => setPreloginCompleted(true) })
              : undefined
          }
          onRetry={() => void preloginUpdaterService.runStartupSequence({ onProceed: () => setPreloginCompleted(true) })}
          onCloseApp={() => {
            void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => getCurrentWindow().close());
          }}
        />
      );
    }

    if (!preloginCompleted) {
      return <MinimalSplashView isConnectionPending />;
    }

    // 1. Splash / Carregamento Inicial (com timeout de segurança recuperável para evitar loading infinito)
    if (!isInitialized || authStatus === 'initializing' || (networkStatus.server_reachability === 'connecting' && !onlineUser)) {
      if (startupTimedOut) {
        return (
          <div className="relative flex flex-col items-center justify-center h-screen w-screen bg-nexus-bg text-nexus-text select-none p-6">
            <div
              data-tauri-drag-region
              className="absolute top-0 left-0 right-0 h-9 flex items-center justify-end px-3 z-50 bg-nexus-bg/60 backdrop-blur-md border-b border-nexus-border/30"
            >
              <WindowControls />
            </div>
            <div className="w-12 h-12 rounded-xl bg-amber-500/15 border border-amber-500/30 flex items-center justify-center text-amber-400 font-bold text-xl shadow-lg mb-3">
              !
            </div>
            <p className="text-xs font-semibold text-nexus-text">A inicialização está demorando mais do que o esperado</p>
            <p className="text-[10px] text-nexus-muted mt-1 text-center max-w-xs font-mono">
              Não foi possível concluir a verificação inicial de conectividade.
            </p>
            <div className="flex items-center gap-2 mt-4">
              <button
                onClick={() => {
                  setStartupTimedOut(false);
                  checkSession();
                }}
                className="px-3 py-1.5 rounded-lg bg-nexus-panel hover:bg-nexus-surface border border-nexus-border text-xs font-semibold text-nexus-text transition-colors cursor-pointer"
              >
                Tentar novamente
              </button>
              <button
                onClick={() => {
                  useAppStore.setState({
                    isInitialized: true,
                    backendAvailable: false,
                    networkStatus: {
                      ...networkStatus,
                      server_reachability: 'server_unreachable',
                    },
                  });
                }}
                className="px-3 py-1.5 rounded-lg bg-nexus-accent hover:bg-nexus-accent-hover text-xs font-semibold text-white transition-colors cursor-pointer"
              >
                Abrir opções de rede
              </button>
            </div>
          </div>
        );
      }

      return <MinimalSplashView />;
    }

    // 2. Identidade inesperada ou falha de verificação do servidor oficial: bloqueia conexão
    if (networkStatus.server_reachability === 'needs_approval') {
      return (
        <MinimalSplashView
          isConnectionPending
          statusText="Não foi possível conectar ao NEXUS."
          onRetry={() => window.location.reload()}
          retryLabel="Tentar novamente"
        />
      );
    }

    // 3. Servidor offline / rede desconectada sem sessão ativa em memória
    if (
      (networkStatus.server_reachability === 'network_disconnected' ||
        networkStatus.server_reachability === 'server_unreachable') &&
      !onlineUser
    ) {
      return (
        <MinimalSplashView
          isConnectionPending
          statusText="Não foi possível conectar ao NEXUS."
          onRetry={() => window.location.reload()}
          retryLabel="Tentar novamente"
        />
      );
    }

    // 4. Sem autenticação (primeiro acesso, sem sessão ou sessão expirada/deslogado)
    if (authStatus === 'unauthenticated' || !onlineUser) {
      return <AuthView />;
    }

    // 5. Onboarding de perfil obrigatório após cadastro novo (antes de liberar a Home)
    if (pendingProfileOnboarding) {
      return (
        <ProfileOnboardingView
          username={onlineUser.username}
          onComplete={() => useAppStore.getState().completeProfileOnboarding()}
        />
      );
    }

    return (
      <div className="flex flex-col h-screen w-screen overflow-hidden bg-nexus-bg text-nexus-text">
        {/* Top TitleBar (prepared for custom titlebar + search + indicators) */}
        <TitleBar backendReady={rustBackendReady} />

        {/* Discrete Connection / Network Status Banner */}
        <ConnectionBanner />

        {/* Main Workspace Body */}
        <div className="flex-1 flex overflow-hidden">
          {/* Collapsible Sidebar */}
          <Sidebar suppressCallBar />

          {/* Dynamic Center Work Area */}
          <main className="flex-1 flex flex-col min-w-0 bg-nexus-bg overflow-hidden relative">
            <div className="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden relative">
              {activeTab === 'home' && <HomeView />}
              {activeTab === 'messages' && <MessagesView />}
              {activeTab === 'communities' && <CommunitiesView />}
              {activeTab === 'calls' && <CallsView />}
              {activeTab === 'settings' && <SettingsView />}
            </div>
            <FloatingCallDock />
          </main>
        </div>

        {/* Modal de Autenticação Online */}
        <AuthModal isOpen={isAuthModalOpen} onClose={closeAuthModal} />

        {/* Notificação Flutuante de Chamada Recebida */}
        <IncomingCallToast />

        {/* Notificação Flutuante de Atualização Automática (GitHub Releases) */}
        <UpdateNotificationToast />
      </div>
    );
  };

  return (
    <>
      {renderScreen()}

      {/* Confirmação de fechamento quando há chamada, sala de voz ou transmissão ativa */}
      {closeConfirmSummary && (
        <div
          data-testid="close-confirm-modal"
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/75 backdrop-blur-sm p-4 animate-fadeIn select-none"
          onClick={handleCancelWindowClose}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="close-confirm-title"
            aria-describedby="close-confirm-description"
            onClick={(e) => e.stopPropagation()}
            className="relative w-full max-w-sm bg-nexus-surface border border-nexus-border rounded-2xl shadow-2xl p-5 space-y-4"
          >
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-rose-500/15 border border-rose-500/30 flex items-center justify-center text-rose-400 shrink-0">
                <AlertTriangle className="w-5 h-5" />
              </div>
              <div>
                <h3 id="close-confirm-title" className="text-sm font-bold text-white">
                  {closeConfirmSummary.title}
                </h3>
                <p className="text-xs text-zinc-400 mt-0.5">Sessão de mídia em andamento</p>
              </div>
            </div>

            <p id="close-confirm-description" className="text-xs text-zinc-300 leading-relaxed">
              {closeConfirmSummary.description}
            </p>

            <div className="flex items-center justify-end gap-2.5 pt-2">
              <button
                type="button"
                data-testid="close-confirm-cancel"
                disabled={isClosingWindow}
                onClick={handleCancelWindowClose}
                className="px-3 py-1.5 rounded-lg bg-nexus-panel hover:bg-nexus-border disabled:opacity-50 text-xs font-semibold text-zinc-200 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nexus-accent/70"
              >
                Cancelar
              </button>
              <button
                type="button"
                data-testid="close-confirm-accept"
                disabled={isClosingWindow}
                onClick={() => void handleConfirmWindowClose()}
                className="px-3.5 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 disabled:opacity-50 text-xs font-semibold text-white shadow-sm transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nexus-accent/70"
              >
                {isClosingWindow ? 'Encerrando...' : 'Encerrar e Fechar'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default App;
