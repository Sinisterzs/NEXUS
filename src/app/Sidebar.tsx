import React, { useEffect, useRef, useState } from 'react';
import {
  Home,
  MessageSquare,
  Users,
  Phone,
  Settings,
  ChevronLeft,
  ChevronRight,
  Mic,
  MicOff,
  Headphones,
  Check,
  LogOut,
} from 'lucide-react';
import { useAppStore } from '../stores/useAppStore';
import { MainTab, UserStatus } from '../lib/types';
import { mockDirectMessages } from '../mocks';
import { callService } from '../services/CallService';
import { Badge } from '../components/Badge';
import { Tooltip } from '../components/Tooltip';
import { CurrentUserAvatar } from '../components/Avatar';
import { ActiveCallBar } from '../components/ActiveCallBar';

interface StatusOption {
  value: UserStatus;
  label: string;
  dotClass: string;
}

const STATUS_OPTIONS: StatusOption[] = [
  { value: 'online', label: 'Online', dotClass: 'bg-emerald-500' },
  { value: 'idle', label: 'Ausente', dotClass: 'bg-amber-500' },
  { value: 'dnd', label: 'Não Perturbe', dotClass: 'bg-rose-500' },
  { value: 'invisible', label: 'Invisível', dotClass: 'bg-slate-500' },
];

function getStatusMeta(status: UserStatus): StatusOption {
  if (status === 'offline') {
    return { value: 'offline', label: 'Offline', dotClass: 'bg-slate-500' };
  }
  if (status === 'invisible') {
    return { value: 'invisible', label: 'Invisível', dotClass: 'bg-slate-500' };
  }
  return STATUS_OPTIONS.find((opt) => opt.value === status) ?? STATUS_OPTIONS[0];
}

export interface SidebarProps {
  suppressCallBar?: boolean;
}

