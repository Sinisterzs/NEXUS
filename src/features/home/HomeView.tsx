import React, { useState, useEffect, useRef } from 'react';
import {
  Gamepad2,
  Users,
  MessageSquare,
  Radio,
  Hash,
  Search,
  UserPlus,
  MoreVertical,
  UserMinus,
  Ban,
  Phone,
  X,
  Plus,
  ArrowRight,
} from 'lucide-react';
import { useAppStore } from '../../stores/useAppStore';
import { UserStatus } from '../../lib/types';
import { callService } from '../../services/CallService';
import { mockCommunities, mockDirectMessages } from '../../mocks';
import { Avatar, CurrentUserAvatar, sanitizeAvatarUrl } from '../../components/Avatar';
import { Badge } from '../../components/Badge';
import { Tooltip } from '../../components/Tooltip';
import { AddFriendModal } from '../friends/AddFriendModal';

function maskPublicStatus(status?: UserStatus): Exclude<UserStatus, 'invisible'> {
  if (!status || status === 'invisible') {
    return 'offline';
  }
  return status;
}

function getStatusDotClass(status?: UserStatus): string {
  switch (status) {
    case 'online':
      return 'bg-emerald-500';
    case 'idle':
      return 'bg-amber-500';
    case 'dnd':
      return 'bg-rose-500';
    default:
      return 'bg-slate-500';
  }
}

