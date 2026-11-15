import React, { useState, useEffect, useRef } from 'react';
import {
  Search,
  Bell,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  User,
  Settings,
  LogOut,
  Check,
  LogIn,
  AlertTriangle,
  MessageSquare,
} from 'lucide-react';
import { useAppStore } from '../stores/useAppStore';
import { CurrentUserAvatar } from './Avatar';
import { WindowControls } from './WindowControls';
import { Tooltip } from './Tooltip';
import { MainTab, UserStatus } from '../lib/types';
import { getCurrentWindow } from '@tauri-apps/api/window';

const statusOptions: Array<{
  value: UserStatus;
  label: string;
  colorClass: string;
  borderClass: string;
}> = [
  { value: 'online', label: 'Disponível', colorClass: 'bg-emerald-500', borderClass: 'border-emerald-500/40' },
  { value: 'idle', label: 'Ausente', colorClass: 'bg-amber-500', borderClass: 'border-amber-500/40' },
  { value: 'dnd', label: 'Não Perturbe', colorClass: 'bg-rose-500', borderClass: 'border-rose-500/40' },
  { value: 'invisible', label: 'Invisível', colorClass: 'bg-zinc-400', borderClass: 'border-zinc-500/40' },
];

interface TitleBarProps {
  backendReady?: boolean;
}

