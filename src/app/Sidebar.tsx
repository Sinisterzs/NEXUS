import React from 'react';
import {
  Home,
  MessageSquare,
  Users,
  Radio,
  Settings,
  ChevronLeft,
  ChevronRight,
  Mic,
  MicOff,
  Headphones,
} from 'lucide-react';
import { useAppStore } from '../stores/useAppStore';
import { MainTab } from '../lib/types';
import { mockCommunities, mockDirectMessages } from '../mocks';
import { callService } from '../services/CallService';
import { Avatar } from '../components/Avatar';
import { Badge } from '../components/Badge';
import { Tooltip } from '../components/Tooltip';

export const Sidebar: React.FC = () => {
  const activeTab = useAppStore((state) => state.activeTab);
  const isSidebarCollapsed = useAppStore((state) => state.isSidebarCollapsed);
  const setActiveTab = useAppStore((state) => state.setActiveTab);
  const toggleSidebar = useAppStore((state) => state.toggleSidebar);
  const currentUser = useAppStore((state) => state.currentUser);
  const authStatus = useAppStore((state) => state.authStatus);
  const isMicMuted = useAppStore((state) => state.isMicMuted);
  const isDeafened = useAppStore((state) => state.isDeafened);
  const activeCommunityId = useAppStore((state) => state.activeCommunityId);
  const setActiveCommunity = useAppStore((state) => state.setActiveCommunity);

  const totalDmUnreads = mockDirectMessages.reduce(
    (acc, dm) => acc + (dm.unreadCount || 0),
    0
  );

  const totalCommunityUnreads = mockCommunities.reduce(
    (acc, c) => acc + (c.unreadCount || 0),
    0
  );

  const navItems: { id: MainTab; label: string; icon: React.ElementType; badge?: number }[] = [
    { id: 'home', label: 'Início', icon: Home },
    { id: 'messages', label: 'Mensagens', icon: MessageSquare, badge: totalDmUnreads },
    { id: 'communities', label: 'Comunidades', icon: Users, badge: totalCommunityUnreads },
    { id: 'calls', label: 'Histórico', icon: Radio },
    { id: 'settings', label: 'Configurações', icon: Settings },
  ];

  return (
    <aside
      className={`h-full bg-nexus-surface border-r border-nexus-border flex flex-col justify-between shrink-0 transition-all duration-200 select-none ${
        isSidebarCollapsed ? 'w-16' : 'w-60'
      }`}
    >
      {/* Top Section: Nav items */}
      <div className="flex flex-col flex-1 overflow-hidden">
        {/* Toggle Collapse Header */}
        <div className="h-10 border-b border-nexus-border px-3 flex items-center justify-between">
          {!isSidebarCollapsed && (
            <span className="text-[11px] font-bold text-nexus-muted uppercase tracking-wider">
              Navegação
            </span>
          )}
          <Tooltip
            content={isSidebarCollapsed ? 'Expandir barra lateral' : 'Recolher barra lateral'}
            position="right"
          >
            <button
              onClick={toggleSidebar}
              className="p-1 rounded hover:bg-nexus-panel text-nexus-muted hover:text-nexus-text transition-nexus mx-auto"
            >
              {isSidebarCollapsed ? (
                <ChevronRight className="w-4 h-4" />
              ) : (
                <ChevronLeft className="w-4 h-4" />
              )}
            </button>
          </Tooltip>
        </div>

        {/* Primary Tabs */}
        <div className="p-2 space-y-1">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;

            return (
              <Tooltip
                key={item.id}
                content={isSidebarCollapsed ? item.label : ''}
                position="right"
                className="w-full"
              >
                <button
                  onClick={() => setActiveTab(item.id)}
                  className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-xs font-medium transition-nexus ${
                    isActive
                      ? 'bg-nexus-panel text-white border-l-2 border-nexus-accent shadow-sm'
                      : 'text-nexus-muted hover:bg-nexus-panel/60 hover:text-nexus-text'
                  } ${isSidebarCollapsed ? 'justify-center px-0' : ''}`}
                >
                  <div className="relative flex items-center justify-center">
                    <Icon
                      className={`w-4 h-4 shrink-0 ${
                        isActive ? 'text-nexus-accent' : 'text-nexus-muted'
                      }`}
                    />
                    {isSidebarCollapsed && item.badge && item.badge > 0 ? (
                      <span className="absolute -top-1.5 -right-2">
                        <Badge count={item.badge} dot />
                      </span>
                    ) : null}
                  </div>

                  {!isSidebarCollapsed && (
                    <>
                      <span className="flex-1 text-left truncate">{item.label}</span>
                      {item.badge && item.badge > 0 ? <Badge count={item.badge} /> : null}
                    </>
                  )}
                </button>
              </Tooltip>
            );
          })}
        </div>

        {/* Lateral Communities Quick Library (Steam inspired) */}
        {!isSidebarCollapsed && (
          <div className="flex-1 overflow-y-auto px-2 py-3 border-t border-nexus-border/60">
            <div className="px-3 pb-2 text-[10px] font-bold text-nexus-muted uppercase tracking-wider flex items-center justify-between">
              <span>Sua Biblioteca</span>
              <span className="text-[10px] text-nexus-muted font-mono">{mockCommunities.length}</span>
            </div>

            {mockCommunities.length === 0 ? (
              <div className="px-3 py-4 text-center text-nexus-muted">
                <p className="text-[11px]">Nenhuma comunidade</p>
              </div>
            ) : (
              <div className="space-y-1">
                {mockCommunities.map((comm) => {
                  const isSelected = activeCommunityId === comm.id && activeTab === 'communities';
                  return (
                    <button
                      key={comm.id}
                      onClick={() => {
                        setActiveCommunity(comm.id);
                        setActiveTab('communities');
                      }}
                      className={`w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-xs transition-nexus text-left ${
                        isSelected
                          ? 'bg-nexus-panel text-white font-medium border-l-2 border-nexus-accent'
                          : 'text-nexus-muted hover:bg-nexus-panel/50 hover:text-nexus-text'
                      }`}
                    >
                      <div
                        className="w-5 h-5 rounded flex items-center justify-center text-[10px] font-bold text-white shrink-0"
                        style={{ backgroundColor: comm.iconBg }}
                      >
                        {comm.initials}
                      </div>
                      <span className="truncate flex-1">{comm.name}</span>
                      {comm.unreadCount && comm.unreadCount > 0 ? (
                        <Badge count={comm.unreadCount} />
                      ) : null}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Bottom User Profile & Audio Dock */}
      <div className="p-2 border-t border-nexus-border bg-nexus-panel/40 shrink-0">
        <div
          className={`flex items-center gap-2 ${
            isSidebarCollapsed ? 'flex-col justify-center' : 'justify-between'
          }`}
        >
          {/* User info */}
          <Tooltip
            content={`${currentUser.displayName} (${currentUser.status})`}
            position="right"
          >
            <div
              onClick={() => setActiveTab('settings')}
              className={`flex items-center gap-2 p-1 rounded-lg hover:bg-nexus-panel cursor-pointer min-w-0 transition-nexus ${
                isSidebarCollapsed ? 'justify-center' : 'flex-1'
              }`}
            >
              <Avatar
                name={currentUser.displayName}
                avatarUrl={currentUser.avatarUrl}
                status={currentUser.status}
                size={isSidebarCollapsed ? 'sm' : 'md'}
              />
              {!isSidebarCollapsed && (
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-semibold text-nexus-text truncate">
                    {currentUser.displayName}
                  </p>
                  <p className="text-[10px] text-nexus-muted truncate">
                    {currentUser.customStatus || (authStatus === 'authenticated' ? `@${currentUser.username}` : currentUser.tag)}
                  </p>
                </div>
              )}
            </div>
          </Tooltip>

          {/* Quick Mic / Headphone controls */}
          <div className={`flex items-center ${isSidebarCollapsed ? 'flex-col gap-1' : 'gap-1'}`}>
            <Tooltip
              content={isMicMuted ? 'Ativar Microfone' : 'Mutar Microfone'}
              position="top"
            >
              <button
                onClick={() => callService.toggleMute()}
                className={`p-1.5 rounded-lg transition-nexus cursor-pointer ${
                  isMicMuted
                    ? 'bg-rose-500/20 text-rose-400'
                    : 'text-nexus-muted hover:bg-nexus-panel hover:text-nexus-text'
                }`}
              >
                {isMicMuted ? <MicOff className="w-3.5 h-3.5" /> : <Mic className="w-3.5 h-3.5" />}
              </button>
            </Tooltip>

            <Tooltip
              content={isDeafened ? 'Ativar Áudio' : 'Desativar Áudio'}
              position="top"
            >
              <button
                onClick={() => callService.toggleDeafen()}
                className={`p-1.5 rounded-lg transition-nexus cursor-pointer ${
                  isDeafened
                    ? 'bg-rose-500/20 text-rose-400'
                    : 'text-nexus-muted hover:bg-nexus-panel hover:text-nexus-text'
                }`}
              >
                <Headphones
                  className={`w-3.5 h-3.5 ${isDeafened ? 'text-rose-400' : ''}`}
                />
              </button>
            </Tooltip>
          </div>
        </div>
      </div>
    </aside>
  );
};
