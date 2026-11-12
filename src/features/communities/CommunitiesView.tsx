import React, { useState, useRef, useEffect, useMemo } from 'react';
import {
  Hash,
  Volume2,
  Users,
  Send,
  Plus,
  Settings,
  Lock,
  Shield,
  FolderPlus,
  ArrowUp,
  ArrowDown,
  Edit2,
  Trash2,
  ChevronUp,
  AlertCircle,
  X,
  Link2,
  Check,
  Clock,
  Loader2,
  MessageSquareOff,
  Mic,
  MicOff,
  Headphones,
  Monitor,
  PhoneOff,
} from 'lucide-react';
import { useAppStore } from '../../stores/useAppStore';
import {
  ChannelMessageDto,
  CommunityCategoryDto,
  CommunityChannelDto,
  RoomParticipantDto,
} from '../../lib/types';
import { Avatar } from '../../components/Avatar';
import { Badge } from '../../components/Badge';
import { Tooltip } from '../../components/Tooltip';
import { EmptyState } from '../../components/EmptyState';
import { CommunityMemberList } from '../../components/CommunityMemberList';
import { CreateJoinCommunityModal } from './CreateJoinCommunityModal';
import { CommunitySettingsModal } from './CommunitySettingsModal';
import { ChannelManageModal, ChannelManageMode } from './ChannelManageModal';
import { InviteModal } from './InviteModal';
import { VoiceRoomPanel } from './VoiceRoomPanel';
import {
  formatDateTimePtBr,
  formatMessageTimestamp,
  hasCommunityOrAdminPermission,
  isFutureTimestamp,
} from './communityUtils';

