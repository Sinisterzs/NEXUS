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
import { Badge } from '../components/Badge';
import { Tooltip } from '../components/Tooltip';

export const Sidebar: React.FC = () => {
  const activeTab = useAppStore((state) => state.activeTab);
  const isSidebarCollapsed = useAppStore((state) => state.isSidebarCollapsed);
  const setActiveTab = useAppStore((state) => state.setActiveTab);
  const toggleSidebar = useAppStore((state) => state.toggleSidebar);
  const authStatus = useAppStore((state) => state.authStatus);
  const isMicMuted = useAppStore((state) => state.isMicMuted);
  const isDeafened = useAppStore((state) => state.isDeafened);
  const activeCommunityId = useAppStore((state) => state.activeCommunityId);
  const setActiveCommunity = useAppStore((state) => state.setActiveCommunity);
  const conversations = useAppStore((state) => state.conversations);

  const isOnline = authStatus === 'authenticated';
  const totalDmUnreads = isOnline
    ? conversations.reduce((acc, c) => acc + (c.unread_count || 0), 0)
    : mockDirectMessages.reduce((acc, dm) => acc + (dm.unreadCount || 0), 0);

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
      className={`h-full bg-[#0e1015] border-r border-zinc-800/80 flex flex-col justify-between shrink-0 transition-all duration-200 select-none ${
        isSidebarCollapsed ? 'w-16' : 'w-60'
      }`}
    >
      {/* Top Section: Nav items */}
      <div className="flex flex-col flex-1 overflow-hidden">
        {/* Toggle Collapse Header */}
        <div className="h-10 border-b border-zinc-800/60 px-3 flex items-center justify-between">
          {!isSidebarCollapsed && (
            <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-500">
              Navegação
            </span>
          )}
          <Tooltip
            content={isSidebarCollapsed ? 'Expandir barra lateral' : 'Recolher barra lateral'}
            position="right"
          >
            <button
              type="button"
              onClick={toggleSidebar}
              className="p-1 rounded-lg hover:bg-zinc-800/80 text-zinc-400 hover:text-zinc-200 transition-colors mx-auto cursor-pointer"
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
                  type="button"
                  onClick={() => setActiveTab(item.id)}
                  className={`w-full flex items-center gap-3 px-3 py-2 rounded-xl text-xs font-medium transition-colors cursor-pointer ${
                    isActive
                      ? 'bg-zinc-900/90 text-white border-l-2 border-rose-500 shadow-sm'
                      : 'text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200'
                  } ${isSidebarCollapsed ? 'justify-center px-0' : ''}`}
                >
                  <div className="relative flex items-center justify-center">
                    <Icon
                      className={`w-4 h-4 shrink-0 ${
                        isActive ? 'text-rose-400' : 'text-zinc-400'
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
          <div className="flex-1 overflow-y-auto px-2 py-3 border-t border-zinc-800/60">
            <div className="px-3 pb-2 text-[10px] font-mono uppercase tracking-wider text-zinc-500 flex items-center justify-between">
              <span>Sua Biblioteca</span>
              <span className="text-[10px] text-zinc-500 font-mono">{mockCommunities.length}</span>
            </div>

            {mockCommunities.length === 0 ? (
              <div className="px-3 py-4 text-center text-zinc-500">
                <p className="text-[11px]">Nenhuma comunidade</p>
              </div>
            ) : (
              <div className="space-y-1">
                {mockCommunities.map((comm) => {
                  const isSelected = activeCommunityId === comm.id && activeTab === 'communities';
                  return (
                    <button
                      key={comm.id}
                      type="button"
                      onClick={() => {
                        setActiveCommunity(comm.id);
                        setActiveTab('communities');
                      }}
                      className={`w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-xl text-xs transition-colors text-left cursor-pointer ${
                        isSelected
                          ? 'bg-zinc-900 text-white font-medium border-l-2 border-rose-500'
                          : 'text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200'
                      }`}
                    >
                      <div
                        className="w-5 h-5 rounded-md flex items-center justify-center text-[10px] font-bold text-white shrink-0 shadow-xs"
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

      {/* Bottom Audio & Quick Controls Dock */}
      <div className="p-2.5 border-t border-zinc-800/80 bg-[#0a0c10]/90 shrink-0">
        <div
          className={`flex items-center ${
            isSidebarCollapsed ? 'flex-col gap-1.5 justify-center' : 'justify-between px-1'
          }`}
        >
          {/* Quick Mic / Headphone controls */}
          <div className="flex items-center gap-1.5">
            <Tooltip
              content={isMicMuted ? 'Ativar Microfone' : 'Mutar Microfone'}
              position="top"
            >
              <button
                type="button"
                onClick={() => callService.toggleMute()}
                className={`p-1.5 rounded-lg transition-colors cursor-pointer ${
                  isMicMuted
                    ? 'bg-rose-500/20 text-rose-400 hover:bg-rose-500/30'
                    : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
                }`}
              >
                {isMicMuted ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
              </button>
            </Tooltip>

            <Tooltip
              content={isDeafened ? 'Ativar Áudio' : 'Desativar Áudio'}
              position="top"
            >
              <button
                type="button"
                onClick={() => callService.toggleDeafen()}
                className={`p-1.5 rounded-lg transition-colors cursor-pointer ${
                  isDeafened
                    ? 'bg-rose-500/20 text-rose-400 hover:bg-rose-500/30'
                    : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
                }`}
              >
                <Headphones
                  className={`w-4 h-4 ${
                    isDeafened ? 'text-rose-400' : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                />
              </button>
            </Tooltip>
          </div>

          {/* Quick settings shortcut on expanded dock */}
          {!isSidebarCollapsed && (
            <Tooltip content="Configurações" position="top">
              <button
                type="button"
                onClick={() => setActiveTab('settings')}
                className="p-1.5 rounded-lg text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 transition-colors cursor-pointer"
              >
                <Settings className="w-4 h-4" />
              </button>
            </Tooltip>
          )}
        </div>
      </div>
    </aside>
  );
};
