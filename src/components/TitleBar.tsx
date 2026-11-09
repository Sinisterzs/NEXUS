import React, { useState, useEffect, useRef } from 'react';
import {
  Search,
  Bell,
  ChevronDown,
  User,
  Settings,
  LogOut,
  Check,
  LogIn,
  AlertTriangle,
  MessageSquare,
} from 'lucide-react';
import { useAppStore } from '../stores/useAppStore';
import { APP_VERSION } from '../version';
import { CurrentUserAvatar } from './Avatar';
import { WindowControls } from './WindowControls';
import { UserStatus } from '../lib/types';
import { getCurrentWindow } from '@tauri-apps/api/window';

const tabTitles: Record<string, string> = {
  home: 'Início',
  messages: 'Mensagens',
  communities: 'Comunidades',
  calls: 'Chamadas',
  settings: 'Configurações',
};

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
        className="h-10 w-full bg-[#0B0C0E] border-b border-[#1E2026] flex items-center justify-between px-3 shrink-0 select-none text-xs relative z-30"
      >
        {/* Left: Brand Monogram & Breadcrumb */}
        <div className="flex items-center gap-3 shrink-0">
          <div className="flex items-center gap-2">
            <div className="w-5 h-5 rounded bg-gradient-to-br from-rose-600 to-rose-700 flex items-center justify-center text-white font-black text-[11px] shadow-sm shadow-rose-900/40 shrink-0">
              N
            </div>
            <span className="font-bold text-xs tracking-wider text-zinc-100">
              NEXUS
            </span>
            <span className="text-[10px] px-1.5 py-0.2 rounded bg-zinc-900 text-zinc-400 border border-zinc-800 font-mono">
              v{APP_VERSION}
            </span>
          </div>

          <span className="text-zinc-700">/</span>

          <span className="text-zinc-400 font-medium tracking-tight">
            {tabTitles[activeTab] || 'NEXUS'}
          </span>
        </div>

        {/* Center: Global Search Bar */}
        <div
          ref={searchContainerRef}
          data-tauri-drag-region="false"
          className="relative flex-1 max-w-sm mx-4"
        >
          <div className="relative flex items-center">
            <Search className="w-3.5 h-3.5 absolute left-2.5 text-zinc-500 pointer-events-none" />
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onFocus={() => setIsSearchFocused(true)}
              placeholder="Pesquisar canais, amigos ou mensagens (Ctrl+K)"
              className="w-full bg-[#14161C] hover:bg-[#181A22] text-zinc-200 placeholder-zinc-500 text-xs pl-8 pr-16 py-1.5 rounded-lg border border-zinc-800/80 hover:border-zinc-700/80 focus:border-rose-500/60 focus:bg-[#161820] focus:outline-none transition-colors"
            />
            <div className="absolute right-2 flex items-center gap-1 pointer-events-none">
              <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-zinc-800/80 text-zinc-400 border border-zinc-700/60">
                Ctrl K
              </span>
            </div>
          </div>

          {/* Search Dropdown Results */}
          {isSearching && (
            <div className="absolute left-0 right-0 top-full mt-1.5 bg-[#14161C] border border-zinc-800 rounded-xl shadow-2xl p-2 z-50 text-xs animate-fadeIn max-h-80 overflow-y-auto">
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
                          className="w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg hover:bg-zinc-800/70 text-left transition-colors cursor-pointer group"
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
                          className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg hover:bg-zinc-800/70 text-left transition-colors cursor-pointer group"
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
          className="flex items-center gap-1.5 h-full"
        >
          {/* Notifications Bell */}
          <div ref={notificationsRef} className="relative">
            <button
              type="button"
              onClick={() => {
                setIsNotificationsOpen(!isNotificationsOpen);
                setIsProfileOpen(false);
              }}
              title="Notificações"
              className={`p-1.5 rounded-lg transition-colors cursor-pointer relative ${
                isNotificationsOpen
                  ? 'bg-zinc-800 text-zinc-100'
                  : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/60'
              }`}
            >
              <Bell className="w-4 h-4" />
              {incomingRequestsCount > 0 && (
                <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-rose-500 shadow-sm shadow-rose-500/50" />
              )}
            </button>

            {/* Notifications Popover */}
            {isNotificationsOpen && (
              <div className="absolute right-0 top-full mt-2 w-72 bg-[#14161C] border border-zinc-800 rounded-xl shadow-2xl p-3 z-50 text-xs animate-fadeIn space-y-2">
                <div className="flex items-center justify-between pb-2 border-b border-zinc-800">
                  <span className="font-semibold text-zinc-200">Notificações</span>
                  {incomingRequestsCount > 0 && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-rose-500/20 text-rose-300 font-mono font-medium">
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
                      className="w-full py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-center font-medium transition-colors cursor-pointer"
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
                className={`flex items-center gap-2 pl-1.5 pr-2 py-1 rounded-lg transition-colors cursor-pointer border ${
                  isProfileOpen
                    ? 'bg-zinc-800/90 border-zinc-700 text-white'
                    : 'bg-zinc-900/60 hover:bg-zinc-800/70 border-zinc-800/80 text-zinc-300 hover:text-white'
                }`}
              >
                <CurrentUserAvatar size="xs" />
                <span className="text-xs font-medium truncate max-w-[100px]">
                  {onlineUser.displayName || onlineUser.username}
                </span>
                <ChevronDown className="w-3 h-3 text-zinc-400 shrink-0" />
              </button>

              {/* Profile Dropdown Menu */}
              {isProfileOpen && (
                <div className="absolute right-0 top-full mt-2 w-64 bg-[#14161C] border border-zinc-800 rounded-xl shadow-2xl p-2 z-50 text-xs animate-fadeIn space-y-2">
                  {/* User Profile Header Card */}
                  <div className="p-2.5 rounded-lg bg-zinc-900/70 border border-zinc-800/70 flex items-center gap-3">
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
                            className={`flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-left transition-colors cursor-pointer border ${
                              isCurrent
                                ? `bg-zinc-800 ${opt.borderClass} text-white font-medium`
                                : 'bg-zinc-900/40 hover:bg-zinc-800/50 border-transparent text-zinc-400 hover:text-zinc-200'
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

                  <div className="h-[1px] bg-zinc-800/80 my-1" />

                  {/* Navigation Actions */}
                  <div className="space-y-0.5">
                    <button
                      type="button"
                      onClick={() => {
                        setActiveTab('settings');
                        setIsProfileOpen(false);
                      }}
                      className="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-zinc-300 hover:text-white hover:bg-zinc-800/70 transition-colors cursor-pointer text-left"
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
                      className="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-zinc-300 hover:text-white hover:bg-zinc-800/70 transition-colors cursor-pointer text-left"
                    >
                      <Settings className="w-3.5 h-3.5 text-zinc-400" />
                      <span>Configurações</span>
                    </button>
                  </div>

                  <div className="h-[1px] bg-zinc-800/80 my-1" />

                  {/* Logout with Confirmation Trigger */}
                  <button
                    type="button"
                    onClick={() => {
                      setIsProfileOpen(false);
                      setShowLogoutConfirm(true);
                    }}
                    className="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-rose-400 hover:text-rose-300 hover:bg-rose-500/15 transition-colors cursor-pointer text-left font-medium"
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
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-rose-600/20 hover:bg-rose-600/30 border border-rose-500/40 text-[11px] font-semibold text-rose-200 transition-colors cursor-pointer"
              >
                <LogIn className="w-3 h-3 text-rose-400" />
                <span>Entrar</span>
              </button>
            </div>
          )}

          {/* Vertical Divider */}
          <div className="h-4 w-[1px] bg-zinc-800 mx-1 shrink-0" />

          {/* Official Native Tauri 2 Window Controls */}
          <WindowControls />
        </div>
      </header>

      {/* Logout Confirmation Modal */}
      {showLogoutConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4 animate-fadeIn select-none">
          <div className="relative w-full max-w-sm bg-[#14161C] border border-zinc-800 rounded-2xl shadow-2xl p-5 space-y-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-rose-500/15 border border-rose-500/30 flex items-center justify-center text-rose-400 shrink-0">
                <AlertTriangle className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-sm font-bold text-white">Encerrar Sessão?</h3>
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
                className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-xs font-semibold text-zinc-200 transition-colors cursor-pointer"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={async () => {
                  setShowLogoutConfirm(false);
                  await logoutOnline();
                }}
                className="px-3.5 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 text-xs font-semibold text-white shadow-sm transition-colors cursor-pointer"
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
