import React, { useState, useEffect } from 'react';
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
  Compass,
  PlusCircle,
  X,
  Check,
} from 'lucide-react';
import { useAppStore } from '../../stores/useAppStore';
import { callService } from '../../services/CallService';
import { mockCommunities, mockDirectMessages } from '../../mocks';
import { Avatar, CurrentUserAvatar } from '../../components/Avatar';
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
  const conversations = useAppStore((state) => state.conversations);
  const loadConversations = useAppStore((state) => state.loadConversations);
  const loadFriends = useAppStore((state) => state.loadFriends);
  const loadFriendRequests = useAppStore((state) => state.loadFriendRequests);
  const startConversationWithUser = useAppStore((state) => state.startConversationWithUser);
  const selectConversation = useAppStore((state) => state.selectConversation);
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

  // Carrega lista de amigos, solicitações e conversas ao montar ou autenticar
  useEffect(() => {
    if (isAuthenticated) {
      loadFriends();
      loadFriendRequests();
      loadConversations();
    }
  }, [isAuthenticated, loadFriends, loadFriendRequests, loadConversations]);

  const onlineFriendsCount = friends.filter(
    (f) => f.status === 'online' || f.status === 'idle' || f.status === 'dnd'
  ).length;

  const gamingFriendsCount = friends.filter((f) => f.activity?.startsWith('Em jogo')).length;

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
    { value: 'online', label: 'Disponível', color: 'bg-emerald-500', desc: 'Disponível no NEXUS' },
    { value: 'idle', label: 'Ausente', color: 'bg-amber-500', desc: 'Temporariamente ausente' },
    { value: 'dnd', label: 'Não Perturbe', color: 'bg-rose-500', desc: 'Notificações silenciadas' },
    { value: 'invisible', label: 'Invisível', color: 'bg-zinc-400', desc: 'Aparece offline aos amigos' },
  ];

  const currentStatusOption =
    statusOptions.find((o) => o.value === currentUser.status) || statusOptions[0];

  const totalUnreadConversations = conversations.reduce(
    (acc, c) => acc + (c.unread_count || 0),
    0
  );

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6 select-none bg-[#0b0d12] text-zinc-100">
      {/* 1. Top Welcome Banner - Redesenhado Premium */}
      <section className="relative overflow-hidden rounded-2xl bg-[#12151c]/90 border border-zinc-800/80 p-5 shadow-xl">
        {/* Fundo com sutil iluminação carmesim no topo */}
        <div className="absolute top-0 left-0 right-0 h-[1px] bg-gradient-to-r from-transparent via-rose-500/40 to-transparent" />
        <div className="absolute -top-16 -left-16 w-48 h-48 bg-rose-500/[0.04] rounded-full blur-2xl pointer-events-none" />

        <div className="relative flex flex-col md:flex-row md:items-center justify-between gap-5">
          {/* Lado Esquerdo: Identidade do Usuário */}
          <div className="flex items-center gap-4 min-w-0">
            <div className="relative shrink-0">
              <CurrentUserAvatar
                size="lg"
                className="ring-2 ring-zinc-700/70 shadow-md"
              />
              <span
                className={`absolute bottom-0.5 right-0.5 w-3.5 h-3.5 rounded-full border-2 border-[#12151c] ${currentStatusOption.color} shadow-sm`}
                title={currentStatusOption.label}
              />
            </div>

            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2.5 flex-wrap">
                <h1 className="text-base sm:text-lg font-bold text-zinc-100 tracking-tight truncate">
                  Olá, {currentUser.displayName}
                </h1>
                {isAuthenticated ? (
                  <span className="text-[11px] font-mono text-zinc-400 bg-zinc-900/80 border border-zinc-800/70 px-2 py-0.5 rounded-md">
                    @{currentUser.username}
                  </span>
                ) : (
                  currentUser.tag && (
                    <span className="text-[11px] font-mono text-zinc-400 bg-zinc-900/80 border border-zinc-800/70 px-2 py-0.5 rounded-md">
                      {currentUser.tag}
                    </span>
                  )
                )}
              </div>

              {/* Seletor Rápido de Status */}
              <div className="flex items-center gap-2.5 mt-1.5 flex-wrap">
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setIsStatusMenuOpen(!isStatusMenuOpen)}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-zinc-900/90 hover:bg-zinc-800 text-xs font-medium text-zinc-300 border border-zinc-800 hover:border-zinc-700 transition-colors cursor-pointer"
                  >
                    <span className={`w-2 h-2 rounded-full ${currentStatusOption.color} shrink-0`} />
                    <span className="text-zinc-200">{currentStatusOption.label}</span>
                    <ChevronDown className="w-3 h-3 text-zinc-500" />
                  </button>

                  {isStatusMenuOpen && (
                    <div
                      className="absolute left-0 mt-1.5 w-52 rounded-xl bg-[#141720] border border-zinc-800 shadow-2xl py-1.5 z-40 animate-fadeIn"
                      onMouseLeave={() => setIsStatusMenuOpen(false)}
                    >
                      <div className="px-3 py-1 text-[10px] font-mono uppercase tracking-wider text-zinc-500">
                        Alterar Presença
                      </div>
                      {statusOptions.map((opt) => {
                        const isCurrent = currentUser.status === opt.value;
                        return (
                          <button
                            key={opt.value}
                            type="button"
                            onClick={() => {
                              setUserStatus(opt.value);
                              setIsStatusMenuOpen(false);
                            }}
                            className={`w-full flex items-center justify-between px-3 py-1.5 text-xs text-left hover:bg-zinc-800/70 transition-colors cursor-pointer ${
                              isCurrent ? 'text-white font-medium bg-zinc-800/40' : 'text-zinc-300'
                            }`}
                          >
                            <div className="flex items-center gap-2">
                              <span className={`w-2 h-2 rounded-full shrink-0 ${opt.color}`} />
                              <span>{opt.label}</span>
                            </div>
                            {isCurrent && <Check className="w-3.5 h-3.5 text-emerald-400" />}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>

                <span className="text-xs text-zinc-400 truncate max-w-xs font-normal">
                  {currentUser.customStatus || 'Disponível no NEXUS'}
                </span>
              </div>
            </div>
          </div>

          {/* Lado Direito: Ações Rápidas de Navegação */}
          <div className="flex items-center gap-2.5 shrink-0">
            <button
              type="button"
              onClick={() => setActiveTab('messages')}
              className="relative inline-flex items-center gap-2 px-3.5 py-2 rounded-xl bg-zinc-900/80 hover:bg-zinc-800 text-zinc-300 hover:text-white text-xs font-medium border border-zinc-800 hover:border-zinc-700/80 transition-colors cursor-pointer shadow-xs"
            >
              <MessageSquare className="w-3.5 h-3.5 text-zinc-400" />
              <span>Mensagens</span>
              {totalUnreadConversations > 0 && (
                <span className="w-4 h-4 bg-rose-500 text-white rounded-full text-[10px] font-bold flex items-center justify-center">
                  {totalUnreadConversations}
                </span>
              )}
            </button>

            <button
              type="button"
              onClick={() => setActiveTab('communities')}
              className="inline-flex items-center gap-2 px-3.5 py-2 rounded-xl bg-zinc-900/80 hover:bg-zinc-800 text-zinc-300 hover:text-white text-xs font-medium border border-zinc-800 hover:border-zinc-700/80 transition-colors cursor-pointer shadow-xs"
            >
              <Users className="w-3.5 h-3.5 text-zinc-400" />
              <span>Comunidades</span>
            </button>

            <button
              type="button"
              onClick={() => {
                joinCall('Rustaceans Hub • Sala de Voz 01');
                setActiveTab('calls');
              }}
              className="inline-flex items-center gap-2 px-3.5 py-2 rounded-xl bg-rose-500/15 hover:bg-rose-500/25 text-rose-300 hover:text-rose-200 text-xs font-semibold border border-rose-500/30 transition-colors cursor-pointer shadow-xs"
            >
              <Radio className="w-3.5 h-3.5 text-rose-400" />
              <span>Entrar em Voz</span>
            </button>
          </div>
        </div>
      </section>

      {/* 2. Grid Principal: Conversas Recentes & Comunidades (Esq) vs Amigos (Dir) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Coluna Esquerda: Conversas Recentes & Comunidades (7 colunas) */}
        <div className="lg:col-span-7 space-y-6">
          {/* Card: Conversas Recentes */}
          <section className="bg-[#12151c]/80 border border-zinc-800/80 rounded-2xl p-5 shadow-lg flex flex-col">
            <div className="flex items-center justify-between mb-3.5 pb-2.5 border-b border-zinc-800/60">
              <div className="flex items-center gap-2">
                <Clock className="w-4 h-4 text-rose-400" />
                <h2 className="text-xs font-semibold text-zinc-300 uppercase tracking-wider">
                  Conversas Recentes
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setActiveTab('messages')}
                className="text-xs text-rose-400 hover:text-rose-300 flex items-center gap-1 font-medium transition-colors cursor-pointer"
              >
                <span>Ver todas</span>
                <ArrowRight className="w-3 h-3" />
              </button>
            </div>

            <div className="space-y-1.5">
              {isAuthenticated ? (
                conversations.length === 0 ? (
                  <div className="text-center py-8 px-4 rounded-xl bg-zinc-900/30 border border-dashed border-zinc-800/70 text-zinc-400 space-y-2">
                    <MessageSquare className="w-6 h-6 mx-auto text-zinc-500 opacity-60" />
                    <p className="text-xs font-semibold text-zinc-300">Nenhuma conversa recente</p>
                    <p className="text-[11px] text-zinc-500 max-w-xs mx-auto">
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
                        className="flex items-center justify-between p-3 rounded-xl hover:bg-zinc-900/70 border border-transparent hover:border-zinc-800/80 transition-all cursor-pointer group"
                      >
                        <div className="flex items-center gap-3.5 min-w-0">
                          <Avatar
                            name={other.name}
                            avatarUrl={other.avatarUrl}
                            status={other.status}
                            size="md"
                          />
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-semibold text-zinc-200 group-hover:text-white truncate">
                                {other.name}
                              </span>
                              <span className="text-[11px] text-zinc-500 font-mono">
                                @{other.username || other.tag}
                              </span>
                            </div>
                            <p className="text-xs text-zinc-400 group-hover:text-zinc-300 truncate max-w-sm mt-0.5">
                              {lastMsgContent}
                            </p>
                          </div>
                        </div>

                        <div className="flex items-center gap-3 shrink-0 ml-2">
                          {timeStr ? (
                            <span className="text-[11px] text-zinc-500 font-mono">
                              {timeStr}
                            </span>
                          ) : null}
                          {conv.unread_count > 0 ? (
                            <Badge count={conv.unread_count} />
                          ) : (
                            <MessageSquare className="w-3.5 h-3.5 text-zinc-600 opacity-0 group-hover:opacity-100 transition-opacity" />
                          )}
                        </div>
                      </div>
                    );
                  })
                )
              ) : mockDirectMessages.length === 0 ? (
                <div className="text-center py-8 px-4 rounded-xl bg-zinc-900/30 border border-dashed border-zinc-800/70 text-zinc-400 space-y-2">
                  <MessageSquare className="w-6 h-6 mx-auto text-zinc-500 opacity-60" />
                  <p className="text-xs font-semibold text-zinc-300">Nenhuma conversa recente</p>
                  <p className="text-[11px] text-zinc-500">Inicie uma conversa direta pela lista de amigos.</p>
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
                      className="flex items-center justify-between p-3 rounded-xl hover:bg-zinc-900/70 border border-transparent hover:border-zinc-800/80 transition-all cursor-pointer group"
                    >
                      <div className="flex items-center gap-3.5 min-w-0">
                        <Avatar name={friend.name} status={friend.status} size="md" />
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-semibold text-zinc-200 group-hover:text-white truncate">
                              {friend.name}
                            </span>
                            <span className="text-[11px] text-zinc-500 font-mono">
                              {friend.tag}
                            </span>
                          </div>
                          <p className="text-xs text-zinc-400 group-hover:text-zinc-300 truncate max-w-sm mt-0.5">
                            {dm.lastMessage}
                          </p>
                        </div>
                      </div>

                      <div className="flex items-center gap-3 shrink-0 ml-2">
                        <span className="text-[11px] text-zinc-500 font-mono">
                          {dm.timestamp}
                        </span>
                        {dm.unreadCount > 0 ? (
                          <Badge count={dm.unreadCount} />
                        ) : (
                          <MessageSquare className="w-3.5 h-3.5 text-zinc-600 opacity-0 group-hover:opacity-100 transition-opacity" />
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </section>

          {/* Card: Suas Comunidades com Estado Vazio Elegante */}
          <section className="bg-[#12151c]/80 border border-zinc-800/80 rounded-2xl p-5 shadow-lg flex flex-col">
            <div className="flex items-center justify-between mb-3.5 pb-2.5 border-b border-zinc-800/60">
              <div className="flex items-center gap-2">
                <Users className="w-4 h-4 text-rose-400" />
                <h2 className="text-xs font-semibold text-zinc-300 uppercase tracking-wider">
                  Suas Comunidades
                </h2>
              </div>
              <span className="text-xs text-zinc-500 font-mono">
                {mockCommunities.length} {mockCommunities.length === 1 ? 'ativa' : 'ativas'}
              </span>
            </div>

            {mockCommunities.length === 0 ? (
              /* Estado Vazio Elegante para Comunidades */
              <div className="text-center py-7 px-5 bg-zinc-900/40 rounded-xl border border-dashed border-zinc-800/80 flex flex-col items-center">
                <div className="w-12 h-12 rounded-2xl bg-[#171a23] border border-zinc-800 flex items-center justify-center text-zinc-400 mb-3 shadow-inner">
                  <Compass className="w-6 h-6 text-rose-400" />
                </div>
                <h3 className="text-xs font-bold text-zinc-200">
                  Nenhuma comunidade participando
                </h3>
                <p className="text-[11px] text-zinc-400 mt-1 max-w-sm">
                  Crie seu próprio servidor ou explore hubs temáticos para reunir seus amigos e compartilhar canais de voz.
                </p>
                <div className="flex items-center gap-2.5 mt-4">
                  <button
                    type="button"
                    onClick={() => setActiveTab('communities')}
                    className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-zinc-800 hover:bg-zinc-700/80 text-zinc-200 hover:text-white text-xs font-medium border border-zinc-700/60 transition-colors cursor-pointer"
                  >
                    <Compass className="w-3.5 h-3.5 text-zinc-400" />
                    <span>Explorar Comunidades</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab('communities')}
                    className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-rose-500/15 hover:bg-rose-500/25 text-rose-300 hover:text-rose-200 text-xs font-semibold border border-rose-500/30 transition-colors cursor-pointer"
                  >
                    <PlusCircle className="w-3.5 h-3.5 text-rose-400" />
                    <span>Criar Comunidade</span>
                  </button>
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                {mockCommunities.map((comm) => (
                  <div
                    key={comm.id}
                    className="bg-zinc-900/60 border border-zinc-800/90 hover:border-zinc-700/80 rounded-xl p-3.5 transition-all flex flex-col justify-between group shadow-sm"
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
                          <h4 className="text-xs font-bold text-zinc-200 group-hover:text-white truncate">
                            {comm.name}
                          </h4>
                          <p className="text-[11px] text-zinc-500 font-mono mt-0.5">
                            {comm.channels.length} canais
                          </p>
                        </div>
                      </div>

                      {comm.unreadCount && comm.unreadCount > 0 ? (
                        <Badge count={comm.unreadCount} />
                      ) : null}
                    </div>

                    {/* Atalhos para Canais Rápidos */}
                    <div className="space-y-1 pt-2 border-t border-zinc-800/60">
                      {comm.channels.slice(0, 2).map((ch) => (
                        <button
                          key={ch.id}
                          type="button"
                          onClick={() => {
                            setActiveCommunity(comm.id);
                            setActiveChannel(ch.id);
                            setActiveTab('communities');
                          }}
                          className="w-full flex items-center justify-between px-2.5 py-1 rounded-lg text-xs text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/60 transition-colors text-left cursor-pointer"
                        >
                          <span className="flex items-center gap-1.5 truncate">
                            {ch.type === 'text' ? (
                              <Hash className="w-3 h-3 text-zinc-500 shrink-0" />
                            ) : (
                              <Radio className="w-3 h-3 text-rose-400 shrink-0" />
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

        {/* Coluna Direita: Lista de Amigos Refinada (5 colunas) */}
        <div className="lg:col-span-5 space-y-4">
          <section className="bg-[#12151c]/80 border border-zinc-800/80 rounded-2xl p-5 shadow-lg flex flex-col">
            {/* Cabeçalho de Amigos */}
            <div className="flex items-center justify-between mb-3.5 pb-2.5 border-b border-zinc-800/60">
              <div className="flex items-center gap-2">
                <Gamepad2 className="w-4 h-4 text-emerald-400" />
                <h2 className="text-xs font-semibold text-zinc-300 uppercase tracking-wider">
                  Amigos ({friends.length})
                </h2>
              </div>

              {/* Botão Adicionar Amigo */}
              <button
                type="button"
                onClick={openAddFriendModal}
                className="relative inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-rose-600 hover:bg-rose-500 text-white text-xs font-medium transition-colors shadow-sm cursor-pointer"
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

            {/* Aviso de Modo Demonstração (se não autenticado) */}
            {!isAuthenticated && (
              <div className="mb-3.5 p-2.5 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-between gap-2 text-xs text-amber-200">
                <div className="flex items-center gap-2">
                  <Sparkles className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                  <span>Modo Demonstração ativo</span>
                </div>
                <button
                  type="button"
                  onClick={openAuthModal}
                  className="px-2.5 py-1 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 font-bold transition-colors text-[11px] cursor-pointer"
                >
                  Conectar
                </button>
              </div>
            )}

            {/* Filtros e Busca de Amigos */}
            <div className="space-y-2.5 mb-3.5">
              {/* Segmented Control de Filtro */}
              <div className="flex items-center justify-between p-0.5 rounded-xl bg-zinc-900/90 border border-zinc-800/80 text-xs">
                <button
                  type="button"
                  onClick={() => setFriendFilter('all')}
                  className={`flex-1 py-1 rounded-lg text-center transition-colors cursor-pointer ${
                    friendFilter === 'all'
                      ? 'bg-zinc-800 text-white font-medium shadow-xs'
                      : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  Todos ({friends.length})
                </button>
                <button
                  type="button"
                  onClick={() => setFriendFilter('online')}
                  className={`flex-1 py-1 rounded-lg text-center transition-colors cursor-pointer ${
                    friendFilter === 'online'
                      ? 'bg-zinc-800 text-white font-medium shadow-xs'
                      : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  Online ({onlineFriendsCount})
                </button>
                <button
                  type="button"
                  onClick={() => setFriendFilter('gaming')}
                  className={`flex-1 py-1 rounded-lg text-center transition-colors cursor-pointer ${
                    friendFilter === 'gaming'
                      ? 'bg-zinc-800 text-white font-medium shadow-xs'
                      : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  Em Jogo ({gamingFriendsCount})
                </button>
              </div>

              {/* Barra de Busca de Amigos */}
              <div className="relative">
                <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500 pointer-events-none" />
                <input
                  type="text"
                  value={friendSearch}
                  onChange={(e) => setFriendSearch(e.target.value)}
                  placeholder="Buscar amigo por nome ou tag..."
                  className="w-full bg-zinc-900/80 text-zinc-200 placeholder-zinc-500 text-xs pl-8.5 pr-8 py-2 rounded-xl border border-zinc-800 focus:border-rose-500/60 focus:outline-hidden transition-colors"
                />
                {friendSearch && (
                  <button
                    type="button"
                    onClick={() => setFriendSearch('')}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300 p-0.5 rounded cursor-pointer"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </div>

            {/* Lista Rolável de Amigos */}
            <div className="space-y-1 overflow-y-auto max-h-[500px] pr-1">
              {filteredFriends.length === 0 ? (
                <div className="text-center py-10 px-4 space-y-3">
                  <div className="w-12 h-12 rounded-2xl bg-zinc-900/60 border border-zinc-800 flex items-center justify-center mx-auto text-zinc-500">
                    <Users className="w-6 h-6 text-rose-400/80" />
                  </div>
                  <div className="space-y-1">
                    <h4 className="text-xs font-semibold text-zinc-300">
                      {friendSearch ? 'Nenhum amigo encontrado' : 'Nenhum amigo nesta lista'}
                    </h4>
                    <p className="text-[11px] text-zinc-500 max-w-xs mx-auto">
                      {friendSearch
                        ? 'Tente outro termo ou limpe a busca.'
                        : 'Adicione amigos no NEXUS para chamadas de voz e mensagens diretas.'}
                    </p>
                  </div>
                  {!friendSearch && (
                    <button
                      type="button"
                      onClick={openAddFriendModal}
                      className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-rose-600 hover:bg-rose-500 text-white text-xs font-medium transition-colors shadow-xs cursor-pointer"
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
                    className="relative flex items-center justify-between p-2.5 rounded-xl hover:bg-zinc-900/70 border border-transparent hover:border-zinc-800/80 transition-all group"
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
                      <Avatar name={friend.name} avatarUrl={friend.avatarUrl} status={friend.status} size="sm" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="text-xs font-semibold text-zinc-200 group-hover:text-white truncate">
                            {friend.name}
                          </span>
                          <span className="text-[11px] text-zinc-500 font-mono">
                            {friend.tag}
                          </span>
                        </div>
                        <p className="text-[11px] truncate max-w-[170px] mt-0.5 text-zinc-400">
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

                    {/* Botões de Ação de Amigos */}
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
                          className="p-1.5 rounded-lg text-zinc-400 hover:text-emerald-400 hover:bg-emerald-500/15 transition-colors cursor-pointer active:scale-95"
                          title={`Ligar para ${friend.name}`}
                        >
                          <Phone className="w-3.5 h-3.5" />
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
                          className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors cursor-pointer"
                        >
                          <MessageSquare className="w-3.5 h-3.5" />
                        </button>
                      </Tooltip>

                      {/* Menu de Mais Opções */}
                      <div className="relative">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setOpenFriendMenuId(
                              openFriendMenuId === friend.id ? null : friend.id
                            );
                          }}
                          className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors cursor-pointer"
                          title="Mais Opções"
                        >
                          <MoreVertical className="w-3.5 h-3.5" />
                        </button>

                        {openFriendMenuId === friend.id && (
                          <div
                            className="absolute right-0 top-full mt-1.5 w-44 rounded-xl bg-[#141720] border border-zinc-800 shadow-2xl py-1 z-40 animate-fadeIn"
                            onMouseLeave={() => setOpenFriendMenuId(null)}
                          >
                            <button
                              type="button"
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
                              onClick={async () => {
                                setOpenFriendMenuId(null);
                                await removeFriend(friend.id);
                              }}
                              className="w-full flex items-center gap-2.5 px-3 py-1.5 text-xs text-rose-400 hover:text-rose-300 hover:bg-rose-500/10 transition-colors text-left cursor-pointer"
                            >
                              <UserMinus className="w-3.5 h-3.5" />
                              <span>Remover Amigo</span>
                            </button>
                            <button
                              type="button"
                              onClick={async () => {
                                setOpenFriendMenuId(null);
                                await blockUser(friend.id);
                              }}
                              className="w-full flex items-center gap-2.5 px-3 py-1.5 text-xs text-rose-400 hover:text-rose-300 hover:bg-rose-500/10 transition-colors text-left cursor-pointer"
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
          </section>
        </div>
      </div>

      {/* Modal de Adicionar Amigo */}
      <AddFriendModal />
    </div>
  );
};