export const HomeView: React.FC = () => {
  const setActiveTab = useAppStore((state) => state.setActiveTab);
  const setActiveCommunity = useAppStore((state) => state.setActiveCommunity);
  const setActiveChannel = useAppStore((state) => state.setActiveChannel);
  const setActiveDm = useAppStore((state) => state.setActiveDm);
  const joinCall = useAppStore((state) => state.joinCall);
  const currentUser = useAppStore((state) => state.currentUser);
  const onlineUser = useAppStore((state) => state.onlineUser);
  const authStatus = useAppStore((state) => state.authStatus);
  const friends = useAppStore((state) => state.friends);
  const friendRequests = useAppStore((state) => state.friendRequests);
  const conversations = useAppStore((state) => state.conversations);
  const communities = useAppStore((state) => state.communities);
  const loadConversations = useAppStore((state) => state.loadConversations);
  const loadCommunities = useAppStore((state) => state.loadCommunities);
  const selectCommunity = useAppStore((state) => state.selectCommunity);
  const loadFriends = useAppStore((state) => state.loadFriends);
  const loadFriendRequests = useAppStore((state) => state.loadFriendRequests);
  const startConversationWithUser = useAppStore((state) => state.startConversationWithUser);
  const selectConversation = useAppStore((state) => state.selectConversation);
  const openAddFriendModal = useAppStore((state) => state.openAddFriendModal);
  const removeFriend = useAppStore((state) => state.removeFriend);
  const blockUser = useAppStore((state) => state.blockUser);

  const [friendFilter, setFriendFilter] = useState<'all' | 'online' | 'gaming'>('all');
  const [friendSearch, setFriendSearch] = useState('');
  const [openFriendMenuId, setOpenFriendMenuId] = useState<string | null>(null);
  const openFriendMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!openFriendMenuId) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpenFriendMenuId(null);
      }
    };

    const handleMouseDown = (e: MouseEvent) => {
      if (
        openFriendMenuRef.current &&
        !openFriendMenuRef.current.contains(e.target as Node)
      ) {
        setOpenFriendMenuId(null);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    document.addEventListener('mousedown', handleMouseDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('mousedown', handleMouseDown);
    };
  }, [openFriendMenuId]);

  const isAuthenticated = authStatus === 'authenticated';
  const incomingRequestsCount = friendRequests.incoming.length;

  // Carrega lista de amigos, solicitações, conversas e comunidades ao montar ou autenticar
  useEffect(() => {
    if (isAuthenticated) {
      loadFriends();
      loadFriendRequests();
      loadConversations();
      void loadCommunities();
    }
  }, [isAuthenticated, loadFriends, loadFriendRequests, loadConversations, loadCommunities]);

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

  const totalUnreadConversations = conversations.reduce(
    (acc, c) => acc + (c.unread_count || 0),
    0
  );

  const displayName = currentUser?.displayName || onlineUser?.displayName || 'Kel';
  const username = currentUser?.username || onlineUser?.username || 'kelzyx';
  const userStatus: UserStatus = currentUser?.status || 'online';

  return (
    <div className="flex-1 overflow-y-auto p-5 lg:p-6 space-y-5 select-none bg-nexus-bg text-zinc-100">
      {/* 1. Top Welcome Banner com Arco Celestial e Ações */}
      <section className="relative overflow-hidden rounded-2xl bg-[#0C0E15]/95 border border-white/[0.07] px-6 py-5 shadow-2xl">
        {/* Arco Celestial com glow dinâmico de acordo com o tema */}
        <div className="absolute inset-0 pointer-events-none overflow-hidden select-none">
          {/* Ambient soft glow */}
          <div className="absolute -top-10 right-1/4 w-96 h-48 bg-nexus-accent/[0.09] rounded-full blur-3xl" />
          {/* SVG do horizonte celestial curvo */}
          <svg
            className="absolute inset-0 w-full h-full"
            viewBox="0 0 1000 120"
            preserveAspectRatio="none"
            fill="none"
          >
            <defs>
              <linearGradient id="celestialArcGrad" x1="0" y1="1" x2="1" y2="0">
                <stop offset="0%" stopColor="var(--nexus-accent)" stopOpacity="0" />
                <stop offset="30%" stopColor="var(--nexus-accent)" stopOpacity="0.25" />
                <stop offset="50%" stopColor="var(--nexus-accent)" stopOpacity="0.8" />
                <stop offset="70%" stopColor="var(--nexus-accent-hover)" stopOpacity="0.95" />
                <stop offset="90%" stopColor="var(--nexus-accent)" stopOpacity="0.3" />
                <stop offset="100%" stopColor="var(--nexus-accent)" stopOpacity="0" />
              </linearGradient>
              <filter id="arcGlow" x="-20%" y="-50%" width="140%" height="200%">
                <feGaussianBlur in="SourceGraphic" stdDeviation="5" />
              </filter>
            </defs>
            {/* Glow difuso */}
            <path
              d="M 450 130 C 580 80, 720 20, 950 -10"
              stroke="url(#celestialArcGrad)"
              strokeWidth="9"
              filter="url(#arcGlow)"
              opacity="0.5"
            />
            {/* Borda nítida e brilhante */}
            <path
              d="M 450 130 C 580 80, 720 20, 950 -10"
              stroke="url(#celestialArcGrad)"
              strokeWidth="2.2"
              opacity="0.95"
            />
          </svg>
        </div>

        <div className="relative flex flex-col md:flex-row md:items-center justify-between gap-5 z-10">
          {/* Lado Esquerdo: Identidade do Usuário com Squircle maior */}
          <div className="flex items-center gap-4 min-w-0">
            <div className="relative shrink-0">
              <CurrentUserAvatar
                size="2xl"
                shapeClassName="rounded-2xl"
                showStatus={false}
                className="shadow-[0_0_16px_var(--nexus-accent-dim)]"
              />
              <span
                className={`absolute bottom-0 right-0 w-3.5 h-3.5 rounded-full ${getStatusDotClass(
                  userStatus
                )} ring-2 ring-[#0C0E15] shadow-sm`}
                title={userStatus}
              />
            </div>

            <div className="min-w-0">
              <h1 className="text-2xl font-bold text-white tracking-tight truncate">
                Olá, {displayName}
              </h1>
              <p className="text-[12px] text-zinc-400 font-mono mt-0.5">
                @{username}
              </p>
            </div>
          </div>

          {/* Lado Direito: Ações Rápidas em Pill Buttons */}
          <div className="flex items-center gap-3 shrink-0 flex-wrap">
            <button
              type="button"
              onClick={() => setActiveTab('messages')}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-white/[0.04] hover:bg-white/[0.08] text-zinc-200 hover:text-white text-xs font-medium border border-white/[0.08] hover:border-white/[0.15] transition-all cursor-pointer shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nexus-accent/70"
            >
              <MessageSquare className="w-4 h-4 text-zinc-300" />
              <span>Mensagens</span>
              {totalUnreadConversations > 0 && (
                <span className="w-4 h-4 bg-nexus-accent text-white rounded-full text-[10px] font-bold flex items-center justify-center">
                  {totalUnreadConversations}
                </span>
              )}
            </button>

            <button
              type="button"
              onClick={() => setActiveTab('communities')}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-white/[0.04] hover:bg-white/[0.08] text-zinc-200 hover:text-white text-xs font-medium border border-white/[0.08] hover:border-white/[0.15] transition-all cursor-pointer shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nexus-accent/70"
            >
              <Users className="w-4 h-4 text-zinc-300" />
              <span>Comunidades</span>
            </button>

            <button
              type="button"
              onClick={() => {
                joinCall('Rustaceans Hub • Sala de Voz 01');
                setActiveTab('calls');
              }}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-nexus-accent/20 hover:bg-nexus-accent/30 text-white text-xs font-medium border border-nexus-accent/45 hover:border-nexus-accent/65 transition-all cursor-pointer shadow-sm shadow-nexus-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nexus-accent/70"
            >
              {/* Waveform icon fiel à referência */}
              <svg
                className="w-4 h-4 text-nexus-accent"
                viewBox="0 0 20 20"
                fill="currentColor"
              >
                <rect x="2" y="7" width="2" height="6" rx="1" />
                <rect x="6" y="4" width="2" height="12" rx="1" />
                <rect x="10" y="2" width="2" height="16" rx="1" />
                <rect x="14" y="5" width="2" height="10" rx="1" />
                <rect x="18" y="8" width="2" height="4" rx="1" />
              </svg>
              <span>Entrar em Voz</span>
            </button>
          </div>
        </div>
      </section>

      {/* 2. Grid Principal: Conversas Recentes & Comunidades (Esq) vs Amigos (Dir) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        {/* Coluna Esquerda: Conversas Recentes & Comunidades (7 colunas ~ 60%) */}
        <div className="lg:col-span-7 space-y-5">
          {/* Card: Conversas Recentes */}
          <section className="bg-[#0C0E15]/95 border border-white/[0.07] rounded-2xl p-5 shadow-xl flex flex-col">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <MessageSquare className="w-4 h-4 text-nexus-accent" />
                <h2 className="text-[15px] font-bold text-white tracking-tight">
                  Conversas Recentes
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setActiveTab('messages')}
                className="text-[12px] text-nexus-accent hover:text-nexus-accent-hover font-medium transition-colors flex items-center gap-1 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nexus-accent/70 rounded-md px-1"
              >
                <span>Ver todas</span>
                <span>&rarr;</span>
              </button>
            </div>

            <div>
              {isAuthenticated ? (
                conversations.length === 0 ? (
                  <div className="text-center py-8 px-4 rounded-xl bg-[#121520] border border-white/[0.06] text-zinc-400 space-y-2 mt-1">
                    <MessageSquare className="w-6 h-6 mx-auto text-zinc-500 opacity-60" />
                    <p className="text-[13.5px] font-semibold text-zinc-200">Nenhuma conversa recente</p>
                    <p className="text-[12px] text-zinc-400 max-w-xs mx-auto">
                      Suas mensagens diretas e canais ativos aparecerão aqui.
                    </p>
                  </div>
                ) : (
                  conversations.slice(0, 4).map((conv) => {
                    const other = conv.other_user;
                    const lastMsgContent = conv.last_message?.content || 'Nenhuma mensagem recente';
                    const timeStr = conv.last_message?.created_at
                      ? new Date(conv.last_message.created_at).toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                        })
                      : '';

                    return (
                      <div
                        key={conv.id}
                        onClick={async () => {
                          await selectConversation(conv.id);
                          setActiveTab('messages');
                        }}
                        className="flex items-center justify-between py-2.5 border-b border-white/[0.03] last:border-b-0 hover:bg-[#121520]/80 px-2.5 rounded-xl transition-colors cursor-pointer group"
                      >
                        <div className="flex items-center gap-3.5 min-w-0">
                          <Avatar
                            name={other.name}
                            avatarUrl={other.avatarUrl}
                            status={maskPublicStatus(other.status)}
                            size="md"
                            shapeClassName="rounded-full"
                            showStatus={false}
                          />
                          <div className="min-w-0">
                            <div className="flex items-center">
                              <span className="text-[13.5px] font-semibold text-white group-hover:text-white truncate">
                                {other.name}
                              </span>
                              <span className="text-[12px] text-zinc-400 font-mono ml-2">
                                @{other.username || other.tag}
                              </span>
                            </div>
                            <p className="text-[12px] text-zinc-400 group-hover:text-zinc-300 truncate max-w-md mt-0.5">
                              {lastMsgContent}
                            </p>
                          </div>
                        </div>

                        <div className="flex items-center gap-3 shrink-0 ml-2">
                          {timeStr ? (
                            <span className="text-[12px] text-zinc-500 font-mono">
                              {timeStr}
                            </span>
                          ) : null}
                          {conv.unread_count > 0 ? (
                            <Badge count={conv.unread_count} />
                          ) : null}
                        </div>
                      </div>
                    );
                  })
                )
              ) : mockDirectMessages.length === 0 ? (
                <div className="text-center py-8 px-4 rounded-xl bg-[#121520] border border-white/[0.06] text-zinc-400 space-y-2 mt-1">
                  <MessageSquare className="w-6 h-6 mx-auto text-zinc-500 opacity-60" />
                  <p className="text-[13.5px] font-semibold text-zinc-200">Nenhuma conversa recente</p>
                  <p className="text-[12px] text-zinc-400">Inicie uma conversa direta pela lista de amigos.</p>
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
                      className="flex items-center justify-between py-2.5 border-b border-white/[0.03] last:border-b-0 hover:bg-[#121520]/80 px-2.5 rounded-xl transition-colors cursor-pointer group"
                    >
                      <div className="flex items-center gap-3.5 min-w-0">
                        <Avatar
                          name={friend.name}
                          avatarUrl={friend.avatarUrl}
                          status={maskPublicStatus(friend.status)}
                          size="md"
                          shapeClassName="rounded-full"
                          showStatus={false}
                        />
                        <div className="min-w-0">
                          <div className="flex items-center">
                            <span className="text-[13.5px] font-semibold text-white group-hover:text-white truncate">
                              {friend.name}
                            </span>
                            <span className="text-[12px] text-zinc-400 font-mono ml-2">
                              {friend.tag}
                            </span>
                          </div>
                          <p className="text-[12px] text-zinc-400 group-hover:text-zinc-300 truncate max-w-md mt-0.5">
                            {dm.lastMessage}
                          </p>
                        </div>
                      </div>

                      <div className="flex items-center gap-3 shrink-0 ml-2">
                        <span className="text-[12px] text-zinc-500 font-mono">
                          {dm.timestamp}
                        </span>
                        {dm.unreadCount > 0 ? (
                          <Badge count={dm.unreadCount} />
                        ) : null}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </section>

          {/* Card: Suas Comunidades com Dados Reais (Autenticado) ou Demo (Offline) */}
          <section className="bg-[#0C0E15]/95 border border-white/[0.07] rounded-2xl p-5 shadow-xl flex flex-col">
            <div className="flex items-center justify-between mb-3.5">
              <div className="flex items-center gap-2">
                <Users className="w-4 h-4 text-nexus-accent" />
                <h2 className="text-[15px] font-bold text-white tracking-tight">
                  Suas Comunidades
                </h2>
              </div>
              {(() => {
                const count = isAuthenticated ? communities.length : mockCommunities.length;
                return (
                  <span className="text-[12px] text-zinc-400 font-mono">
                    {count} {count === 1 ? 'ativa' : 'ativas'}
                  </span>
                );
              })()}
            </div>

            {isAuthenticated ? (
              communities.length === 0 ? (
                <div className="rounded-xl bg-[#121520] border border-white/[0.06] py-9 px-6 flex flex-col items-center justify-center text-center">
                  <div className="w-12 h-12 rounded-xl bg-white/[0.03] border border-white/[0.07] flex items-center justify-center text-zinc-400 mb-3 shadow-inner">
                    <Users className="w-5 h-5 text-nexus-accent/80" />
                  </div>
                  <h3 className="text-[15px] font-bold text-zinc-100">
                    Nenhuma comunidade ainda
                  </h3>
                  <p className="text-[12px] text-zinc-400 mt-1 max-w-xs">
                    Você ainda não participa de nenhuma comunidade no NEXUS.
                  </p>
                  <button
                    type="button"
                    onClick={() => setActiveTab('communities')}
                    className="mt-4 inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-nexus-accent/20 hover:bg-nexus-accent/30 text-white text-xs font-medium border border-nexus-accent/45 hover:border-nexus-accent/65 transition-all cursor-pointer shadow-sm shadow-nexus-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nexus-accent/70"
                  >
                    <Plus className="w-3.5 h-3.5 text-nexus-accent" />
                    <span>Explorar ou Criar Comunidade</span>
                  </button>
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                  {communities.map((comm) => {
                    const safeIconUrl = sanitizeAvatarUrl(comm.icon_url);
                    return (
                      <button
                        key={comm.id}
                        type="button"
                        onClick={() => {
                          void selectCommunity(comm.id);
                          setActiveTab('communities');
                        }}
                        className="bg-[#121520]/85 border border-white/[0.07] hover:border-nexus-accent/45 hover:bg-[#171B28] rounded-xl p-3.5 transition-all flex flex-col justify-between text-left group shadow-sm cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nexus-accent/70"
                      >
                        <div className="flex items-start justify-between gap-3 w-full">
                          <div className="flex items-center gap-3 min-w-0">
                            {safeIconUrl ? (
                              <img
                                src={safeIconUrl}
                                alt={comm.name}
                                className="w-10 h-10 rounded-xl object-cover shrink-0 shadow-md ring-1 ring-white/10"
                              />
                            ) : (
                              <div
                                className="w-10 h-10 rounded-xl flex items-center justify-center font-bold text-sm text-white shrink-0 shadow-md ring-1 ring-white/10"
                                style={{ backgroundColor: comm.icon_bg || '#4f46e5' }}
                              >
                                {comm.initials}
                              </div>
                            )}
                            <div className="min-w-0 flex-1">
                              <h4 className="text-[13.5px] font-bold text-zinc-100 group-hover:text-white truncate">
                                {comm.name}
                              </h4>
                              <p className="text-[12px] text-zinc-400 font-mono mt-0.5">
                                {comm.member_count} {comm.member_count === 1 ? 'membro' : 'membros'}
                              </p>
                            </div>
                          </div>

                          {comm.unread_count > 0 ? <Badge count={comm.unread_count} /> : null}
                        </div>

                        <div className="w-full flex items-center justify-between gap-2 pt-2.5 mt-2.5 border-t border-white/[0.04] text-[12px] text-zinc-400">
                          <span className="truncate">
                            {comm.description?.trim() || 'Abrir comunidade'}
                          </span>
                          <ArrowRight className="w-3.5 h-3.5 text-zinc-500 group-hover:text-nexus-accent transition-colors shrink-0" />
                        </div>
                      </button>
                    );
                  })}
                </div>
              )
            ) : mockCommunities.length === 0 ? (
              /* Estado Vazio Minimalista e Elegante (Demo Offline) */
              <div className="rounded-xl bg-[#121520] border border-white/[0.06] py-9 px-6 flex flex-col items-center justify-center text-center">
                <div className="w-12 h-12 rounded-xl bg-white/[0.03] border border-white/[0.07] flex items-center justify-center text-zinc-400 mb-3 shadow-inner">
                  <Users className="w-5 h-5 text-zinc-400" />
                </div>
                <h3 className="text-[15px] font-bold text-zinc-100">
                  Nenhuma comunidade
                </h3>
                <p className="text-[12px] text-zinc-400 mt-1 max-w-xs">
                  Você não participa de nenhuma comunidade no momento.
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                {mockCommunities.map((comm) => (
                  <div
                    key={comm.id}
                    className="bg-[#121520]/85 border border-white/[0.07] hover:border-white/[0.12] rounded-xl p-3.5 transition-all flex flex-col justify-between group shadow-sm"
                  >
                    <div className="flex items-start justify-between gap-3 mb-2.5">
                      <div className="flex items-center gap-3 min-w-0">
                        <div
                          className="w-10 h-10 rounded-xl flex items-center justify-center font-bold text-sm text-white shrink-0 shadow-md ring-1 ring-white/10"
                          style={{ backgroundColor: comm.iconBg }}
                        >
                          {comm.initials}
                        </div>
                        <div className="min-w-0 flex-1">
                          <h4 className="text-[13.5px] font-bold text-zinc-100 group-hover:text-white truncate">
                            {comm.name}
                          </h4>
                          <p className="text-[12px] text-zinc-400 font-mono mt-0.5">
                            {comm.channels.length} canais
                          </p>
                        </div>
                      </div>

                      {comm.unreadCount && comm.unreadCount > 0 ? (
                        <Badge count={comm.unreadCount} />
                      ) : null}
                    </div>

                    {/* Atalhos para Canais Rápidos */}
                    <div className="space-y-1 pt-2 border-t border-white/[0.04]">
                      {comm.channels.slice(0, 2).map((ch) => (
                        <button
                          key={ch.id}
                          type="button"
                          onClick={() => {
                            setActiveCommunity(comm.id);
                            setActiveChannel(ch.id);
                            setActiveTab('communities');
                          }}
                          className="w-full flex items-center justify-between px-2.5 py-1 rounded-lg text-[12px] text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.04] transition-colors text-left cursor-pointer"
                        >
                          <span className="flex items-center gap-1.5 truncate">
                            {ch.type === 'text' ? (
                              <Hash className="w-3 h-3 text-zinc-500 shrink-0" />
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
          </section>
        </div>

        {/* Coluna Direita: Lista de Amigos Refinada (5 colunas ~ 40%) */}
        <div className="lg:col-span-5">
          <section className="bg-[#0C0E15]/95 border border-white/[0.07] rounded-2xl p-5 shadow-xl flex flex-col h-full">
            {/* Cabeçalho de Amigos */}
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <Gamepad2 className="w-4 h-4 text-emerald-400" />
                <h2 className="text-[15px] font-bold text-white tracking-tight">
                  Amigos ({friends.length})
                </h2>
              </div>

              {/* Botão + Adicionar em Pill com acento suave do tema */}
              <button
                type="button"
                onClick={openAddFriendModal}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-nexus-accent/20 hover:bg-nexus-accent/30 text-white text-xs font-medium border border-nexus-accent/45 hover:border-nexus-accent/65 transition-all cursor-pointer shadow-sm shadow-nexus-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nexus-accent/70"
              >
                <UserPlus className="w-3.5 h-3.5 text-nexus-accent" />
                <span>Adicionar</span>
                {incomingRequestsCount > 0 && (
                  <span className="w-4 h-4 bg-nexus-accent text-white rounded-full text-[10px] font-bold flex items-center justify-center ml-1">
                    {incomingRequestsCount}
                  </span>
                )}
              </button>
            </div>

            {/* Segmented Control de Filtro */}
            <div className="flex items-center gap-1 p-1 rounded-xl bg-[#121520] border border-white/[0.07] mt-3">
              <button
                type="button"
                onClick={() => setFriendFilter('all')}
                className={`px-3.5 py-1.5 rounded-lg text-xs transition-all cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nexus-accent/70 ${
                  friendFilter === 'all'
                    ? 'bg-nexus-accent/25 border border-nexus-accent/50 text-white font-medium shadow-sm shadow-nexus-accent/15'
                    : 'text-zinc-400 hover:text-zinc-200 border border-transparent'
                }`}
              >
                Todos
              </button>
              <button
                type="button"
                onClick={() => setFriendFilter('online')}
                className={`px-3.5 py-1.5 rounded-lg text-xs transition-all cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nexus-accent/70 ${
                  friendFilter === 'online'
                    ? 'bg-nexus-accent/25 border border-nexus-accent/50 text-white font-medium shadow-sm shadow-nexus-accent/15'
                    : 'text-zinc-400 hover:text-zinc-200 border border-transparent'
                }`}
              >
                Online
              </button>
              <button
                type="button"
                onClick={() => setFriendFilter('gaming')}
                className={`px-3.5 py-1.5 rounded-lg text-xs transition-all cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nexus-accent/70 ${
                  friendFilter === 'gaming'
                    ? 'bg-nexus-accent/25 border border-nexus-accent/50 text-white font-medium shadow-sm shadow-nexus-accent/15'
                    : 'text-zinc-400 hover:text-zinc-200 border border-transparent'
                }`}
              >
                Em Jogo
              </button>
            </div>

            {/* Barra de Busca de Amigos em Pill */}
            <div className="relative flex items-center mt-3 mb-2">
              <Search className="w-3.5 h-3.5 absolute left-3 text-zinc-500 pointer-events-none" />
              <input
                type="text"
                value={friendSearch}
                onChange={(e) => setFriendSearch(e.target.value)}
                placeholder="Buscar amigo por nome ou tag..."
                className="w-full bg-[#121520] border border-white/[0.07] focus:border-nexus-accent/60 rounded-xl pl-9 pr-8 py-2 text-xs text-zinc-200 placeholder-zinc-500 focus:outline-none transition-colors"
              />
              {friendSearch && (
                <button
                  type="button"
                  onClick={() => setFriendSearch('')}
                  aria-label="Limpar busca de amigos"
                  title="Limpar busca"
                  className="absolute right-2.5 text-zinc-500 hover:text-zinc-300 p-0.5 rounded cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            {/* Lista de Amigos com Divisores Finos e Ações */}
            <div className="overflow-y-auto max-h-[520px]">
              {filteredFriends.length === 0 ? (
                <div className="text-center py-10 px-4 space-y-3">
                  <div className="w-12 h-12 rounded-2xl bg-[#121520] border border-white/[0.07] flex items-center justify-center mx-auto text-zinc-500">
                    <Users className="w-5 h-5 text-nexus-accent/80" />
                  </div>
                  <div className="space-y-1">
                    <h4 className="text-[13.5px] font-semibold text-zinc-200">
                      {friendSearch ? 'Nenhum amigo encontrado' : 'Nenhum amigo nesta lista'}
                    </h4>
                    <p className="text-[12px] text-zinc-400 max-w-xs mx-auto">
                      {friendSearch
                        ? 'Tente outro termo ou limpe a busca.'
                        : 'Adicione amigos no NEXUS para chamadas de voz e mensagens diretas.'}
                    </p>
                  </div>
                </div>
              ) : (
                filteredFriends.map((friend) => {
                  const publicStatus = maskPublicStatus(friend.status);
                  const friendStatusText =
                    friend.activity ||
                    friend.customStatus ||
                    (publicStatus === 'offline' ? 'Offline' : 'Disponível');

                  return (
                  <div
                    key={friend.id}
                    className="flex items-center justify-between py-2.5 border-b border-white/[0.03] last:border-b-0 hover:bg-[#121520]/80 px-2.5 rounded-xl transition-colors group"
                  >
                    <div
                      onClick={() => {
                        if (isAuthenticated) {
                          startConversationWithUser(friend.id, friend.username).then((convId) => {
                            if (convId) {
                              selectConversation(convId);
                            }
                            setActiveTab('messages');
                          });
                        } else {
                          setActiveDm(friend.id);
                          setActiveTab('messages');
                        }
                      }}
                      className="flex items-center gap-3 min-w-0 cursor-pointer flex-1"
                    >
                      <Avatar
                        name={friend.name}
                        avatarUrl={
                          friend.avatarUrl ||
                          (friend.username?.toLowerCase() === currentUser.username?.toLowerCase() ||
                           friend.name?.toLowerCase() === currentUser.username?.toLowerCase() ||
                           friend.name === currentUser.displayName
                            ? currentUser.avatarUrl
                            : undefined)
                        }
                        status={publicStatus}
                        size="md"
                        shapeClassName="rounded-full"
                        showStatus={false}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center">
                          <span className="text-[13.5px] font-semibold text-white group-hover:text-white truncate">
                            {friend.name}
                          </span>
                          <span className="text-[12px] text-zinc-400 font-mono ml-2">
                            @{friend.username || friend.tag.replace('#', '')}
                          </span>
                        </div>
                        <div className="flex items-center gap-1.5 mt-0.5">
                          <span
                            className={`w-1.5 h-1.5 rounded-full shrink-0 ${getStatusDotClass(
                              publicStatus
                            )}`}
                          />
                          <span className="text-[12px] text-zinc-400 font-normal truncate">
                            {friendStatusText}
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* Botões de Ação de Amigos (Telefone verde, Mensagem, Mais) */}
                    <div className="flex items-center gap-1 shrink-0 ml-2">
                      <Tooltip content="Iniciar Chamada" position="left">
                        <button
                          type="button"
                          onClick={() => {
                            callService.startCall({
                              id: friend.id,
                              name: friend.name,
                              username: friend.username || friend.name,
                            });
                          }}
                          className="p-2 text-emerald-400 hover:text-emerald-300 hover:bg-emerald-500/10 rounded-lg transition-colors cursor-pointer"
                          title={`Ligar para ${friend.name}`}
                          aria-label={`Ligar para ${friend.name}`}
                        >
                          <Phone className="w-4 h-4" />
                        </button>
                      </Tooltip>

                      <Tooltip content="Enviar Mensagem" position="left">
                        <button
                          type="button"
                          onClick={async () => {
                            if (isAuthenticated) {
                              await startConversationWithUser(friend.id, friend.username);
                              setActiveTab('messages');
                            } else {
                              setActiveDm(friend.id);
                              setActiveTab('messages');
                            }
                          }}
                          className="p-2 text-zinc-400 hover:text-white hover:bg-white/5 rounded-lg transition-colors cursor-pointer"
                          title="Enviar Mensagem"
                          aria-label={`Enviar mensagem para ${friend.name}`}
                        >
                          <MessageSquare className="w-4 h-4" />
                        </button>
                      </Tooltip>

                      {/* Menu de Mais Opções */}
                      <div
                        className="relative"
                        ref={openFriendMenuId === friend.id ? openFriendMenuRef : undefined}
                      >
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setOpenFriendMenuId(
                              openFriendMenuId === friend.id ? null : friend.id
                            );
                          }}
                          className="p-2 text-zinc-500 hover:text-zinc-300 hover:bg-white/5 rounded-lg transition-colors cursor-pointer"
                          title="Mais Opções"
                          aria-label={`Mais opções para ${friend.name}`}
                          aria-expanded={openFriendMenuId === friend.id}
                          aria-haspopup="menu"
                        >
                          <MoreVertical className="w-4 h-4" />
                        </button>

                        {openFriendMenuId === friend.id && (
                          <div
                            role="menu"
                            aria-label={`Ações para ${friend.name}`}
                            className="absolute right-0 top-full mt-1.5 w-44 rounded-xl bg-[#12141C] border border-white/[0.08] shadow-2xl py-1 z-40 animate-fadeIn"
                            onMouseLeave={() => setOpenFriendMenuId(null)}
                          >
                            <button
                              type="button"
                              role="menuitem"
                              onClick={async () => {
                                setOpenFriendMenuId(null);
                                if (isAuthenticated) {
                                  await startConversationWithUser(friend.id, friend.username);
                                  setActiveTab('messages');
                                } else {
                                  setActiveDm(friend.id);
                                  setActiveTab('messages');
                                }
                              }}
                              className="w-full flex items-center gap-2.5 px-3 py-1.5 text-xs text-zinc-300 hover:text-white hover:bg-zinc-800/70 transition-colors text-left cursor-pointer"
                            >
                              <MessageSquare className="w-3.5 h-3.5 text-zinc-400" />
                              <span>Conversar</span>
                            </button>
                            <button
                              type="button"
                              role="menuitem"
                              onClick={async () => {
                                setOpenFriendMenuId(null);
                                await removeFriend(friend.id);
                              }}
                              className="w-full flex items-center gap-2.5 px-3 py-1.5 text-xs text-rose-400 hover:text-rose-300 hover:bg-rose-500/10 transition-colors text-left cursor-pointer"
                            >
                              <UserMinus className="w-3.5 h-3.5 text-rose-400" />
                              <span>Remover Amigo</span>
                            </button>
                            <button
                              type="button"
                              role="menuitem"
                              onClick={async () => {
                                setOpenFriendMenuId(null);
                                await blockUser(friend.id);
                              }}
                              className="w-full flex items-center gap-2.5 px-3 py-1.5 text-xs text-rose-400 hover:text-rose-300 hover:bg-rose-500/10 transition-colors text-left cursor-pointer"
                            >
                              <Ban className="w-3.5 h-3.5 text-rose-400" />
                              <span>Bloquear</span>
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                  );
                })
              )}
            </div>
          </section>
        </div>
      </div>

      {/* Modal de Adicionar Amigo */}
      <AddFriendModal />
    </div>
  );
};
