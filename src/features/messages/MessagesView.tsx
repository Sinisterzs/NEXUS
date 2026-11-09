import React, { useState, useRef, useEffect } from 'react';
import {
  MessageSquare,
  Search,
  Send,
  Phone,
  Smile,
  Paperclip,
  HardDrive,
  ChevronUp,
  AlertCircle,
  Check,
  CheckCheck,
  Clock,
  Edit2,
  Trash2,
  X,
  RotateCw,
  Plus,
} from 'lucide-react';
import { useAppStore } from '../../stores/useAppStore';
import { mockFriends, mockDirectMessages } from '../../mocks';
import { Avatar } from '../../components/Avatar';
import { Badge } from '../../components/Badge';
import { Tooltip } from '../../components/Tooltip';
import { ChatMessage, DbMessage, DirectMessageSummary, DirectMessageDto } from '../../lib/types';
import { messageRepository } from '../../repositories/MessageRepository';
import { conversationRepository } from '../../repositories/ConversationRepository';
import { callService } from '../../services/CallService';

function formatDbMessage(
  dbMsg: DbMessage,
  friendName: string,
  userName: string
): ChatMessage {
  const date = new Date(dbMsg.created_at * 1000);
  const now = new Date();
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(
    date.getMinutes()
  ).padStart(2, '0')}`;

  const isToday = date.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday = date.toDateString() === yesterday.toDateString();

  let dateKey = 'Hoje';
  if (isYesterday) {
    dateKey = 'Ontem';
  } else if (!isToday) {
    dateKey = date.toLocaleDateString('pt-BR', { day: 'numeric', month: 'long' });
  }

  const isUser = dbMsg.sender_id === 'usr_me';

  return {
    id: dbMsg.id,
    authorId: dbMsg.sender_id,
    authorName: isUser ? userName : friendName,
    content: dbMsg.content,
    timestamp: time,
    rawTimestamp: dbMsg.created_at,
    dateKey,
  };
}

function formatDateKey(isoDateStr: string): { time: string; dateKey: string } {
  const date = new Date(isoDateStr);
  const now = new Date();
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(
    date.getMinutes()
  ).padStart(2, '0')}`;

  const isToday = date.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday = date.toDateString() === yesterday.toDateString();

  let dateKey = 'Hoje';
  if (isYesterday) {
    dateKey = 'Ontem';
  } else if (!isToday) {
    dateKey = date.toLocaleDateString('pt-BR', { day: 'numeric', month: 'long' });
  }

  return { time, dateKey };
}

