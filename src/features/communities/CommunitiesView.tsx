import React, { useState, useRef, useEffect } from 'react';
import {
  Hash,
  Volume2,
  Users,
  Send,
  Plus,
  Smile,
  Paperclip,
  Bell,
  Settings,
  Radio,
  Gamepad2,
} from 'lucide-react';
import { useAppStore } from '../../stores/useAppStore';
import { mockCommunities, mockFriends, mockCommunityMessages } from '../../mocks';
import { Avatar } from '../../components/Avatar';
import { Badge } from '../../components/Badge';
import { Tooltip } from '../../components/Tooltip';
import { EmptyState } from '../../components/EmptyState';
import { ChatMessage } from '../../lib/types';

export const CommunitiesView: React.FC = () => {
  const activeCommunityId = useAppStore((state) => state.activeCommunityId);
  const activeChannelId = useAppStore((state) => state.activeChannelId);
  const setActiveChannel = useAppStore((state) => state.setActiveChannel);
  const currentUser = useAppStore((state) => state.currentUser);
  const joinCall = useAppStore((state) => state.joinCall);
  const setActiveTab = useAppStore((state) => state.setActiveTab);

  const [channelDraft, setChannelDraft] = useState('');
  const [showMembers, setShowMembers] = useState(true);
  const [communityMessages, setCommunityMessages] = useState<Record<string, ChatMessage[]>>(
    mockCommunityMessages
  );

  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  if (mockCommunities.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-8 bg-nexus-bg select-none">
        <EmptyState
          icon={Users}
          title="Nenhuma comunidade encontrada"
          description="Você ainda não participa de nenhuma comunidade no NEXUS. Crie uma comunidade ou conecte-se com seus amigos para criar grupos e salas de voz privadas."
          actionText="Ir para Início"
          onAction={() => setActiveTab('home')}
        />
      </div>
    );
  }

  const selectedCommunity =
    mockCommunities.find((c) => c.id === activeCommunityId) || mockCommunities[0];

  const selectedChannel =
    selectedCommunity?.channels?.find((ch) => ch.id === activeChannelId) ||
    selectedCommunity?.channels?.[0];

  const activeMessages = selectedChannel
    ? communityMessages[selectedChannel.id] || []
    : [];

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [activeMessages.length, selectedChannel?.id]);

  const handleSendMessage = () => {
    if (!channelDraft.trim() || !selectedChannel) return;

    const now = new Date();
    const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(
      now.getMinutes()
    ).padStart(2, '0')}`;

    const newMsg: ChatMessage = {
      id: `cm_msg_${Date.now()}`,
      authorId: currentUser.id,
      authorName: currentUser.displayName,
      content: channelDraft.trim(),
      timestamp: timeStr,
      dateKey: 'Hoje',
    };

    setCommunityMessages((prev) => ({
      ...prev,
      [selectedChannel.id]: [...(prev[selectedChannel.id] || []), newMsg],
    }));

    setChannelDraft('');
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  const connectToVoiceRoom = () => {
    joinCall(`${selectedCommunity.name} • ${selectedChannel.name}`);
    setActiveTab('calls');
  };

  // Group members into Online, Gaming, and Offline
  const gamingMembers = mockFriends.filter(
    (f) => f.status === 'online' && f.activity?.startsWith('Em jogo')
  );
  const onlineMembers = mockFriends.filter(
    (f) => f.status === 'online' && !f.activity?.startsWith('Em jogo')
  );
  const offlineMembers = mockFriends.filter((f) => f.status === 'offline' || f.status === 'idle');

  return (
    <div className="flex-1 flex overflow-hidden">
      {/* Channels Sidebar */}
      <div className="w-56 bg-nexus-surface border-r border-nexus-border flex flex-col shrink-0 select-none">
        {/* Community Info Header */}
        <div className="h-12 border-b border-nexus-border px-3.5 flex items-center justify-between font-bold text-xs text-nexus-text">
          <div className="flex items-center gap-2 truncate">
            <div
              className="w-5 h-5 rounded flex items-center justify-center text-[10px] text-white shrink-0 font-extrabold"
              style={{ backgroundColor: selectedCommunity.iconBg }}
            >
              {selectedCommunity.initials}
            </div>
            <span className="truncate">{selectedCommunity.name}</span>
          </div>

          <Tooltip content="Configurações da Comunidade" position="left">
            <button className="text-nexus-muted hover:text-nexus-text transition-nexus">
              <Settings className="w-3.5 h-3.5" />
            </button>
          </Tooltip>
        </div>

        {/* Channel Categories & List */}
        <div className="flex-1 overflow-y-auto p-2 space-y-4">
          {/* Text Channels Section */}
          <div>
            <div className="px-2 py-1 text-[10px] font-bold text-nexus-muted uppercase tracking-wider flex items-center justify-between">
              <span>Canais de Texto</span>
              <Tooltip content="Criar canal" position="top">
                <button className="hover:text-nexus-text transition-nexus">
                  <Plus className="w-3 h-3" />
                </button>
              </Tooltip>
            </div>

            <div className="space-y-0.5 mt-1">
              {selectedCommunity.channels
                .filter((ch) => ch.type === 'text')
                .map((ch) => {
                  const isActive = selectedChannel.id === ch.id;
                  return (
                    <button
                      key={ch.id}
                      onClick={() => setActiveChannel(ch.id)}
                      className={`w-full flex items-center justify-between px-2 py-1.5 rounded text-xs transition-nexus ${
                        isActive
                          ? 'bg-nexus-panel text-white font-medium border-l-2 border-nexus-accent shadow-sm'
                          : 'text-nexus-muted hover:bg-nexus-panel/50 hover:text-nexus-text'
                      }`}
                    >
                      <div className="flex items-center gap-2 truncate">
                        <Hash className="w-3.5 h-3.5 text-nexus-muted shrink-0" />
                        <span className="truncate">{ch.name}</span>
                      </div>
                      {ch.unreadCount && ch.unreadCount > 0 ? (
                        <Badge count={ch.unreadCount} />
                      ) : null}
                    </button>
                  );
                })}
            </div>
          </div>

          {/* Voice Channels Section */}
          <div>
            <div className="px-2 py-1 text-[10px] font-bold text-nexus-muted uppercase tracking-wider flex items-center justify-between">
              <span>Canais de Voz</span>
              <Tooltip content="Criar canal de voz" position="top">
                <button className="hover:text-nexus-text transition-nexus">
                  <Plus className="w-3 h-3" />
                </button>
              </Tooltip>
            </div>

            <div className="space-y-0.5 mt-1">
              {selectedCommunity.channels
                .filter((ch) => ch.type === 'voice')
                .map((ch) => {
                  const isActive = selectedChannel.id === ch.id;
                  return (
                    <button
                      key={ch.id}
                      onClick={() => setActiveChannel(ch.id)}
                      className={`w-full flex items-center justify-between px-2 py-1.5 rounded text-xs transition-nexus ${
                        isActive
                          ? 'bg-nexus-panel text-white font-medium border-l-2 border-nexus-accent'
                          : 'text-nexus-muted hover:bg-nexus-panel/50 hover:text-nexus-text'
                      }`}
                    >
                      <div className="flex items-center gap-2 truncate">
                        <Volume2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                        <span className="truncate">{ch.name}</span>
                      </div>
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400/80 shrink-0" />
                    </button>
                  );
                })}
            </div>
          </div>
        </div>
      </div>

      {/* Main Channel Area */}
      <div className="flex-1 flex flex-col bg-nexus-bg overflow-hidden">
        {/* Top Channel Header */}
        <div className="h-12 border-b border-nexus-border px-4 flex items-center justify-between bg-nexus-surface shrink-0 select-none">
          <div className="flex items-center gap-2 truncate">
            {selectedChannel.type === 'text' ? (
              <Hash className="w-4 h-4 text-nexus-muted shrink-0" />
            ) : (
              <Volume2 className="w-4 h-4 text-emerald-400 shrink-0" />
            )}
            <span className="text-xs font-bold text-nexus-text">{selectedChannel.name}</span>
            {selectedChannel.topic && (
              <span className="text-[11px] text-nexus-muted ml-2 border-l border-nexus-border pl-2 truncate hidden sm:inline">
                {selectedChannel.topic}
              </span>
            )}
          </div>

          <div className="flex items-center gap-1.5 text-nexus-muted">
            <Tooltip content="Notificações do Canal" position="bottom">
              <button className="p-1.5 rounded hover:bg-nexus-panel hover:text-nexus-text transition-nexus">
                <Bell className="w-4 h-4" />
              </button>
            </Tooltip>

            <Tooltip content="Membros da Comunidade" position="bottom">
              <button
                onClick={() => setShowMembers(!showMembers)}
                className={`p-1.5 rounded transition-nexus ${
                  showMembers
                    ? 'text-nexus-accent bg-nexus-panel'
                    : 'hover:bg-nexus-panel hover:text-nexus-text'
                }`}
              >
                <Users className="w-4 h-4" />
              </button>
            </Tooltip>
          </div>
        </div>

        {/* Content Body: Text or Voice Channel */}
        {selectedChannel.type === 'text' ? (
          <div className="flex-1 flex flex-col justify-between overflow-hidden">
            {/* Messages Feed */}
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              <div className="py-6 border-b border-nexus-border/30">
                <div className="w-10 h-10 rounded-lg bg-nexus-surface border border-nexus-border flex items-center justify-center mb-2">
                  <Hash className="w-5 h-5 text-nexus-text" />
                </div>
                <h3 className="text-base font-bold text-nexus-text">
                  Bem-vindo a #{selectedChannel.name}!
                </h3>
                <p className="text-xs text-nexus-muted mt-1">
                  Este é o início do canal #{selectedChannel.name} na comunidade {selectedCommunity.name}.
                </p>
              </div>

              {/* Render Channel Messages */}
              {activeMessages.map((msg, index) => {
                const prevMsg = activeMessages[index - 1];
                const showDateDivider = !prevMsg || prevMsg.dateKey !== msg.dateKey;
                const isGrouped = !showDateDivider && prevMsg && prevMsg.authorId === msg.authorId;
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
                      className={`flex items-start gap-3 hover:bg-nexus-surface/30 px-2 py-1 rounded transition-nexus ${
                        isGrouped ? 'mt-0.5 pl-12' : 'mt-2'
                      }`}
                    >
                      {!isGrouped && (
                        <Avatar name={msg.authorName} size="sm" className="shrink-0 mt-0.5" />
                      )}

                      <div className="flex-1 min-w-0">
                        {!isGrouped && (
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

                        {msg.reactions && msg.reactions.length > 0 && (
                          <div className="flex items-center gap-1.5 mt-1.5">
                            {msg.reactions.map((react, rIdx) => (
                              <button
                                key={rIdx}
                                className={`flex items-center gap-1 px-2 py-0.5 rounded text-[11px] border transition-nexus ${
                                  react.userReacted
                                    ? 'bg-nexus-accent/20 border-nexus-accent/40 text-nexus-text'
                                    : 'bg-nexus-panel border-nexus-border text-nexus-muted'
                                }`}
                              >
                                <span>{react.emoji}</span>
                                <span className="font-mono text-[10px]">{react.count}</span>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  </React.Fragment>
                );
              })}

              <div ref={messagesEndRef} />
            </div>

            {/* Input Bar */}
            <div className="p-3 bg-nexus-surface border-t border-nexus-border shrink-0">
              <div className="flex items-center gap-2 bg-nexus-bg border border-nexus-border rounded-lg px-3 py-2 focus-within:border-nexus-accent transition-nexus">
                <Tooltip content="Anexar arquivo" position="top">
                  <button className="text-nexus-muted hover:text-nexus-text transition-nexus">
                    <Paperclip className="w-4 h-4" />
                  </button>
                </Tooltip>

                <input
                  type="text"
                  value={channelDraft}
                  onChange={(e) => setChannelDraft(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder={`Enviar mensagem em #${selectedChannel.name}...`}
                  className="flex-1 bg-transparent text-xs text-nexus-text placeholder-nexus-muted focus:outline-none"
                />

                <Tooltip content="Emojis" position="top">
                  <button className="text-nexus-muted hover:text-nexus-text transition-nexus">
                    <Smile className="w-4 h-4" />
                  </button>
                </Tooltip>

                <Tooltip content="Enviar" position="top">
                  <button
                    onClick={handleSendMessage}
                    disabled={!channelDraft.trim()}
                    className={`p-1.5 rounded transition-nexus ${
                      channelDraft.trim()
                        ? 'bg-nexus-accent text-white hover:bg-nexus-accent-hover'
                        : 'bg-nexus-panel text-nexus-muted cursor-not-allowed'
                    }`}
                  >
                    <Send className="w-3.5 h-3.5" />
                  </button>
                </Tooltip>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center p-8">
            <EmptyState
              icon={Radio}
              title={`Sala de Voz: ${selectedChannel.name}`}
              description="Conexão direta de voz otimizada em Opus com transmissão de baixa latência e áudio posicional."
              actionText="Conectar à Sala de Voz"
              onAction={connectToVoiceRoom}
            />
          </div>
        )}
      </div>

      {/* Right: Categorized Member List */}
      {showMembers && (
        <div className="w-52 bg-nexus-surface border-l border-nexus-border hidden md:flex flex-col shrink-0 p-3 select-none overflow-y-auto">
          {/* Gaming Section */}
          {gamingMembers.length > 0 && (
            <div className="mb-4">
              <div className="text-[10px] font-bold text-nexus-muted uppercase tracking-wider mb-2 flex items-center gap-1.5">
                <Gamepad2 className="w-3 h-3 text-emerald-400" />
                <span>Em Jogo ({gamingMembers.length})</span>
              </div>
              <div className="space-y-1">
                {gamingMembers.map((m) => (
                  <div
                    key={m.id}
                    className="flex items-center gap-2 p-1.5 rounded hover:bg-nexus-panel transition-nexus cursor-pointer"
                  >
                    <Avatar name={m.name} status={m.status} size="sm" />
                    <div className="truncate">
                      <p className="text-xs font-medium text-nexus-text truncate">{m.name}</p>
                      <p className="text-[10px] text-emerald-400 truncate">{m.activity}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Online Section */}
          <div className="mb-4">
            <div className="text-[10px] font-bold text-nexus-muted uppercase tracking-wider mb-2">
              Online ({onlineMembers.length})
            </div>
            <div className="space-y-1">
              {onlineMembers.map((m) => (
                <div
                  key={m.id}
                  className="flex items-center gap-2 p-1.5 rounded hover:bg-nexus-panel transition-nexus cursor-pointer"
                >
                  <Avatar name={m.name} status={m.status} size="sm" />
                  <div className="truncate">
                    <p className="text-xs font-medium text-nexus-text truncate">{m.name}</p>
                    <p className="text-[10px] text-nexus-muted truncate">
                      {m.customStatus || 'Disponível'}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Offline Section */}
          <div>
            <div className="text-[10px] font-bold text-nexus-muted uppercase tracking-wider mb-2">
              Offline ({offlineMembers.length})
            </div>
            <div className="space-y-1 opacity-70">
              {offlineMembers.map((m) => (
                <div
                  key={m.id}
                  className="flex items-center gap-2 p-1.5 rounded hover:bg-nexus-panel transition-nexus cursor-pointer"
                >
                  <Avatar name={m.name} status={m.status} size="sm" />
                  <div className="truncate">
                    <p className="text-xs font-medium text-nexus-muted truncate">{m.name}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