export const TitleBar: React.FC<TitleBarProps> = () => {
  const activeTab = useAppStore((state) => state.activeTab);
  const setActiveTab = useAppStore((state) => state.setActiveTab);
  const authMode = useAppStore((state) => state.authMode);
  const currentUser = useAppStore((state) => state.currentUser);
  const onlineUser = useAppStore((state) => state.onlineUser);
  const openAuthModal = useAppStore((state) => state.openAuthModal);
  const logoutOnline = useAppStore((state) => state.logoutOnline);
  const setUserStatus = useAppStore((state) => state.setUserStatus);
  const friends = useAppStore((state) => state.friends);
  const conversations = useAppStore((state) => state.conversations);
  const friendRequests = useAppStore((state) => state.friendRequests);
  const selectConversation = useAppStore((state) => state.selectConversation);
  const startConversationWithUser = useAppStore((state) => state.startConversationWithUser);

  // In-memory tab navigation history
  const historyRef = useRef<{ stack: MainTab[]; index: number }>({
    stack: [activeTab],
    index: 0,
  });
  const pendingNavTabRef = useRef<MainTab | null>(null);
  const [navState, setNavState] = useState({ canGoBack: false, canGoForward: false });

  useEffect(() => {
    if (pendingNavTabRef.current === activeTab) {
      pendingNavTabRef.current = null;
      return;
    }
    pendingNavTabRef.current = null;

    const { stack, index } = historyRef.current;
    if (stack[index] === activeTab) {
      return;
    }

    const nextStack = stack.slice(0, index + 1);
    nextStack.push(activeTab);
    if (nextStack.length > 50) {
      nextStack.shift();
    }
    const nextIndex = nextStack.length - 1;
    historyRef.current = { stack: nextStack, index: nextIndex };
    setNavState({
      canGoBack: nextIndex > 0,
      canGoForward: false,
    });
  }, [activeTab]);

  const handleGoBack = () => {
    const { stack, index } = historyRef.current;
    if (index <= 0) return;
    const nextIndex = index - 1;
    const targetTab = stack[nextIndex];
    historyRef.current.index = nextIndex;
    setNavState({
      canGoBack: nextIndex > 0,
      canGoForward: nextIndex < stack.length - 1,
    });
    pendingNavTabRef.current = targetTab;
    setActiveTab(targetTab);
  };

  const handleGoForward = () => {
    const { stack, index } = historyRef.current;
    if (index >= stack.length - 1) return;
    const nextIndex = index + 1;
    const targetTab = stack[nextIndex];
    historyRef.current.index = nextIndex;
    setNavState({
      canGoBack: nextIndex > 0,
      canGoForward: nextIndex < stack.length - 1,
    });
    pendingNavTabRef.current = targetTab;
    setActiveTab(targetTab);
  };

  // Popover / dropdown states
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const [isNotificationsOpen, setIsNotificationsOpen] = useState(false);
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);

  // Search state
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearchFocused, setIsSearchFocused] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const profileRef = useRef<HTMLDivElement>(null);
  const notificationsRef = useRef<HTMLDivElement>(null);
  const searchContainerRef = useRef<HTMLDivElement>(null);

  // Global Ctrl+K shortcut listener
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        searchInputRef.current?.focus();
        setIsSearchFocused(true);
      }
      if (e.key === 'Escape') {
        setIsProfileOpen(false);
        setIsNotificationsOpen(false);
        setIsSearchFocused(false);
        setShowLogoutConfirm(false);
        setSearchQuery('');
        searchInputRef.current?.blur();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Close dropdowns when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (profileRef.current && !profileRef.current.contains(target)) {
        setIsProfileOpen(false);
      }
      if (notificationsRef.current && !notificationsRef.current.contains(target)) {
        setIsNotificationsOpen(false);
      }
      if (searchContainerRef.current && !searchContainerRef.current.contains(target)) {
        setIsSearchFocused(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('click', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('click', handleClickOutside);
    };
  }, []);

  // Double click header to toggle maximize natively
  const handleHeaderDoubleClick = async (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.getAttribute('data-tauri-drag-region') === 'false' || target.closest('button, input, [role="button"]')) {
      return;
    }
    try {
      await getCurrentWindow().toggleMaximize();
    } catch {}
  };

  // Filtered search results
  const trimmedSearch = searchQuery.trim().toLowerCase();
  const matchingFriends = trimmedSearch
    ? friends
        .filter(
          (f) =>
            f.name.toLowerCase().includes(trimmedSearch) ||
            (f.customStatus && f.customStatus.toLowerCase().includes(trimmedSearch))
        )
        .slice(0, 5)
    : [];

  const matchingConversations = trimmedSearch
    ? conversations
        .filter((c) => (c.other_user?.name || '').toLowerCase().includes(trimmedSearch))
        .slice(0, 5)
    : [];

  const hasSearchResults = matchingFriends.length > 0 || matchingConversations.length > 0;
  const isSearching = isSearchFocused && trimmedSearch.length > 0;

  const incomingRequestsCount = friendRequests?.incoming?.length || 0;
  const currentStatusOption =
    statusOptions.find((opt) => opt.value === currentUser?.status) || statusOptions[0];
  const statusDisplayLabel =
    currentStatusOption.value === 'online' ? 'Online' : currentStatusOption.label;

  const handleSelectFriend = async (friendId: string, friendName?: string) => {
    await startConversationWithUser(friendId, friendName);
    setActiveTab('messages');
    setSearchQuery('');
    setIsSearchFocused(false);
  };

  const handleSelectConversation = (convId: string) => {
    selectConversation(convId);
    setActiveTab('messages');
    setSearchQuery('');
    setIsSearchFocused(false);
  };

  return (
    <>
      <header
        data-tauri-drag-region
        onDoubleClick={handleHeaderDoubleClick}
        className="h-10 w-full bg-[#090A0F] border-b border-white/[0.06] flex items-center justify-between px-3 shrink-0 select-none text-xs relative z-30"
      >
        {/* Left: Angular NEXUS Monogram + Wordmark + Tab History Arrows */}
        <div className="flex items-center gap-3 shrink-0">
          <div className="flex items-center gap-2">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              className="w-5 h-5 shrink-0 drop-shadow-[0_0_8px_rgba(200,62,82,0.5)]"
              aria-hidden="true"
            >
              <defs>
                <linearGradient id="nexus-emblem-pillar" x1="3" y1="4" x2="21" y2="20" gradientUnits="userSpaceOnUse">
                  <stop offset="0%" stopColor="#E04F64" />
                  <stop offset="100%" stopColor="#9E2336" />
                </linearGradient>
                <linearGradient id="nexus-emblem-slash" x1="3" y1="4" x2="21" y2="20" gradientUnits="userSpaceOnUse">
                  <stop offset="0%" stopColor="#FF6B81" />
                  <stop offset="50%" stopColor="#E04F64" />
                  <stop offset="100%" stopColor="#C83E52" />
                </linearGradient>
              </defs>
              <path
                d="M3.0 20.0L4.6 4.0H8.0L6.4 18.0L3.0 20.0Z"
                fill="url(#nexus-emblem-pillar)"
              />
              <path
                d="M16.0 20.0L17.6 6.0L21.0 4.0L19.4 20.0H16.0Z"
                fill="url(#nexus-emblem-pillar)"
              />
              <path
                d="M3.2 5.4L4.6 4.0H8.2L20.8 18.6L19.4 20.0H15.8L3.2 5.4Z"
                fill="url(#nexus-emblem-slash)"
              />
            </svg>
            <span className="font-extrabold text-[13px] tracking-wider text-zinc-100">
              NEXUS
            </span>
          </div>

          <div
            data-tauri-drag-region="false"
            className="flex items-center gap-0.5 pl-1"
          >
            <Tooltip content="Voltar" position="bottom">
              <button
                type="button"
                onClick={handleGoBack}
                disabled={!navState.canGoBack}
                aria-label="Voltar"
                className="w-7 h-7 rounded-lg flex items-center justify-center text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.06] active:bg-white/[0.09] transition-colors cursor-pointer disabled:opacity-30 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nexus-accent/70"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
            </Tooltip>
            <Tooltip content="Avançar" position="bottom">
              <button
                type="button"
                onClick={handleGoForward}
                disabled={!navState.canGoForward}
                aria-label="Avançar"
                className="w-7 h-7 rounded-lg flex items-center justify-center text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.06] active:bg-white/[0.09] transition-colors cursor-pointer disabled:opacity-30 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nexus-accent/70"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </Tooltip>
          </div>
        </div>

        {/* Center: Global Search Bar */}
        <div
          ref={searchContainerRef}
          data-tauri-drag-region="false"
          className="relative flex-1 max-w-md w-full mx-4 min-w-0"
        >
          <div className="relative flex items-center">
            <Search className="w-3.5 h-3.5 absolute left-3 text-zinc-400 pointer-events-none" />
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onFocus={() => setIsSearchFocused(true)}
              aria-label="Pesquisar canais, amigos ou mensagens"
              placeholder="Pesquisar canais, amigos ou mensagens..."
              className="w-full bg-[#10121A] hover:bg-[#141722] focus:bg-[#141722] border border-white/[0.07] hover:border-white/[0.13] focus:border-nexus-accent/60 rounded-lg py-1.5 pl-8 pr-16 text-xs text-zinc-200 placeholder-zinc-500 focus:outline-none transition-colors"
            />
            <div className="absolute right-2 flex items-center gap-1 pointer-events-none">
              <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-white/[0.05] text-zinc-400 border border-white/[0.07]">
                Ctrl + K
              </span>
            </div>
          </div>

          {/* Search Dropdown Results */}
          {isSearching && (
            <div className="absolute left-0 right-0 top-full mt-1.5 bg-nexus-surface border border-nexus-border rounded-xl shadow-2xl p-2 z-50 text-xs animate-fadeIn max-h-80 overflow-y-auto">
              {hasSearchResults ? (
                <div className="space-y-2">
                  {matchingFriends.length > 0 && (
                    <div>
                      <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-500 px-2 py-1 block">
                        Amigos
                      </span>
                      {matchingFriends.map((friend) => (
                        <button
                          key={friend.id}
                          type="button"
                          onClick={() => handleSelectFriend(friend.id, friend.name)}
                          className="w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg hover:bg-white/[0.06] text-left transition-colors cursor-pointer group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nexus-accent/70"
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <span
                              className={`w-2 h-2 rounded-full shrink-0 ${
                                friend.status === 'online'
                                  ? 'bg-emerald-400'
                                  : friend.status === 'idle'
                                  ? 'bg-amber-400'
                                  : friend.status === 'dnd'
                                  ? 'bg-rose-400'
                                  : 'bg-zinc-500'
                              }`}
                            />
                            <span className="text-zinc-200 font-medium truncate group-hover:text-white">
                              {friend.name}
                            </span>
                          </div>
                          {friend.customStatus && (
                            <span className="text-[10px] text-zinc-500 truncate max-w-[120px]">
                              {friend.customStatus}
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                  )}

                  {matchingConversations.length > 0 && (
                    <div>
                      <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-500 px-2 py-1 block">
                        Conversas
                      </span>
                      {matchingConversations.map((conv) => (
                        <button
                          key={conv.id}
                          type="button"
                          onClick={() => handleSelectConversation(conv.id)}
                          className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg hover:bg-white/[0.06] text-left transition-colors cursor-pointer group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nexus-accent/70"
                        >
                          <MessageSquare className="w-3.5 h-3.5 text-zinc-500 group-hover:text-zinc-300" />
                          <span className="text-zinc-200 font-medium truncate group-hover:text-white">
                            {conv.other_user?.name || 'Conversa'}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <div className="py-4 text-center text-zinc-500 text-xs">
                  Nenhum resultado para "{searchQuery}"
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right: Notifications, Profile Dropdown & Window Controls */}
        <div
          data-tauri-drag-region="false"
          className="flex items-center gap-1.5 h-full shrink-0"
        >
          {/* Notifications Bell */}
          <div ref={notificationsRef} className="relative">
            <Tooltip content="Notificações" position="bottom">
              <button
                type="button"
                onClick={() => {
                  setIsNotificationsOpen(!isNotificationsOpen);
                  setIsProfileOpen(false);
                }}
                aria-label="Notificações"
                aria-expanded={isNotificationsOpen}
                className={`w-7 h-7 rounded-lg flex items-center justify-center transition-colors cursor-pointer relative focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nexus-accent/70 ${
                  isNotificationsOpen
                    ? 'bg-white/[0.08] text-zinc-100'
                    : 'text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.06]'
                }`}
              >
                <Bell className="w-4 h-4" />
                {incomingRequestsCount > 0 && (
                  <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-nexus-accent shadow-[0_0_8px_var(--nexus-accent)]" />
                )}
              </button>
            </Tooltip>

            {/* Notifications Popover */}
            {isNotificationsOpen && (
              <div className="absolute right-0 top-full mt-2 w-72 bg-nexus-surface border border-nexus-border rounded-xl shadow-2xl p-3 z-50 text-xs animate-fadeIn space-y-2">
                <div className="flex items-center justify-between pb-2 border-b border-nexus-border">
                  <span className="font-semibold text-zinc-200">Notificações</span>
                  {incomingRequestsCount > 0 && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-nexus-accent/20 text-nexus-accent font-mono font-medium">
                      {incomingRequestsCount} novas
                    </span>
                  )}
                </div>

                {incomingRequestsCount > 0 ? (
                  <div className="space-y-1.5 py-1">
                    <p className="text-[11px] text-zinc-300">
                      Você tem {incomingRequestsCount} solicitação(ões) de amizade pendente(s).
                    </p>
                    <button
                      type="button"
                      onClick={() => {
                        setActiveTab('home');
                        setIsNotificationsOpen(false);
                      }}
                      className="w-full py-1.5 rounded-lg bg-nexus-panel hover:bg-nexus-border text-zinc-200 text-center font-medium transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nexus-accent/70"
                    >
                      Ver Solicitações no Início
                    </button>
                  </div>
                ) : (
                  <div className="py-4 text-center text-zinc-500 text-xs">
                    Tudo limpo! Nenhuma nova notificação.
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Profile Dropdown Trigger */}
          {authMode === 'authenticated' && onlineUser ? (
            <div ref={profileRef} className="relative">
              <button
                type="button"
                onClick={() => {
                  setIsProfileOpen(!isProfileOpen);
                  setIsNotificationsOpen(false);
                }}
                aria-expanded={isProfileOpen}
                className={`flex items-center gap-2 pl-1.5 pr-2 py-0.5 rounded-lg transition-colors cursor-pointer border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nexus-accent/70 ${
                  isProfileOpen
                    ? 'bg-white/[0.08] border-white/[0.14] text-white'
                    : 'bg-[#10121A] hover:bg-[#141722] border-white/[0.07] hover:border-white/[0.13] text-zinc-200 hover:text-white'
                }`}
              >
                <div className="relative">
                  <CurrentUserAvatar
                    size="xs"
                    shapeClassName="rounded-md"
                    showStatus={false}
                    className="shadow-[0_0_8px_var(--nexus-accent-dim)]"
                  />
                  <span
                    className={`absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full ${currentStatusOption.colorClass} ring-1 ring-[#090A0F]`}
                  />
                </div>
                <div className="flex flex-col items-start text-left leading-tight">
                  <div className="flex items-center gap-1">
                    <span className="text-xs font-semibold text-white truncate max-w-[90px]">
                      {onlineUser.displayName || onlineUser.username}
                    </span>
                    <ChevronDown className="w-3 h-3 text-zinc-400 shrink-0" />
                  </div>
                  <span className="text-[10px] text-zinc-400 flex items-center gap-1">
                    <span className={`w-1.5 h-1.5 rounded-full ${currentStatusOption.colorClass} shrink-0`} />
                    {statusDisplayLabel}
                  </span>
                </div>
              </button>

              {/* Profile Dropdown Menu */}
              {isProfileOpen && (
                <div className="absolute right-0 top-full mt-2 w-64 bg-nexus-surface border border-nexus-border rounded-xl shadow-2xl p-2 z-50 text-xs animate-fadeIn space-y-2">
                  {/* User Profile Header Card */}
                  <div className="p-2.5 rounded-lg bg-nexus-panel/60 border border-nexus-border/70 flex items-center gap-3">
                    <CurrentUserAvatar size="md" />
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold text-zinc-100 truncate">
                        {onlineUser.displayName || onlineUser.username}
                      </p>
                      <p className="text-[11px] text-zinc-400 font-mono truncate">
                        @{onlineUser.username}
                      </p>
                    </div>
                  </div>

                  {/* Status Picker Submenu */}
                  <div className="px-1 py-1">
                    <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-500 px-1.5 pb-1 block">
                      Definir Status
                    </span>
                    <div className="grid grid-cols-2 gap-1 pt-0.5">
                      {statusOptions.map((opt) => {
                        const isCurrent = currentUser.status === opt.value;
                        return (
                          <button
                            key={opt.value}
                            type="button"
                            onClick={() => setUserStatus(opt.value)}
                            className={`flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-left transition-colors cursor-pointer border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nexus-accent/70 ${
                              isCurrent
                                ? `bg-nexus-panel ${opt.borderClass} text-white font-medium`
                                : 'bg-nexus-panel/30 hover:bg-nexus-panel/70 border-transparent text-zinc-400 hover:text-zinc-200'
                            }`}
                          >
                            <span className={`w-2 h-2 rounded-full ${opt.colorClass} shrink-0`} />
                            <span className="text-[11px] truncate">{opt.label}</span>
                            {isCurrent && <Check className="w-3 h-3 text-emerald-400 ml-auto shrink-0" />}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div className="h-[1px] bg-nexus-border/80 my-1" />

                  {/* Navigation Actions */}
                  <div className="space-y-0.5">
                    <button
                      type="button"
                      onClick={() => {
                        setActiveTab('settings');
                        setIsProfileOpen(false);
                      }}
                      className="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-zinc-300 hover:text-white hover:bg-white/[0.06] transition-colors cursor-pointer text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nexus-accent/70"
                    >
                      <User className="w-3.5 h-3.5 text-zinc-400" />
                      <span>Meu perfil</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        setActiveTab('settings');
                        setIsProfileOpen(false);
                      }}
                      className="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-zinc-300 hover:text-white hover:bg-white/[0.06] transition-colors cursor-pointer text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nexus-accent/70"
                    >
                      <Settings className="w-3.5 h-3.5 text-zinc-400" />
                      <span>Configurações</span>
                    </button>
                  </div>

                  <div className="h-[1px] bg-nexus-border/80 my-1" />

                  {/* Logout with Confirmation Trigger */}
                  <button
                    type="button"
                    onClick={() => {
                      setIsProfileOpen(false);
                      setShowLogoutConfirm(true);
                    }}
                    className="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-rose-400 hover:text-rose-300 hover:bg-rose-500/15 transition-colors cursor-pointer text-left font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nexus-accent/70"
                  >
                    <LogOut className="w-3.5 h-3.5" />
                    <span>Sair da conta</span>
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={openAuthModal}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-nexus-accent/20 hover:bg-nexus-accent/30 border border-nexus-accent/40 text-[11px] font-semibold text-nexus-text transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nexus-accent/70"
              >
                <LogIn className="w-3 h-3 text-nexus-accent" />
                <span>Entrar</span>
              </button>
            </div>
          )}

          {/* Vertical Divider */}
          <div className="h-4 w-[1px] bg-white/[0.08] mx-1 shrink-0" />

          {/* Official Native Tauri 2 Window Controls */}
          <WindowControls />
        </div>
      </header>

      {/* Logout Confirmation Modal */}
      {showLogoutConfirm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4 animate-fadeIn select-none"
          onClick={() => setShowLogoutConfirm(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="logout-confirm-title"
            onClick={(e) => e.stopPropagation()}
            className="relative w-full max-w-sm bg-nexus-surface border border-nexus-border rounded-2xl shadow-2xl p-5 space-y-4"
          >
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-rose-500/15 border border-rose-500/30 flex items-center justify-center text-rose-400 shrink-0">
                <AlertTriangle className="w-5 h-5" />
              </div>
              <div>
                <h3 id="logout-confirm-title" className="text-sm font-bold text-white">
                  Encerrar Sessão?
                </h3>
                <p className="text-xs text-zinc-400 mt-0.5">Desconectar da sua conta NEXUS</p>
              </div>
            </div>

            <p className="text-xs text-zinc-300 leading-relaxed">
              Você será desconectado da sua conta NEXUS. Seu banco de dados local SQLite e configurações continuarão salvos com segurança neste dispositivo.
            </p>

            <div className="flex items-center justify-end gap-2.5 pt-2">
              <button
                type="button"
                onClick={() => setShowLogoutConfirm(false)}
                className="px-3 py-1.5 rounded-lg bg-nexus-panel hover:bg-nexus-border text-xs font-semibold text-zinc-200 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nexus-accent/70"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={async () => {
                  setShowLogoutConfirm(false);
                  await logoutOnline();
                }}
                className="px-3.5 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 text-xs font-semibold text-white shadow-sm transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nexus-accent/70"
              >
                Sair da Conta
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