export const Sidebar: React.FC<SidebarProps> = ({ suppressCallBar = false }) => {
  const activeTab = useAppStore((state) => state.activeTab);
  const isSidebarCollapsed = useAppStore((state) => state.isSidebarCollapsed);
  const voiceCallState = useAppStore((state) => state.voiceCallState);
  const setActiveTab = useAppStore((state) => state.setActiveTab);
  const toggleSidebar = useAppStore((state) => state.toggleSidebar);
  const authStatus = useAppStore((state) => state.authStatus);
  const isMicMuted = useAppStore((state) => state.isMicMuted);
  const isDeafened = useAppStore((state) => state.isDeafened);
  const communities = useAppStore((state) => state.communities) ?? [];
  const conversations = useAppStore((state) => state.conversations) ?? [];
  const currentUser = useAppStore((state) => state.currentUser);
  const onlineUser = useAppStore((state) => state.onlineUser);
  const setUserStatus = useAppStore((state) => state.setUserStatus);
  const logoutOnline = useAppStore((state) => state.logoutOnline);

  const [isProfileMenuOpen, setIsProfileMenuOpen] = useState(false);

  const profileTriggerRef = useRef<HTMLButtonElement>(null);
  const profilePopoverRef = useRef<HTMLDivElement>(null);

  // ActiveCallBar owns the compact controls only outside the main call screen unless suppressed by FloatingCallDock.
  const showSidebarCallBar =
    !suppressCallBar && voiceCallState !== 'idle' && activeTab !== 'calls';
  const hasCompactCallControls = isSidebarCollapsed && showSidebarCallBar;

  useEffect(() => {
    if (hasCompactCallControls) {
      setIsProfileMenuOpen(false);
    }
  }, [hasCompactCallControls]);

  useEffect(() => {
    if (!isProfileMenuOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsProfileMenuOpen(false);
      }
    };

    const handleMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        !profileTriggerRef.current?.contains(target) &&
        !profilePopoverRef.current?.contains(target)
      ) {
        setIsProfileMenuOpen(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    document.addEventListener('mousedown', handleMouseDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('mousedown', handleMouseDown);
    };
  }, [isProfileMenuOpen]);

  const userDisplayName =
    onlineUser?.displayName ||
    currentUser?.displayName ||
    (currentUser as any)?.name ||
    onlineUser?.username ||
    currentUser?.username ||
    'Usuário';
  const userHandle = onlineUser?.username || currentUser?.username;
  const userStatus: UserStatus = currentUser?.status || 'online';
  const statusMeta = getStatusMeta(userStatus);

  const isOnline = authStatus === 'authenticated';
  const totalDmUnreads = isOnline
    ? conversations.reduce((acc, c) => acc + (c.unread_count || 0), 0)
    : mockDirectMessages.reduce((acc, dm) => acc + (dm.unreadCount || 0), 0);

  const totalCommunityUnreads = communities.reduce(
    (acc, c) => acc + (c.unread_count || 0),
    0
  );

  const navItems: { id: MainTab; label: string; icon: React.ElementType; badge?: number }[] = [
    { id: 'home', label: 'Início', icon: Home },
    { id: 'messages', label: 'Amigos & DMs', icon: MessageSquare, badge: totalDmUnreads },
    { id: 'communities', label: 'Comunidades', icon: Users, badge: totalCommunityUnreads },
    { id: 'calls', label: 'Chamadas', icon: Phone },
    { id: 'settings', label: 'Configurações', icon: Settings },
  ];

  const renderAudioControls = (tooltipPosition: 'top' | 'right', compact = false) => {
    const btnSize = compact ? 'w-6 h-6' : 'w-8 h-8';
    const iconSize = compact ? 'w-3.5 h-3.5' : 'w-4 h-4';
    const usePortal = tooltipPosition === 'right';

    return (
      <>
        <Tooltip
          content={isMicMuted ? 'Ativar microfone' : 'Silenciar microfone'}
          position={tooltipPosition}
          portal={usePortal}
        >
          <button
            type="button"
            onClick={() => callService.toggleMute()}
            aria-label={isMicMuted ? 'Ativar microfone' : 'Silenciar microfone'}
            aria-pressed={isMicMuted}
            className={`${btnSize} shrink-0 flex items-center justify-center rounded-lg transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nexus-accent/70 ${
              isMicMuted
                ? 'bg-rose-500/20 text-rose-400 hover:bg-rose-500/30'
                : 'text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100'
            }`}
          >
            {isMicMuted ? <MicOff className={iconSize} /> : <Mic className={iconSize} />}
          </button>
        </Tooltip>

        <Tooltip
          content={isDeafened ? 'Ativar áudio' : 'Desativar áudio'}
          position={tooltipPosition}
          portal={usePortal}
        >
          <button
            type="button"
            onClick={() => callService.toggleDeafen()}
            aria-label={isDeafened ? 'Ativar áudio' : 'Desativar áudio'}
            aria-pressed={isDeafened}
            className={`${btnSize} shrink-0 flex items-center justify-center rounded-lg transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nexus-accent/70 ${
              isDeafened
                ? 'bg-rose-500/20 text-rose-400 hover:bg-rose-500/30'
                : 'text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100'
            }`}
          >
            <Headphones
              className={`${iconSize} ${
                isDeafened ? 'text-rose-400' : 'text-zinc-400 hover:text-zinc-100'
              }`}
            />
          </button>
        </Tooltip>
      </>
    );
  };

  const renderUserAvatar = (ringClass = 'ring-[#0a0c10]') => (
    <div className="relative shrink-0">
      <CurrentUserAvatar size="sm" showStatus={false} />
      <span
        aria-hidden="true"
        className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full ${statusMeta.dotClass} ring-2 ${ringClass}`}
      />
    </div>
  );

  return (
    <aside
      className={`h-full bg-[#090A0F] border-r border-white/[0.06] flex flex-col justify-between shrink-0 transition-all duration-200 select-none relative z-20 ${
        isSidebarCollapsed ? 'w-[60px]' : 'w-[214px]'
      }`}
    >
      {/* Subtle bottom-left crimson ambient glow clipped within sidebar bounds */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -bottom-10 -left-10 w-44 h-44 bg-nexus-accent/[0.07] rounded-full blur-3xl" />
      </div>

      {/* Top Section: Compact Collapse Toggle & Primary Tabs */}
      <div className="flex flex-col flex-1 min-h-0 relative z-10">
        <div
          className={`flex items-center shrink-0 pt-2.5 pb-1 ${
            isSidebarCollapsed ? 'justify-center px-2' : 'justify-end px-3'
          }`}
        >
          <Tooltip
            content={isSidebarCollapsed ? 'Expandir barra lateral' : 'Recolher barra lateral'}
            position="right"
            portal
          >
            <button
              type="button"
              onClick={toggleSidebar}
              aria-label={isSidebarCollapsed ? 'Expandir barra lateral' : 'Recolher barra lateral'}
              className="p-1.5 rounded-lg hover:bg-white/[0.05] text-zinc-500 hover:text-zinc-100 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nexus-accent/70"
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
        <nav aria-label="Navegação principal" className="flex-1 overflow-y-auto px-2.5 pt-1 pb-2.5 space-y-1.5">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;

            const button = (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveTab(item.id)}
                aria-current={isActive ? 'page' : undefined}
                aria-label={isSidebarCollapsed ? item.label : undefined}
                className={`relative w-full flex items-center gap-3 py-2.5 rounded-xl text-[13.5px] font-medium transition-all cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nexus-accent/70 ${
                  isActive
                    ? 'bg-gradient-to-r from-[#E04F64]/28 via-[#C83E52]/16 to-transparent border border-[#E04F64]/45 text-white shadow-[0_0_18px_rgba(200,62,82,0.16)]'
                    : 'text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-100 border border-transparent'
                } ${isSidebarCollapsed ? 'justify-center px-0' : 'px-3.5'}`}
              >
                {isActive && (
                  <span
                    aria-hidden="true"
                    className="absolute left-0 top-2 bottom-2 w-[3px] rounded-r-full bg-[#E04F64] shadow-[0_0_8px_var(--nexus-accent)]"
                  />
                )}

                <div className="relative flex items-center justify-center">
                  <Icon
                    className={`w-[18px] h-[18px] shrink-0 transition-colors ${
                      isActive ? 'text-[#E04F64]' : 'text-zinc-400'
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
            );

            return isSidebarCollapsed ? (
              <Tooltip key={item.id} content={item.label} position="right" portal className="w-full">
                {button}
              </Tooltip>
            ) : (
              button
            );
          })}
        </nav>
      </div>

      {/* Dock de Chamada Ativa na Barra Lateral (exibido quando fora da tela de chamadas e não suprimido) */}
      {!suppressCallBar && <ActiveCallBar />}

      {/* Bottom User & Quick Controls Dock */}
      {!hasCompactCallControls && (
        <div
          className={`${
            isSidebarCollapsed ? 'mx-1.5 mb-2 p-1.5' : 'mx-2 mb-2.5 px-2.5 py-2'
          } rounded-2xl border border-white/[0.08] bg-[#0a0c10]/90 shadow-[0_8px_24px_rgba(0,0,0,0.45)] shrink-0 relative z-20`}
        >
          {isProfileMenuOpen && (
            <div
              ref={profilePopoverRef}
              role="menu"
              aria-label="Opções de perfil e status"
              className={`absolute bottom-full mb-2 z-40 bg-[#12141C] border border-white/[0.08] rounded-xl shadow-2xl p-2 text-xs ${
                isSidebarCollapsed ? 'left-0 w-56' : 'left-0 right-0'
              }`}
            >
              {/* User summary */}
              <div className="px-2 py-1.5 rounded-lg bg-white/[0.03] border border-white/[0.05] flex items-center gap-2.5 mb-2">
                {renderUserAvatar('ring-[#12141C]')}
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-zinc-100 truncate">{userDisplayName}</p>
                  <p className="text-[10px] text-zinc-400 truncate">
                    {userHandle ? `@${userHandle}` : statusMeta.label}
                  </p>
                </div>
              </div>

              {/* Status picker */}
              <div className="space-y-0.5">
                <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-500 px-2 py-0.5 block">
                  Status
                </span>
                {STATUS_OPTIONS.map((opt) => {
                  const isCurrent = userStatus === opt.value;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      role="menuitemradio"
                      aria-checked={isCurrent}
                      onClick={() => {
                        setUserStatus?.(opt.value);
                        setIsProfileMenuOpen(false);
                      }}
                      className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nexus-accent/70 ${
                        isCurrent
                          ? 'bg-white/[0.08] text-white font-medium'
                          : 'text-zinc-300 hover:bg-white/[0.05] hover:text-white'
                      }`}
                    >
                      <span
                        aria-hidden="true"
                        className={`w-2 h-2 rounded-full shrink-0 ${opt.dotClass}`}
                      />
                      <span className="flex-1 truncate">{opt.label}</span>
                      {isCurrent && <Check className="w-3.5 h-3.5 text-emerald-400 shrink-0" />}
                    </button>
                  );
                })}
              </div>

              <div className="h-px bg-white/[0.06] my-1.5" />

              {/* Navigation & Account actions */}
              <div className="space-y-0.5">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setActiveTab('settings');
                    setIsProfileMenuOpen(false);
                  }}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-zinc-300 hover:text-white hover:bg-white/[0.05] transition-colors cursor-pointer text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nexus-accent/70"
                >
                  <Settings className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
                  <span>Configurações</span>
                </button>

                {authStatus === 'authenticated' && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setIsProfileMenuOpen(false);
                      void logoutOnline?.();
                    }}
                    className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-rose-400 hover:text-rose-300 hover:bg-rose-500/15 transition-colors cursor-pointer text-left font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nexus-accent/70"
                  >
                    <LogOut className="w-3.5 h-3.5 shrink-0" />
                    <span>Sair da conta</span>
                  </button>
                )}
              </div>
            </div>
          )}

          {isSidebarCollapsed ? (
            <div className="flex flex-col items-center gap-1.5">
              <Tooltip content={`${userDisplayName} • ${statusMeta.label}`} position="right" portal>
                <button
                  ref={profileTriggerRef}
                  type="button"
                  onClick={() => setIsProfileMenuOpen((prev) => !prev)}
                  aria-expanded={isProfileMenuOpen}
                  aria-haspopup="menu"
                  aria-label={`${userDisplayName} (${statusMeta.label})`}
                  className={`w-9 h-9 rounded-xl flex items-center justify-center transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nexus-accent/70 ${
                    isProfileMenuOpen ? 'bg-white/[0.08]' : 'hover:bg-white/[0.06]'
                  }`}
                >
                  {renderUserAvatar()}
                </button>
              </Tooltip>

              {renderAudioControls('right', false)}
            </div>
          ) : (
            <div className="flex items-center justify-between gap-1">
              <button
                ref={profileTriggerRef}
                type="button"
                onClick={() => setIsProfileMenuOpen((prev) => !prev)}
                aria-expanded={isProfileMenuOpen}
                aria-haspopup="menu"
                aria-label="Abrir perfil e status"
                className={`flex items-center gap-2 min-w-0 flex-1 pl-0.5 pr-0.5 py-1 rounded-xl transition-colors text-left cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nexus-accent/70 ${
                  isProfileMenuOpen ? 'bg-white/[0.07]' : 'hover:bg-white/[0.05]'
                }`}
              >
                {renderUserAvatar()}
                <div className="min-w-0 flex-1 leading-tight">
                  <p className="text-[12px] font-semibold text-zinc-100 truncate">
                    {userDisplayName}
                  </p>
                  <p className="text-[10px] text-zinc-400 flex items-center gap-1 mt-0.5">
                    <span
                      aria-hidden="true"
                      className={`w-1.5 h-1.5 rounded-full shrink-0 ${statusMeta.dotClass}`}
                    />
                    <span className="truncate">{statusMeta.label}</span>
                  </p>
                </div>
              </button>

              <div className="flex items-center gap-0.5 shrink-0">
                {renderAudioControls('top', true)}

                <Tooltip content="Configurações" position="top">
                  <button
                    type="button"
                    onClick={() => setActiveTab('settings')}
                    aria-label="Abrir configurações"
                    className="w-6 h-6 shrink-0 flex items-center justify-center rounded-lg text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nexus-accent/70"
                  >
                    <Settings className="w-3.5 h-3.5" />
                  </button>
                </Tooltip>
              </div>
            </div>
          )}
        </div>
      )}
    </aside>
  );
};
