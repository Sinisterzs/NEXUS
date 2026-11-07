import React, { useState } from 'react';
import {
  Gamepad2,
  Users,
  MessageSquare,
  Radio,
  Clock,
  ArrowRight,
  Hash,
  Search,
  UserPlus,
  MoreVertical,
  UserMinus,
  Ban,
  ChevronDown,
  Sparkles,
  Phone,
} from 'lucide-react';
import { useAppStore } from '../../stores/useAppStore';
import { callService } from '../../services/CallService';
import { mockCommunities, mockDirectMessages } from '../../mocks';
import { Avatar } from '../../components/Avatar';
import { Badge } from '../../components/Badge';
import { Tooltip } from '../../components/Tooltip';
import { AddFriendModal } from '../friends/AddFriendModal';
import { UserStatus } from '../../lib/types';

export const HomeView: React.FC = () => {
  const setActiveTab = useAppStore((state) => state.setActiveTab);
  const setActiveCommunity = useAppStore((state) => state.setActiveCommunity);
  const setActiveChannel = useAppStore((state) => state.setActiveChannel);
  const setActiveDm = useAppStore((state) => state.setActiveDm);
  const joinCall = useAppStore((state) => state.joinCall);
  const currentUser = useAppStore((state) => state.currentUser);
  const authStatus = useAppStore((state) => state.authStatus);
  const friends = useAppStore((state) => state.friends);
  const friendRequests = useAppStore((state) => state.friendRequests);
  const openAddFriendModal = useAppStore((state) => state.openAddFriendModal);
  const removeFriend = useAppStore((state) => state.removeFriend);
  const blockUser = useAppStore((state) => state.blockUser);
  const setUserStatus = useAppStore((state) => state.setUserStatus);
  const openAuthModal = useAppStore((state) => state.openAuthModal);

  const [friendFilter, setFriendFilter] = useState<'all' | 'online' | 'gaming'>('all');
  const [friendSearch, setFriendSearch] = useState('');
  const [openFriendMenuId, setOpenFriendMenuId] = useState<string | null>(null);
  const [isStatusMenuOpen, setIsStatusMenuOpen] = useState(false);

  const isAuthenticated = authStatus === 'authenticated';
  const incomingRequestsCount = friendRequests.incoming.length;

  const filteredFriends = friends.filter((f) => {
    const matchesFilter =
      friendFilter === 'gaming'
        ? f.activity?.startsWith('Em jogo')
        : friendFilter === 'online'
        ? f.status === 'online' || f.status === 'idle' || f.status === 'dnd'
        : true;
    const matchesSearch =
      friendSearch.trim() === '' ||
      f.name.toLowerCase().includes(friendSearch.toLowerCase()) ||
      f.tag.toLowerCase().includes(friendSearch.toLowerCase()) ||
      (f.username && f.username.toLowerCase().includes(friendSearch.toLowerCase()));
    return matchesFilter && matchesSearch;
  });

  const statusOptions: { value: UserStatus; label: string; color: string; desc: string }[] = [
    { value: 'online', label: 'Online', color: 'bg-emerald-400', desc: 'Disponível no NEXUS' },
    { value: 'idle', label: 'Ausente', color: 'bg-amber-400', desc: 'Temporariamente ausente' },
    { value: 'dnd', label: 'Não Perturbe', color: 'bg-rose-500', desc: 'Notificações silenciadas' },
    { value: 'invisible', label: 'Invisível', color: 'bg-zinc-400', desc: 'Aparece offline aos amigos' },
  ];

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6 select-none bg-nexus-bg">
      {/* Top Welcome Banner */}
      <div className="bg-nexus-surface border border-nexus-border rounded-xl p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4 shadow-xs">
        <div className="flex items-center gap-4">
          <div className="relative">
            <Avatar
              name={currentUser.displayName}
              status={currentUser.status}
              size="lg"
              className="ring-2 ring-nexus-border"
            />
          </div>

          <div className="relative">
            <div className="flex items-center gap-2">
              <h1 className="text-base font-bold text-nexus-text">
                Olá, {currentUser.displayName}
              </h1>
              {authStatus === 'authenticated' ? (
                <span className="text-xs font-mono text-nexus-muted">
                  @{currentUser.username}
                </span>
              ) : (
                currentUser.tag && (
                  <span className="text-xs font-mono text-nexus-muted">
                    {currentUser.tag}
                  </span>
                )
              )}
            </div>

            {/* Quick Status Selector */}
            <div className="flex items-center gap-2 mt-1">
              <div className="relative">
                <button
                  onClick={() => setIsStatusMenuOpen(!isStatusMenuOpen)}
                  className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-nexus-panel hover:bg-nexus-border text-[11px] font-medium text-nexus-text border border-nexus-border/60 transition-nexus"
                >
                  <span
                    className={`w-2 h-2 rounded-full ${
                      currentUser.status === 'online'
                        ? 'bg-emerald-400'
                        : currentUser.status === 'idle'
                        ? 'bg-amber-400'
                        : currentUser.status === 'dnd'
                        ? 'bg-rose-500'
                        : 'bg-zinc-400'
                    }`}
                  />
                  <span className="capitalize">{currentUser.status}</span>
                  <ChevronDown className="w-3 h-3 text-nexus-muted" />
                </button>

                {isStatusMenuOpen && (
                  <div
                    className="absolute left-0 mt-1 w-44 rounded-lg bg-nexus-surface border border-nexus-border shadow-xl py-1 z-30 animate-in fade-in zoom-in-95 duration-100"
                    onMouseLeave={() => setIsStatusMenuOpen(false)}
                  >
                    {statusOptions.map((opt) => (
                      <button
                        key={opt.value}
                        onClick={() => {
                          setUserStatus(opt.value);
                          setIsStatusMenuOpen(false);
                        }}
                        className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-xs text-left hover:bg-nexus-panel transition-nexus ${
                          currentUser.status === opt.value
                            ? 'text-nexus-accent font-bold'
                            : 'text-nexus-text'
                        }`}
                      >
                        <span className={`w-2 h-2 rounded-full shrink-0 ${opt.color}`} />
                        <div>
                          <div className="font-medium">{opt.label}</div>
                          <div className="text-[10px] text-nexus-muted">{opt.desc}</div>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <span className="text-xs text-nexus-muted truncate max-w-xs">
                {currentUser.customStatus || 'Disponível no NEXUS'}
              </span>
            </div>
          </div>
        </div>

        {/* Quick Hub Navigation Actions */}
        <div className="flex items-center gap-2.5 shrink-0">
          <button
            onClick={() => setActiveTab('messages')}
            className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg bg-nexus-panel hover:bg-nexus-border text-nexus-text text-xs font-medium border border-nexus-border transition-nexus"
          >
            <MessageSquare className="w-3.5 h-3.5 text-nexus-muted" />
            <span>Mensagens</span>
          </button>

          <button
            onClick={() => setActiveTab('communities')}
            className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg bg-nexus-panel hover:bg-nexus-border text-nexus-text text-xs font-medium border border-nexus-border transition-nexus"
          >
            <Users className="w-3.5 h-3.5 text-nexus-muted" />
            <span>Comunidades</span>
          </button>

          <button
            onClick={() => {
              joinCall('Rustaceans Hub • Sala de Voz 01');
              setActiveTab('calls');
            }}
            className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg bg-nexus-accent hover:bg-nexus-accent-hover text-white text-xs font-medium transition-nexus shadow-xs"
          >
            <Radio className="w-3.5 h-3.5" />
            <span>Entrar em Voz</span>
          </button>
        </div>
      </div>

      {/* Main Content Grid: Communities & Messages (Left) and Friends (Right) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Column (7 cols): Conversas Recentes & Suas Comunidades */}
        <div className="lg:col-span-7 space-y-6">
          {/* Conversas Recentes */}
          <div className="bg-nexus-surface border border-nexus-border rounded-xl p-4 shadow-xs">
            <div className="flex items-center justify-between mb-3 pb-2 border-b border-nexus-border/40">
              <div className="flex items-center gap-2">
                <Clock className="w-4 h-4 text-nexus-accent" />
                <h2 className="text-xs font-bold text-nexus-text uppercase tracking-wider">
                  Conversas Recentes
                </h2>
              </div>
              <button
                onClick={() => setActiveTab('messages')}
                className="text-xs text-nexus-accent hover:underline flex items-center gap-1 font-medium"
              >
                <span>Ver todas</span>
                <ArrowRight className="w-3 h-3" />
              </button>
            </div>

            <div className="space-y-1.5">
              {mockDirectMessages.length === 0 ? (
                <div className="text-center py-6 px-4 text-nexus-muted">
                  <MessageSquare className="w-5 h-5 mx-auto mb-1.5 opacity-40" />
                  <p className="text-xs font-medium">Nenhuma mensagem recente</p>
                  <p className="text-[10px] mt-0.5">Suas conversas diretas aparecerão aqui.</p>
                </div>
              ) : (
                mockDirectMessages.slice(0, 4).map((dm) => {
                  const friend = friends.find((f) => f.id === dm.friendId);
                  if (!friend) return null;

                  return (
                    <div
                      key={dm.id}
                      onClick={() => {
                        setActiveDm(friend.id);
                        setActiveTab('messages');
                      }}
                      className="flex items-center justify-between p-2.5 rounded-lg hover:bg-nexus-panel transition-nexus cursor-pointer group"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <Avatar name={friend.name} status={friend.status} size="md" />
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-semibold text-nexus-text group-hover:text-white truncate">
                              {friend.name}
                            </span>
                            <span className="text-[10px] text-nexus-muted font-mono">
                              {friend.tag}
                            </span>
                          </div>
                          <p className="text-xs text-nexus-muted truncate max-w-sm mt-0.5">
                            {dm.lastMessage}
                          </p>
                        </div>
                      </div>

                      <div className="flex items-center gap-3 shrink-0 ml-2">
                        <span className="text-[11px] text-nexus-muted font-mono">
                          {dm.timestamp}
                        </span>
                        {dm.unreadCount > 0 ? (
                          <Badge count={dm.unreadCount} />
                        ) : (
                          <MessageSquare className="w-3.5 h-3.5 text-nexus-muted opacity-0 group-hover:opacity-100 transition-opacity" />
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* Suas Comunidades & Canais Principais */}
          <div className="bg-nexus-surface border border-nexus-border rounded-xl p-4 shadow-xs">
            <div className="flex items-center justify-between mb-3 pb-2 border-b border-nexus-border/40">
              <div className="flex items-center gap-2">
                <Users className="w-4 h-4 text-nexus-accent" />
                <h2 className="text-xs font-bold text-nexus-text uppercase tracking-wider">
                  Suas Comunidades
                </h2>
              </div>
              <span className="text-xs text-nexus-muted font-mono">
                {mockCommunities.length} ativas
              </span>
            </div>

            {mockCommunities.length === 0 ? (
              <div className="text-center py-6 px-4 bg-nexus-panel/40 rounded-xl border border-dashed border-nexus-border">
                <Users className="w-5 h-5 text-nexus-muted mx-auto mb-1.5 opacity-50" />
                <p className="text-xs font-semibold text-nexus-text">Nenhuma comunidade</p>
                <p className="text-[11px] text-nexus-muted mt-0.5">
                  Você não participa de nenhuma comunidade no momento.
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {mockCommunities.map((comm) => (
                  <div
                    key={comm.id}
                    className="bg-nexus-panel/70 border border-nexus-border hover:border-nexus-accent/60 rounded-xl p-3.5 transition-nexus flex flex-col justify-between"
                  >
                    <div className="flex items-start justify-between gap-3 mb-3">
                      <div className="flex items-center gap-3">
                        <div
                          className="w-10 h-10 rounded-lg flex items-center justify-center font-bold text-sm text-white shrink-0 shadow-xs"
                          style={{ backgroundColor: comm.iconBg }}
                        >
                          {comm.initials}
                        </div>
                        <div>
                          <h4 className="text-xs font-bold text-nexus-text">
                            {comm.name}
                          </h4>
                          <p className="text-[11px] text-nexus-muted">
                            {comm.channels.length} canais
                          </p>
                        </div>
                      </div>

                      {comm.unreadCount && comm.unreadCount > 0 ? (
                        <Badge count={comm.unreadCount} />
                      ) : null}
                    </div>

                    {/* Channel Jump Links */}
                    <div className="space-y-1 pt-2 border-t border-nexus-border/50">
                      {comm.channels.slice(0, 2).map((ch) => (
                        <button
                          key={ch.id}
                          onClick={() => {
                            setActiveCommunity(comm.id);
                            setActiveChannel(ch.id);
                            setActiveTab('communities');
                          }}
                          className="w-full flex items-center justify-between px-2 py-1 rounded text-xs text-nexus-muted hover:text-nexus-text hover:bg-nexus-surface transition-nexus text-left"
                        >
                          <span className="flex items-center gap-1.5 truncate">
                            {ch.type === 'text' ? (
                              <Hash className="w-3 h-3 text-nexus-muted shrink-0" />
                            ) : (
                              <Radio className="w-3 h-3 text-nexus-accent shrink-0" />
                            )}
                            <span className="truncate">{ch.name}</span>
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Right Column (5 cols): Lista de Amigos Completa */}
        <div className="lg:col-span-5 space-y-4">
          <div className="bg-nexus-surface border border-nexus-border rounded-xl p-4 shadow-xs flex flex-col">
            {/* Friends Header */}
            <div className="flex items-center justify-between mb-3 pb-2 border-b border-nexus-border/40">
              <div className="flex items-center gap-2">
                <Gamepad2 className="w-4 h-4 text-emerald-400" />
                <h2 className="text-xs font-bold text-nexus-text uppercase tracking-wider">
                  Amigos ({friends.length})
                </h2>
              </div>

              {/* Action: Adicionar Amigo */}
              <button
                onClick={openAddFriendModal}
                className="relative inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-nexus-accent hover:bg-nexus-accent-hover text-white text-xs font-medium transition-nexus shadow-xs"
              >
                <UserPlus className="w-3.5 h-3.5" />
                <span>Adicionar</span>
                {incomingRequestsCount > 0 && (
                  <span className="absolute -top-1 -right-1 w-4 h-4 bg-rose-500 text-white rounded-full text-[10px] font-bold flex items-center justify-center animate-pulse">
                    {incomingRequestsCount}
                  </span>
                )}
              </button>
            </div>

            {/* Offline / Demo Notice */}
            {!isAuthenticated && (
              <div className="mb-3 p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/20 flex items-center justify-between gap-2 text-xs text-amber-200">
                <div className="flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                  <span>Modo Demonstração ativo</span>
                </div>
                <button
                  onClick={openAuthModal}
                  className="px-2 py-0.5 rounded bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 font-bold transition-nexus text-[11px]"
                >
                  Conectar
                </button>
              </div>
            )}

            {/* Filter and Search Bar */}
            <div className="space-y-2 mb-3">
              <div className="flex items-center justify-between gap-2">
                {/* Status Filters */}
                <div className="flex items-center gap-1 bg-nexus-panel p-0.5 rounded-lg border border-nexus-border text-[11px]">
                  <button
                    onClick={() => setFriendFilter('all')}
                    className={`px-2 py-0.5 rounded transition-nexus ${
                      friendFilter === 'all'
                        ? 'bg-nexus-surface text-nexus-text font-bold shadow-xs'
                        : 'text-nexus-muted hover:text-nexus-text'
                    }`}
                  >
                    Todos
                  </button>
                  <button
                    onClick={() => setFriendFilter('online')}
                    className={`px-2 py-0.5 rounded transition-nexus ${
                      friendFilter === 'online'
                        ? 'bg-nexus-surface text-nexus-text font-bold shadow-xs'
                        : 'text-nexus-muted hover:text-nexus-text'
                    }`}
                  >
                    Online
                  </button>
                  <button
                    onClick={() => setFriendFilter('gaming')}
                    className={`px-2 py-0.5 rounded transition-nexus ${
                      friendFilter === 'gaming'
                        ? 'bg-nexus-surface text-nexus-text font-bold shadow-xs'
                        : 'text-nexus-muted hover:text-nexus-text'
                    }`}
                  >
                    Em Jogo
                  </button>
                </div>
              </div>

              {/* Friend Search Input */}
              <div className="relative">
                <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-nexus-muted pointer-events-none" />
                <input
                  type="text"
                  value={friendSearch}
                  onChange={(e) => setFriendSearch(e.target.value)}
                  placeholder="Buscar amigo por nome ou tag..."
                  className="w-full bg-nexus-bg text-nexus-text text-xs pl-8 pr-3 py-1.5 rounded-lg border border-nexus-border focus:border-nexus-accent focus:outline-hidden transition-nexus"
                />
              </div>
            </div>

            {/* Friend List Items */}
            <div className="space-y-1.5 overflow-y-auto max-h-[520px] pr-1">
              {filteredFriends.length === 0 ? (
                <div className="text-center py-10 px-4 space-y-3">
                  <div className="w-12 h-12 rounded-full bg-nexus-panel border border-nexus-border flex items-center justify-center mx-auto text-nexus-muted">
                    <Users className="w-6 h-6 text-nexus-accent" />
                  </div>
                  <div className="space-y-1">
                    <h4 className="text-xs font-bold text-nexus-text">
                      {friendSearch ? 'Nenhum amigo encontrado' : 'Nenhum amigo adicionado'}
                    </h4>
                    <p className="text-[11px] text-nexus-muted max-w-xs mx-auto">
                      {friendSearch
                        ? 'Tente buscar com outro termo ou limpe o campo de busca.'
                        : 'Encontre outros usuários no NEXUS e acompanhe o status deles em tempo real.'}
                    </p>
                  </div>
                  {!friendSearch && (
                    <button
                      onClick={openAddFriendModal}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-nexus-accent hover:bg-nexus-accent-hover text-white text-xs font-medium transition-nexus shadow-xs"
                    >
                      <UserPlus className="w-3.5 h-3.5" />
                      <span>Adicionar Amigo</span>
                    </button>
                  )}
                </div>
              ) : (
                filteredFriends.map((friend) => (
                  <div
                    key={friend.id}
                    className="relative flex items-center justify-between p-2 rounded-lg hover:bg-nexus-panel transition-nexus group"
                  >
                    <div
                      onClick={() => {
                        setActiveDm(friend.id);
                        setActiveTab('messages');
                      }}
                      className="flex items-center gap-3 min-w-0 cursor-pointer flex-1"
                    >
                      <Avatar name={friend.name} status={friend.status} size="sm" />
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="text-xs font-semibold text-nexus-text group-hover:text-white truncate">
                            {friend.name}
                          </span>
                          <span className="text-[10px] text-nexus-muted font-mono">
                            {friend.tag}
                          </span>
                        </div>
                        <p className="text-[11px] truncate max-w-[180px] mt-0.5 text-nexus-muted">
                          {friend.activity ? (
                            <span className="text-emerald-400 font-medium">
                              {friend.activity}
                            </span>
                          ) : (
                            friend.customStatus || 'Disponível'
                          )}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-1 shrink-0 ml-2">
                      <Tooltip content="Iniciar Chamada" position="left">
                        <button
                          onClick={() => {
                            callService.startCall({
                              id: friend.id,
                              name: friend.name,
                              username: friend.username || friend.name,
                            });
                          }}
                          className="p-1.5 rounded-md hover:bg-emerald-500/20 text-emerald-400 transition-nexus cursor-pointer active:scale-95"
                          title={`Ligar para ${friend.name}`}
                        >
                          <Phone className="w-3.5 h-3.5" />
                        </button>
                      </Tooltip>

                      <Tooltip content="Enviar Mensagem" position="left">
                        <button
                          onClick={() => {
                            setActiveDm(friend.id);
                            setActiveTab('messages');
                          }}
                          className="p-1.5 rounded-md hover:bg-nexus-surface text-nexus-muted hover:text-nexus-text transition-nexus"
                        >
                          <MessageSquare className="w-3.5 h-3.5" />
                        </button>
                      </Tooltip>

                      {/* Friend Action Dropdown Menu */}
                      <div className="relative">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setOpenFriendMenuId(
                              openFriendMenuId === friend.id ? null : friend.id
                            );
                          }}
                          className="p-1.5 rounded-md hover:bg-nexus-surface text-nexus-muted hover:text-nexus-text transition-nexus"
                          title="Mais Opções"
                        >
                          <MoreVertical className="w-3.5 h-3.5" />
                        </button>

                        {openFriendMenuId === friend.id && (
                          <div
                            className="absolute right-0 top-full mt-1 w-40 rounded-lg bg-nexus-surface border border-nexus-border shadow-xl py-1 z-30 animate-in fade-in zoom-in-95 duration-100"
                            onMouseLeave={() => setOpenFriendMenuId(null)}
                          >
                            <button
                              onClick={() => {
                                setActiveDm(friend.id);
                                setActiveTab('messages');
                                setOpenFriendMenuId(null);
                              }}
                              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-nexus-text hover:bg-nexus-panel transition-nexus text-left"
                            >
                              <MessageSquare className="w-3.5 h-3.5 text-nexus-muted" />
                              <span>Conversar</span>
                            </button>
                            <button
                              onClick={async () => {
                                setOpenFriendMenuId(null);
                                await removeFriend(friend.id);
                              }}
                              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-rose-400 hover:bg-rose-500/10 transition-nexus text-left"
                            >
                              <UserMinus className="w-3.5 h-3.5" />
                              <span>Remover Amigo</span>
                            </button>
                            <button
                              onClick={async () => {
                                setOpenFriendMenuId(null);
                                await blockUser(friend.id);
                              }}
                              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-rose-400 hover:bg-rose-500/10 transition-nexus text-left"
                            >
                              <Ban className="w-3.5 h-3.5" />
                              <span>Bloquear</span>
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Add Friend & Requests Modal */}
      <AddFriendModal />
    </div>
  );
};
