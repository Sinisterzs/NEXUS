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
  ChevronDown,
  ChevronRight,
  AlertCircle,
  X,
  Link2,
  Check,
  Clock,
  Loader2,
  MessageSquareOff,
  MicOff,
  Headphones,
  Monitor,
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
import { ActiveStreamCard } from '../../components/ActiveStreamCard';
import { getEffectiveStatus } from '../../components/CommunityMemberList';
import {
  formatFpsMetric,
  formatResolutionHeightLabel,
  pickFirstValidMetric,
} from '../../lib/streamMetrics';
import { CommunityServerRail } from './CommunityServerRail';
import {
  CommunityContextPanel,
  CommunityVoiceChannelPresence,
} from './CommunityContextPanel';
import { CommunityHeroBanner } from './CommunityHeroBanner';
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
  const joinVoiceChannel = useAppStore((state) => state.joinVoiceChannel);
  const setPreferredVoiceStreamPeerId = useAppStore(
    (state) => state.setPreferredVoiceStreamPeerId
  );
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
  const voiceRoomRemoteStreams = useAppStore((state) => state.voiceRoomRemoteStreams);
  const nativeCaptureStatus = useAppStore((state) => state.nativeCaptureStatus);
  const nativeStatsDstHeight = useAppStore((state) => state.nativeScreenStats?.dst_height ?? 0);
  const nativeStatsTargetFps = useAppStore((state) => state.nativeScreenStats?.target_fps ?? 0);
  const loadCommunityVoiceRooms = useAppStore((state) => state.loadCommunityVoiceRooms);

  const [channelDraft, setChannelDraft] = useState('');
  const [showMembers, setShowMembers] = useState<boolean>(() =>
    typeof window !== 'undefined' ? window.innerWidth >= 1200 : true
  );
  const [isCompactContextOverlay, setIsCompactContextOverlay] = useState<boolean>(() =>
    typeof window !== 'undefined' ? window.innerWidth < 1200 : false
  );
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingContent, setEditingContent] = useState('');
  const [collapsedCategories, setCollapsedCategories] = useState<Record<string, boolean>>({});

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
  const wasNarrowRef = useRef<boolean>(
    typeof window !== 'undefined' ? window.innerWidth < 1200 : false
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handleResize = () => {
      const isNarrow = window.innerWidth < 1200;
      setIsCompactContextOverlay((prev) => (prev === isNarrow ? prev : isNarrow));
      if (isNarrow !== wasNarrowRef.current) {
        wasNarrowRef.current = isNarrow;
        setShowMembers(!isNarrow);
      }
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const hasOpenCommunityModal =
    createJoinModal.open || isInviteOpen || channelManageMode !== null || isSettingsOpen;

  useEffect(() => {
    if (!showMembers || !isCompactContextOverlay || hasOpenCommunityModal) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setShowMembers(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showMembers, isCompactContextOverlay, hasOpenCommunityModal]);

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

  const activeCommunityStreams = useMemo(() => {
    if (!selectedCommunity) return [];
    const items: Array<{
      key: string;
      voiceChannelId: string;
      voiceChannelName: string;
      streamerUserId: string;
      streamerName: string;
      streamerAvatarUrl?: string | null;
      previewStream: MediaStream | null;
      resolutionLabel: string | null;
      fpsLabel: string | null;
    }> = [];
    const seen = new Set<string>();

    for (const ch of channels) {
      if (ch.channel_type !== 'voice') continue;

      const isConnectedVoiceHere =
        activeVoiceCommunityId === selectedCommunity.id &&
        activeVoiceChannelId === ch.id &&
        voiceRoomState !== 'idle';

      const participants: RoomParticipantDto[] =
        isConnectedVoiceHere && voiceRoomParticipants.length > 0
          ? voiceRoomParticipants
          : communityVoiceRooms[selectedCommunity.id]?.[ch.id] || [];

      for (const p of participants) {
        if (!p.is_screen_sharing) continue;
        const itemKey = `${ch.id}:${p.user_id}`;
        if (seen.has(itemKey)) continue;
        seen.add(itemKey);

        const streamerName = p.display_name || p.username || 'Usuário';
        let previewStream: MediaStream | null = null;
        let resolutionLabel: string | null = null;
        let fpsLabel: string | null = null;

        if (
          p.user_id === currentUserId &&
          nativeCaptureStatus?.active &&
          isConnectedVoiceHere
        ) {
          const height = pickFirstValidMetric(
            [nativeStatsDstHeight, nativeCaptureStatus.height],
            { allowZero: false }
          );
          const fps = pickFirstValidMetric(
            [nativeStatsTargetFps, nativeCaptureStatus.fps],
            { allowZero: false }
          );
          resolutionLabel = formatResolutionHeightLabel(height);
          const formattedFps = fps !== null ? formatFpsMetric(fps, 'FPS', '') : '';
          fpsLabel = formattedFps || null;
        } else if (isConnectedVoiceHere && voiceRoomRemoteStreams[p.user_id]) {
          const remoteStream = voiceRoomRemoteStreams[p.user_id];
          previewStream = selectedChannel?.channel_type === 'text' ? remoteStream : null;
          const trackSettings = remoteStream.getVideoTracks()[0]?.getSettings?.();
          resolutionLabel = formatResolutionHeightLabel(trackSettings?.height);
          const remoteFps = pickFirstValidMetric(
            [trackSettings?.frameRate],
            { allowZero: false }
          );
          const formattedFps = remoteFps !== null ? formatFpsMetric(remoteFps, 'FPS', '') : '';
          fpsLabel = formattedFps || null;
        }

        items.push({
          key: itemKey,
          voiceChannelId: ch.id,
          voiceChannelName: ch.name,
          streamerUserId: p.user_id,
          streamerName,
          streamerAvatarUrl: p.avatar_url ?? null,
          previewStream,
          resolutionLabel,
          fpsLabel,
        });
      }
    }

    return items;
  }, [
    selectedCommunity,
    channels,
    selectedChannel?.channel_type,
    activeVoiceCommunityId,
    activeVoiceChannelId,
    voiceRoomState,
    voiceRoomParticipants,
    communityVoiceRooms,
    currentUserId,
    nativeCaptureStatus,
    nativeStatsDstHeight,
    nativeStatsTargetFps,
    voiceRoomRemoteStreams,
  ]);

  const voiceChannelsWithPresence: CommunityVoiceChannelPresence[] = useMemo(() => {
    if (!selectedCommunity) return [];
    return channels
      .filter((ch) => ch.channel_type === 'voice')
      .map((ch) => {
        const isConnectedHere =
          activeVoiceCommunityId === selectedCommunity.id &&
          activeVoiceChannelId === ch.id &&
          voiceRoomState !== 'idle';
        const participants: RoomParticipantDto[] =
          isConnectedHere && voiceRoomParticipants.length > 0
            ? voiceRoomParticipants
            : communityVoiceRooms[selectedCommunity.id]?.[ch.id] || [];
        return {
          channel: ch,
          participants,
          isConnectedHere,
        };
      });
  }, [
    selectedCommunity,
    channels,
    activeVoiceCommunityId,
    activeVoiceChannelId,
    voiceRoomState,
    voiceRoomParticipants,
    communityVoiceRooms,
  ]);

  const onlineMembersCount = useMemo(() => {
    if (!communitySnapshot || communitySnapshot.community.id !== selectedCommunity?.id) {
      return 0;
    }
    return communitySnapshot.members.filter((m) => {
      const status = getEffectiveStatus(m);
      return status !== 'offline';
    }).length;
  }, [communitySnapshot, selectedCommunity?.id]);

  const hasActiveCommunityStreams = activeCommunityStreams.length > 0;
  const hasActiveCommunityVoice = voiceChannelsWithPresence.some(
    (room) => room.participants.length > 0
  );

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
      <div className="flex-1 flex overflow-hidden bg-nexus-bg">
        <CommunityServerRail
          communities={communities}
          selectedCommunityId={selectedCommunity?.id ?? null}
          onSelectCommunity={(id) => void selectCommunity(id)}
          onOpenCreateJoinModal={() => setCreateJoinModal({ open: true, tab: 'create' })}
        />
        <div className="flex-1 flex flex-col items-center justify-center p-8 select-none my-2 mr-2 ml-1.5 rounded-2xl border border-white/[0.07] bg-[#0B0D13] overflow-hidden shadow-2xl min-w-0">
          <Loader2 className="w-6 h-6 animate-spin text-nexus-accent mb-3" />
          <p className="text-[13px] text-zinc-400">Carregando comunidades...</p>
        </div>

        <CreateJoinCommunityModal
          isOpen={createJoinModal.open}
          initialTab={createJoinModal.tab}
          onClose={() => setCreateJoinModal((p) => ({ ...p, open: false }))}
        />
      </div>
    );
  }

  if (communities.length === 0 || !selectedCommunity) {
    return (
      <div className="flex-1 flex overflow-hidden bg-nexus-bg">
        <CommunityServerRail
          communities={communities}
          selectedCommunityId={selectedCommunity?.id ?? null}
          onSelectCommunity={(id) => void selectCommunity(id)}
          onOpenCreateJoinModal={() => setCreateJoinModal({ open: true, tab: 'create' })}
        />
        <div className="flex-1 flex flex-col items-center justify-center p-8 select-none my-2 mr-2 ml-1.5 rounded-2xl border border-white/[0.07] bg-[#0B0D13] overflow-hidden shadow-2xl min-w-0">
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
            className="mt-2 px-4 py-2 rounded-xl text-[13px] font-medium text-zinc-100 bg-[#131622] hover:bg-white/[0.06] border border-white/[0.08] transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nexus-accent/70"
          >
            Entrar por Convite
          </button>
        </div>

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

  const isVoiceChannelJoiningOrConnected = (channelId: string) =>
    activeVoiceCommunityId === selectedCommunity.id &&
    activeVoiceChannelId === channelId &&
    (voiceRoomState === 'connected' ||
      voiceRoomState === 'joining' ||
      voiceRoomState === 'reconnecting');

  const canConnectToVoiceChannel = (ch: CommunityChannelDto) =>
    isOwner ||
    hasCommunityOrAdminPermission(
      ch.effective_permissions || selectedCommunity.effective_permissions,
      'CONNECT_VOICE'
    );

  const handleVoiceChannelClick = (ch: CommunityChannelDto, forceOpenPanel = false) => {
    if (isCompactContextOverlay) {
      setShowMembers(false);
    }

    if (ch.channel_type !== 'voice') {
      void selectCommunityChannel(ch.id);
      return;
    }

    if (!canConnectToVoiceChannel(ch) || isVoiceChannelJoiningOrConnected(ch.id)) {
      void selectCommunityChannel(ch.id);
      return;
    }

    const wasViewingVoicePanel = selectedChannel?.channel_type === 'voice';
    void joinVoiceChannel(selectedCommunity.id, ch.id);
    if (forceOpenPanel || (wasViewingVoicePanel && selectedChannel?.id !== ch.id)) {
      void selectCommunityChannel(ch.id);
    }
  };

  const handleContextChannelSelect = (channelId: string) => {
    const target = channels.find((c) => c.id === channelId);
    if (target) {
      handleVoiceChannelClick(target, false);
      return;
    }
    if (isCompactContextOverlay) {
      setShowMembers(false);
    }
    void selectCommunityChannel(channelId);
  };

  const handleWatchStream = (voiceChannelId: string, streamerUserId?: string) => {
    if (isCompactContextOverlay) {
      setShowMembers(false);
    }
    setPreferredVoiceStreamPeerId(streamerUserId ?? null);
    const target = channels.find((c) => c.id === voiceChannelId);
    if (target) {
      handleVoiceChannelClick(target, true);
      return;
    }
    if (!isVoiceChannelJoiningOrConnected(voiceChannelId)) {
      void joinVoiceChannel(selectedCommunity.id, voiceChannelId);
    }
    void selectCommunityChannel(voiceChannelId);
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
    const isThisVoiceChannel =
      isVoice &&
      activeVoiceCommunityId === selectedCommunity.id &&
      activeVoiceChannelId === ch.id;
    const isConnectedVoiceHere =
      isThisVoiceChannel &&
      (voiceRoomState === 'connected' ||
        voiceRoomState === 'joining' ||
        voiceRoomState === 'reconnecting');
    const isVoiceErrorHere = isThisVoiceChannel && voiceRoomState === 'error';
    const voiceStateForRow = isThisVoiceChannel ? voiceRoomState : 'idle';
    const voiceStatusLabel =
      voiceStateForRow === 'joining'
        ? 'Conectando'
        : voiceStateForRow === 'connected'
        ? 'Em voz'
        : voiceStateForRow === 'reconnecting'
        ? 'Reconectando'
        : voiceStateForRow === 'error'
        ? 'Erro'
        : null;
    const voiceButtonActionLabel =
      voiceStateForRow === 'joining'
        ? `${ch.name} — Conectando à sala de voz. Clique para abrir o painel`
        : voiceStateForRow === 'connected'
        ? `${ch.name} — Em voz. Clique para abrir o painel`
        : voiceStateForRow === 'reconnecting'
        ? `${ch.name} — Reconectando à sala de voz. Clique para abrir o painel`
        : voiceStateForRow === 'error'
        ? `${ch.name} — Erro na sala de voz. Clique para tentar novamente`
        : `${ch.name} — Clique para entrar no canal de voz`;
    const voiceParticipants: RoomParticipantDto[] = isVoice
      ? isConnectedVoiceHere && voiceRoomParticipants.length > 0
        ? voiceRoomParticipants
        : communityVoiceRooms[selectedCommunity.id]?.[ch.id] || []
      : [];
    const hasLiveStream = isVoice && voiceParticipants.some((p) => p.is_screen_sharing);
    const isHighlightedVoiceBlock =
      isVoice && (isConnectedVoiceHere || isVoiceErrorHere || voiceParticipants.length > 0);
    const isCrimsonVoiceHighlight =
      isHighlightedVoiceBlock && (isConnectedVoiceHere || isVoiceErrorHere || hasLiveStream || isActive);

    return (
      <div
        key={ch.id}
        className={
          isHighlightedVoiceBlock
            ? isCrimsonVoiceHighlight
              ? 'rounded-xl border border-[#C83E52]/35 bg-[#C83E52]/[0.07] p-1.5 space-y-1.5'
              : 'rounded-xl border border-white/[0.07] bg-[#131520]/85 p-1.5 space-y-1.5'
            : 'space-y-0.5'
        }
      >
        <div
          className={`group flex items-center justify-between gap-1 text-[13px] font-medium transition-all ${
            isHighlightedVoiceBlock
              ? `px-2 py-1 rounded-lg ${
                  isActive
                    ? 'bg-[#C83E52]/20 text-white'
                    : 'text-zinc-200 hover:bg-white/[0.05] hover:text-white'
                }`
              : `px-2.5 py-1.5 rounded-xl ${
                  isActive
                    ? 'bg-gradient-to-r from-[#C83E52]/22 to-transparent border border-[#C83E52]/35 text-white'
                    : 'text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-200 border border-transparent'
                }`
          }`}
        >
          <button
            type="button"
            onClick={() => handleVoiceChannelClick(ch)}
            aria-label={isVoice ? voiceButtonActionLabel : `Abrir canal de texto ${ch.name}`}
            title={isVoice ? voiceButtonActionLabel : `#${ch.name}`}
            data-testid={isVoice ? `voice-channel-btn-${ch.id}` : `text-channel-btn-${ch.id}`}
            data-voice-state={isVoice ? voiceStateForRow : undefined}
            className="flex items-center gap-1.5 min-w-0 flex-1 text-left cursor-pointer rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E04F64]/70"
          >
            <span className="flex items-center gap-1.5 min-w-0 flex-1 overflow-hidden">
              {isVoice ? (
                <Volume2
                  className={`w-4 h-4 shrink-0 ${
                    isVoiceErrorHere
                      ? 'text-rose-400'
                      : isConnectedVoiceHere || hasLiveStream
                      ? 'text-[#E04F64]'
                      : 'text-emerald-400'
                  }`}
                />
              ) : (
                <Hash
                  className={`w-4 h-4 shrink-0 ${
                    isActive ? 'text-[#E04F64]' : 'text-zinc-500'
                  }`}
                />
              )}
              <span className="truncate">{ch.name}</span>
              {ch.is_private && <Lock className="w-3 h-3 text-zinc-500 shrink-0" />}
              {ch.is_read_only && !isVoice && (
                <Shield className="w-3 h-3 text-amber-400/80 shrink-0" />
              )}
              {isVoice && voiceStatusLabel && (
                <span
                  className={`inline-flex items-center gap-1 shrink-0 text-[9.5px] font-bold px-1.5 py-0.5 rounded-full border ${
                    voiceStateForRow === 'connected'
                      ? 'bg-emerald-500/15 border-emerald-500/35 text-emerald-300'
                      : voiceStateForRow === 'error'
                      ? 'bg-rose-500/15 border-rose-500/35 text-rose-300'
                      : 'bg-amber-500/15 border-amber-500/35 text-amber-300'
                  }`}
                >
                  {(voiceStateForRow === 'joining' || voiceStateForRow === 'reconnecting') && (
                    <Loader2 className="w-2.5 h-2.5 animate-spin motion-reduce:animate-none" />
                  )}
                  <span>{voiceStatusLabel}</span>
                </span>
              )}
              {isVoice && hasLiveStream && (
                <span className="inline-flex items-center gap-1 shrink-0 bg-[#E04F64] text-white text-[9px] font-extrabold uppercase tracking-wider px-1.5 py-0.5 rounded-full">
                  <span className="w-1.5 h-1.5 rounded-full bg-white" />
                  LIVE
                </span>
              )}
              {isVoice && voiceParticipants.length > 0 && (
                <span className="shrink-0 px-1.5 py-0.5 rounded-full bg-white/[0.08] text-zinc-200 text-[10px] font-semibold tabular-nums">
                  {voiceParticipants.length}
                </span>
              )}
              {ch.unread_count > 0 && <Badge count={ch.unread_count} />}
            </span>
          </button>

          {canManageChannels && (
            <div className="hidden group-hover:flex group-focus-within:flex items-center gap-0.5 shrink-0">
              <button
                type="button"
                onClick={() => void handleMoveChannel(groupList, idx, -1)}
                disabled={idx === 0}
                aria-label={`Subir canal ${ch.name}`}
                className="p-0.5 text-zinc-400 hover:text-white disabled:opacity-30 cursor-pointer rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E04F64]/70"
                title="Subir canal"
              >
                <ArrowUp className="w-3 h-3" />
              </button>
              <button
                type="button"
                onClick={() => void handleMoveChannel(groupList, idx, 1)}
                disabled={idx === groupList.length - 1}
                aria-label={`Descer canal ${ch.name}`}
                className="p-0.5 text-zinc-400 hover:text-white disabled:opacity-30 cursor-pointer rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E04F64]/70"
                title="Descer canal"
              >
                <ArrowDown className="w-3 h-3" />
              </button>
              <button
                type="button"
                onClick={() => setChannelManageMode({ kind: 'edit_channel', channel: ch })}
                aria-label={`Configurar canal ${ch.name}`}
                className="p-0.5 text-zinc-400 hover:text-white cursor-pointer rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E04F64]/70"
                title="Editar canal e permissões"
              >
                <Settings className="w-3 h-3" />
              </button>
              <button
                type="button"
                onClick={() => void deleteCommunityChannel(selectedCommunity.id, ch.id)}
                aria-label={`Excluir canal ${ch.name}`}
                className="p-0.5 text-zinc-400 hover:text-rose-400 cursor-pointer rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E04F64]/70"
                title="Excluir canal"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          )}
        </div>

        {isVoice &&
          voiceParticipants.length > 0 &&
          (voiceParticipants.length <= 3 ? (
            <div className="pl-2 pr-1 pb-0.5 space-y-0.5">
              {voiceParticipants.map((p) => {
                const pName = p.display_name || p.username || 'Usuário';
                const isSpeaking = Boolean(p.is_speaking && !p.is_muted);
                return (
                  <div
                    key={p.user_id}
                    className="flex items-center justify-between gap-1.5 px-1.5 py-1 rounded-lg hover:bg-white/[0.04] text-[12px] text-zinc-200"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <div
                        className={`rounded-full shrink-0 ${
                          isSpeaking ? 'ring-1.5 ring-emerald-400' : ''
                        }`}
                      >
                        <Avatar
                          name={pName}
                          avatarUrl={p.avatar_url}
                          size="xs"
                          showStatus={false}
                          shapeClassName="rounded-full !w-5 !h-5 text-[9px]"
                        />
                      </div>
                      <span className="truncate">{pName}</span>
                    </div>
                    <div className="flex items-center gap-1 shrink-0 text-zinc-400">
                      {p.is_screen_sharing && (
                        <Monitor className="w-3 h-3 text-[#E04F64]" />
                      )}
                      {p.is_muted && <MicOff className="w-3 h-3 text-rose-400" />}
                      {p.is_deafened && <Headphones className="w-3 h-3 text-rose-400" />}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="flex items-center justify-between gap-2 px-2 pb-1">
              <div className="flex items-center -space-x-1.5">
                {voiceParticipants.slice(0, 4).map((p) => (
                  <Avatar
                    key={`stack-${p.user_id}`}
                    name={p.display_name || p.username || 'Usuário'}
                    avatarUrl={p.avatar_url}
                    size="xs"
                    showStatus={false}
                    shapeClassName="rounded-full !w-5 !h-5 text-[9px] ring-2 ring-[#131520]"
                  />
                ))}
                <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-[#191C2B] border border-white/[0.1] ring-2 ring-[#131520] text-[9px] font-bold text-zinc-200 tabular-nums">
                  +{voiceParticipants.length - 4}
                </span>
              </div>
              <span className="text-[11px] text-zinc-400 tabular-nums">
                {voiceParticipants.length} na sala
              </span>
            </div>
          ))}
      </div>
    );
  };

  const uncategorizedChannels = channels.filter((ch) => !ch.category_id);
  const communityShortPrivacyLabel =
    selectedCommunity.privacy === 'public'
      ? 'Pública'
      : selectedCommunity.privacy === 'invite_only'
      ? 'Somente convite'
      : 'Privada';

  return (
    <div className="flex-1 flex overflow-hidden bg-nexus-bg">
      <CommunityServerRail
        communities={communities}
        selectedCommunityId={selectedCommunity.id}
        onSelectCommunity={(communityId) => void selectCommunity(communityId)}
        onOpenCreateJoinModal={() => setCreateJoinModal({ open: true, tab: 'create' })}
      />

      {/* Unified Elevated Container (Channels + Central Chat + Members) */}
      <div className="flex-1 flex my-2 mr-2 ml-1.5 rounded-2xl border border-white/[0.07] bg-[#0B0D13] overflow-hidden shadow-2xl min-w-0">
        {/* Channels Sidebar */}
        <div className="w-56 bg-[#0E1018]/90 border-r border-white/[0.06] flex flex-col shrink-0 select-none">
          {/* Integrated Atmospheric Community Header */}
          <div className="bg-gradient-to-br from-[#25131E] via-[#141622] to-[#0E1018] border-b border-white/[0.06] px-3.5 pt-3.5 pb-3 shrink-0 space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-[15px] font-extrabold text-white">
                {selectedCommunity.name}
              </span>

              <div className="flex items-center gap-0.5 shrink-0">
                {canCreateInvites && (
                  <Tooltip content="Convidar pessoas" position="bottom">
                    <button
                      type="button"
                      aria-label="Convidar pessoas"
                      onClick={() => setIsInviteOpen(true)}
                      className="p-1 rounded-lg text-zinc-300/80 hover:text-white hover:bg-white/[0.08] cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E04F64]/70"
                    >
                      <Link2 className="w-3.5 h-3.5" />
                    </button>
                  </Tooltip>
                )}
                {canManageChannels && (
                  <>
                    <Tooltip content="Criar canal" position="bottom">
                      <button
                        type="button"
                        aria-label="Criar canal"
                        onClick={() => setChannelManageMode({ kind: 'create_channel' })}
                        className="p-1 rounded-lg text-zinc-300/80 hover:text-white hover:bg-white/[0.08] cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E04F64]/70"
                      >
                        <Plus className="w-3.5 h-3.5" />
                      </button>
                    </Tooltip>
                    <Tooltip content="Criar categoria" position="bottom">
                      <button
                        type="button"
                        aria-label="Criar categoria"
                        onClick={() => setChannelManageMode({ kind: 'create_category' })}
                        className="p-1 rounded-lg text-zinc-300/80 hover:text-white hover:bg-white/[0.08] cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E04F64]/70"
                      >
                        <FolderPlus className="w-3.5 h-3.5" />
                      </button>
                    </Tooltip>
                  </>
                )}
                <Tooltip content="Configurações da Comunidade" position="bottom">
                  <button
                    type="button"
                    aria-label="Configurações da Comunidade"
                    onClick={() => setIsSettingsOpen(true)}
                    className="p-1 rounded-lg text-zinc-300/80 hover:text-white hover:bg-white/[0.08] cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E04F64]/70"
                  >
                    <Settings className="w-3.5 h-3.5" />
                  </button>
                </Tooltip>
              </div>
            </div>

            <div className="flex items-center gap-1.5 text-[11.5px] text-white/60">
              <span className="w-2 h-2 rounded-full bg-emerald-500 shrink-0" />
              <span className="truncate">
                {communityShortPrivacyLabel} · {selectedCommunity.member_count} membros
              </span>
            </div>
          </div>

          {/* Channel Tree */}
          <div className="flex-1 overflow-y-auto px-2 py-2.5 space-y-4">
            {isLoadingCommunitySnapshot && !communitySnapshot ? (
              <div className="flex items-center justify-center py-8 text-xs text-zinc-400 gap-2">
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Carregando canais...</span>
              </div>
            ) : channels.length === 0 && categories.length === 0 ? (
              <div className="px-2 py-6 text-center text-xs text-zinc-400">
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
                  const isCollapsed = Boolean(collapsedCategories[cat.id]);
                  return (
                    <div key={cat.id} className="space-y-1">
                      <div className="group px-2 py-0.5 text-[11px] font-semibold tracking-wider uppercase text-zinc-400 flex items-center justify-between gap-1">
                        <button
                          type="button"
                          aria-expanded={!isCollapsed}
                          onClick={() =>
                            setCollapsedCategories((prev) => ({
                              ...prev,
                              [cat.id]: !prev[cat.id],
                            }))
                          }
                          className="flex items-center gap-1 min-w-0 flex-1 text-left hover:text-zinc-200 transition-colors cursor-pointer rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E04F64]/70"
                        >
                          {isCollapsed ? (
                            <ChevronRight className="w-3 h-3 shrink-0" />
                          ) : (
                            <ChevronDown className="w-3 h-3 shrink-0" />
                          )}
                          <span className="truncate">{cat.name}</span>
                        </button>
                        {canManageChannels && (
                          <div className="flex items-center gap-0.5 shrink-0">
                            <div className="hidden group-hover:flex group-focus-within:flex items-center gap-0.5">
                              <button
                                type="button"
                                onClick={() => void handleMoveCategory(catIdx, -1)}
                                disabled={catIdx === 0}
                                aria-label={`Subir categoria ${cat.name}`}
                                className="p-0.5 hover:text-white disabled:opacity-30 cursor-pointer rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E04F64]/70"
                                title="Subir categoria"
                              >
                                <ArrowUp className="w-3 h-3" />
                              </button>
                              <button
                                type="button"
                                onClick={() => void handleMoveCategory(catIdx, 1)}
                                disabled={catIdx === categories.length - 1}
                                aria-label={`Descer categoria ${cat.name}`}
                                className="p-0.5 hover:text-white disabled:opacity-30 cursor-pointer rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E04F64]/70"
                                title="Descer categoria"
                              >
                                <ArrowDown className="w-3 h-3" />
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  setChannelManageMode({ kind: 'edit_category', category: cat })
                                }
                                aria-label={`Renomear categoria ${cat.name}`}
                                className="p-0.5 hover:text-white cursor-pointer rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E04F64]/70"
                                title="Renomear categoria"
                              >
                                <Edit2 className="w-3 h-3" />
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  void deleteCommunityCategory(selectedCommunity.id, cat.id)
                                }
                                aria-label={`Excluir categoria ${cat.name}`}
                                className="p-0.5 hover:text-rose-400 cursor-pointer rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E04F64]/70"
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
                              aria-label={`Criar canal na categoria ${cat.name}`}
                              className="p-0.5 hover:text-white cursor-pointer rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E04F64]/70"
                              title="Criar canal nesta categoria"
                            >
                              <Plus className="w-3 h-3" />
                            </button>
                          </div>
                        )}
                      </div>

                      {!isCollapsed && (
                        <div className="space-y-0.5">
                          {catChannels.length === 0 ? (
                            <div className="px-2 py-1 text-[11px] text-zinc-500 italic">
                              Sem canais
                            </div>
                          ) : (
                            catChannels.map((ch, idx) => renderChannelRow(ch, catChannels, idx))
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </>
            )}
          </div>
        </div>

        <div className="relative flex-1 flex min-w-0 overflow-hidden">
          {/* Main Channel Area */}
          <div className="flex-1 flex flex-col min-w-0 bg-[#0B0D13] overflow-hidden">
          {/* Top Channel Header */}
          <div className="h-[52px] px-5 border-b border-white/[0.06] bg-[#0D1018]/80 backdrop-blur-md flex items-center justify-between shrink-0 select-none">
            <div className="flex items-center gap-2 min-w-0">
              {selectedChannel ? (
                <>
                  {selectedChannel.channel_type === 'voice' ? (
                    <Volume2 className="w-4 h-4 text-emerald-400 shrink-0" />
                  ) : (
                    <Hash className="w-4 h-4 text-[#E04F64] shrink-0" />
                  )}
                  <span className="text-[15px] font-bold text-white truncate">
                    {selectedChannel.name}
                  </span>
                  {selectedChannel.is_read_only && selectedChannel.channel_type === 'text' && (
                    <span className="px-2 py-0.5 rounded-full bg-amber-500/15 border border-amber-500/30 text-[11px] text-amber-300 shrink-0">
                      Somente leitura
                    </span>
                  )}
                  {selectedChannel.topic && (
                    <span className="hidden sm:block text-[12px] text-zinc-400 ml-2 border-l border-white/[0.08] pl-2.5 truncate">
                      {selectedChannel.topic}
                    </span>
                  )}
                </>
              ) : (
                <span className="text-[15px] font-bold text-white truncate">
                  {selectedCommunity.name}
                </span>
              )}
            </div>

            <div className="flex items-center gap-2.5 text-zinc-400 shrink-0">
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
                    aria-label={gatewayConnected ? 'Gateway conectado' : 'Gateway reconectando'}
                    className={`w-2 h-2 rounded-full shrink-0 ${
                      gatewayConnected ? 'bg-emerald-400/80' : 'bg-amber-400 animate-pulse'
                    }`}
                  />
                </Tooltip>
              )}

              <Tooltip content="Membros da Comunidade" position="bottom">
                <button
                  type="button"
                  aria-label="Membros da Comunidade"
                  aria-pressed={showMembers}
                  onClick={() => setShowMembers((prev) => !prev)}
                  className={`relative p-1.5 rounded-xl border transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E04F64]/70 ${
                    showMembers
                      ? 'text-[#E04F64] bg-[#C83E52]/15 border-[#C83E52]/35'
                      : 'border-transparent hover:bg-white/[0.06] hover:text-white'
                  }`}
                >
                  <Users className="w-4 h-4" />
                  {!showMembers && (hasActiveCommunityStreams || hasActiveCommunityVoice) && (
                    <span
                      aria-hidden="true"
                      className={`absolute top-1 right-1 w-2 h-2 rounded-full ring-2 ring-[#0D1018] ${
                        hasActiveCommunityStreams ? 'bg-[#E04F64]' : 'bg-emerald-400'
                      }`}
                    />
                  )}
                </button>
              </Tooltip>
            </div>
          </div>

          {/* Community API Error Banner */}
          {communityError && (
            <div className="px-5 py-2 bg-rose-500/10 border-b border-rose-500/30 flex items-center justify-between gap-2 text-xs text-rose-300 shrink-0">
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
              <div className="@container flex-1 overflow-y-auto overflow-x-hidden px-5 py-4 space-y-1.5">
                {communityMessagesHasMore && (
                  <div className="flex justify-center pb-2">
                    <button
                      type="button"
                      onClick={() => void loadOlderChannelMessages()}
                      disabled={isLoadingChannelMessages}
                      className="px-3.5 py-1.5 rounded-xl bg-[#131622] hover:bg-white/[0.06] border border-white/[0.08] text-xs font-medium text-zinc-200 flex items-center gap-1.5 disabled:opacity-50 cursor-pointer"
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
                  <div className="-mx-4 -mt-3 mb-3">
                    <CommunityHeroBanner
                      community={selectedCommunity}
                      channelName={selectedChannel.name}
                      channelTopic={selectedChannel.topic}
                      channelsCount={channels.length}
                      onlineMembersCount={onlineMembersCount}
                    />
                  </div>
                )}

                {isLoadingChannelMessages && visibleMessages.length === 0 ? (
                  <div className="flex items-center justify-center py-8 text-[13px] text-zinc-400 gap-2">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>Carregando mensagens...</span>
                  </div>
                ) : visibleMessages.length === 0 ? (
                  <div className="py-8 text-center text-[13px] text-zinc-400">
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
                            <div className="flex-1 border-t border-white/[0.06]" />
                            <span className="px-3 text-[11px] font-semibold uppercase tracking-wider text-zinc-400 bg-[#131622] py-0.5 rounded-full border border-white/[0.07]">
                              {dateKey}
                            </span>
                            <div className="flex-1 border-t border-white/[0.06]" />
                          </div>
                        )}

                        <div
                          className={`group relative flex items-start gap-3 hover:bg-white/[0.03] px-2.5 py-1 rounded-xl transition-colors ${
                            isGrouped ? 'mt-0.5' : 'mt-2.5'
                          }`}
                        >
                          {!isGrouped && (
                            <Avatar
                              name={authorName}
                              avatarUrl={msg.author?.avatar_url}
                              size="md"
                              showStatus={false}
                              shapeClassName="rounded-full"
                              className="shrink-0 mt-0.5"
                            />
                          )}

                          <div className={`min-w-0 flex-1 ${isGrouped ? 'pl-[48px]' : ''}`}>
                            {!isGrouped && (
                              <div className="flex items-baseline gap-2 mb-0.5">
                                <span
                                  className="text-[14px] font-bold text-white"
                                  style={
                                    msg.author?.role_color
                                      ? { color: msg.author.role_color }
                                      : undefined
                                  }
                                >
                                  {authorName}
                                </span>
                                <span className="text-[11px] text-zinc-500">{time}</span>
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
                                  className="flex-1 px-3 py-1.5 rounded-xl bg-[#131622] border border-[#E04F64]/60 text-[13.5px] text-white focus:outline-none"
                                />
                                <button
                                  type="button"
                                  onClick={() => void handleSaveEdit(msg.id)}
                                  className="p-1.5 text-emerald-400 hover:text-emerald-300 cursor-pointer"
                                  title="Salvar"
                                >
                                  <Check className="w-4 h-4" />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setEditingMessageId(null)}
                                  className="p-1.5 text-zinc-400 hover:text-white cursor-pointer"
                                  title="Cancelar"
                                >
                                  <X className="w-4 h-4" />
                                </button>
                              </div>
                            ) : (
                              <p className="text-[13.5px] leading-[1.55] text-zinc-200 whitespace-pre-wrap break-words">
                                {msg.content}
                                {msg.edited_at && (
                                  <span className="ml-1.5 text-[11px] text-zinc-500">
                                    (editada)
                                  </span>
                                )}
                                {msg.delivery_status === 'sending' && (
                                  <Clock className="inline w-3 h-3 ml-1.5 text-zinc-400" />
                                )}
                                {msg.delivery_status === 'failed' && (
                                  <span className="ml-1.5 text-[11px] text-rose-400">
                                    Falha ao enviar
                                  </span>
                                )}
                              </p>
                            )}
                          </div>

                          {!isEditing && (isMine || canDeleteMsg) && !msg.id.startsWith('opt_') && (
                            <div className="hidden group-hover:flex items-center gap-1 bg-[#131622] border border-white/[0.08] shadow-lg rounded-lg px-1 py-0.5 shrink-0">
                              {isMine && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setEditingMessageId(msg.id);
                                    setEditingContent(msg.content);
                                  }}
                                  className="p-1 text-zinc-400 hover:text-white cursor-pointer"
                                  title="Editar mensagem"
                                >
                                  <Edit2 className="w-3.5 h-3.5" />
                                </button>
                              )}
                              {canDeleteMsg && (
                                <button
                                  type="button"
                                  onClick={() => void deleteChannelMessage(msg.id)}
                                  className="p-1 text-zinc-400 hover:text-rose-400 cursor-pointer"
                                  title="Excluir mensagem"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      </React.Fragment>
                    );
                  })
                )}
                {activeCommunityStreams.length > 0 && (
                  <div className="pt-2 space-y-2.5">
                    {activeCommunityStreams.map((item) => (
                      <ActiveStreamCard
                        key={item.key}
                        streamerName={item.streamerName}
                        streamerAvatarUrl={item.streamerAvatarUrl}
                        streamerUserId={item.streamerUserId}
                        voiceChannelId={item.voiceChannelId}
                        voiceChannelName={item.voiceChannelName}
                        previewStream={item.previewStream}
                        resolutionLabel={item.resolutionLabel}
                        fpsLabel={item.fpsLabel}
                        isWatching={
                          activeVoiceCommunityId === selectedCommunity.id &&
                          activeVoiceChannelId === item.voiceChannelId &&
                          voiceRoomState !== 'idle'
                        }
                        onWatch={(voiceChannelId) => {
                          handleWatchStream(voiceChannelId, item.streamerUserId);
                        }}
                      />
                    ))}
                  </div>
                )}
                <div ref={messagesEndRef} />
              </div>

              {/* Message Input Floating Capsule */}
              <div className="px-4 pb-4 pt-2 shrink-0">
                {sendBlockedReason ? (
                  <div className="flex items-center gap-2.5 px-3.5 py-2.5 rounded-2xl bg-[#131622]/85 border border-white/[0.08] text-[13px] text-zinc-400">
                    <MessageSquareOff className="w-4 h-4 text-amber-400 shrink-0" />
                    <span>{sendBlockedReason}</span>
                  </div>
                ) : (
                  <div className="rounded-2xl border border-white/[0.08] bg-[#131622]/95 px-3.5 py-2.5 flex items-center gap-3 focus-within:border-[#C83E52]/50 transition-colors">
                    <input
                      type="text"
                      value={channelDraft}
                      onChange={(e) => setChannelDraft(e.target.value)}
                      onKeyDown={handleKeyDown}
                      placeholder={`Conversar em #${selectedChannel.name}`}
                      disabled={isSendingChannelMessage}
                      className="flex-1 bg-transparent text-[13.5px] text-zinc-100 placeholder:text-zinc-500 focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => void handleSendMessage()}
                      disabled={!channelDraft.trim() || isSendingChannelMessage}
                      className="p-2 rounded-xl bg-[#C83E52] hover:bg-[#E04F64] text-white disabled:opacity-40 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E04F64]/70"
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

          {/* Right Contextual Community Panel */}
          {showMembers && communitySnapshot && (
            <>
              {isCompactContextOverlay && (
                <div
                  className="absolute inset-0 top-[52px] z-20 bg-black/45 backdrop-blur-[1px]"
                  onClick={() => setShowMembers(false)}
                  aria-hidden="true"
                />
              )}
              <aside
                aria-label="Painel contextual da comunidade"
                className={
                  isCompactContextOverlay
                    ? 'absolute right-0 top-[52px] bottom-0 z-30 w-64 max-w-[85%] bg-[#0B0D14]/98 backdrop-blur-xl border-l border-white/[0.09] shadow-[-16px_0_40px_rgba(0,0,0,0.8)] overflow-y-auto overflow-x-hidden p-3 select-none'
                    : 'w-56 xl:w-64 bg-[#0E1018]/85 border-l border-white/[0.06] overflow-y-auto overflow-x-hidden p-3 shrink-0 select-none'
                }
              >
                <CommunityContextPanel
                  selectedChannel={selectedChannel}
                  voiceChannels={voiceChannelsWithPresence}
                  activeStreams={activeCommunityStreams}
                  members={communitySnapshot.members}
                  currentUserId={currentUserId}
                  onSelectChannel={handleContextChannelSelect}
                  onWatchStream={handleWatchStream}
                />
              </aside>
            </>
          )}
        </div>
      </div>

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