export const CommunitiesView: React.FC = () => {
  const communities = useAppStore((state) => state.communities);
  const activeCommunityId = useAppStore((state) => state.activeCommunityId);
  const activeChannelId = useAppStore((state) => state.activeChannelId);
  const communitySnapshot = useAppStore((state) => state.communitySnapshot);
  const activeCommunityChannelMessages = useAppStore(
    (state) => state.activeCommunityChannelMessages
  );
  const communityMessagesHasMore = useAppStore((state) => state.communityMessagesHasMore);
  const isLoadingCommunities = useAppStore((state) => state.isLoadingCommunities);
  const isLoadingCommunitySnapshot = useAppStore((state) => state.isLoadingCommunitySnapshot);
  const isLoadingChannelMessages = useAppStore((state) => state.isLoadingChannelMessages);
  const isSendingChannelMessage = useAppStore((state) => state.isSendingChannelMessage);
  const gatewayConnected = useAppStore((state) => state.gatewayConnected);
  const communityError = useAppStore((state) => state.communityError);
  const currentUserId = useAppStore(
    (state) => state.onlineUser?.id || state.currentUser.id
  );

  const selectCommunity = useAppStore((state) => state.selectCommunity);
  const selectCommunityChannel = useAppStore((state) => state.selectCommunityChannel);
  const loadOlderChannelMessages = useAppStore((state) => state.loadOlderChannelMessages);
  const sendChannelMessage = useAppStore((state) => state.sendChannelMessage);
  const editChannelMessage = useAppStore((state) => state.editChannelMessage);
  const deleteChannelMessage = useAppStore((state) => state.deleteChannelMessage);
  const markChannelRead = useAppStore((state) => state.markChannelRead);
  const reorderCommunityCategories = useAppStore((state) => state.reorderCommunityCategories);
  const deleteCommunityCategory = useAppStore((state) => state.deleteCommunityCategory);
  const reorderCommunityChannels = useAppStore((state) => state.reorderCommunityChannels);
  const deleteCommunityChannel = useAppStore((state) => state.deleteCommunityChannel);
  const clearCommunityError = useAppStore((state) => state.clearCommunityError);

  // Phase B3.2: Multi-participant Voice Room state & actions
  const communityVoiceRooms = useAppStore((state) => state.communityVoiceRooms);
  const voiceRoomState = useAppStore((state) => state.voiceRoomState);
  const activeVoiceCommunityId = useAppStore((state) => state.activeVoiceCommunityId);
  const activeVoiceChannelId = useAppStore((state) => state.activeVoiceChannelId);
  const voiceRoomParticipants = useAppStore((state) => state.voiceRoomParticipants);
  const voiceRoomMuted = useAppStore((state) => state.voiceRoomMuted);
  const voiceRoomDeafened = useAppStore((state) => state.voiceRoomDeafened);
  const loadCommunityVoiceRooms = useAppStore((state) => state.loadCommunityVoiceRooms);
  const leaveVoiceChannel = useAppStore((state) => state.leaveVoiceChannel);
  const toggleVoiceRoomMute = useAppStore((state) => state.toggleVoiceRoomMute);
  const toggleVoiceRoomDeafen = useAppStore((state) => state.toggleVoiceRoomDeafen);

  const [channelDraft, setChannelDraft] = useState('');
  const [showMembers, setShowMembers] = useState(true);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingContent, setEditingContent] = useState('');

  // Modals state
  const [createJoinModal, setCreateJoinModal] = useState<{
    open: boolean;
    tab: 'create' | 'join';
  }>({ open: false, tab: 'create' });
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isInviteOpen, setIsInviteOpen] = useState(false);
  const [channelManageMode, setChannelManageMode] = useState<ChannelManageMode | null>(null);

  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const lastReadMarkedRef = useRef<string | null>(null);

  // Ensure an active community is selected & snapshot is loaded when communities exist
  useEffect(() => {
    if (communities.length === 0) return;
    const validActive =
      activeCommunityId && communities.some((c) => c.id === activeCommunityId);
    if (!validActive) {
      void selectCommunity(communities[0].id);
      return;
    }
    if (
      activeCommunityId &&
      communitySnapshot?.community.id !== activeCommunityId &&
      !isLoadingCommunitySnapshot
    ) {
      void selectCommunity(activeCommunityId);
    }
  }, [
    communities,
    activeCommunityId,
    communitySnapshot?.community.id,
    isLoadingCommunitySnapshot,
    selectCommunity,
  ]);

  const selectedCommunity = useMemo(() => {
    if (communitySnapshot && communitySnapshot.community.id === activeCommunityId) {
      return communitySnapshot.community;
    }
    return communities.find((c) => c.id === activeCommunityId) || null;
  }, [communities, activeCommunityId, communitySnapshot]);

  const categories = useMemo(() => {
    if (!communitySnapshot || communitySnapshot.community.id !== selectedCommunity?.id) {
      return [];
    }
    return [...communitySnapshot.categories].sort((a, b) => a.position - b.position);
  }, [communitySnapshot, selectedCommunity?.id]);

  const channels = useMemo(() => {
    if (!communitySnapshot || communitySnapshot.community.id !== selectedCommunity?.id) {
      return [];
    }
    return [...communitySnapshot.channels].sort((a, b) => a.position - b.position);
  }, [communitySnapshot, selectedCommunity?.id]);

  const selectedChannel: CommunityChannelDto | null = useMemo(() => {
    if (channels.length === 0) return null;
    return channels.find((ch) => ch.id === activeChannelId) || channels[0];
  }, [channels, activeChannelId]);

  const visibleMessages: ChannelMessageDto[] = useMemo(() => {
    if (!selectedCommunity || !selectedChannel) return [];
    return activeCommunityChannelMessages.filter(
      (m) =>
        m.community_id === selectedCommunity.id &&
        m.channel_id === selectedChannel.id &&
        !m.deleted_at
    );
  }, [activeCommunityChannelMessages, selectedCommunity, selectedChannel]);

  // Auto-select first channel if snapshot loaded without activeChannelId
  useEffect(() => {
    if (!selectedCommunity || channels.length === 0) return;
    const exists = activeChannelId && channels.some((c) => c.id === activeChannelId);
    if (!exists) {
      const firstText = channels.find((c) => c.channel_type === 'text') || channels[0];
      if (firstText) {
        void selectCommunityChannel(firstText.id);
      }
    }
  }, [selectedCommunity, channels, activeChannelId, selectCommunityChannel]);

  // Mark channel as read when viewing latest message
  useEffect(() => {
    if (
      !selectedCommunity ||
      !selectedChannel ||
      selectedChannel.channel_type !== 'text' ||
      visibleMessages.length === 0
    ) {
      return;
    }
    const lastMsg = visibleMessages[visibleMessages.length - 1];
    if (!lastMsg || lastMsg.id.startsWith('opt_')) return;
    const markerKey = `${selectedChannel.id}:${lastMsg.id}`;
    if (lastReadMarkedRef.current !== markerKey) {
      lastReadMarkedRef.current = markerKey;
      void markChannelRead(selectedCommunity.id, selectedChannel.id, lastMsg.id);
    }
  }, [selectedCommunity, selectedChannel, visibleMessages, markChannelRead]);

  // Scroll to bottom when channel changes or new message arrives
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [selectedChannel?.id, visibleMessages.length]);

  // Load active voice room participants when opening a community
  useEffect(() => {
    if (!selectedCommunity?.id) return;
    void loadCommunityVoiceRooms(selectedCommunity.id);
  }, [selectedCommunity?.id, loadCommunityVoiceRooms]);

  if (isLoadingCommunities && communities.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-8 bg-nexus-bg select-none">
        <Loader2 className="w-6 h-6 animate-spin text-nexus-accent mb-3" />
        <p className="text-xs text-nexus-muted">Carregando comunidades...</p>
      </div>
    );
  }

  if (communities.length === 0 || !selectedCommunity) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-8 bg-nexus-bg select-none">
        <EmptyState
          icon={Users}
          title="Nenhuma comunidade encontrada"
          description="Você ainda não participa de nenhuma comunidade no NEXUS. Crie sua própria comunidade ou entre usando um código ou link de convite."
          actionText="Criar Comunidade"
          onAction={() => setCreateJoinModal({ open: true, tab: 'create' })}
        />
        <button
          type="button"
          onClick={() => setCreateJoinModal({ open: true, tab: 'join' })}
          className="mt-2 px-4 py-2 rounded-lg text-xs font-medium text-nexus-text bg-nexus-surface hover:bg-nexus-panel border border-nexus-border transition-colors cursor-pointer"
        >
          Entrar por Convite
        </button>

        <CreateJoinCommunityModal
          isOpen={createJoinModal.open}
          initialTab={createJoinModal.tab}
          onClose={() => setCreateJoinModal((p) => ({ ...p, open: false }))}
        />
      </div>
    );
  }

  const isOwner = selectedCommunity.owner_id === currentUserId;
  const canManageChannels =
    isOwner ||
    hasCommunityOrAdminPermission(selectedCommunity.effective_permissions, 'MANAGE_CHANNELS');
  const canManageMessages =
    isOwner ||
    hasCommunityOrAdminPermission(
      selectedChannel?.effective_permissions || selectedCommunity.effective_permissions,
      'MANAGE_MESSAGES'
    );
  const canCreateInvites =
    isOwner ||
    hasCommunityOrAdminPermission(selectedCommunity.effective_permissions, 'CREATE_INVITES') ||
    hasCommunityOrAdminPermission(selectedCommunity.effective_permissions, 'MANAGE_COMMUNITY');

  const isTextMuted = isFutureTimestamp(communitySnapshot?.my_mute?.text_muted_until);
  const hasSendPermission =
    isOwner ||
    hasCommunityOrAdminPermission(
      selectedChannel?.effective_permissions || selectedCommunity.effective_permissions,
      'SEND_MESSAGES'
    );
  const isReadOnlyBlocked = Boolean(selectedChannel?.is_read_only && !canManageMessages);
  const canSendInChannel =
    selectedChannel?.channel_type === 'text' &&
    hasSendPermission &&
    !isReadOnlyBlocked &&
    !isTextMuted;

  const sendBlockedReason = isTextMuted
    ? `Você está silenciado até ${formatDateTimePtBr(
        communitySnapshot?.my_mute?.text_muted_until
      )}.`
    : isReadOnlyBlocked
    ? 'Este canal está em modo somente leitura.'
    : !hasSendPermission
    ? 'Você não tem permissão para enviar mensagens neste canal.'
    : null;

  const handleSendMessage = async () => {
    if (!channelDraft.trim() || !selectedChannel || !canSendInChannel) return;
    const text = channelDraft;
    setChannelDraft('');
    const ok = await sendChannelMessage(text);
    if (!ok) {
      setChannelDraft(text);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSendMessage();
    }
  };

  const handleSaveEdit = async (messageId: string) => {
    const trimmed = editingContent.trim();
    if (!trimmed) return;
    const ok = await editChannelMessage(messageId, trimmed);
    if (ok) {
      setEditingMessageId(null);
      setEditingContent('');
    }
  };

  const handleMoveCategory = async (index: number, direction: -1 | 1) => {
    const targetIdx = index + direction;
    if (targetIdx < 0 || targetIdx >= categories.length) return;
    const reordered = [...categories];
    const [moved] = reordered.splice(index, 1);
    reordered.splice(targetIdx, 0, moved);
    await reorderCommunityCategories(
      selectedCommunity.id,
      reordered.map((c, idx) => ({ id: c.id, position: idx }))
    );
  };

  const handleMoveChannel = async (
    groupChannels: CommunityChannelDto[],
    index: number,
    direction: -1 | 1
  ) => {
    const targetIdx = index + direction;
    if (targetIdx < 0 || targetIdx >= groupChannels.length) return;
    const reordered = [...groupChannels];
    const [moved] = reordered.splice(index, 1);
    reordered.splice(targetIdx, 0, moved);
    await reorderCommunityChannels(
      selectedCommunity.id,
      reordered.map((ch, idx) => ({
        id: ch.id,
        category_id: ch.category_id ?? null,
        position: idx,
      }))
    );
  };

  const renderChannelRow = (
    ch: CommunityChannelDto,
    groupList: CommunityChannelDto[],
    idx: number
  ) => {
    const isActive = selectedChannel?.id === ch.id;
    const isVoice = ch.channel_type === 'voice';
    const isConnectedVoiceHere =
      isVoice &&
      activeVoiceCommunityId === selectedCommunity.id &&
      activeVoiceChannelId === ch.id &&
      voiceRoomState !== 'idle';
    const voiceParticipants: RoomParticipantDto[] = isVoice
      ? isConnectedVoiceHere && voiceRoomParticipants.length > 0
        ? voiceRoomParticipants
        : communityVoiceRooms[selectedCommunity.id]?.[ch.id] || []
      : [];

    return (
      <div key={ch.id} className="space-y-0.5">
        <div
          className={`group flex items-center justify-between gap-1 px-2 py-1.5 rounded text-xs transition-colors ${
            isActive
              ? 'bg-nexus-panel text-white font-medium border-l-2 border-nexus-accent'
              : 'text-nexus-muted hover:bg-nexus-panel/50 hover:text-nexus-text'
          }`}
        >
          <button
            type="button"
            onClick={() => void selectCommunityChannel(ch.id)}
            className="flex items-center gap-1.5 min-w-0 flex-1 text-left cursor-pointer"
          >
            {isVoice ? (
              <Volume2
                className={`w-3.5 h-3.5 shrink-0 ${
                  isConnectedVoiceHere ? 'text-emerald-300' : 'text-emerald-400'
                }`}
              />
            ) : (
              <Hash className="w-3.5 h-3.5 text-nexus-muted shrink-0" />
            )}
            <span className="truncate">{ch.name}</span>
            {ch.is_private && <Lock className="w-3 h-3 text-nexus-muted shrink-0" />}
            {ch.is_read_only && !isVoice && (
              <Shield className="w-3 h-3 text-amber-400/80 shrink-0" />
            )}
          </button>

          <div className="flex items-center gap-0.5 shrink-0">
            {isVoice && voiceParticipants.length > 0 && (
              <span className="px-1.5 py-0.2 rounded bg-emerald-500/15 text-emerald-300 text-[10px] font-semibold tabular-nums">
                {voiceParticipants.length}
              </span>
            )}
            {ch.unread_count > 0 && <Badge count={ch.unread_count} />}
            {canManageChannels && (
              <div className="hidden group-hover:flex items-center gap-0.5">
                <button
                  type="button"
                  onClick={() => void handleMoveChannel(groupList, idx, -1)}
                  disabled={idx === 0}
                  className="p-0.5 text-nexus-muted hover:text-nexus-text disabled:opacity-30 cursor-pointer"
                  title="Subir canal"
                >
                  <ArrowUp className="w-3 h-3" />
                </button>
                <button
                  type="button"
                  onClick={() => void handleMoveChannel(groupList, idx, 1)}
                  disabled={idx === groupList.length - 1}
                  className="p-0.5 text-nexus-muted hover:text-nexus-text disabled:opacity-30 cursor-pointer"
                  title="Descer canal"
                >
                  <ArrowDown className="w-3 h-3" />
                </button>
                <button
                  type="button"
                  onClick={() => setChannelManageMode({ kind: 'edit_channel', channel: ch })}
                  className="p-0.5 text-nexus-muted hover:text-nexus-text cursor-pointer"
                  title="Editar canal e permissões"
                >
                  <Settings className="w-3 h-3" />
                </button>
                <button
                  type="button"
                  onClick={() => void deleteCommunityChannel(selectedCommunity.id, ch.id)}
                  className="p-0.5 text-nexus-muted hover:text-rose-400 cursor-pointer"
                  title="Excluir canal"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            )}
          </div>
        </div>

        {isVoice && voiceParticipants.length > 0 && (
          <div className="pl-5 pr-1.5 py-0.5 space-y-0.5">
            {voiceParticipants.map((p) => {
              const pName = p.display_name || p.username || 'Usuário';
              const isSpeaking = Boolean(p.is_speaking && !p.is_muted);
              return (
                <div
                  key={p.user_id}
                  className="flex items-center justify-between gap-1.5 px-1.5 py-1 rounded hover:bg-nexus-panel/40 text-[11px] text-nexus-text/90"
                >
                  <div className="flex items-center gap-1.5 min-w-0">
                    <div
                      className={`rounded-md shrink-0 ${
                        isSpeaking ? 'ring-1.5 ring-emerald-400' : ''
                      }`}
                    >
                      <Avatar
                        name={pName}
                        avatarUrl={p.avatar_url}
                        size="xs"
                        showStatus={false}
                      />
                    </div>
                    <span className="truncate">{pName}</span>
                  </div>
                  <div className="flex items-center gap-1 shrink-0 text-nexus-muted">
                    {p.is_screen_sharing && (
                      <Monitor className="w-3 h-3 text-indigo-300" />
                    )}
                    {p.is_muted && <MicOff className="w-3 h-3 text-rose-400" />}
                    {p.is_deafened && <Headphones className="w-3 h-3 text-rose-400" />}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  const uncategorizedChannels = channels.filter((ch) => !ch.category_id);

  return (
    <div className="flex-1 flex overflow-hidden">
      {/* Channels Sidebar */}
      <div className="w-60 bg-nexus-surface border-r border-nexus-border flex flex-col shrink-0 select-none">
        {/* Community Header */}
        <div className="h-12 border-b border-nexus-border px-3 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            {selectedCommunity.icon_url ? (
              <img
                src={selectedCommunity.icon_url}
                alt={selectedCommunity.name}
                className="w-5 h-5 rounded object-cover shrink-0"
              />
            ) : (
              <div
                className="w-5 h-5 rounded flex items-center justify-center text-[10px] text-white shrink-0 font-extrabold"
                style={{ backgroundColor: selectedCommunity.icon_bg || '#4f46e5' }}
              >
                {selectedCommunity.initials}
              </div>
            )}
            <span className="truncate font-bold text-xs text-nexus-text">
              {selectedCommunity.name}
            </span>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            {canCreateInvites && (
              <Tooltip content="Convidar pessoas" position="bottom">
                <button
                  type="button"
                  onClick={() => setIsInviteOpen(true)}
                  className="p-1 rounded text-nexus-muted hover:text-nexus-text hover:bg-nexus-panel cursor-pointer"
                >
                  <Link2 className="w-3.5 h-3.5" />
                </button>
              </Tooltip>
            )}
            <Tooltip content="Configurações da Comunidade" position="bottom">
              <button
                type="button"
                onClick={() => setIsSettingsOpen(true)}
                className="p-1 rounded text-nexus-muted hover:text-nexus-text hover:bg-nexus-panel cursor-pointer"
              >
                <Settings className="w-3.5 h-3.5" />
              </button>
            </Tooltip>
          </div>
        </div>

        {/* Quick actions for channels/categories */}
        {canManageChannels && (
          <div className="px-2.5 py-2 border-b border-nexus-border/60 flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setChannelManageMode({ kind: 'create_channel' })}
              className="flex-1 flex items-center justify-center gap-1 py-1 px-2 rounded bg-nexus-panel hover:bg-nexus-bg border border-nexus-border text-[11px] text-nexus-text cursor-pointer"
            >
              <Plus className="w-3 h-3" />
              <span>Canal</span>
            </button>
            <button
              type="button"
              onClick={() => setChannelManageMode({ kind: 'create_category' })}
              className="flex-1 flex items-center justify-center gap-1 py-1 px-2 rounded bg-nexus-panel hover:bg-nexus-bg border border-nexus-border text-[11px] text-nexus-text cursor-pointer"
            >
              <FolderPlus className="w-3 h-3" />
              <span>Categoria</span>
            </button>
          </div>
        )}

        {/* Channel Tree */}
        <div className="flex-1 overflow-y-auto p-2 space-y-4">
          {isLoadingCommunitySnapshot && !communitySnapshot ? (
            <div className="flex items-center justify-center py-8 text-xs text-nexus-muted gap-2">
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>Carregando canais...</span>
            </div>
          ) : channels.length === 0 && categories.length === 0 ? (
            <div className="px-2 py-6 text-center text-xs text-nexus-muted">
              Nenhum canal disponível nesta comunidade.
            </div>
          ) : (
            <>
              {uncategorizedChannels.length > 0 && (
                <div className="space-y-0.5">
                  {uncategorizedChannels.map((ch, idx) =>
                    renderChannelRow(ch, uncategorizedChannels, idx)
                  )}
                </div>
              )}

              {categories.map((cat: CommunityCategoryDto, catIdx: number) => {
                const catChannels = channels.filter((ch) => ch.category_id === cat.id);
                return (
                  <div key={cat.id} className="space-y-1">
                    <div className="group px-2 py-0.5 text-[10px] font-bold text-nexus-muted uppercase tracking-wider flex items-center justify-between gap-1">
                      <span className="truncate">{cat.name}</span>
                      {canManageChannels && (
                        <div className="flex items-center gap-0.5 shrink-0">
                          <div className="hidden group-hover:flex items-center gap-0.5">
                            <button
                              type="button"
                              onClick={() => void handleMoveCategory(catIdx, -1)}
                              disabled={catIdx === 0}
                              className="p-0.5 hover:text-nexus-text disabled:opacity-30 cursor-pointer"
                              title="Subir categoria"
                            >
                              <ArrowUp className="w-3 h-3" />
                            </button>
                            <button
                              type="button"
                              onClick={() => void handleMoveCategory(catIdx, 1)}
                              disabled={catIdx === categories.length - 1}
                              className="p-0.5 hover:text-nexus-text disabled:opacity-30 cursor-pointer"
                              title="Descer categoria"
                            >
                              <ArrowDown className="w-3 h-3" />
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                setChannelManageMode({ kind: 'edit_category', category: cat })
                              }
                              className="p-0.5 hover:text-nexus-text cursor-pointer"
                              title="Renomear categoria"
                            >
                              <Edit2 className="w-3 h-3" />
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                void deleteCommunityCategory(selectedCommunity.id, cat.id)
                              }
                              className="p-0.5 hover:text-rose-400 cursor-pointer"
                              title="Excluir categoria"
                            >
                              <Trash2 className="w-3 h-3" />
                            </button>
                          </div>
                          <button
                            type="button"
                            onClick={() =>
                              setChannelManageMode({
                                kind: 'create_channel',
                                defaultCategoryId: cat.id,
                              })
                            }
                            className="p-0.5 hover:text-nexus-text cursor-pointer"
                            title="Criar canal nesta categoria"
                          >
                            <Plus className="w-3 h-3" />
                          </button>
                        </div>
                      )}
                    </div>

                    <div className="space-y-0.5">
                      {catChannels.length === 0 ? (
                        <div className="px-2 py-1 text-[11px] text-nexus-muted/60 italic">
                          Sem canais
                        </div>
                      ) : (
                        catChannels.map((ch, idx) => renderChannelRow(ch, catChannels, idx))
                      )}
                    </div>
                  </div>
                );
              })}
            </>
          )}
        </div>

        {/* Compact Voice Connection Bar (shown when connected to voice while browsing another channel) */}
        {voiceRoomState !== 'idle' &&
          activeVoiceCommunityId &&
          activeVoiceChannelId &&
          (selectedChannel?.id !== activeVoiceChannelId ||
            selectedCommunity.id !== activeVoiceCommunityId) && (
            <div className="p-2.5 border-t border-nexus-border bg-nexus-panel/90 flex items-center justify-between gap-2 shrink-0">
              <button
                type="button"
                onClick={() => {
                  if (activeVoiceCommunityId !== selectedCommunity.id) {
                    void selectCommunity(activeVoiceCommunityId).then(() =>
                      selectCommunityChannel(activeVoiceChannelId)
                    );
                  } else {
                    void selectCommunityChannel(activeVoiceChannelId);
                  }
                }}
                className="min-w-0 flex-1 text-left cursor-pointer group"
                title="Voltar ao canal de voz"
              >
                <div className="flex items-center gap-1.5 text-[11px] font-semibold text-emerald-400">
                  <span
                    className={`w-2 h-2 rounded-full shrink-0 ${
                      voiceRoomState === 'connected'
                        ? 'bg-emerald-400'
                        : voiceRoomState === 'error'
                        ? 'bg-rose-400'
                        : 'bg-amber-400 animate-pulse'
                    }`}
                  />
                  <span className="truncate">
                    {voiceRoomState === 'connected'
                      ? 'Voz conectada'
                      : voiceRoomState === 'reconnecting'
                      ? 'Reconectando...'
                      : voiceRoomState === 'joining'
                      ? 'Conectando...'
                      : 'Erro na voz'}
                  </span>
                </div>
                <div className="text-[10px] text-nexus-muted truncate group-hover:text-nexus-text">
                  {channels.find((c) => c.id === activeVoiceChannelId)?.name || 'Canal de voz'}
                </div>
              </button>

              <div className="flex items-center gap-1 shrink-0">
                <button
                  type="button"
                  onClick={toggleVoiceRoomMute}
                  className={`p-1.5 rounded transition-colors cursor-pointer ${
                    voiceRoomMuted
                      ? 'bg-rose-500/20 text-rose-300'
                      : 'text-nexus-muted hover:text-nexus-text hover:bg-nexus-surface'
                  }`}
                  title={voiceRoomMuted ? 'Ativar microfone' : 'Mutar microfone'}
                >
                  {voiceRoomMuted ? (
                    <MicOff className="w-3.5 h-3.5" />
                  ) : (
                    <Mic className="w-3.5 h-3.5" />
                  )}
                </button>
                <button
                  type="button"
                  onClick={toggleVoiceRoomDeafen}
                  className={`p-1.5 rounded transition-colors cursor-pointer ${
                    voiceRoomDeafened
                      ? 'bg-rose-500/20 text-rose-300'
                      : 'text-nexus-muted hover:text-nexus-text hover:bg-nexus-surface'
                  }`}
                  title={voiceRoomDeafened ? 'Voltar a ouvir' : 'Ensurdecer'}
                >
                  <Headphones className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => void leaveVoiceChannel()}
                  className="p-1.5 rounded text-rose-400 hover:bg-rose-500/20 transition-colors cursor-pointer"
                  title="Desconectar da voz"
                >
                  <PhoneOff className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          )}
      </div>

      {/* Main Channel Area */}
      <div className="flex-1 flex flex-col bg-nexus-bg overflow-hidden">
        {/* Top Channel Header */}
        <div className="h-12 border-b border-nexus-border px-4 flex items-center justify-between bg-nexus-surface shrink-0 select-none">
          <div className="flex items-center gap-2 min-w-0">
            {selectedChannel ? (
              <>
                {selectedChannel.channel_type === 'voice' ? (
                  <Volume2 className="w-4 h-4 text-emerald-400 shrink-0" />
                ) : (
                  <Hash className="w-4 h-4 text-nexus-muted shrink-0" />
                )}
                <span className="text-xs font-bold text-nexus-text truncate">
                  {selectedChannel.name}
                </span>
                {selectedChannel.is_read_only && selectedChannel.channel_type === 'text' && (
                  <span className="px-1.5 py-0.5 rounded bg-amber-500/15 border border-amber-500/30 text-[10px] text-amber-300 shrink-0">
                    Somente leitura
                  </span>
                )}
                {selectedChannel.topic && (
                  <span className="text-[11px] text-nexus-muted ml-2 border-l border-nexus-border pl-2 truncate hidden sm:inline">
                    {selectedChannel.topic}
                  </span>
                )}
              </>
            ) : (
              <span className="text-xs font-bold text-nexus-text">
                {selectedCommunity.name}
              </span>
            )}
          </div>

          <div className="flex items-center gap-2 text-nexus-muted shrink-0">
            {selectedChannel?.channel_type === 'text' && (
              <Tooltip
                content={
                  gatewayConnected
                    ? 'Conectado em tempo real via WebSocket do Gateway'
                    : 'Conexão com o Gateway interrompida. Tentando reconectar...'
                }
                position="bottom"
              >
                <span
                  className={`hidden md:flex items-center gap-1.5 px-2 py-0.5 rounded bg-nexus-panel/70 border text-[10px] ${
                    gatewayConnected
                      ? 'border-emerald-500/30 text-emerald-400'
                      : 'border-amber-500/30 text-amber-400'
                  }`}
                >
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${
                      gatewayConnected ? 'bg-emerald-400' : 'bg-amber-400 animate-pulse'
                    }`}
                  />
                  <span>{gatewayConnected ? 'Tempo real' : 'Reconectando...'}</span>
                </span>
              </Tooltip>
            )}

            <Tooltip content="Membros da Comunidade" position="bottom">
              <button
                type="button"
                onClick={() => setShowMembers(!showMembers)}
                className={`p-1.5 rounded transition-colors cursor-pointer ${
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

        {/* Community API Error Banner */}
        {communityError && (
          <div className="px-4 py-2 bg-rose-500/10 border-b border-rose-500/30 flex items-center justify-between gap-2 text-xs text-rose-300 shrink-0">
            <div className="flex items-center gap-2 min-w-0">
              <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
              <span className="truncate">{communityError}</span>
            </div>
            <button
              type="button"
              onClick={clearCommunityError}
              className="p-0.5 hover:text-white cursor-pointer shrink-0"
              title="Fechar aviso"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Body */}
        {!selectedChannel ? (
          <div className="flex-1 flex items-center justify-center p-8">
            <EmptyState
              icon={Hash}
              title="Nenhum canal selecionado"
              description={
                canManageChannels
                  ? 'Crie um canal de texto ou voz para começar a organizar esta comunidade.'
                  : 'Esta comunidade ainda não possui canais disponíveis para você.'
              }
              actionText={canManageChannels ? 'Criar Canal' : undefined}
              onAction={
                canManageChannels
                  ? () => setChannelManageMode({ kind: 'create_channel' })
                  : undefined
              }
            />
          </div>
        ) : selectedChannel.channel_type === 'voice' ? (
          <VoiceRoomPanel
            communityId={selectedCommunity.id}
            channel={selectedChannel}
            canConnectVoice={
              isOwner ||
              hasCommunityOrAdminPermission(
                selectedChannel.effective_permissions || selectedCommunity.effective_permissions,
                'CONNECT_VOICE'
              )
            }
          />
        ) : (
          <div className="flex-1 flex flex-col justify-between overflow-hidden">
            {/* Messages Feed */}
            <div className="flex-1 overflow-y-auto p-4 space-y-2">
              {communityMessagesHasMore && (
                <div className="flex justify-center pb-2">
                  <button
                    type="button"
                    onClick={() => void loadOlderChannelMessages()}
                    disabled={isLoadingChannelMessages}
                    className="px-3 py-1.5 rounded-lg bg-nexus-surface hover:bg-nexus-panel border border-nexus-border text-xs text-nexus-text flex items-center gap-1.5 disabled:opacity-50 cursor-pointer"
                  >
                    {isLoadingChannelMessages ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <ChevronUp className="w-3.5 h-3.5" />
                    )}
                    <span>Carregar mensagens anteriores</span>
                  </button>
                </div>
              )}

              {!communityMessagesHasMore && (
                <div className="py-5 border-b border-nexus-border/30 mb-2">
                  <div className="w-10 h-10 rounded-lg bg-nexus-surface border border-nexus-border flex items-center justify-center mb-2">
                    <Hash className="w-5 h-5 text-nexus-text" />
                  </div>
                  <h3 className="text-base font-bold text-nexus-text">
                    Bem-vindo a #{selectedChannel.name}!
                  </h3>
                  <p className="text-xs text-nexus-muted mt-1">
                    Este é o início do canal #{selectedChannel.name} em {selectedCommunity.name}.
                  </p>
                </div>
              )}

              {isLoadingChannelMessages && visibleMessages.length === 0 ? (
                <div className="flex items-center justify-center py-8 text-xs text-nexus-muted gap-2">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Carregando mensagens...</span>
                </div>
              ) : visibleMessages.length === 0 ? (
                <div className="py-8 text-center text-xs text-nexus-muted">
                  Nenhuma mensagem neste canal ainda. Seja o primeiro a enviar!
                </div>
              ) : (
                visibleMessages.map((msg, index) => {
                  const { time, dateKey } = formatMessageTimestamp(msg.created_at);
                  const prevMsg = visibleMessages[index - 1];
                  const prevDateKey = prevMsg
                    ? formatMessageTimestamp(prevMsg.created_at).dateKey
                    : null;
                  const showDateDivider = !prevMsg || prevDateKey !== dateKey;
                  const isGrouped =
                    !showDateDivider && prevMsg && prevMsg.sender_id === msg.sender_id;

                  const authorName =
                    msg.author?.nickname ||
                    msg.author?.display_name ||
                    msg.author?.username ||
                    'Usuário';
                  const isMine = msg.is_mine || msg.sender_id === currentUserId;
                  const canDeleteMsg = isMine || canManageMessages;
                  const isEditing = editingMessageId === msg.id;

                  return (
                    <React.Fragment key={msg.id}>
                      {showDateDivider && (
                        <div className="flex items-center my-4">
                          <div className="flex-1 border-t border-nexus-border/50" />
                          <span className="px-3 text-[10px] font-semibold uppercase tracking-wider text-nexus-muted bg-nexus-panel/60 py-0.5 rounded-full border border-nexus-border/40">
                            {dateKey}
                          </span>
                          <div className="flex-1 border-t border-nexus-border/50" />
                        </div>
                      )}

                      <div
                        className={`group relative flex items-start gap-3 hover:bg-nexus-surface/40 px-2 py-1 rounded transition-colors ${
                          isGrouped ? 'mt-0.5 pl-11' : 'mt-2'
                        }`}
                      >
                        {!isGrouped && (
                          <Avatar
                            name={authorName}
                            avatarUrl={msg.author?.avatar_url}
                            size="sm"
                            showStatus={false}
                            className="shrink-0 mt-0.5"
                          />
                        )}

                        <div className="min-w-0 flex-1">
                          {!isGrouped && (
                            <div className="flex items-baseline gap-2 mb-0.5">
                              <span
                                className="text-xs font-semibold text-nexus-text"
                                style={
                                  msg.author?.role_color
                                    ? { color: msg.author.role_color }
                                    : undefined
                                }
                              >
                                {authorName}
                              </span>
                              <span className="text-[10px] text-nexus-muted">{time}</span>
                            </div>
                          )}

                          {isEditing ? (
                            <div className="flex items-center gap-2 mt-1">
                              <input
                                type="text"
                                value={editingContent}
                                onChange={(e) => setEditingContent(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') {
                                    e.preventDefault();
                                    void handleSaveEdit(msg.id);
                                  } else if (e.key === 'Escape') {
                                    setEditingMessageId(null);
                                  }
                                }}
                                autoFocus
                                className="flex-1 px-2.5 py-1 rounded bg-nexus-surface border border-nexus-accent text-xs text-nexus-text focus:outline-none"
                              />
                              <button
                                type="button"
                                onClick={() => void handleSaveEdit(msg.id)}
                                className="p-1 text-emerald-400 hover:text-emerald-300 cursor-pointer"
                                title="Salvar"
                              >
                                <Check className="w-3.5 h-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={() => setEditingMessageId(null)}
                                className="p-1 text-nexus-muted hover:text-nexus-text cursor-pointer"
                                title="Cancelar"
                              >
                                <X className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          ) : (
                            <p className="text-xs text-nexus-text/95 whitespace-pre-wrap break-words leading-relaxed">
                              {msg.content}
                              {msg.edited_at && (
                                <span className="ml-1.5 text-[10px] text-nexus-muted">
                                  (editada)
                                </span>
                              )}
                              {msg.delivery_status === 'sending' && (
                                <Clock className="inline w-3 h-3 ml-1.5 text-nexus-muted" />
                              )}
                              {msg.delivery_status === 'failed' && (
                                <span className="ml-1.5 text-[10px] text-rose-400">
                                  Falha ao enviar
                                </span>
                              )}
                            </p>
                          )}
                        </div>

                        {!isEditing && (isMine || canDeleteMsg) && !msg.id.startsWith('opt_') && (
                          <div className="hidden group-hover:flex items-center gap-1 bg-nexus-surface border border-nexus-border rounded-md px-1 py-0.5 shrink-0">
                            {isMine && (
                              <button
                                type="button"
                                onClick={() => {
                                  setEditingMessageId(msg.id);
                                  setEditingContent(msg.content);
                                }}
                                className="p-1 text-nexus-muted hover:text-nexus-text cursor-pointer"
                                title="Editar mensagem"
                              >
                                <Edit2 className="w-3 h-3" />
                              </button>
                            )}
                            {canDeleteMsg && (
                              <button
                                type="button"
                                onClick={() => void deleteChannelMessage(msg.id)}
                                className="p-1 text-nexus-muted hover:text-rose-400 cursor-pointer"
                                title="Excluir mensagem"
                              >
                                <Trash2 className="w-3 h-3" />
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    </React.Fragment>
                  );
                })
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Message Input */}
            <div className="p-3 border-t border-nexus-border bg-nexus-surface/60 shrink-0">
              {sendBlockedReason ? (
                <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-nexus-panel/60 border border-nexus-border text-xs text-nexus-muted">
                  <MessageSquareOff className="w-4 h-4 text-amber-400 shrink-0" />
                  <span>{sendBlockedReason}</span>
                </div>
              ) : (
                <div className="flex items-center gap-2 bg-nexus-bg border border-nexus-border rounded-lg px-3 py-2 focus-within:border-nexus-accent transition-colors">
                  <input
                    type="text"
                    value={channelDraft}
                    onChange={(e) => setChannelDraft(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder={`Conversar em #${selectedChannel.name}`}
                    disabled={isSendingChannelMessage}
                    className="flex-1 bg-transparent text-xs text-nexus-text placeholder:text-nexus-muted focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => void handleSendMessage()}
                    disabled={!channelDraft.trim() || isSendingChannelMessage}
                    className="p-1.5 rounded-md bg-nexus-accent hover:bg-nexus-accent/90 text-white disabled:opacity-40 transition-colors cursor-pointer"
                    title="Enviar mensagem"
                  >
                    {isSendingChannelMessage ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Send className="w-3.5 h-3.5" />
                    )}
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Right Member List Sidebar */}
      {showMembers && communitySnapshot && (
        <div className="w-56 bg-nexus-surface border-l border-nexus-border overflow-y-auto p-2.5 shrink-0 select-none">
          <CommunityMemberList members={communitySnapshot.members} />
        </div>
      )}

      {/* Modals */}
      <CreateJoinCommunityModal
        isOpen={createJoinModal.open}
        initialTab={createJoinModal.tab}
        onClose={() => setCreateJoinModal((p) => ({ ...p, open: false }))}
      />

      {communitySnapshot && (
        <>
          <CommunitySettingsModal
            isOpen={isSettingsOpen}
            snapshot={communitySnapshot}
            onClose={() => setIsSettingsOpen(false)}
          />

          <ChannelManageModal
            isOpen={channelManageMode !== null}
            mode={channelManageMode}
            communityId={selectedCommunity.id}
            effectivePermissions={selectedCommunity.effective_permissions}
            categories={categories}
            roles={communitySnapshot.roles}
            members={communitySnapshot.members}
            onClose={() => setChannelManageMode(null)}
          />

          <InviteModal
            isOpen={isInviteOpen}
            community={selectedCommunity}
            channelId={selectedChannel?.id ?? null}
            onClose={() => setIsInviteOpen(false)}
          />
        </>
      )}
    </div>
  );
};
