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
import { EmptyState } from '../../components/EmptyState';
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
  const friends = useAppStore((state) => state.friends);
  const joinCall = useAppStore((state) => state.joinCall);
  const setActiveTab = useAppStore((state) => state.setActiveTab);

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
  }, [isOnline]);

  // Select active conversation partner
  const selectedOnlineConv = conversations.find((c) => c.id === activeConversationId);
  const selectedDemoFriend = allDemoFriends.find((f) => f.id === activeDmId) || allDemoFriends[0];

  // Auto-scroll on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [activeConversationMessages.length, demoMessages.length]);

  // -------------------------------------------------------------
  // Offline Demo Mode Logic
  // -------------------------------------------------------------
  useEffect(() => {
    if (isOnline || !selectedDemoFriend) return;

    const friendId = selectedDemoFriend.id;
    const friendName = selectedDemoFriend.name;

    async function loadDemoData() {
      try {
        await conversationRepository.ensureConversation(friendId, 'dm', friendName);
        const state = await conversationRepository.getConversationState(friendId);
        const savedDraft = state?.draft_text || '';
        setDraftMessage(savedDraft);
        currentDraftRef.current = savedDraft;

        const dbMsgs = await messageRepository.getMessages(friendId, 25);
        const formatted = dbMsgs.map((m) =>
          formatDbMessage(m, friendName, currentUser.displayName)
        );
        setDemoMessages(formatted);

        if (dbMsgs.length > 0) {
          const lastMsg = dbMsgs[dbMsgs.length - 1];
          await conversationRepository.markAsRead(friendId, lastMsg.id);
        }
      } catch (err: any) {
        console.error('[MessagesView] Erro ao carregar conversa demo:', err);
      }
    }

    loadDemoData();
  }, [isOnline, selectedDemoFriend?.id]);

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
      const ok = await sendDirectMessage(content);
      if (!ok) {
        setDraftMessage(content);
      }
    } else {
      if (!selectedDemoFriend) return;
      setDraftMessage('');
      currentDraftRef.current = '';

      try {
        await conversationRepository.ensureConversation(
          selectedDemoFriend.id,
          'dm',
          selectedDemoFriend.name
        );
        await conversationRepository.saveDraft(selectedDemoFriend.id, '');
        const savedDb = await messageRepository.saveMessage(
          selectedDemoFriend.id,
          currentUser.id,
          content
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

  return (
    <div className="flex-1 flex overflow-hidden">
      {/* Lateral Direct Messages List */}
      <div className="w-64 bg-nexus-surface border-r border-nexus-border flex flex-col shrink-0 select-none">
        <div className="p-3 border-b border-nexus-border space-y-2">
          <div className="relative flex items-center">
            <Search className="w-3.5 h-3.5 absolute left-2.5 text-nexus-muted pointer-events-none" />
            <input
              type="text"
              value={searchFilter}
              onChange={(e) => setSearchFilter(e.target.value)}
              placeholder="Filtrar conversas..."
              className="w-full bg-nexus-bg text-nexus-text text-xs pl-8 pr-2.5 py-1.5 rounded border border-nexus-border focus:border-nexus-accent focus:outline-none transition-nexus"
            />
          </div>

          {isOnline && (
            <button
              onClick={() => setShowFriendsList(!showFriendsList)}
              className="w-full flex items-center justify-center gap-1.5 py-1 px-2 rounded bg-nexus-panel hover:bg-nexus-panel/80 border border-nexus-border text-xs text-nexus-text font-medium transition-nexus cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5 text-nexus-accent" />
              <span>Nova Conversa</span>
            </button>
          )}
        </div>

        {/* Modal/Dropdown for selecting a friend to start a DM */}
        {showFriendsList && isOnline && (
          <div className="p-2 border-b border-nexus-border bg-nexus-bg space-y-1 max-h-48 overflow-y-auto">
            <div className="px-2 py-1 text-[10px] font-bold text-nexus-muted uppercase tracking-wider flex justify-between items-center">
              <span>Selecione um amigo</span>
              <button
                onClick={() => setShowFriendsList(false)}
                className="text-nexus-muted hover:text-white"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
            {friends.length === 0 ? (
              <p className="text-[11px] text-nexus-muted px-2 py-2">
                Nenhum amigo online ou adicionado ainda.
              </p>
            ) : (
              friends.map((f) => (
                <button
                  key={f.id}
                  onClick={() => handleStartWithFriend(f.id)}
                  className="w-full flex items-center gap-2 p-1.5 rounded hover:bg-nexus-panel text-left text-xs text-nexus-text transition-nexus cursor-pointer"
                >
                  <Avatar name={f.name} status={f.status} size="sm" />
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold truncate">{f.name}</p>
                    <p className="text-[10px] text-nexus-muted font-mono">{f.tag}</p>
                  </div>
                </button>
              ))
            )}
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          <div className="px-2 py-1 text-[10px] font-bold text-nexus-muted uppercase tracking-wider flex items-center justify-between">
            <span>Mensagens Diretas</span>
            {isOnline && (
              <span className="text-[9px] text-emerald-400 font-normal">Ao vivo</span>
            )}
          </div>

          {/* ONLINE REAL CONVERSATIONS */}
          {isOnline ? (
            filteredOnlineConvs.length === 0 ? (
              <div className="px-2 py-6 text-center text-xs text-nexus-muted">
                {isLoadingConversations ? (
                  <p>Carregando conversas...</p>
                ) : (
                  <p>Nenhuma conversa ativa ainda. Clique em "Nova Conversa" para falar com um amigo.</p>
                )}
              </div>
            ) : (
              filteredOnlineConvs.map((conv) => {
                const isSelected = activeConversationId === conv.id;
                const lastMsg = conv.last_message;
                const lastMsgPreview = lastMsg
                  ? lastMsg.deleted_at
                    ? '[Mensagem apagada]'
                    : lastMsg.content
                  : 'Nenhuma mensagem';

                const timePreview = lastMsg
                  ? formatDateKey(lastMsg.created_at).time
                  : '';

                return (
                  <button
                    key={conv.id}
                    onClick={() => selectConversation(conv.id)}
                    className={`w-full flex items-center gap-2.5 p-2 rounded text-left transition-nexus cursor-pointer ${
                      isSelected
                        ? 'bg-nexus-panel text-white border-l-2 border-nexus-accent'
                        : 'text-nexus-muted hover:bg-nexus-panel/60 hover:text-nexus-text'
                    }`}
                  >
                    <Avatar
                      name={conv.other_user.name}
                      status={conv.other_user.status}
                      size="sm"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-semibold truncate text-nexus-text">
                          {conv.other_user.name}
                        </span>
                        {timePreview && (
                          <span className="text-[10px] text-nexus-muted shrink-0 font-mono">
                            {timePreview}
                          </span>
                        )}
                      </div>
                      <p className="text-[11px] truncate text-nexus-muted">
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
                  onClick={() => {
                    setActiveDm(friend.id);
                  }}
                  className={`w-full flex items-center gap-2.5 p-2 rounded text-left transition-nexus cursor-pointer ${
                    isSelected
                      ? 'bg-nexus-panel text-white border-l-2 border-nexus-accent'
                      : 'text-nexus-muted hover:bg-nexus-panel/60 hover:text-nexus-text'
                  }`}
                >
                  <Avatar name={friend.name} status={friend.status} size="sm" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold truncate text-nexus-text">
                        {friend.name}
                      </span>
                      <span className="text-[10px] text-nexus-muted shrink-0">
                        {dm.timestamp}
                      </span>
                    </div>
                    <p className="text-[11px] truncate text-nexus-muted">{dm.lastMessage}</p>
                  </div>
                  {dm.unreadCount > 0 && <Badge count={dm.unreadCount} />}
                </button>
              );
            })
          )}
        </div>
      </div>

      {/* Main Conversation Pane */}
      {(isOnline && selectedOnlineConv) || (!isOnline && selectedDemoFriend) ? (
        <div className="flex-1 flex flex-col bg-nexus-bg overflow-hidden">
          {/* Header */}
          <div className="h-12 border-b border-nexus-border px-4 flex items-center justify-between bg-nexus-surface shrink-0">
            <div className="flex items-center gap-3">
              <Avatar
                name={
                  isOnline
                    ? selectedOnlineConv!.other_user.name
                    : selectedDemoFriend.name
                }
                status={
                  isOnline
                    ? selectedOnlineConv!.other_user.status
                    : selectedDemoFriend.status
                }
                size="sm"
              />
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-xs font-bold text-nexus-text">
                    {isOnline
                      ? selectedOnlineConv!.other_user.name
                      : selectedDemoFriend.name}
                  </h3>
                  <span className="text-[10px] text-nexus-muted font-mono">
                    {isOnline
                      ? selectedOnlineConv!.other_user.tag
                      : selectedDemoFriend.tag}
                  </span>
                </div>
                <p className="text-[10px] text-nexus-muted truncate">
                  {isOnline
                    ? selectedOnlineConv!.other_user.activity ||
                      selectedOnlineConv!.other_user.customStatus ||
                      'Disponível'
                    : selectedDemoFriend.activity ||
                      selectedDemoFriend.customStatus ||
                      'Disponível'}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={startQuickCall}
                className="flex items-center gap-2 px-3.5 py-1.5 rounded-lg bg-emerald-600/90 hover:bg-emerald-500 text-white font-semibold text-xs transition-nexus shadow-sm shadow-emerald-950/40 cursor-pointer active:scale-95"
                title={`Iniciar chamada de voz P2P via Tailscale com ${
                  isOnline ? selectedOnlineConv!.other_user.name : selectedDemoFriend?.name
                }`}
              >
                <Phone className="w-3.5 h-3.5" />
                <span>Ligar</span>
              </button>
            </div>
          </div>

          {/* Real Error Banner */}
          {(localError || dmError) && (
            <div className="bg-red-500/15 border-b border-red-500/30 px-4 py-2 flex items-center justify-between text-xs text-red-300 shrink-0">
              <div className="flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
                <span>{localError || dmError}</span>
              </div>
              <button
                onClick={() => setLocalError(null)}
                className="text-[11px] text-red-400 hover:text-white underline ml-2 cursor-pointer"
              >
                Dispensar
              </button>
            </div>
          )}

          {/* Messages History Pane */}
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {/* Online load older messages pagination */}
            {isOnline && activeConversationMessages.length >= 25 && (
              <div className="flex justify-center pb-2">
                <button
                  onClick={() => loadOlderMessages()}
                  disabled={isLoadingMessages}
                  className="inline-flex items-center gap-1.5 px-3 py-1 rounded bg-nexus-surface hover:bg-nexus-panel border border-nexus-border text-[11px] text-nexus-muted hover:text-nexus-text transition-nexus cursor-pointer"
                >
                  <ChevronUp className="w-3.5 h-3.5" />
                  <span>Carregar mensagens anteriores</span>
                </button>
              </div>
            )}

            {/* Header intro */}
            <div className="flex flex-col items-center justify-center py-6 border-b border-nexus-border/30">
              <Avatar
                name={
                  isOnline
                    ? selectedOnlineConv!.other_user.name
                    : selectedDemoFriend.name
                }
                size="lg"
                className="mb-2"
              />
              <h4 className="text-sm font-bold text-nexus-text">
                {isOnline
                  ? selectedOnlineConv!.other_user.name
                  : selectedDemoFriend.name}
              </h4>
              <p className="text-xs text-nexus-muted">
                {isOnline
                  ? `Início da sua conversa privada com @${selectedOnlineConv!.other_user.username}`
                  : `Histórico local de demonstração com @${selectedDemoFriend.name}`}
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

                return (
                  <React.Fragment key={msg.id}>
                    {showDateDivider && (
                      <div className="flex items-center my-4">
                        <div className="flex-1 border-t border-nexus-border/50"></div>
                        <span className="px-3 text-[10px] font-semibold uppercase tracking-wider text-nexus-muted bg-nexus-panel/60 py-0.5 rounded-full border border-nexus-border/40">
                          {dateKey}
                        </span>
                        <div className="flex-1 border-t border-nexus-border/50"></div>
                      </div>
                    )}

                    <div
                      className={`group relative flex items-start gap-3 hover:bg-nexus-surface/30 px-2 py-1 rounded transition-nexus ${
                        isGroupedWithPrev ? 'mt-0.5 pl-12' : 'mt-2'
                      }`}
                    >
                      {!isGroupedWithPrev && (
                        <Avatar
                          name={isAuthorMe ? currentUser.displayName : selectedOnlineConv!.other_user.name}
                          size="sm"
                          className="shrink-0 mt-0.5"
                        />
                      )}

                      <div className="flex-1 min-w-0">
                        {!isGroupedWithPrev && (
                          <div className="flex items-center gap-2 mb-0.5">
                            <span
                              className={`text-xs font-bold ${
                                isAuthorMe ? 'text-nexus-accent' : 'text-nexus-text'
                              }`}
                            >
                              {isAuthorMe ? currentUser.displayName : selectedOnlineConv!.other_user.name}
                            </span>
                            <span className="text-[10px] text-nexus-muted font-mono">
                              {time}
                            </span>
                            {msg.edited_at && !isDeleted && (
                              <span className="text-[9px] text-nexus-muted italic">
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
                              className="flex-1 bg-nexus-surface text-xs text-nexus-text px-2.5 py-1 rounded border border-nexus-accent focus:outline-none"
                              autoFocus
                            />
                            <button
                              onClick={handleSaveEdit}
                              className="px-2 py-1 bg-nexus-accent text-white text-[10px] font-bold rounded"
                            >
                              Salvar
                            </button>
                            <button
                              onClick={handleCancelEdit}
                              className="px-2 py-1 bg-nexus-panel text-nexus-muted text-[10px] rounded hover:text-white"
                            >
                              Cancelar
                            </button>
                          </div>
                        ) : (
                          <div
                            className={`text-xs leading-relaxed break-words ${
                              isDeleted
                                ? 'text-nexus-muted italic select-none'
                                : 'text-nexus-text/95'
                            }`}
                          >
                            {msg.content}
                          </div>
                        )}

                        {/* Delivery Status Indicator for my messages */}
                        {isAuthorMe && (
                          <div className="flex items-center gap-1 mt-0.5">
                            {msg.delivery_status === 'sending' && (
                              <Tooltip content="Enviando...">
                                <Clock className="w-3 h-3 text-nexus-muted animate-spin" />
                              </Tooltip>
                            )}
                            {msg.delivery_status === 'failed' && (
                              <Tooltip content="Falha no envio">
                                <AlertCircle className="w-3 h-3 text-red-400" />
                              </Tooltip>
                            )}
                            {(!msg.delivery_status || msg.delivery_status === 'sent') && (
                              <Tooltip content="Enviado ao servidor">
                                <Check className="w-3 h-3 text-nexus-muted" />
                              </Tooltip>
                            )}
                            {msg.delivery_status === 'delivered' && (
                              <Tooltip content="Entregue ao dispositivo do destinatário">
                                <CheckCheck className="w-3 h-3 text-nexus-muted" />
                              </Tooltip>
                            )}
                            {(msg.read_at || msg.delivery_status === 'read') && (
                              <Tooltip content="Lido pelo destinatário">
                                <CheckCheck className="w-3 h-3 text-nexus-accent" />
                              </Tooltip>
                            )}
                          </div>
                        )}
                      </div>

                      {/* Action buttons (Edit / Delete) for author */}
                      {isAuthorMe && !isDeleted && !isEditing && (
                        <div className="hidden group-hover:flex items-center gap-1 bg-nexus-surface border border-nexus-border px-1 py-0.5 rounded shadow-sm">
                          <Tooltip content="Editar mensagem">
                            <button
                              onClick={() => handleStartEdit(msg)}
                              className="p-1 text-nexus-muted hover:text-nexus-text hover:bg-nexus-panel rounded transition-nexus"
                            >
                              <Edit2 className="w-3 h-3" />
                            </button>
                          </Tooltip>
                          <Tooltip content="Apagar mensagem">
                            <button
                              onClick={() => handleDelete(msg.id)}
                              className="p-1 text-nexus-muted hover:text-red-400 hover:bg-nexus-panel rounded transition-nexus"
                            >
                              <Trash2 className="w-3 h-3" />
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
                      <div className="flex items-center my-4">
                        <div className="flex-1 border-t border-nexus-border/50"></div>
                        <span className="px-3 text-[10px] font-semibold uppercase tracking-wider text-nexus-muted bg-nexus-panel/60 py-0.5 rounded-full border border-nexus-border/40">
                          {msg.dateKey}
                        </span>
                        <div className="flex-1 border-t border-nexus-border/50"></div>
                      </div>
                    )}

                    <div
                      className={`group flex items-start gap-3 hover:bg-nexus-surface/30 px-2 py-1 rounded transition-nexus ${
                        isGroupedWithPrev ? 'mt-0.5 pl-12' : 'mt-2'
                      }`}
                    >
                      {!isGroupedWithPrev && (
                        <Avatar
                          name={msg.authorName}
                          size="sm"
                          className="shrink-0 mt-0.5"
                        />
                      )}

                      <div className="flex-1 min-w-0">
                        {!isGroupedWithPrev && (
                          <div className="flex items-center gap-2 mb-0.5">
                            <span
                              className={`text-xs font-bold ${
                                isCurrentUser ? 'text-nexus-accent' : 'text-nexus-text'
                              }`}
                            >
                              {msg.authorName}
                            </span>
                            <span className="text-[10px] text-nexus-muted font-mono">
                              {msg.timestamp}
                            </span>
                          </div>
                        )}

                        <div className="text-xs text-nexus-text/95 leading-relaxed break-words">
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

          {/* Typing Input Box */}
          <div className="p-3 bg-nexus-surface border-t border-nexus-border shrink-0">
            <div className="flex items-center gap-2 bg-nexus-bg border border-nexus-border rounded-lg px-3 py-2 focus-within:border-nexus-accent transition-nexus">
              <Tooltip content="Anexar arquivo" position="top">
                <button className="text-nexus-muted hover:text-nexus-text transition-nexus">
                  <Paperclip className="w-4 h-4" />
                </button>
              </Tooltip>

              <input
                type="text"
                value={draftMessage}
                onChange={(e) => setDraftMessage(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={
                  isOnline
                    ? `Conversar com @${selectedOnlineConv!.other_user.username}... (Pressione Enter)`
                    : `Conversar com @${selectedDemoFriend.name}... (Pressione Enter)`
                }
                className="flex-1 bg-transparent text-xs text-nexus-text placeholder-nexus-muted focus:outline-none"
              />

              <Tooltip content="Adicionar Emoji" position="top">
                <button className="text-nexus-muted hover:text-nexus-text transition-nexus">
                  <Smile className="w-4 h-4" />
                </button>
              </Tooltip>

              <Tooltip content="Enviar mensagem" position="top">
                <button
                  onClick={handleSendMessage}
                  disabled={!draftMessage.trim() || isSendingDm}
                  className={`p-1.5 rounded transition-nexus cursor-pointer ${
                    draftMessage.trim() && !isSendingDm
                      ? 'bg-nexus-accent text-white hover:bg-nexus-accent-hover'
                      : 'bg-nexus-panel text-nexus-muted cursor-not-allowed'
                  }`}
                >
                  {isSendingDm ? (
                    <RotateCw className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Send className="w-3.5 h-3.5" />
                  )}
                </button>
              </Tooltip>
            </div>
            <div className="flex items-center justify-between mt-1 px-1 text-[10px] text-nexus-muted">
              <span>Enter para enviar • Shift + Enter para quebra de linha</span>
              <span className="flex items-center gap-1 font-mono">
                {isOnline ? (
                  <>
                    <CheckCheck className="w-3 h-3 text-emerald-400" /> Comunicação Privada Segura • Sincronização em Tempo Real (Gateway)
                  </>
                ) : (
                  <>
                    <HardDrive className="w-3 h-3 text-emerald-400" /> Armazenamento Local SQLite • Modo Demonstração Offline
                  </>
                )}
              </span>
            </div>
          </div>
        </div>
      ) : (
        <EmptyState
          icon={MessageSquare}
          title="Nenhuma conversa selecionada"
          description={
            isOnline
              ? "Selecione uma conversa ao lado ou clique em 'Nova Conversa' para falar com um amigo."
              : "Selecione um contato na lista lateral para abrir o histórico de mensagens ou iniciar uma conversa direta."
          }
        />
      )}
    </div>
  );
};