export const MessagesView: React.FC = () => {
  const authStatus = useAppStore((state) => state.authStatus);
  const isOnline = authStatus === 'authenticated';
  const currentUser = useAppStore((state) => state.currentUser);
  const onlineUser = useAppStore((state) => state.onlineUser);
  const friends = useAppStore((state) => state.friends);
  const joinCall = useAppStore((state) => state.joinCall);
  const setActiveTab = useAppStore((state) => state.setActiveTab);
  const compactMode = useAppStore((state) => state.settings.appearance.compactMode);

  // Online Real DMs State
  const conversations = useAppStore((state) => state.conversations);
  const activeConversationId = useAppStore((state) => state.activeConversationId);
  const activeConversationMessages = useAppStore((state) => state.activeConversationMessages);
  const isLoadingConversations = useAppStore((state) => state.isLoadingConversations);
  const isLoadingMessages = useAppStore((state) => state.isLoadingMessages);
  const isSendingDm = useAppStore((state) => state.isSendingDm);
  const dmError = useAppStore((state) => state.dmError);
  const loadConversations = useAppStore((state) => state.loadConversations);
  const selectConversation = useAppStore((state) => state.selectConversation);
  const startConversationWithUser = useAppStore((state) => state.startConversationWithUser);
  const sendDirectMessage = useAppStore((state) => state.sendDirectMessage);
  const editDirectMessage = useAppStore((state) => state.editDirectMessage);
  const deleteDirectMessage = useAppStore((state) => state.deleteDirectMessage);
  const loadOlderMessages = useAppStore((state) => state.loadOlderMessages);

  // Offline / Demo state
  const activeDmId = useAppStore((state) => state.activeDmId);
  const setActiveDm = useAppStore((state) => state.setActiveDm);
  const allDemoFriends = friends.length > 0 ? friends : mockFriends;
  const [demoMessages, setDemoMessages] = useState<ChatMessage[]>([]);
  const [dmsList] = useState<DirectMessageSummary[]>(mockDirectMessages);

  // Shared UI state
  const [searchFilter, setSearchFilter] = useState('');
  const [draftMessage, setDraftMessage] = useState('');
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingContent, setEditingContent] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const [showFriendsList, setShowFriendsList] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const currentDraftRef = useRef<string>('');

  // Initial load for online mode
  useEffect(() => {
    if (isOnline) {
      loadConversations();
    }
  }, [isOnline, loadConversations]);

  // Select active conversation partner
  const selectedOnlineConv = conversations.find((c) => c.id === activeConversationId);
  const selectedDemoFriend = allDemoFriends.find((f) => f.id === activeDmId) || allDemoFriends[0];

  // Auto-scroll on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [activeConversationMessages.length, demoMessages.length]);

  // -------------------------------------------------------------
  // Draft Management (Scoped per Account & Conversation)
  // -------------------------------------------------------------
  const activeTargetId = isOnline ? activeConversationId : (selectedDemoFriend?.id || null);
  const activeAccountId = isOnline ? (onlineUser?.id || 'offline_demo') : 'offline_demo';

  useEffect(() => {
    if (!activeTargetId) {
      setDraftMessage('');
      currentDraftRef.current = '';
      return;
    }

    let isMounted = true;
    async function loadDraft() {
      try {
        const state = await conversationRepository.getConversationState(
          activeTargetId!,
          activeAccountId
        );
        if (isMounted) {
          const saved = state?.draft_text || '';
          setDraftMessage(saved);
          currentDraftRef.current = saved;
        }
      } catch (err) {
        console.warn('[MessagesView] Erro ao carregar rascunho:', err);
      }
    }

    loadDraft();

    return () => {
      isMounted = false;
      const textToSave = currentDraftRef.current;
      conversationRepository
        .saveDraft(activeTargetId, textToSave, activeAccountId)
        .catch(() => {});
    };
  }, [activeTargetId, activeAccountId]);

  const handleDraftChange = (text: string) => {
    setDraftMessage(text);
    currentDraftRef.current = text;
    if (activeTargetId) {
      conversationRepository
        .saveDraft(activeTargetId, text, activeAccountId)
        .catch(() => {});
    }
  };

  // -------------------------------------------------------------
  // Offline Demo Mode Logic
  // -------------------------------------------------------------
  useEffect(() => {
    if (isOnline || !selectedDemoFriend) return;

    const friendId = selectedDemoFriend.id;
    const friendName = selectedDemoFriend.name;

    async function loadDemoData() {
      try {
        await conversationRepository.ensureConversation(
          friendId,
          'dm',
          friendName,
          'offline_demo'
        );

        const dbMsgs = await messageRepository.getMessages(
          friendId,
          25,
          undefined,
          'offline_demo'
        );
        const formatted = dbMsgs.map((m) =>
          formatDbMessage(m, friendName, currentUser.displayName)
        );
        setDemoMessages(formatted);

        if (dbMsgs.length > 0) {
          const lastMsg = dbMsgs[dbMsgs.length - 1];
          await conversationRepository.markAsRead(friendId, lastMsg.id, 'offline_demo');
        }
      } catch (err: any) {
        console.error('[MessagesView] Erro ao carregar conversa demo:', err);
      }
    }

    loadDemoData();
  }, [isOnline, selectedDemoFriend, currentUser.displayName]);

  // -------------------------------------------------------------
  // Message Sending
  // -------------------------------------------------------------
  const handleSendMessage = async () => {
    const content = draftMessage.trim();
    if (!content) return;

    setLocalError(null);

    if (isOnline) {
      if (!activeConversationId) return;
      setDraftMessage('');
      currentDraftRef.current = '';
      conversationRepository
        .saveDraft(activeConversationId, '', activeAccountId)
        .catch(() => {});
      const ok = await sendDirectMessage(content);
      if (!ok) {
        setDraftMessage(content);
        currentDraftRef.current = content;
        conversationRepository
          .saveDraft(activeConversationId, content, activeAccountId)
          .catch(() => {});
      }
    } else {
      if (!selectedDemoFriend) return;
      setDraftMessage('');
      currentDraftRef.current = '';

      try {
        await conversationRepository.ensureConversation(
          selectedDemoFriend.id,
          'dm',
          selectedDemoFriend.name,
          'offline_demo'
        );
        await conversationRepository.saveDraft(selectedDemoFriend.id, '', 'offline_demo');
        const savedDb = await messageRepository.saveMessage(
          selectedDemoFriend.id,
          currentUser.id,
          content,
          'offline_demo'
        );
        const visualMsg = formatDbMessage(
          savedDb,
          selectedDemoFriend.name,
          currentUser.displayName
        );
        setDemoMessages((prev) => [...prev, visualMsg]);
      } catch (err: any) {
        setLocalError(`Erro ao salvar mensagem: ${err?.message || err}`);
        setDraftMessage(content);
        currentDraftRef.current = content;
        conversationRepository
          .saveDraft(selectedDemoFriend.id, content, 'offline_demo')
          .catch(() => {});
      }
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  // -------------------------------------------------------------
  // Message Editing & Deletion (Real DMs)
  // -------------------------------------------------------------
  const handleStartEdit = (msg: DirectMessageDto) => {
    if (msg.deleted_at) return;
    setEditingMessageId(msg.id);
    setEditingContent(msg.content);
  };

  const handleSaveEdit = async () => {
    if (!editingMessageId) return;
    const clean = editingContent.trim();
    if (!clean) return;

    const ok = await editDirectMessage(editingMessageId, clean);
    if (ok) {
      setEditingMessageId(null);
      setEditingContent('');
    }
  };

  const handleCancelEdit = () => {
    setEditingMessageId(null);
    setEditingContent('');
  };

  const handleDelete = async (msgId: string) => {
    await deleteDirectMessage(msgId);
  };

  const startQuickCall = async () => {
    if (isOnline && selectedOnlineConv) {
      const target = {
        id: selectedOnlineConv.other_user.id,
        name: selectedOnlineConv.other_user.name,
        username: selectedOnlineConv.other_user.username || selectedOnlineConv.other_user.name,
        avatarUrl: selectedOnlineConv.other_user.avatarUrl,
      };
      await callService.startCall(target);
      setActiveTab('calls');
    } else if (selectedDemoFriend) {
      joinCall(`Chamada com ${selectedDemoFriend.name}`);
      setActiveTab('calls');
    }
  };

  // Helper to start conversation with a friend
  const handleStartWithFriend = async (friendId: string) => {
    setShowFriendsList(false);
    await startConversationWithUser(friendId);
  };

  // Filter conversations
  const filteredOnlineConvs = conversations.filter(
    (c) =>
      c.other_user.name.toLowerCase().includes(searchFilter.toLowerCase()) ||
      (c.other_user.username &&
        c.other_user.username.toLowerCase().includes(searchFilter.toLowerCase()))
  );

  const filteredDemoDms = dmsList.filter((dm) => {
    const friend = allDemoFriends.find((f) => f.id === dm.friendId);
    if (!friend) return false;
    return friend.name.toLowerCase().includes(searchFilter.toLowerCase());
  });

  const activePartnerName = isOnline
    ? selectedOnlineConv?.other_user.name
    : selectedDemoFriend?.name;

  const activePartnerUsername = isOnline
    ? selectedOnlineConv?.other_user.username || selectedOnlineConv?.other_user.tag
    : selectedDemoFriend?.username || selectedDemoFriend?.tag;

  const activePartnerAvatar = isOnline
    ? selectedOnlineConv?.other_user.avatarUrl || (selectedOnlineConv?.other_user.username === currentUser.username ? currentUser.avatarUrl : undefined)
    : selectedDemoFriend?.avatarUrl || (selectedDemoFriend?.username === currentUser.username ? currentUser.avatarUrl : undefined);

  const activePartnerStatus = isOnline
    ? selectedOnlineConv?.other_user.status
    : selectedDemoFriend?.status;

  const activePartnerActivity = isOnline
    ? selectedOnlineConv?.other_user.activity || selectedOnlineConv?.other_user.customStatus || 'Disponível'
    : selectedDemoFriend?.activity || selectedDemoFriend?.customStatus || 'Disponível';

  return (
    <div className="flex-1 flex overflow-hidden select-none bg-[#07080b] text-zinc-100">
      {/* 1. Lateral Conversations Column (Width: 288px / w-72) */}
      <div className="w-72 bg-[#090b10] border-r border-white/[0.06] flex flex-col shrink-0 select-none">
        {/* Search & New Conversation Header */}
        <div className="p-3.5 border-b border-white/[0.05] space-y-2.5">
          <div className="relative flex items-center">
            <Search className="w-3.5 h-3.5 absolute left-3 text-zinc-500 pointer-events-none" />
            <input
              type="text"
              value={searchFilter}
              onChange={(e) => setSearchFilter(e.target.value)}
              placeholder="Filtrar conversas..."
              className="w-full bg-[#0e1118]/80 text-zinc-200 placeholder-zinc-500 text-xs pl-8.5 pr-3 py-2 rounded-xl border border-white/[0.06] focus:border-rose-500/50 focus:outline-none transition-colors"
            />
          </div>

          {isOnline && (
            <button
              type="button"
              onClick={() => setShowFriendsList(!showFriendsList)}
              className="w-full flex items-center justify-center gap-2 py-2 px-3 rounded-xl bg-rose-950/30 hover:bg-rose-900/40 text-rose-200 hover:text-white border border-rose-500/40 hover:border-rose-500/60 text-xs font-medium transition-all shadow-sm shadow-rose-950/40 cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5 text-rose-400" />
              <span>Nova Conversa</span>
            </button>
          )}
        </div>

        {/* Modal/Dropdown for selecting a friend to start a DM */}
        {showFriendsList && isOnline && (
          <div className="p-2.5 border-b border-white/[0.06] bg-[#0c0e14] space-y-1 max-h-52 overflow-y-auto animate-fadeIn">
            <div className="px-2 py-1 text-[10px] font-mono uppercase tracking-wider text-zinc-500 flex justify-between items-center">
              <span>Selecione um amigo</span>
              <button
                type="button"
                onClick={() => setShowFriendsList(false)}
                className="text-zinc-500 hover:text-white p-0.5 rounded cursor-pointer"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
            {friends.length === 0 ? (
              <p className="text-xs text-zinc-500 px-2 py-3 text-center">
                Nenhum amigo adicionado ainda.
              </p>
            ) : (
              friends.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => handleStartWithFriend(f.id)}
                  className="w-full flex items-center gap-2.5 p-2 rounded-xl hover:bg-white/[0.04] text-left text-xs text-zinc-200 transition-colors cursor-pointer group"
                >
                  <Avatar
                    name={f.name}
                    avatarUrl={f.avatarUrl || (f.username === currentUser.username ? currentUser.avatarUrl : undefined)}
                    status={f.status}
                    size="sm"
                    shapeClassName="rounded-xl"
                  />
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-white group-hover:text-white truncate">{f.name}</p>
                    <p className="text-[11px] text-zinc-400 font-mono">@{f.username || f.tag}</p>
                  </div>
                </button>
              ))
            )}
          </div>
        )}

        {/* Conversations List */}
        <div className="flex-1 overflow-y-auto p-2.5 space-y-1">
          <div className="px-2.5 py-1.5 text-[10px] font-mono uppercase tracking-wider text-zinc-500 flex items-center justify-between">
            <span>Conversas Diretas</span>
            {isOnline && (
              <span className="flex items-center gap-1 text-[10px] text-emerald-400 font-mono font-normal">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                Ao vivo
              </span>
            )}
          </div>

          {/* ONLINE REAL CONVERSATIONS */}
          {isOnline ? (
            filteredOnlineConvs.length === 0 ? (
              <div className="px-3 py-8 text-center text-xs text-zinc-500 space-y-1">
                {isLoadingConversations ? (
                  <p>Carregando conversas...</p>
                ) : (
                  <>
                    <p className="font-semibold text-zinc-400">Nenhuma conversa ativa</p>
                    <p className="text-[11px] text-zinc-500">Clique em "Nova Conversa" para falar com um amigo.</p>
                  </>
                )}
              </div>
            ) : (
              filteredOnlineConvs.map((conv) => {
                const isSelected = activeConversationId === conv.id;
                const other = conv.other_user;
                const lastMsg = conv.last_message;
                const lastMsgPreview = lastMsg
                  ? lastMsg.deleted_at
                    ? '[Mensagem apagada]'
                    : lastMsg.content
                  : 'Nenhuma mensagem recente';

                const timePreview = lastMsg
                  ? formatDateKey(lastMsg.created_at).time
                  : '';

                const effectiveAvatar =
                  other.avatarUrl ||
                  (other.username?.toLowerCase() === currentUser.username?.toLowerCase() || other.name === currentUser.displayName
                    ? currentUser.avatarUrl
                    : undefined);

                return (
                  <button
                    key={conv.id}
                    type="button"
                    onClick={() => selectConversation(conv.id)}
                    className={`w-full flex items-center gap-3 p-2.5 rounded-xl text-left transition-all cursor-pointer group ${
                      isSelected
                        ? 'bg-gradient-to-r from-rose-950/40 via-rose-900/20 to-transparent border border-rose-500/40 text-white shadow-[0_0_12px_rgba(244,63,94,0.12)]'
                        : 'text-zinc-400 hover:bg-white/[0.03] hover:text-zinc-200 border border-transparent'
                    }`}
                  >
                    <Avatar
                      name={other.name}
                      avatarUrl={effectiveAvatar}
                      status={other.status}
                      size="md"
                      shapeClassName="rounded-xl"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-semibold text-white group-hover:text-white truncate">
                          {other.name}
                        </span>
                        {timePreview && (
                          <span className="text-[10px] text-zinc-500 font-mono shrink-0 ml-1">
                            {timePreview}
                          </span>
                        )}
                      </div>
                      <p className="text-[11px] text-zinc-400 group-hover:text-zinc-300 truncate mt-0.5">
                        {lastMsgPreview}
                      </p>
                    </div>
                    {conv.unread_count > 0 && <Badge count={conv.unread_count} />}
                  </button>
                );
              })
            )
          ) : (
            /* OFFLINE DEMO CONVERSATIONS */
            filteredDemoDms.map((dm) => {
              const friend = allDemoFriends.find((f) => f.id === dm.friendId);
              if (!friend) return null;
              const isSelected = selectedDemoFriend?.id === friend.id;

              return (
                <button
                  key={dm.id}
                  type="button"
                  onClick={() => {
                    setActiveDm(friend.id);
                  }}
                  className={`w-full flex items-center gap-3 p-2.5 rounded-xl text-left transition-all cursor-pointer group ${
                    isSelected
                      ? 'bg-gradient-to-r from-rose-950/40 via-rose-900/20 to-transparent border border-rose-500/40 text-white shadow-[0_0_12px_rgba(244,63,94,0.12)]'
                      : 'text-zinc-400 hover:bg-white/[0.03] hover:text-zinc-200 border border-transparent'
                  }`}
                >
                  <Avatar
                    name={friend.name}
                    avatarUrl={friend.avatarUrl}
                    status={friend.status}
                    size="md"
                    shapeClassName="rounded-xl"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-white group-hover:text-white truncate">
                        {friend.name}
                      </span>
                      <span className="text-[10px] text-zinc-500 font-mono shrink-0 ml-1">
                        {dm.timestamp}
                      </span>
                    </div>
                    <p className="text-[11px] text-zinc-400 group-hover:text-zinc-300 truncate mt-0.5">
                      {dm.lastMessage}
                    </p>
                  </div>
                  {dm.unreadCount > 0 && <Badge count={dm.unreadCount} />}
                </button>
              );
            })
          )}
        </div>
      </div>

      {/* 2. Main Conversation Pane */}
      {(isOnline && selectedOnlineConv) || (!isOnline && selectedDemoFriend) ? (
        <div className="flex-1 flex flex-col bg-[#07080b] overflow-hidden">
          {/* Header Bar */}
          <div className="h-14 border-b border-white/[0.06] px-5 flex items-center justify-between bg-[#0d0f15]/90 backdrop-blur shrink-0">
            <div className="flex items-center gap-3.5 min-w-0">
              <Avatar
                name={activePartnerName || 'Usuário'}
                avatarUrl={activePartnerAvatar}
                status={activePartnerStatus}
                size="md"
                shapeClassName="rounded-xl"
                className="ring-1 ring-white/10"
              />
              <div className="min-w-0">
                <div className="flex items-center">
                  <h3 className="text-sm font-bold text-white tracking-tight truncate">
                    {activePartnerName}
                  </h3>
                  {activePartnerUsername && (
                    <span className="text-xs text-zinc-400 font-mono ml-2 truncate">
                      @{activePartnerUsername}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1.5 mt-0.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" />
                  <span className="text-[11px] text-zinc-400 font-normal truncate">
                    {activePartnerActivity}
                  </span>
                </div>
              </div>
            </div>

            {/* Header Actions */}
            <div className="flex items-center gap-2.5 shrink-0">
              <button
                type="button"
                onClick={startQuickCall}
                className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-xl bg-rose-950/30 hover:bg-rose-900/40 text-rose-200 hover:text-white text-xs font-medium border border-rose-500/40 hover:border-rose-500/60 transition-all cursor-pointer shadow-sm shadow-rose-950/40 active:scale-95"
                title={`Iniciar chamada com ${activePartnerName}`}
              >
                <Phone className="w-3.5 h-3.5 text-emerald-400" />
                <span>Ligar</span>
              </button>
            </div>
          </div>

          {/* Real Error Banner */}
          {(localError || dmError) && (
            <div className="bg-rose-950/40 border-b border-rose-500/30 px-5 py-2.5 flex items-center justify-between text-xs text-rose-200 shrink-0 animate-fadeIn">
              <div className="flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
                <span>{localError || dmError}</span>
              </div>
              <button
                type="button"
                onClick={() => setLocalError(null)}
                className="text-xs text-rose-300 hover:text-white underline ml-2 cursor-pointer"
              >
                Dispensar
              </button>
            </div>
          )}

          {/* Messages History Pane */}
          <div className="flex-1 overflow-y-auto p-5 space-y-3.5">
            {/* Online load older messages pagination */}
            {isOnline && activeConversationMessages.length >= 25 && (
              <div className="flex justify-center pb-2">
                <button
                  type="button"
                  onClick={() => loadOlderMessages()}
                  disabled={isLoadingMessages}
                  className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.06] text-xs text-zinc-400 hover:text-zinc-200 transition-all cursor-pointer"
                >
                  <ChevronUp className="w-3.5 h-3.5" />
                  <span>Carregar mensagens anteriores</span>
                </button>
              </div>
            )}

            {/* Conversation Intro Header */}
            <div className="flex flex-col items-center justify-center py-8 mb-4 border-b border-white/[0.04] text-center">
              <Avatar
                name={activePartnerName || 'Usuário'}
                avatarUrl={activePartnerAvatar}
                size="xl"
                shapeClassName="rounded-2xl"
                className="mb-3 ring-1 ring-rose-500/50 shadow-[0_0_16px_rgba(244,63,94,0.18)]"
              />
              <h4 className="text-base font-bold text-white tracking-tight">
                {activePartnerName}
              </h4>
              <p className="text-xs text-zinc-400 mt-1 max-w-sm">
                {isOnline
                  ? `Início da sua conversa privada e segura com @${activePartnerUsername}`
                  : `Histórico local de demonstração com @${activePartnerName}`}
              </p>
            </div>

            {/* RENDER MESSAGES: ONLINE MODE */}
            {isOnline ? (
              activeConversationMessages.map((msg, index) => {
                const prevMsg = activeConversationMessages[index - 1];
                const { time, dateKey } = formatDateKey(msg.created_at);
                const prevDateKey = prevMsg ? formatDateKey(prevMsg.created_at).dateKey : null;
                const showDateDivider = !prevMsg || prevDateKey !== dateKey;
                const isGroupedWithPrev =
                  !showDateDivider && prevMsg && prevMsg.sender_id === msg.sender_id;

                const isAuthorMe = msg.is_mine;
                const isEditing = editingMessageId === msg.id;
                const isDeleted = Boolean(msg.deleted_at);

                const authorAvatar = isAuthorMe
                  ? currentUser.avatarUrl
                  : activePartnerAvatar;

                return (
                  <React.Fragment key={msg.id}>
                    {showDateDivider && (
                      <div className="flex items-center my-5">
                        <div className="flex-1 border-t border-white/[0.05]" />
                        <span className="px-3.5 py-0.5 text-[10px] font-mono uppercase tracking-wider text-zinc-400 bg-[#111319] border border-white/[0.06] rounded-full">
                          {dateKey}
                        </span>
                        <div className="flex-1 border-t border-white/[0.05]" />
                      </div>
                    )}

                    <div
                      className={`group relative flex items-start gap-3.5 hover:bg-white/[0.02] px-3 py-1 rounded-xl transition-all ${
                        isGroupedWithPrev ? (compactMode ? 'mt-0 pl-12' : 'mt-0.5 pl-12') : 'mt-2.5'
                      }`}
                    >
                      {!isGroupedWithPrev && (
                        <Avatar
                          name={isAuthorMe ? currentUser.displayName : (activePartnerName || 'Usuário')}
                          avatarUrl={authorAvatar}
                          size="sm"
                          shapeClassName="rounded-xl"
                          className="shrink-0 mt-0.5"
                          showStatus={false}
                        />
                      )}

                      <div className="flex-1 min-w-0">
                        {!isGroupedWithPrev && (
                          <div className="flex items-center gap-2 mb-1">
                            <span
                              className={`text-xs font-semibold ${
                                isAuthorMe ? 'text-rose-400' : 'text-white'
                              }`}
                            >
                              {isAuthorMe ? currentUser.displayName : activePartnerName}
                            </span>
                            <span className="text-[11px] text-zinc-500 font-mono">
                              {time}
                            </span>
                            {msg.edited_at && !isDeleted && (
                              <span className="text-[10px] text-zinc-500 italic">
                                (editado)
                              </span>
                            )}
                          </div>
                        )}

                        {isEditing ? (
                          <div className="flex items-center gap-2 mt-1">
                            <input
                              type="text"
                              value={editingContent}
                              onChange={(e) => setEditingContent(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') handleSaveEdit();
                                if (e.key === 'Escape') handleCancelEdit();
                              }}
                              className="flex-1 bg-[#111319] text-xs text-white px-3 py-1.5 rounded-xl border border-rose-500/60 focus:outline-none"
                              autoFocus
                            />
                            <button
                              type="button"
                              onClick={handleSaveEdit}
                              className="px-3 py-1.5 bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold rounded-xl transition-colors cursor-pointer"
                            >
                              Salvar
                            </button>
                            <button
                              type="button"
                              onClick={handleCancelEdit}
                              className="px-3 py-1.5 bg-white/[0.04] hover:bg-white/[0.08] text-zinc-400 hover:text-white text-xs rounded-xl transition-colors cursor-pointer"
                            >
                              Cancelar
                            </button>
                          </div>
                        ) : (
                          <div
                            className={`text-xs leading-relaxed break-words ${
                              isDeleted
                                ? 'text-zinc-500 italic select-none'
                                : 'text-zinc-200'
                            }`}
                          >
                            {msg.content}
                          </div>
                        )}

                        {/* Delivery Status Indicator for my messages */}
                        {isAuthorMe && (
                          <div className="flex items-center gap-1 mt-1">
                            {msg.delivery_status === 'sending' && (
                              <Tooltip content="Enviando...">
                                <Clock className="w-3 h-3 text-zinc-500 animate-spin" />
                              </Tooltip>
                            )}
                            {msg.delivery_status === 'failed' && (
                              <Tooltip content="Falha no envio">
                                <AlertCircle className="w-3 h-3 text-rose-400" />
                              </Tooltip>
                            )}
                            {(!msg.delivery_status || msg.delivery_status === 'sent') && (
                              <Tooltip content="Enviado ao servidor">
                                <Check className="w-3 h-3 text-zinc-500" />
                              </Tooltip>
                            )}
                            {msg.delivery_status === 'delivered' && (
                              <Tooltip content="Entregue ao dispositivo do destinatário">
                                <CheckCheck className="w-3 h-3 text-zinc-400" />
                              </Tooltip>
                            )}
                            {(msg.read_at || msg.delivery_status === 'read') && (
                              <Tooltip content="Lido pelo destinatário">
                                <CheckCheck className="w-3 h-3 text-rose-400" />
                              </Tooltip>
                            )}
                          </div>
                        )}
                      </div>

                      {/* Action buttons (Edit / Delete) for author */}
                      {isAuthorMe && !isDeleted && !isEditing && (
                        <div className="hidden group-hover:flex items-center gap-1 bg-[#141720] border border-white/[0.08] px-1.5 py-1 rounded-xl shadow-xl">
                          <Tooltip content="Editar mensagem">
                            <button
                              type="button"
                              onClick={() => handleStartEdit(msg)}
                              className="p-1 text-zinc-400 hover:text-white hover:bg-white/[0.06] rounded-lg transition-colors cursor-pointer"
                            >
                              <Edit2 className="w-3.5 h-3.5" />
                            </button>
                          </Tooltip>
                          <Tooltip content="Apagar mensagem">
                            <button
                              type="button"
                              onClick={() => handleDelete(msg.id)}
                              className="p-1 text-zinc-400 hover:text-rose-400 hover:bg-rose-500/10 rounded-lg transition-colors cursor-pointer"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </Tooltip>
                        </div>
                      )}
                    </div>
                  </React.Fragment>
                );
              })
            ) : (
              /* RENDER MESSAGES: DEMO MODE */
              demoMessages.map((msg, index) => {
                const prevMsg = demoMessages[index - 1];
                const showDateDivider = !prevMsg || prevMsg.dateKey !== msg.dateKey;
                const isGroupedWithPrev =
                  !showDateDivider && prevMsg && prevMsg.authorId === msg.authorId;
                const isCurrentUser = msg.authorId === currentUser.id;

                return (
                  <React.Fragment key={msg.id}>
                    {showDateDivider && (
                      <div className="flex items-center my-5">
                        <div className="flex-1 border-t border-white/[0.05]" />
                        <span className="px-3.5 py-0.5 text-[10px] font-mono uppercase tracking-wider text-zinc-400 bg-[#111319] border border-white/[0.06] rounded-full">
                          {msg.dateKey}
                        </span>
                        <div className="flex-1 border-t border-white/[0.05]" />
                      </div>
                    )}

                    <div
                      className={`group flex items-start gap-3.5 hover:bg-white/[0.02] px-3 py-1 rounded-xl transition-all ${
                        isGroupedWithPrev ? (compactMode ? 'mt-0 pl-12' : 'mt-0.5 pl-12') : 'mt-2.5'
                      }`}
                    >
                      {!isGroupedWithPrev && (
                        <Avatar
                          name={msg.authorName}
                          avatarUrl={isCurrentUser ? currentUser.avatarUrl : activePartnerAvatar}
                          size="sm"
                          shapeClassName="rounded-xl"
                          className="shrink-0 mt-0.5"
                          showStatus={false}
                        />
                      )}

                      <div className="flex-1 min-w-0">
                        {!isGroupedWithPrev && (
                          <div className="flex items-center gap-2 mb-1">
                            <span
                              className={`text-xs font-semibold ${
                                isCurrentUser ? 'text-rose-400' : 'text-white'
                              }`}
                            >
                              {msg.authorName}
                            </span>
                            <span className="text-[11px] text-zinc-500 font-mono">
                              {msg.timestamp}
                            </span>
                          </div>
                        )}

                        <div className="text-xs text-zinc-200 leading-relaxed break-words">
                          {msg.content}
                        </div>
                      </div>
                    </div>
                  </React.Fragment>
                );
              })
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* Typing Composer Input Box */}
          <div className="p-3.5 bg-[#090b10] border-t border-white/[0.06] shrink-0">
            <div className="flex items-center gap-2 bg-[#0e1118]/90 border border-white/[0.08] focus-within:border-rose-500/50 rounded-2xl px-3.5 py-2 transition-all shadow-sm">
              <Tooltip content="Anexar arquivo" position="top">
                <button
                  type="button"
                  className="text-zinc-400 hover:text-zinc-200 transition-colors p-1 cursor-pointer"
                >
                  <Paperclip className="w-4 h-4" />
                </button>
              </Tooltip>

              <input
                type="text"
                value={draftMessage}
                onChange={(e) => handleDraftChange(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={
                  isOnline
                    ? `Conversar com @${activePartnerUsername || activePartnerName}... (Pressione Enter)`
                    : `Conversar com @${selectedDemoFriend?.name}... (Pressione Enter)`
                }
                className="flex-1 bg-transparent text-xs text-zinc-100 placeholder-zinc-500 focus:outline-none py-1"
              />

              <Tooltip content="Adicionar Emoji" position="top">
                <button
                  type="button"
                  className="text-zinc-400 hover:text-zinc-200 transition-colors p-1 cursor-pointer"
                >
                  <Smile className="w-4 h-4" />
                </button>
              </Tooltip>

              <Tooltip content="Enviar mensagem" position="top">
                <button
                  type="button"
                  onClick={handleSendMessage}
                  disabled={!draftMessage.trim() || isSendingDm}
                  className={`p-2 rounded-xl transition-all cursor-pointer ${
                    draftMessage.trim() && !isSendingDm
                      ? 'bg-rose-600 hover:bg-rose-500 text-white shadow-sm shadow-rose-950/60 active:scale-95'
                      : 'bg-white/[0.04] text-zinc-600 cursor-not-allowed'
                  }`}
                >
                  {isSendingDm ? (
                    <RotateCw className="w-3.5 h-3.5 animate-spin text-white" />
                  ) : (
                    <Send className="w-3.5 h-3.5" />
                  )}
                </button>
              </Tooltip>
            </div>
            <div className="flex items-center justify-between mt-1.5 px-2 text-[10px] text-zinc-500">
              <span>Enter para enviar • Shift + Enter para quebra de linha</span>
              <span className="flex items-center gap-1 font-mono">
                {isOnline ? (
                  <>
                    <CheckCheck className="w-3.5 h-3.5 text-emerald-400" />
                    <span>Comunicação Privada Segura • Sincronização em Tempo Real (Gateway)</span>
                  </>
                ) : (
                  <>
                    <HardDrive className="w-3.5 h-3.5 text-emerald-400" />
                    <span>Armazenamento Local SQLite • Modo Demonstração Offline</span>
                  </>
                )}
              </span>
            </div>
          </div>
        </div>
      ) : (
        /* Empty State */
        <div className="flex-1 flex flex-col items-center justify-center p-8 text-center bg-[#07080b]">
          <div className="w-14 h-14 rounded-2xl bg-white/[0.03] border border-white/[0.06] flex items-center justify-center text-zinc-400 mb-4 shadow-inner">
            <MessageSquare className="w-7 h-7 text-rose-500" />
          </div>
          <h3 className="text-base font-bold text-white mb-1.5">
            Nenhuma conversa selecionada
          </h3>
          <p className="text-xs text-zinc-400 max-w-sm leading-relaxed mb-4">
            {isOnline
              ? "Selecione uma conversa ao lado ou clique em 'Nova Conversa' para falar com um amigo."
              : "Selecione um contato na lista lateral para abrir o histórico de mensagens ou iniciar uma conversa direta."}
          </p>
          {isOnline && (
            <button
              type="button"
              onClick={() => setShowFriendsList(true)}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-rose-950/30 hover:bg-rose-900/40 text-rose-200 hover:text-white border border-rose-500/40 hover:border-rose-500/60 text-xs font-medium transition-all shadow-sm shadow-rose-950/40 cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5 text-rose-400" />
              <span>Nova Conversa</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
};
