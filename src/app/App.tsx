import React, { useEffect, useState } from 'react';
import { TitleBar } from '../components/TitleBar';
import { ConnectionBanner } from '../components/ConnectionBanner';
import { IncomingCallToast } from '../components/IncomingCallToast';
import { ActiveCallBar } from '../components/ActiveCallBar';
import { UpdateNotificationToast } from '../components/UpdateNotificationToast';
import { AuthModal } from '../features/auth/AuthModal';
import { Sidebar } from './Sidebar';
import { HomeView } from '../features/home/HomeView';
import { MessagesView } from '../features/messages/MessagesView';
import { CommunitiesView } from '../features/communities/CommunitiesView';
import { CallsView } from '../features/calls/CallsView';
import { SettingsView } from '../features/settings/SettingsView';
import { AuthView } from '../features/auth/AuthView';
import { ServerOfflineView } from '../features/auth/ServerOfflineView';
import { ServerApprovalView } from '../features/auth/ServerApprovalView';
import { useAppStore } from '../stores/useAppStore';
import { callService } from '../services/CallService';
import { gatewayClient } from '../services/GatewayClient';

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
  const [rustBackendReady, setRustBackendReady] = useState(false);

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
    // Global voice call coordinator initialization (idempotent)
    callService.init();
  }, []);

  useEffect(() => {
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
  }, [initializeStore]);

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

  // 1. Splash / Carregamento Inicial (nunca piscar workspace desautenticado)
  if (!isInitialized || authStatus === 'initializing') {
    return (
      <div className="flex flex-col items-center justify-center h-screen w-screen bg-nexus-bg text-nexus-text select-none">
        <div className="w-12 h-12 rounded-xl bg-nexus-accent flex items-center justify-center text-white font-extrabold text-xl shadow-lg mb-3 animate-pulse">
          N
        </div>
        <p className="text-xs font-semibold text-nexus-text">Iniciando NEXUS...</p>
        <p className="text-[10px] text-nexus-muted mt-1 font-mono">Restaurando sessão e verificando conectividade</p>
      </div>
    );
  }

  // 2. Servidor pendente de aprovação criptográfica de identidade (TOFU)
  if (networkStatus.server_reachability === 'needs_approval') {
    return <ServerApprovalView />;
  }

  // 3. Servidor offline / rede desconectada sem sessão ativa em memória
  if (
    (networkStatus.server_reachability === 'network_disconnected' ||
      networkStatus.server_reachability === 'server_unreachable') &&
    !onlineUser
  ) {
    return <ServerOfflineView />;
  }

  // 4. Sem autenticação (primeiro acesso, sem sessão ou sessão expirada/deslogado)
  if (authStatus === 'unauthenticated' || !onlineUser) {
    return <AuthView />;
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
        <Sidebar />

        {/* Dynamic Center Work Area */}
        <main className="flex-1 flex flex-col min-w-0 bg-nexus-bg overflow-hidden relative">
          {activeTab === 'home' && <HomeView />}
          {activeTab === 'messages' && <MessagesView />}
          {activeTab === 'communities' && <CommunitiesView />}
          {activeTab === 'calls' && <CallsView />}
          {activeTab === 'settings' && <SettingsView />}
        </main>
      </div>

      {/* Modal de Autenticação Online */}
      <AuthModal isOpen={isAuthModalOpen} onClose={closeAuthModal} />

      {/* Notificação Flutuante de Chamada Recebida */}
      <IncomingCallToast />

      {/* Barra Flutuante de Chamada Ativa (quando navegando em outras abas) */}
      <ActiveCallBar />

      {/* Notificação Flutuante de Atualização Automática (GitHub Releases) */}
      <UpdateNotificationToast />
    </div>
  );
};

export default App;
