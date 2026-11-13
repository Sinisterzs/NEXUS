import { create } from 'zustand';
import {
  MainTab,
  UserProfile,
  UserStatus,
  CallParticipant,
  AppSettings,
  AuthUserProfile,
  AuthMode,
  AuthStatus,
  Friend,
  FriendRequestsData,
  UserSearchResult,
  DirectConversationDto,
  DirectMessageDto,
  NetworkStatus,
  PersistedPreferences,
  ScreenShareQualityPreset,
  CaptureSources,
  NativeCaptureStatus,
  NativeScreenStatsEvent,
  StartScreenShareOptions,
  CommunityDto,
  CommunitySnapshotDto,
  CommunityCategoryDto,
  CommunityChannelDto,
  CommunityRoleDto,
  CommunityMemberDto,
  ChannelPermissionOverwriteDto,
  ChannelMessageDto,
  CommunityInviteDto,
  InvitePreviewDto,
  AcceptInviteResponse,
  CommunityBanDto,
  CommunityMemberMuteDto,
  CommunityAuditLogDto,
  CreateCommunityPayload,
  UpdateCommunityPayload,
  DeleteCommunityPayload,
  TransferOwnershipPayload,
  CreateCategoryPayload,
  UpdateCategoryPayload,
  ReorderCategoryItem,
  CreateChannelPayload,
  UpdateChannelPayload,
  ReorderChannelItem,
  UpsertChannelOverwritePayload,
  OverwriteTargetType,
  CreateRolePayload,
  UpdateRolePayload,
  ReorderRoleItem,
  UpdateMemberPayload,
  KickMemberPayload,
  BanMemberPayload,
  MuteMemberPayload,
  AuditLogsQueryPayload,
  CreateInvitePayload,
} from '../lib/types';
import {
  mockCurrentUser,
  initialAppSettings,
} from '../mocks';
import { settingsRepository } from '../repositories/SettingsRepository';
import { authRepository, normalizeAuthUser } from '../repositories/AuthRepository';
import { friendRepository } from '../repositories/FriendRepository';
import { presenceRepository } from '../repositories/PresenceRepository';
import { dmRepository } from '../repositories/DmRepository';
import { communityRepository } from '../repositories/CommunityRepository';
import { conversationRepository } from '../repositories/ConversationRepository';
import { messageRepository } from '../repositories/MessageRepository';
import { callHistoryRepository } from '../repositories/CallHistoryRepository';
import { gatewayClient } from '../services/GatewayClient';
import { callService } from '../services/CallService';
import { meshRoomService, type ScreenReceiverState } from '../services/MeshRoomService';
import { screenCaptureService } from '../services/ScreenCaptureService';
import { networkManager, DEFAULT_NETWORK_STATUS } from '../services/NetworkManager';
import { updateService } from '../services/UpdateService';
import {
  DeliveryStatus,
  RoomParticipantDto,
  VoiceRoomMetricsSnapshot,
  VoiceRoomPeerStatus,
  VoiceRoomQualityPreset,
  VoiceRoomState,
} from '../lib/types';

export function syncAccountRepositories(accountId?: string | null): void {
  const resolved = accountId?.trim() || 'offline_demo';
  settingsRepository.setAccountId(resolved);
  callHistoryRepository.setAccountId(resolved);
  conversationRepository.setAccountId(resolved);
  messageRepository.setAccountId(resolved);
}

export function deliveryStatusRank(status?: DeliveryStatus): number {
  switch (status) {
    case 'read':
      return 4;
    case 'delivered':
      return 3;
    case 'sent':
    case 'local_saved':
      return 2;
    case 'sending':
    case 'pending':
      return 1;
    case 'failed':
      return 0;
    default:
      return 2;
  }
}

export function resolveEffectiveDeliveryStatus(msg: DirectMessageDto): DeliveryStatus {
  if (msg.read_at) return 'read';
  if (msg.delivered_at) return 'delivered';
  if (msg.delivery_status) return msg.delivery_status;
  return 'sent';
}

export function mergeSingleMessage(
  existing: DirectMessageDto,
  incoming: DirectMessageDto
): DirectMessageDto {
  const existingIsOptimistic =
    existing.id.startsWith('opt_') || existing.id.startsWith('local_');
  const incomingIsOptimistic =
    incoming.id.startsWith('opt_') || incoming.id.startsWith('local_');

  const canonicalId =
    existingIsOptimistic && !incomingIsOptimistic ? incoming.id : existing.id;

  // Preserve authoritative creation timestamp once assigned by server
  const createdAt =
    existingIsOptimistic && !incomingIsOptimistic
      ? incoming.created_at
      : existing.created_at || incoming.created_at;

  // Tombstone (`deleted_at`) is irreversible: delayed edit events cannot resurrect deleted messages
  const deletedAt = existing.deleted_at || incoming.deleted_at || null;
  const content = deletedAt
    ? '[Mensagem apagada]'
    : incoming.edited_at &&
      (!existing.edited_at ||
        Date.parse(incoming.edited_at) >= Date.parse(existing.edited_at))
    ? incoming.content
    : incoming.content || existing.content;

  const editedAt = deletedAt
    ? existing.edited_at || null
    : incoming.edited_at || existing.edited_at || null;

  const deliveredAt = existing.delivered_at || incoming.delivered_at || null;
  const readAt = existing.read_at || incoming.read_at || null;

  const existingStatus = resolveEffectiveDeliveryStatus(existing);
  const incomingStatus = resolveEffectiveDeliveryStatus(incoming);

  let finalStatus: DeliveryStatus;
  if (incomingStatus === 'failed' && existingStatus === 'sending') {
    finalStatus = 'failed';
  } else {
    finalStatus =
      deliveryStatusRank(incomingStatus) >= deliveryStatusRank(existingStatus)
        ? incomingStatus
        : existingStatus;
  }

  return {
    ...existing,
    ...incoming,
    id: canonicalId,
    client_message_id: incoming.client_message_id || existing.client_message_id,
    created_at: createdAt,
    content,
    edited_at: editedAt,
    deleted_at: deletedAt,
    delivered_at: deliveredAt,
    read_at: readAt,
    delivery_status: finalStatus,
  };
}

export function mergeAndSortMessages(
  existingList: DirectMessageDto[],
  incomingList: DirectMessageDto[]
): DirectMessageDto[] {
  const result: DirectMessageDto[] = [];
  const byId = new Map<string, number>();
  const byClientId = new Map<string, number>();

  const upsert = (msg: DirectMessageDto) => {
    const normMsg: DirectMessageDto = {
      ...msg,
      delivery_status: resolveEffectiveDeliveryStatus(msg),
    };
    const cid = normMsg.client_message_id?.trim();

    let matchIdx: number | undefined = byId.get(normMsg.id);
    if (matchIdx === undefined && cid) {
      matchIdx = byClientId.get(cid);
    }

    if (matchIdx !== undefined) {
      const merged = mergeSingleMessage(result[matchIdx], normMsg);
      result[matchIdx] = merged;
      byId.set(merged.id, matchIdx);
      if (merged.client_message_id?.trim()) {
        byClientId.set(merged.client_message_id.trim(), matchIdx);
      }
    } else {
      const idx = result.length;
      result.push(normMsg);
      byId.set(normMsg.id, idx);
      if (cid) {
        byClientId.set(cid, idx);
      }
    }
  };

  for (const m of existingList) upsert(m);
  for (const m of incomingList) upsert(m);

  result.sort((a, b) => {
    const ta = Date.parse(a.created_at) || 0;
    const tb = Date.parse(b.created_at) || 0;
    if (ta !== tb) return ta - tb;
    return a.id.localeCompare(b.id);
  });

  return result;
}

export function mergeSingleChannelMessage(
  existing: ChannelMessageDto,
  incoming: ChannelMessageDto
): ChannelMessageDto {
  const existingIsOptimistic = existing.id.startsWith('opt_');
  const incomingIsOptimistic = incoming.id.startsWith('opt_');

  const canonicalId =
    existingIsOptimistic && !incomingIsOptimistic ? incoming.id : existing.id;

  const createdAt =
    existingIsOptimistic && !incomingIsOptimistic
      ? incoming.created_at
      : existing.created_at || incoming.created_at;

  const deletedAt = existing.deleted_at || incoming.deleted_at || null;
  const content = deletedAt
    ? '[Mensagem apagada]'
    : incoming.edited_at &&
      (!existing.edited_at ||
        Date.parse(incoming.edited_at) >= Date.parse(existing.edited_at))
    ? incoming.content
    : incoming.content || existing.content;

  const editedAt = deletedAt
    ? existing.edited_at || null
    : incoming.edited_at || existing.edited_at || null;

  const existingStatus = existing.delivery_status || 'sent';
  const incomingStatus = incoming.delivery_status || 'sent';
  let finalStatus: DeliveryStatus;
  if (incomingStatus === 'failed' && existingStatus === 'sending') {
    finalStatus = 'failed';
  } else {
    finalStatus =
      deliveryStatusRank(incomingStatus) >= deliveryStatusRank(existingStatus)
        ? incomingStatus
        : existingStatus;
  }

  return {
    ...existing,
    ...incoming,
    id: canonicalId,
    client_message_id: incoming.client_message_id || existing.client_message_id,
    created_at: createdAt,
    content,
    edited_at: editedAt,
    deleted_at: deletedAt,
    delivery_status: finalStatus,
  };
}

export function mergeAndSortChannelMessages(
  existingList: ChannelMessageDto[],
  incomingList: ChannelMessageDto[]
): ChannelMessageDto[] {
  const result: ChannelMessageDto[] = [];
  const byId = new Map<string, number>();
  const byClientId = new Map<string, number>();

  const upsert = (msg: ChannelMessageDto) => {
    const normMsg: ChannelMessageDto = {
      ...msg,
      delivery_status: msg.delivery_status || 'sent',
    };
    const cid = normMsg.client_message_id?.trim();

    let matchIdx: number | undefined = byId.get(normMsg.id);
    if (matchIdx === undefined && cid) {
      matchIdx = byClientId.get(cid);
    }

    if (matchIdx !== undefined) {
      const merged = mergeSingleChannelMessage(result[matchIdx], normMsg);
      result[matchIdx] = merged;
      byId.set(merged.id, matchIdx);
      if (merged.client_message_id?.trim()) {
        byClientId.set(merged.client_message_id.trim(), matchIdx);
      }
    } else {
      const idx = result.length;
      result.push(normMsg);
      byId.set(normMsg.id, idx);
      if (cid) {
        byClientId.set(cid, idx);
      }
    }
  };

  for (const m of existingList) upsert(m);
  for (const m of incomingList) upsert(m);

  result.sort((a, b) => {
    const ta = Date.parse(a.created_at) || 0;
    const tb = Date.parse(b.created_at) || 0;
    if (ta !== tb) return ta - tb;
    return a.id.localeCompare(b.id);
  });

  return result;
}

export function syncCommunityMembersPresence(
  members: CommunityMemberDto[],
  friends: Friend[],
  currentUser: UserProfile
): CommunityMemberDto[] {
  if (members.length === 0) return members;
  const friendMap = new Map<string, Friend>();
  for (const f of friends) {
    friendMap.set(f.id, f);
  }

  return members.map((m) => {
    if (m.user_id === currentUser.id) {
      return {
        ...m,
        status: currentUser.status || m.status,
        custom_status: currentUser.customStatus ?? m.custom_status,
      };
    }
    const friend = friendMap.get(m.user_id);
    if (friend) {
      return {
        ...m,
        status: friend.status || m.status,
        custom_status: friend.customStatus ?? m.custom_status,
      };
    }
    return m;
  });
}

let wsUnsubscribe: (() => void) | null = null;

function clearActiveCommunityState() {
  return {
    activeCommunityId: null,
    activeChannelId: null,
    communitySnapshot: null,
    activeCommunityChannelMessages: [] as ChannelMessageDto[],
    communityMessagesHasMore: false,
    communityMessagesNextBefore: null,
  };
}

interface AppState {
  // Initialization state
  isInitialized: boolean;

  // Online Auth & Connectivity State
  authStatus: AuthStatus;
  authMode: AuthMode;
  onlineUser: AuthUserProfile | null;
  authError: string | null;
  isAuthModalOpen: boolean;
  isGoogleLoading: boolean;
  backendAvailable: boolean;
  networkStatus: NetworkStatus;

  // Navigation & Workspace
  activeTab: MainTab;
  isSidebarCollapsed: boolean;
  activeCommunityId: string | null;
  activeChannelId: string | null;
  activeDmId: string | null;

  // Current User Profile
  currentUser: UserProfile;

  // Friends & Social State (Phase 2.2)
  friends: Friend[];
  friendRequests: FriendRequestsData;
  isAddFriendModalOpen: boolean;
  isSearchingUsers: boolean;
  userSearchResults: UserSearchResult[];
  isWsConnected: boolean;
  gatewayConnected: boolean;

  // Phase 2.3: Direct Messages State
  conversations: DirectConversationDto[];
  activeConversationId: string | null;
  activeConversationMessages: DirectMessageDto[];
  isLoadingConversations: boolean;
  isLoadingMessages: boolean;
  isSendingDm: boolean;
  dmError: string | null;

  // Phase B2: Communities State
  communities: CommunityDto[];
  communitySnapshot: CommunitySnapshotDto | null;
  activeCommunityChannelMessages: ChannelMessageDto[];
  communityMessagesHasMore: boolean;
  communityMessagesNextBefore: string | null;
  communityBans: CommunityBanDto[];
  communityAuditLogs: CommunityAuditLogDto[];
  communityInvites: CommunityInviteDto[];
  isLoadingCommunities: boolean;
  isLoadingCommunitySnapshot: boolean;
  isLoadingChannelMessages: boolean;
  isSendingChannelMessage: boolean;
  communityError: string | null;

  // Phase B3.2: Multi-participant Voice Rooms State
  voiceRoomState: VoiceRoomState;
  activeVoiceCommunityId: string | null;
  activeVoiceChannelId: string | null;
  voiceRoomMaxParticipants: number;
  voiceRoomCanSpeak: boolean;
  voiceRoomCanScreenShare: boolean;
  voiceRoomParticipants: RoomParticipantDto[];
  voiceRoomMuted: boolean;
  voiceRoomDeafened: boolean;
  voiceRoomScreenSharing: boolean;
  voiceRoomQuality: VoiceRoomQualityPreset;
  voiceRoomPeerStatuses: Record<string, VoiceRoomPeerStatus>;
  voiceRoomRemoteStreams: Record<string, MediaStream>;
  voiceRoomParticipantVolumes: Record<string, number>;
  voiceRoomMetrics: VoiceRoomMetricsSnapshot | null;
  voiceRoomScreenReceivers: Record<string, ScreenReceiverState>;
  retryVoiceRoomScreen: (peerUserId: string) => boolean;
  voiceRoomError: string | null;
  communityVoiceRooms: Record<string, Record<string, RoomParticipantDto[]>>;

  // Local Audio & Call Controls (simulated state)
  isMicMuted: boolean;
  isDeafened: boolean;
  isCamOn: boolean;
  isCallActive: boolean;
  activeCallRoom: string;
  isCallParticipantsOpen: boolean;
  callParticipants: CallParticipant[];

  // Phase 2.4: Real Voice Calls State
  voiceCallState: 'idle' | 'calling' | 'incoming' | 'connecting' | 'connected' | 'reconnecting';
  activeCallId: string | null;
  activeCallPeer: { id: string; name: string; username: string; avatarUrl?: string } | null;
  incomingCall: {
    callId: string;
    caller: { id: string; username: string; displayName?: string; avatarUrl?: string };
  } | null;
  callDurationSecs: number;
  isLocalSpeaking: boolean;
  isRemoteSpeaking: boolean;
  isPeerMuted: boolean;
  callErrorMessage: string | null;
  callDeviceNotice: string | null;
  reconnectAttempt: number;
  maxReconnectAttempts: number;
  callLayoutMode: 'compact' | 'balanced' | 'cinema';

  // Phase 3.0: Local Screen Capture State
  isScreenSharing: boolean;
  isStartingScreenShare: boolean;
  screenStream: MediaStream | null;
  screenShareLabel: string | null;
  screenShareQuality: ScreenShareQualityPreset;
  screenEffectiveWidth: number | null;
  screenEffectiveHeight: number | null;
  screenEffectiveFps: number | null;
  screenQualityFallbackNotice: string | null;
  screenCaptureNotice: string | null;
  screenDisplaySurface: string | null;
  screenShareError: string | null;
  screenPickerTarget: 'room' | 'call' | null;
  nativeCaptureSources: CaptureSources | null;
  nativeCaptureStatus: NativeCaptureStatus | null;
  nativeScreenStats: NativeScreenStatsEvent | null;
  isLoadingNativeSources: boolean;
  openScreenSourcePicker: (target: 'room' | 'call') => Promise<void>;
  closeScreenSourcePicker: () => void;
  refreshNativeCaptureSources: () => Promise<CaptureSources | null>;
  startNativeVoiceRoomScreenShare: (options: StartScreenShareOptions) => Promise<boolean>;
  startNativeCallScreenShare: (options: StartScreenShareOptions) => Promise<boolean>;
  startScreenShare: (preset?: ScreenShareQualityPreset) => Promise<MediaStream | null>;
  stopScreenShare: () => void;
  setScreenShareQuality: (preset: ScreenShareQualityPreset) => Promise<void>;
  clearScreenShareError: () => void;

  // Phase 3.1: Remote Screen Share State (Received via WebRTC)
  isRemoteScreenSharing: boolean;
  remoteScreenStream: MediaStream | null;
  remoteScreenTrack: MediaStreamTrack | null;
  isRemoteScreenMuted: boolean;
  setRemoteScreenStream: (stream: MediaStream | null, track: MediaStreamTrack | null) => void;
  setRemoteScreenMuted: (isMuted: boolean) => void;

  // App Settings (session persistence)
  settings: AppSettings;

  // Initialization & Hydration
  initializeStore: (overrideTab?: MainTab) => Promise<void>;

  // Auth Actions
  checkSession: () => Promise<void>;
  loginOnline: (login: string, password: string) => Promise<boolean>;
  registerOnline: (
    username: string,
    email: string,
    password: string,
    displayName?: string
  ) => Promise<boolean>;
  loginGoogle: () => Promise<boolean>;
  linkGoogle: () => Promise<string>;
  unlinkGoogle: () => Promise<void>;
  cancelGoogleLogin: () => Promise<void>;
  logoutOnline: () => Promise<void>;
  setOfflineDemoMode: () => void;
  openAuthModal: () => void;
  closeAuthModal: () => void;
  clearAuthError: () => void;

  // Network & Tailscale Actions
  checkNetwork: (includeTailscale?: boolean) => Promise<NetworkStatus>;
  openTailscale: () => Promise<void>;
  setServerAddress: (url: string) => Promise<void>;
  approveServer: () => Promise<void>;

  // Updates & Channel Actions
  updateChannel: 'stable' | 'beta';
  setUpdateChannel: (channel: 'stable' | 'beta') => Promise<void>;

  // Friends & Social Actions (Phase 2.2)
  loadFriends: () => Promise<void>;
  loadFriendRequests: () => Promise<void>;
  sendFriendRequest: (target: string) => Promise<boolean>;
  acceptFriendRequest: (requestId: string) => Promise<boolean>;
  declineFriendRequest: (requestId: string) => Promise<boolean>;
  rejectFriendRequest: (requestId: string) => Promise<boolean>;
  cancelFriendRequest: (requestId: string) => Promise<boolean>;
  removeFriend: (friendId: string) => Promise<boolean>;
  blockUser: (userId: string) => Promise<boolean>;
  unblockUser: (userId: string) => Promise<boolean>;
  searchUsers: (query: string) => Promise<void>;
  clearUserSearch: () => void;
  openAddFriendModal: () => void;
  closeAddFriendModal: () => void;
  initWebSocket: () => void;
  closeWebSocket: () => void;

  // Phase 2.3: DM Actions
  loadConversations: () => Promise<void>;
  selectConversation: (conversationId: string) => Promise<void>;
  startConversationWithUser: (targetUserId?: string, username?: string) => Promise<string | null>;
  sendDirectMessage: (content: string) => Promise<boolean>;
  editDirectMessage: (messageId: string, content: string) => Promise<boolean>;
  deleteDirectMessage: (messageId: string) => Promise<boolean>;
  markActiveConversationRead: () => Promise<void>;
  loadOlderMessages: () => Promise<void>;

  // Phase B2: Communities Actions
  loadCommunities: () => Promise<void>;
  selectCommunity: (communityId: string | null) => Promise<void>;
  loadCommunitySnapshot: (communityId: string) => Promise<CommunitySnapshotDto | null>;
  createCommunity: (payload: CreateCommunityPayload) => Promise<CommunityDto | null>;
  updateCommunity: (communityId: string, payload: UpdateCommunityPayload) => Promise<CommunityDto | null>;
  deleteCommunity: (communityId: string, payload: DeleteCommunityPayload) => Promise<boolean>;
  transferCommunityOwnership: (communityId: string, payload: TransferOwnershipPayload) => Promise<CommunityDto | null>;
  leaveCommunity: (communityId: string) => Promise<boolean>;
  createCommunityCategory: (communityId: string, payload: CreateCategoryPayload) => Promise<CommunityCategoryDto | null>;
  updateCommunityCategory: (communityId: string, categoryId: string, payload: UpdateCategoryPayload) => Promise<CommunityCategoryDto | null>;
  deleteCommunityCategory: (communityId: string, categoryId: string) => Promise<boolean>;
  reorderCommunityCategories: (communityId: string, items: ReorderCategoryItem[]) => Promise<boolean>;
  createCommunityChannel: (communityId: string, payload: CreateChannelPayload) => Promise<CommunityChannelDto | null>;
  updateCommunityChannel: (communityId: string, channelId: string, payload: UpdateChannelPayload) => Promise<CommunityChannelDto | null>;
  deleteCommunityChannel: (communityId: string, channelId: string) => Promise<boolean>;
  reorderCommunityChannels: (communityId: string, items: ReorderChannelItem[]) => Promise<boolean>;
  selectCommunityChannel: (channelId: string | null) => Promise<void>;
  listChannelOverwrites: (communityId: string, channelId: string) => Promise<ChannelPermissionOverwriteDto[]>;
  upsertChannelOverwrite: (communityId: string, channelId: string, payload: UpsertChannelOverwritePayload) => Promise<ChannelPermissionOverwriteDto | null>;
  deleteChannelOverwrite: (communityId: string, channelId: string, targetType: OverwriteTargetType | string, targetId: string) => Promise<boolean>;
  loadChannelMessages: (communityId: string, channelId: string, before?: string, limit?: number) => Promise<void>;
  refreshActiveChannelMessages: () => Promise<void>;
  loadOlderChannelMessages: () => Promise<void>;
  sendChannelMessage: (content: string, replyToMessageId?: string | null) => Promise<boolean>;
  editChannelMessage: (messageId: string, content: string) => Promise<boolean>;
  deleteChannelMessage: (messageId: string) => Promise<boolean>;
  markChannelRead: (communityId?: string, channelId?: string, lastReadMessageId?: string | null) => Promise<void>;
  createCommunityRole: (communityId: string, payload: CreateRolePayload) => Promise<CommunityRoleDto | null>;
  updateCommunityRole: (communityId: string, roleId: string, payload: UpdateRolePayload) => Promise<CommunityRoleDto | null>;
  deleteCommunityRole: (communityId: string, roleId: string) => Promise<boolean>;
  reorderCommunityRoles: (communityId: string, items: ReorderRoleItem[]) => Promise<boolean>;
  updateCommunityMember: (communityId: string, userId: string, payload: UpdateMemberPayload) => Promise<CommunityMemberDto | null>;
  setCommunityMemberRoles: (communityId: string, userId: string, roleIds: string[]) => Promise<CommunityMemberDto | null>;
  addCommunityMemberRole: (communityId: string, userId: string, roleId: string) => Promise<CommunityMemberDto | null>;
  removeCommunityMemberRole: (communityId: string, userId: string, roleId: string) => Promise<CommunityMemberDto | null>;
  kickCommunityMember: (communityId: string, userId: string, payload?: KickMemberPayload) => Promise<boolean>;
  banCommunityMember: (communityId: string, userId: string, payload?: BanMemberPayload) => Promise<boolean>;
  unbanCommunityMember: (communityId: string, userId: string) => Promise<boolean>;
  loadCommunityBans: (communityId: string) => Promise<CommunityBanDto[]>;
  muteCommunityMember: (communityId: string, userId: string, payload: MuteMemberPayload) => Promise<CommunityMemberMuteDto | null>;
  loadCommunityAuditLogs: (communityId: string, query?: AuditLogsQueryPayload) => Promise<CommunityAuditLogDto[]>;
  createCommunityInvite: (communityId: string, payload?: CreateInvitePayload) => Promise<CommunityInviteDto | null>;
  loadCommunityInvites: (communityId: string) => Promise<CommunityInviteDto[]>;
  revokeCommunityInvite: (communityId: string, inviteId: string) => Promise<boolean>;
  previewCommunityInvite: (code: string) => Promise<InvitePreviewDto>;
  acceptCommunityInvite: (code: string) => Promise<AcceptInviteResponse | null>;
  clearCommunityError: () => void;

  // Phase B3.2: Multi-participant Voice Room Actions
  loadCommunityVoiceRooms: (communityId: string) => Promise<void>;
  joinVoiceChannel: (communityId: string, channelId: string) => Promise<void>;
  leaveVoiceChannel: () => Promise<void>;
  toggleVoiceRoomMute: () => void;
  toggleVoiceRoomDeafen: () => void;
  setVoiceRoomParticipantVolume: (peerUserId: string, volume: number) => void;
  startVoiceRoomScreenShare: (preset?: VoiceRoomQualityPreset) => Promise<boolean>;
  stopVoiceRoomScreenShare: () => Promise<void>;
  setVoiceRoomQuality: (preset: VoiceRoomQualityPreset) => Promise<void>;
  clearVoiceRoomError: () => void;

  // Actions
  setActiveTab: (tab: MainTab) => void;
  toggleSidebar: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setActiveCommunity: (id: string | null) => void;
  setActiveChannel: (id: string | null) => void;
  setActiveDm: (id: string | null) => void;

  // Audio / Call Actions
  toggleMic: () => void;
  toggleDeafen: () => void;
  toggleCam: () => void;
  toggleScreenShare: () => void;
  toggleCallParticipants: () => void;
  disconnectCall: () => void;
  joinCall: (roomName: string) => void;

  // Phase 2.4 Voice Call Actions
  setVoiceCallState: (voiceCallState: 'idle' | 'calling' | 'incoming' | 'connecting' | 'connected' | 'reconnecting') => void;
  setActiveCall: (callId: string | null, peer: { id: string; name: string; username: string; avatarUrl?: string } | null) => void;
  setIncomingCall: (incomingCall: { callId: string; caller: { id: string; username: string; displayName?: string; avatarUrl?: string } } | null) => void;
  setCallDurationSecs: (secs: number) => void;
  setSpeakingState: (target: 'local' | 'remote', isSpeaking: boolean) => void;
  setPeerMuted: (isPeerMuted: boolean) => void;
  setCallErrorMessage: (msg: string | null) => void;
  setCallDeviceNotice: (notice: string | null) => void;
  setReconnectStatus: (attempt: number, maxAttempts?: number) => void;
  setParticipantVolume: (peerId: string, volume: number) => void;
  setCallStageSplitRatio: (ratio: number) => void;
  setCallLayoutMode: (mode: 'compact' | 'balanced' | 'cinema') => void;

  // User & Settings Actions
  setUserStatus: (status: UserStatus) => void;
  updateProfile: (profile: Partial<AppSettings['profile']>) => void;
  saveProfile: (updates: {
    username?: string;
    displayName?: string;
    bio?: string;
    customStatus?: string;
    avatarUrl?: string;
  }) => Promise<void>;
  updateAppearance: (appearance: Partial<AppSettings['appearance']>) => void;
  updateAudioVideo: (audioVideo: Partial<AppSettings['audioVideo']>) => void;
  updateNotifications: (notifications: Partial<AppSettings['notifications']>) => void;
  updatePrivacy: (privacy: Partial<AppSettings['privacy']>) => void;
}

const getInitialTab = (): MainTab => {
  if (typeof window !== 'undefined') {
    const tabParam = new URLSearchParams(window.location.search).get('tab') as MainTab;
    if (['home', 'messages', 'communities', 'calls', 'settings'].includes(tabParam)) {
      return tabParam;
    }
  }
  return 'home';
};

function createAuthenticatedState(
  state: AppState,
  user: AuthUserProfile,
  accountAvatarUrl?: string,
  accountPrefs?: PersistedPreferences
) {
  const normUser = normalizeAuthUser(user);
  const previousAccountId = state.onlineUser?.id;
  const isDifferentAccount = previousAccountId !== normUser.id;
  const resolvedAvatar =
    accountAvatarUrl ||
    normUser.avatarUrl ||
    (!isDifferentAccount ? state.currentUser?.avatarUrl : undefined) ||
    (!isDifferentAccount ? state.settings?.profile?.avatarUrl : undefined);

  syncAccountRepositories(normUser.id);

  const updatedSettings = accountPrefs
    ? {
        profile: {
          ...state.settings.profile,
          username: normUser.username,
          displayName: normUser.displayName || normUser.username,
          tag: undefined,
          bio: normUser.bio || '',
          customStatus: normUser.customStatus || '',
          avatarUrl: resolvedAvatar,
        },
        appearance: {
          theme: accountPrefs.theme || state.settings.appearance.theme,
          compactMode: accountPrefs.compactMode ?? state.settings.appearance.compactMode,
          fontSize: accountPrefs.fontSize || state.settings.appearance.fontSize,
        },
        audioVideo: {
          ...state.settings.audioVideo,
          inputDevice: accountPrefs.inputDevice || state.settings.audioVideo.inputDevice,
          outputDevice: accountPrefs.outputDevice || state.settings.audioVideo.outputDevice,
          inputSensitivity: accountPrefs.inputSensitivity ?? state.settings.audioVideo.inputSensitivity,
          voiceAutoSensitivity: accountPrefs.voiceAutoSensitivity ?? true,
          voiceHangoverMs: accountPrefs.voiceHangoverMs ?? 400,
          voiceSoftGate: accountPrefs.voiceSoftGate ?? false,
          outputVolume: accountPrefs.outputVolume ?? state.settings.audioVideo.outputVolume,
          noiseSuppression: accountPrefs.noiseSuppression ?? state.settings.audioVideo.noiseSuppression,
          echoCancellation: accountPrefs.echoCancellation ?? state.settings.audioVideo.echoCancellation,
          autoGainControl: accountPrefs.autoGainControl ?? state.settings.audioVideo.autoGainControl ?? true,
          screenShareQuality: accountPrefs.screenShareQuality ?? state.settings.audioVideo.screenShareQuality ?? 'auto',
          participantVolumes: accountPrefs.participantVolumes ?? state.settings.audioVideo.participantVolumes ?? {},
          callStageSplitRatio: accountPrefs.callStageSplitRatio ?? state.settings.audioVideo.callStageSplitRatio ?? 65,
        },
        notifications: {
          desktopAlerts: accountPrefs.desktopAlerts ?? state.settings.notifications.desktopAlerts,
          soundEffects: accountPrefs.soundEffects ?? state.settings.notifications.soundEffects,
          mentionsOnly: accountPrefs.mentionsOnly ?? state.settings.notifications.mentionsOnly,
          dndMode: accountPrefs.dndMode ?? state.settings.notifications.dndMode,
        },
        privacy: {
          allowDmsFrom: accountPrefs.allowDmsFrom || state.settings.privacy.allowDmsFrom,
          showGameActivity: accountPrefs.showGameActivity ?? state.settings.privacy.showGameActivity,
          streamerMode: accountPrefs.streamerMode ?? state.settings.privacy.streamerMode,
        },
      }
    : {
        ...state.settings,
        profile: {
          ...state.settings.profile,
          username: normUser.username,
          displayName: normUser.displayName || normUser.username,
          tag: undefined,
          bio: normUser.bio || '',
          customStatus: normUser.customStatus || '',
          avatarUrl: resolvedAvatar,
        },
      };

  if (typeof document !== 'undefined' && updatedSettings.appearance.theme) {
    document.documentElement.setAttribute('data-theme', updatedSettings.appearance.theme);
  }

  return {
    authStatus: 'authenticated' as const,
    authMode: 'authenticated' as const,
    onlineUser: {
      ...normUser,
      avatarUrl: resolvedAvatar,
    },
    backendAvailable: true,
    // Reset DM/friend/community state if switching from another account or offline demo
    ...(isDifferentAccount
      ? {
          conversations: [],
          activeConversationId: null,
          activeConversationMessages: [],
          friends: [],
          friendRequests: { incoming: [], outgoing: [] },
          userSearchResults: [],
          dmError: null,
          communities: [],
          communitySnapshot: null,
          activeCommunityChannelMessages: [],
          communityMessagesHasMore: false,
          communityMessagesNextBefore: null,
          communityBans: [],
          communityAuditLogs: [],
          communityInvites: [],
          communityError: null,
        }
      : {}),
    currentUser: {
      id: normUser.id,
      username: normUser.username,
      displayName: normUser.displayName || normUser.username,
      tag: undefined,
      avatarUrl: resolvedAvatar,
      bio: normUser.bio || '',
      status: (normUser.status && normUser.status !== 'offline' ? (normUser.status as UserStatus) : 'online'),
      customStatus: normUser.customStatus || '',
      hasPassword: normUser.hasPassword,
      hasGoogle: normUser.hasGoogle,
    },
    settings: updatedSettings,
    isAuthModalOpen: false,
    authError: null,
  };
}

let isCheckingSessionInProgress = false;

export const useAppStore = create<AppState>((set, get) => ({
  isInitialized: false,
  authStatus: 'initializing',
  authMode: 'checking',
  onlineUser: null,
  authError: null,
  isAuthModalOpen: false,
  isGoogleLoading: false,
  backendAvailable: false,
  networkStatus: DEFAULT_NETWORK_STATUS,
  updateChannel: settingsRepository.getUpdateChannelSync(),

  activeTab: getInitialTab(),
  isSidebarCollapsed: false,
  activeCommunityId: null,
  activeChannelId: null,
  activeDmId: null,
  currentUser: mockCurrentUser,

  // Friends & Social State
  friends: [],
  friendRequests: { incoming: [], outgoing: [] },
  isAddFriendModalOpen: false,
  isSearchingUsers: false,
  userSearchResults: [],
  isWsConnected: false,
  gatewayConnected: false,

  // Phase 2.3: DM Initial State
  conversations: [],
  activeConversationId: null,
  activeConversationMessages: [],
  isLoadingConversations: false,
  isLoadingMessages: false,
  isSendingDm: false,
  dmError: null,

  // Phase B2: Communities Initial State
  communities: [],
  communitySnapshot: null,
  activeCommunityChannelMessages: [],
  communityMessagesHasMore: false,
  communityMessagesNextBefore: null,
  communityBans: [],
  communityAuditLogs: [],
  communityInvites: [],
  isLoadingCommunities: false,
  isLoadingCommunitySnapshot: false,
  isLoadingChannelMessages: false,
  isSendingChannelMessage: false,
  communityError: null,

  // Phase B3.2: Multi-participant Voice Rooms Initial State
  voiceRoomState: 'idle',
  activeVoiceCommunityId: null,
  activeVoiceChannelId: null,
  voiceRoomMaxParticipants: 4,
  voiceRoomCanSpeak: true,
  voiceRoomCanScreenShare: true,
  voiceRoomParticipants: [],
  voiceRoomMuted: false,
  voiceRoomDeafened: false,
  voiceRoomScreenSharing: false,
  voiceRoomQuality: 'auto',
  voiceRoomPeerStatuses: {},
  voiceRoomRemoteStreams: {},
  voiceRoomParticipantVolumes: {},
  voiceRoomMetrics: null,
  voiceRoomScreenReceivers: {},
  voiceRoomError: null,
  communityVoiceRooms: {},

  // Call & Audio State
  isMicMuted: false,
  isDeafened: false,
  isCamOn: false,
  isCallActive: false,
  activeCallRoom: 'Sala de Voz',
  isCallParticipantsOpen: false,
  callParticipants: [],

  // Phase 2.4 Voice Call Initial State
  voiceCallState: 'idle',
  activeCallId: null,
  activeCallPeer: null,
  incomingCall: null,
  callDurationSecs: 0,
  isLocalSpeaking: false,
  isRemoteSpeaking: false,
  isPeerMuted: false,
  callErrorMessage: null,
  callDeviceNotice: null,
  reconnectAttempt: 0,
  maxReconnectAttempts: 3,
  callLayoutMode: 'balanced',

  // Phase 3.0 Screen Sharing Initial State
  isScreenSharing: false,
  isStartingScreenShare: false,
  screenStream: null,
  screenShareLabel: null,
  screenShareQuality: 'auto',
  screenEffectiveWidth: null,
  screenEffectiveHeight: null,
  screenEffectiveFps: null,
  screenQualityFallbackNotice: null,
  screenCaptureNotice: null,
  screenDisplaySurface: null,
  screenShareError: null,
  screenPickerTarget: null,
  nativeCaptureSources: null,
  nativeCaptureStatus: null,
  nativeScreenStats: null,
  isLoadingNativeSources: false,

  // Phase 3.1 Remote Screen Share Initial State
  isRemoteScreenSharing: false,
  remoteScreenStream: null,
  remoteScreenTrack: null,
  isRemoteScreenMuted: false,

  // Settings State
  settings: initialAppSettings,

  initializeStore: async (overrideTab) => {
    try {
      const channel = await settingsRepository.getUpdateChannel();
      updateService.setChannel(channel);

      const prefs = await settingsRepository.loadPreferences();

      // Immediately apply authoritative theme and font attributes to prevent flashes
      if (typeof document !== 'undefined' && prefs.theme) {
        document.documentElement.setAttribute('data-theme', prefs.theme);
        if (prefs.fontSize) document.documentElement.setAttribute('data-font-size', prefs.fontSize);
        if (typeof prefs.compactMode === 'boolean') {
          document.documentElement.setAttribute('data-compact', String(prefs.compactMode));
        }
      }

      // Check if URL search param exists
      const urlTab = typeof window !== 'undefined'
        ? (new URLSearchParams(window.location.search).get('tab') as MainTab)
        : null;

      const finalTab = overrideTab || urlTab || prefs.activeTab || 'home';

      set({
        activeTab: finalTab,
        updateChannel: channel,
        isSidebarCollapsed: prefs.isSidebarCollapsed ?? false,
        activeCommunityId: prefs.activeCommunityId ?? null,
        activeChannelId: prefs.activeChannelId ?? null,
        activeDmId: prefs.activeDmId ?? null,
        settings: {
          profile: {
            ...initialAppSettings.profile,
            avatarUrl: prefs.avatarUrl,
          },
          appearance: {
            theme: prefs.theme,
            compactMode: prefs.compactMode,
            fontSize: prefs.fontSize,
          },
          audioVideo: {
            inputDevice: prefs.inputDevice,
            outputDevice: prefs.outputDevice,
            inputSensitivity: prefs.inputSensitivity,
            voiceAutoSensitivity: prefs.voiceAutoSensitivity ?? true,
            voiceHangoverMs: prefs.voiceHangoverMs ?? 400,
            voiceSoftGate: prefs.voiceSoftGate ?? false,
            outputVolume: prefs.outputVolume,
            noiseSuppression: prefs.noiseSuppression,
            echoCancellation: prefs.echoCancellation,
            autoGainControl: prefs.autoGainControl ?? true,
            screenShareQuality: prefs.screenShareQuality ?? 'auto',
            participantVolumes: prefs.participantVolumes ?? {},
            callStageSplitRatio: prefs.callStageSplitRatio ?? 65,
            cameraDevice: initialAppSettings.audioVideo.cameraDevice,
          },
          notifications: {
            desktopAlerts: prefs.desktopAlerts,
            soundEffects: prefs.soundEffects,
            mentionsOnly: prefs.mentionsOnly,
            dndMode: prefs.dndMode,
          },
          privacy: {
            allowDmsFrom: prefs.allowDmsFrom,
            showGameActivity: prefs.showGameActivity,
            streamerMode: prefs.streamerMode,
          },
        },
      });

      // Setup reactive network monitoring
      networkManager.addListener((status) => {
        set({ networkStatus: status });
        if (status.server_reachability === 'connected') {
          set({ backendAvailable: true });
          const currentMode = get().authMode;
          const currentStatus = get().authStatus;
          const isInitialized = get().isInitialized;
          // Only trigger automatic reconnection if already initialized (background reconnect),
          // avoiding duplicate/competing calls during startup sequence!
          if (isInitialized && (currentMode === 'reconnecting' || currentStatus === 'offline')) {
            console.log('[useAppStore] Conexão com o servidor restabelecida. Reconectando sessão...');
            get().checkSession();
          }
        } else {
          set({ backendAvailable: false });
          if (get().authStatus === 'authenticated') {
            set({ authStatus: 'offline', authMode: 'reconnecting' });
          }
        }
      });

      // Restore session or determine connectivity status before marking as initialized
      // Guarded by a strict safety timeout (6s) to ensure initialization always concludes cleanly
      await Promise.race([
        get().checkSession(),
        new Promise<void>((resolve) => {
          setTimeout(() => {
            console.warn('[useAppStore] Timeout de segurança atingido na verificação inicial.');
            resolve();
          }, 6000);
        }),
      ]);

      // If still connecting after session check/timeout, fallback to server_unreachable
      if (get().networkStatus.server_reachability === 'connecting') {
        set({
          networkStatus: {
            ...get().networkStatus,
            server_reachability: 'server_unreachable',
          },
        });
      }
    } catch (err) {
      console.error('[useAppStore] Error during initializeStore:', err);
      set({ authStatus: 'unauthenticated', authMode: 'offline_demo' });
    } finally {
      // Mark initialized ONLY after preferences and auth state are fully resolved
      set({ isInitialized: true });
    }
  },

  checkNetwork: async (includeTailscale?: boolean) => {
    const status = await networkManager.checkNetwork(includeTailscale);
    set({ networkStatus: status });
    return status;
  },

  openTailscale: async () => {
    await networkManager.openTailscale();
  },

  setServerAddress: async (url: string) => {
    await networkManager.setServerAddress(url);
    await get().checkSession();
  },

  approveServer: async () => {
    const netStatus = get().networkStatus;
    if (netStatus.pending_server_identity) {
      await networkManager.approveServer(
        netStatus.pending_server_identity.bound_endpoint,
        netStatus.pending_server_identity.server_id,
        netStatus.pending_server_identity.public_key,
      );
      await get().checkSession();
    }
  },

  setUpdateChannel: async (channel) => {
    set({ updateChannel: channel });
    updateService.setChannel(channel);
    await settingsRepository.setUpdateChannel(channel);
    await updateService.checkForUpdates(false, channel);
  },

  checkSession: async () => {
    if (isCheckingSessionInProgress) {
      return;
    }
    isCheckingSessionInProgress = true;
    try {
      const netStatus = await networkManager.checkNetwork();
      set({ networkStatus: netStatus });

      if (netStatus.server_reachability === 'needs_approval') {
        const hasToken = await authRepository.hasStoredSession().catch(() => false);
        set({
          backendAvailable: false,
          authStatus: hasToken ? 'offline' : 'unauthenticated',
          authMode: hasToken ? 'reconnecting' : 'offline_demo',
        });
        return;
      }

      if (netStatus.server_reachability === 'network_disconnected' || netStatus.server_reachability === 'server_unreachable') {
        set({ backendAvailable: false });
        const hasToken = await authRepository.hasStoredSession();
        if (hasToken) {
          // Preserve stored credentials safely in Keyring. DO NOT log out.
          set({
            authStatus: 'offline',
            authMode: 'reconnecting',
            backendAvailable: false,
            isAuthModalOpen: false,
          });
          get().loadConversations();
          return;
        } else {
          set({
            authStatus: 'unauthenticated',
            authMode: 'offline_demo',
            onlineUser: null,
            currentUser: mockCurrentUser,
            friends: [],
            friendRequests: { incoming: [], outgoing: [] },
            isAuthModalOpen: false,
          });
          return;
        }
      }

      set({ backendAvailable: true });
      const { user, isOffline, hasStoredToken } = await authRepository.restoreSession();

      if (user) {
        await settingsRepository.flushSave();
        const accPrefs = await settingsRepository.loadPreferences(user.id);
        set((state) => createAuthenticatedState(state, user, accPrefs.avatarUrl, accPrefs));

        // Initialize social friends, communities & real-time presence
        get().loadFriends();
        get().loadFriendRequests();
        get().loadConversations();
        get().loadCommunities();
        get().initWebSocket();

        // Restore saved presence preference if available
        presenceRepository
          .getPresence()
          .then((p) => {
            if (p?.preferredStatus && p.preferredStatus !== 'offline') {
              set((state) => ({
                currentUser: {
                  ...state.currentUser,
                  status: p.preferredStatus as UserStatus,
                  customStatus: p.customStatus || state.currentUser.customStatus,
                },
              }));
            }
          })
          .catch(() => {});
      } else if (isOffline && hasStoredToken) {
        // Backend temporarily down or unreachable, but valid credentials exist in Keyring.
        // DO NOT log out, preserve stored credentials.
        set({
          authStatus: 'offline',
          authMode: 'reconnecting',
          backendAvailable: false,
          isAuthModalOpen: false,
        });
        get().loadConversations();
      } else {
        // No session stored in Keyring or session was revoked (401)
        syncAccountRepositories('offline_demo');
        const demoPrefs = await settingsRepository.loadPreferences('offline_demo');
        set({
          authStatus: 'unauthenticated',
          authMode: 'offline_demo',
          onlineUser: null,
          currentUser: {
            ...mockCurrentUser,
            avatarUrl: demoPrefs.avatarUrl || mockCurrentUser.avatarUrl,
          },
          friends: [],
          friendRequests: { incoming: [], outgoing: [] },
          conversations: [],
          activeConversationId: null,
          activeConversationMessages: [],
          isAuthModalOpen: false,
          settings: {
            ...get().settings,
            profile: {
              ...initialAppSettings.profile,
              avatarUrl: demoPrefs.avatarUrl,
            },
          },
        });
      }
    } catch (err) {
      console.warn('[useAppStore] checkSession fallback:', err);
      const hasToken = await authRepository.hasStoredSession().catch(() => false);
      if (hasToken) {
        set({
          authStatus: 'offline',
          authMode: 'reconnecting',
          backendAvailable: false,
          isAuthModalOpen: false,
        });
        get().loadConversations();
      } else {
        set({
          authStatus: 'unauthenticated',
          authMode: 'offline_demo',
          backendAvailable: false,
          isAuthModalOpen: false,
          settings: {
            ...get().settings,
            profile: initialAppSettings.profile,
          },
        });
      }
    } finally {
      isCheckingSessionInProgress = false;
    }
  },

  loginOnline: async (login, password) => {
    set({ authError: null });
    try {
      await settingsRepository.flushSave();
      const user = await authRepository.login(login, password);
      const accPrefs = await settingsRepository.loadPreferences(user.id);
      set((state) => createAuthenticatedState(state, user, accPrefs.avatarUrl, accPrefs));

      // Initialize friends, communities & real-time presence
      get().loadFriends();
      get().loadFriendRequests();
      get().loadConversations();
      get().loadCommunities();
      get().initWebSocket();

      return true;
    } catch (err: any) {
      const msg = err?.message || 'Falha ao autenticar no servidor.';
      set({ authError: msg });
      throw err;
    }
  },

  registerOnline: async (username, email, password, displayName) => {
    set({ authError: null });
    try {
      await settingsRepository.flushSave();
      const user = await authRepository.register(username, email, password, displayName);
      const accPrefs = await settingsRepository.loadPreferences(user.id);
      set((state) => createAuthenticatedState(state, user, accPrefs.avatarUrl, accPrefs));

      // Initialize friends, communities & real-time presence
      get().loadFriends();
      get().loadFriendRequests();
      get().loadConversations();
      get().loadCommunities();
      get().initWebSocket();

      return true;
    } catch (err: any) {
      const msg = err?.message || 'Falha ao cadastrar usuário.';
      set({ authError: msg });
      throw err;
    }
  },

  loginGoogle: async () => {
    set({ isGoogleLoading: true, authError: null });
    try {
      await settingsRepository.flushSave();
      const user = await authRepository.loginGoogle();
      const accPrefs = await settingsRepository.loadPreferences(user.id);
      set((state) => ({
        ...createAuthenticatedState(state, user, accPrefs.avatarUrl, accPrefs),
        isGoogleLoading: false,
      }));

      // Initialize friends, communities & real-time presence
      get().loadFriends();
      get().loadFriendRequests();
      get().loadConversations();
      get().loadCommunities();
      get().initWebSocket();

      return true;
    } catch (err: any) {
      const msg = err?.message || 'Falha ao autenticar com o Google.';
      set({ authError: msg, isGoogleLoading: false });
      throw err;
    }
  },

  linkGoogle: async () => {
    try {
      const res = await authRepository.linkGoogle();
      const updated = await authRepository.getMe();
      if (updated) {
        set((state) => createAuthenticatedState(state, updated));
      }
      return res;
    } catch (err: any) {
      throw err;
    }
  },

  unlinkGoogle: async () => {
    await authRepository.unlinkGoogle();
    const updated = await authRepository.getMe();
    if (updated) {
      set((state) => createAuthenticatedState(state, updated));
    } else {
      set((state) => ({
        onlineUser: state.onlineUser ? { ...state.onlineUser, hasGoogle: false } : null,
        currentUser: {
          ...state.currentUser,
          hasGoogle: false,
        },
      }));
    }
  },

  cancelGoogleLogin: async () => {
    await authRepository.cancelGoogleLogin();
    set({ isGoogleLoading: false, authError: 'Login com Google cancelado.' });
  },

  logoutOnline: async () => {
    await settingsRepository.flushSave();
    callService.terminateOnLogout();
    void meshRoomService.leaveRoom();
    get().closeWebSocket();
    await authRepository.logout();
    syncAccountRepositories('offline_demo');
    const demoPrefs = await settingsRepository.loadPreferences('offline_demo');
    set({
      activeTab: 'home',
      authStatus: 'unauthenticated',
      authMode: 'offline_demo',
      onlineUser: null,
      currentUser: {
        ...mockCurrentUser,
        avatarUrl: demoPrefs.avatarUrl || mockCurrentUser.avatarUrl,
      },
      friends: [],
      friendRequests: { incoming: [], outgoing: [] },
      userSearchResults: [],
      conversations: [],
      activeConversationId: null,
      activeConversationMessages: [],
      dmError: null,
      communities: [],
      communitySnapshot: null,
      activeCommunityId: null,
      activeChannelId: null,
      activeCommunityChannelMessages: [],
      communityMessagesHasMore: false,
      communityMessagesNextBefore: null,
      communityBans: [],
      communityAuditLogs: [],
      communityInvites: [],
      communityError: null,

  // Phase B3.2: Multi-participant Voice Rooms Initial State
  voiceRoomState: 'idle',
  activeVoiceCommunityId: null,
  activeVoiceChannelId: null,
  voiceRoomMaxParticipants: 4,
  voiceRoomCanSpeak: true,
  voiceRoomCanScreenShare: true,
  voiceRoomParticipants: [],
  voiceRoomMuted: false,
  voiceRoomDeafened: false,
  voiceRoomScreenSharing: false,
  voiceRoomQuality: 'auto',
  voiceRoomPeerStatuses: {},
  voiceRoomRemoteStreams: {},
  voiceRoomParticipantVolumes: {},
  voiceRoomMetrics: null,
  voiceRoomScreenReceivers: {},
  voiceRoomError: null,
  communityVoiceRooms: {},
      isAuthModalOpen: false,
      settings: {
        ...get().settings,
        profile: {
          ...initialAppSettings.profile,
          avatarUrl: demoPrefs.avatarUrl,
        },
      },
    });
  },

  setOfflineDemoMode: () => {
    callService.terminateOnLogout();
    void meshRoomService.leaveRoom();
    get().closeWebSocket();
    syncAccountRepositories('offline_demo');
    set({
      authStatus: 'unauthenticated',
      authMode: 'offline_demo',
      onlineUser: null,
      currentUser: mockCurrentUser,
      friends: [],
      friendRequests: { incoming: [], outgoing: [] },
      userSearchResults: [],
      conversations: [],
      activeConversationId: null,
      activeConversationMessages: [],
      dmError: null,
      communities: [],
      communitySnapshot: null,
      activeCommunityId: null,
      activeChannelId: null,
      activeCommunityChannelMessages: [],
      communityMessagesHasMore: false,
      communityMessagesNextBefore: null,
      communityBans: [],
      communityAuditLogs: [],
      communityInvites: [],
      communityError: null,

  // Phase B3.2: Multi-participant Voice Rooms Initial State
  voiceRoomState: 'idle',
  activeVoiceCommunityId: null,
  activeVoiceChannelId: null,
  voiceRoomMaxParticipants: 4,
  voiceRoomCanSpeak: true,
  voiceRoomCanScreenShare: true,
  voiceRoomParticipants: [],
  voiceRoomMuted: false,
  voiceRoomDeafened: false,
  voiceRoomScreenSharing: false,
  voiceRoomQuality: 'auto',
  voiceRoomPeerStatuses: {},
  voiceRoomRemoteStreams: {},
  voiceRoomParticipantVolumes: {},
  voiceRoomMetrics: null,
  voiceRoomScreenReceivers: {},
  voiceRoomError: null,
  communityVoiceRooms: {},
      authError: null,
      isAuthModalOpen: false,
    });
  },

  openAuthModal: () => set({ isAuthModalOpen: true }),
  closeAuthModal: () => set({ isAuthModalOpen: false, authError: null }),
  clearAuthError: () => set({ authError: null }),

  // Friends & Social Actions
  loadFriends: async () => {
    if (get().authStatus !== 'authenticated') {
      set({ friends: [] });
      return;
    }
    try {
      const friends = await friendRepository.getFriends();
      set({ friends });
    } catch (err) {
      console.warn('[useAppStore] loadFriends failed:', err);
    }
  },

  loadFriendRequests: async () => {
    if (get().authStatus !== 'authenticated') {
      set({ friendRequests: { incoming: [], outgoing: [] } });
      return;
    }
    try {
      const friendRequests = await friendRepository.getRequests();
      set({ friendRequests });
    } catch (err) {
      console.warn('[useAppStore] loadFriendRequests failed:', err);
    }
  },

  sendFriendRequest: async (target: string) => {
    try {
      await friendRepository.sendRequest(target);
      await get().loadFriendRequests();
      await get().loadFriends();
      return true;
    } catch (err: any) {
      throw err;
    }
  },

  acceptFriendRequest: async (requestId: string) => {
    try {
      const newFriend = await friendRepository.acceptRequest(requestId);
      set((state) => ({
        friends: [...state.friends.filter((f) => f.id !== newFriend.id), newFriend],
        friendRequests: {
          ...state.friendRequests,
          incoming: state.friendRequests.incoming.filter((r) => r.id !== requestId),
        },
      }));
      return true;
    } catch (err: any) {
      throw err;
    }
  },

  rejectFriendRequest: async (requestId: string) => {
    try {
      await friendRepository.rejectRequest(requestId);
      set((state) => ({
        friendRequests: {
          ...state.friendRequests,
          incoming: state.friendRequests.incoming.filter((r) => r.id !== requestId),
        },
      }));
      return true;
    } catch (err: any) {
      throw err;
    }
  },

  declineFriendRequest: async (requestId: string) => {
    return get().rejectFriendRequest(requestId);
  },

  cancelFriendRequest: async (requestId: string) => {
    try {
      await friendRepository.cancelRequest(requestId);
      set((state) => ({
        friendRequests: {
          ...state.friendRequests,
          outgoing: state.friendRequests.outgoing.filter((r) => r.id !== requestId),
        },
      }));
      return true;
    } catch (err: any) {
      throw err;
    }
  },

  removeFriend: async (friendId: string) => {
    try {
      await friendRepository.removeFriend(friendId);
      set((state) => ({
        friends: state.friends.filter((f) => f.id !== friendId),
      }));
      return true;
    } catch (err: any) {
      throw err;
    }
  },

  blockUser: async (userId: string) => {
    try {
      await friendRepository.blockUser(userId);
      set((state) => ({
        friends: state.friends.filter((f) => f.id !== userId),
        friendRequests: {
          incoming: state.friendRequests.incoming.filter((r) => r.userId !== userId),
          outgoing: state.friendRequests.outgoing.filter((r) => r.userId !== userId),
        },
      }));
      return true;
    } catch (err: any) {
      throw err;
    }
  },

  unblockUser: async (userId: string) => {
    try {
      await friendRepository.unblockUser(userId);
      return true;
    } catch (err: any) {
      throw err;
    }
  },

  searchUsers: async (query: string) => {
    if (!query.trim()) {
      set({ userSearchResults: [], isSearchingUsers: false });
      return;
    }
    set({ isSearchingUsers: true });
    try {
      const results = await friendRepository.searchUsers(query.trim());
      set({ userSearchResults: results, isSearchingUsers: false });
    } catch {
      set({ userSearchResults: [], isSearchingUsers: false });
    }
  },

  clearUserSearch: () => set({ userSearchResults: [], isSearchingUsers: false }),

  openAddFriendModal: () => set({ isAddFriendModalOpen: true }),
  closeAddFriendModal: () => set({ isAddFriendModalOpen: false, userSearchResults: [] }),

  initWebSocket: () => {
    if (wsUnsubscribe) {
      wsUnsubscribe();
      wsUnsubscribe = null;
    }

    wsUnsubscribe = gatewayClient.addListener({
      onConnectionReady: ({ friends }) => {
        set((state) => ({
          friends,
          communitySnapshot: state.communitySnapshot
            ? {
                ...state.communitySnapshot,
                members: syncCommunityMembersPresence(
                  state.communitySnapshot.members,
                  friends,
                  state.currentUser
                ),
              }
            : null,
        }));
        const cur = get().currentUser;
        const effectiveStatus: UserStatus =
          cur.status && cur.status !== 'offline' ? cur.status : 'online';
        if (cur.status !== effectiveStatus) {
          set((state) => ({
            currentUser: { ...state.currentUser, status: effectiveStatus },
          }));
        }
        gatewayClient.sendPresence(effectiveStatus, cur.customStatus);

        if (
          get().authStatus === 'authenticated' &&
          (get().communities.length > 0 || get().activeCommunityId)
        ) {
          void get().loadCommunities();
          const activeCommId = get().activeCommunityId;
          const activeChanId = get().activeChannelId;
          if (activeCommId) {
            void get().loadCommunitySnapshot(activeCommId);
            if (activeChanId) {
              void get().loadChannelMessages(activeCommId, activeChanId);
            }
          }
        }
      },
      onPresenceUpdated: (update) => {
        if (update.userId === get().currentUser.id) {
          if (update.status && update.status !== 'offline') {
            set((state) => ({
              currentUser: {
                ...state.currentUser,
                status: update.status,
                customStatus: update.customStatus ?? state.currentUser.customStatus,
              },
            }));
          }
        }
        set((state) => ({
          friends: state.friends.map((f) =>
            f.id === update.userId
              ? {
                  ...f,
                  status: update.status,
                  customStatus: update.customStatus ?? f.customStatus,
                  activity: update.activity ?? f.activity,
                  lastSeenAt: update.lastSeenAt ?? f.lastSeenAt,
                }
              : f
          ),
          communitySnapshot: state.communitySnapshot
            ? {
                ...state.communitySnapshot,
                members: state.communitySnapshot.members.map((m) =>
                  m.user_id === update.userId
                    ? {
                        ...m,
                        status: update.status || m.status,
                        custom_status: update.customStatus ?? m.custom_status,
                      }
                    : m
                ),
              }
            : null,
        }));
      },
      onFriendRequestReceived: (req) => {
        set((state) => ({
          friendRequests: {
            ...state.friendRequests,
            incoming: [req, ...state.friendRequests.incoming.filter((r) => r.id !== req.id)],
          },
        }));
      },
      onFriendRequestAccepted: (friend) => {
        set((state) => ({
          friends: [...state.friends.filter((f) => f.id !== friend.id), friend],
          friendRequests: {
            incoming: state.friendRequests.incoming.filter((r) => r.userId !== friend.id),
            outgoing: state.friendRequests.outgoing.filter((r) => r.userId !== friend.id),
          },
        }));
      },
      onFriendRequestRejected: (requestId) => {
        set((state) => ({
          friendRequests: {
            ...state.friendRequests,
            outgoing: state.friendRequests.outgoing.filter((r) => r.id !== requestId),
          },
        }));
      },
      onFriendRemoved: (friendId) => {
        set((state) => ({
          friends: state.friends.filter((f) => f.id !== friendId),
        }));
      },
      onFriendBlocked: (userId) => {
        set((state) => ({
          friends: state.friends.filter((f) => f.id !== userId),
          friendRequests: {
            incoming: state.friendRequests.incoming.filter((r) => r.userId !== userId),
            outgoing: state.friendRequests.outgoing.filter((r) => r.userId !== userId),
          },
        }));
      },
      onDmMessageCreated: (msg) => {
        const state = get();
        // Cache locally in SQLite scoped to active account
        dmRepository.cacheIncomingMessage(msg, state.onlineUser?.id);

        if (state.activeConversationId === msg.conversation_id) {
          set((curr) => ({
            activeConversationMessages: mergeAndSortMessages(
              curr.activeConversationMessages,
              [msg]
            ),
          }));
          get().markActiveConversationRead();
        }

        set((curr) => {
          const convExists = curr.conversations.some((c) => c.id === msg.conversation_id);
          let convs = curr.conversations;
          if (convExists) {
            convs = curr.conversations.map((c) => {
              if (c.id !== msg.conversation_id) return c;
              const mergedLast = c.last_message
                ? c.last_message.id === msg.id ||
                  (msg.client_message_id &&
                    c.last_message.client_message_id === msg.client_message_id)
                  ? mergeSingleMessage(c.last_message, msg)
                  : Date.parse(msg.created_at) >= Date.parse(c.last_message.created_at)
                  ? msg
                  : c.last_message
                : msg;
              const isNewUnread =
                curr.activeConversationId !== msg.conversation_id &&
                !msg.is_mine &&
                c.last_message?.id !== msg.id;
              return {
                ...c,
                last_message: mergedLast,
                unread_count:
                  curr.activeConversationId === msg.conversation_id
                    ? 0
                    : c.unread_count + (isNewUnread ? 1 : 0),
                updated_at: mergedLast.created_at || c.updated_at,
              };
            });
          } else {
            get().loadConversations();
          }
          convs = [...convs].sort(
            (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
          );
          return { conversations: convs };
        });
      },
      onDmMessageUpdated: (msg) => {
        set((state) => ({
          activeConversationMessages: state.activeConversationMessages.map((m) =>
            m.id === msg.id ? mergeSingleMessage(m, msg) : m
          ),
          conversations: state.conversations.map((c) =>
            c.last_message?.id === msg.id
              ? { ...c, last_message: mergeSingleMessage(c.last_message, msg) }
              : c
          ),
        }));
      },
      onDmMessageDeleted: (data) => {
        set((state) => ({
          activeConversationMessages: state.activeConversationMessages.map((m) =>
            m.id === data.id
              ? { ...m, content: '[Mensagem apagada]', deleted_at: data.deleted_at }
              : m
          ),
          conversations: state.conversations.map((c) =>
            c.last_message?.id === data.id
              ? {
                  ...c,
                  last_message: {
                    ...c.last_message,
                    content: '[Mensagem apagada]',
                    deleted_at: data.deleted_at,
                  },
                }
              : c
          ),
        }));
      },
      onDmMessageDelivered: (data) => {
        set((state) => ({
          activeConversationMessages: state.activeConversationMessages.map((m) => {
            if (!data.message_ids.includes(m.id)) return m;
            const currentRank = deliveryStatusRank(resolveEffectiveDeliveryStatus(m));
            const nextStatus: DeliveryStatus =
              currentRank >= deliveryStatusRank('delivered')
                ? resolveEffectiveDeliveryStatus(m)
                : 'delivered';
            return {
              ...m,
              delivered_at: m.delivered_at || data.delivered_at,
              delivery_status: nextStatus,
            };
          }),
          conversations: state.conversations.map((c) => {
            if (!c.last_message || !data.message_ids.includes(c.last_message.id)) return c;
            const currentRank = deliveryStatusRank(
              resolveEffectiveDeliveryStatus(c.last_message)
            );
            const nextStatus: DeliveryStatus =
              currentRank >= deliveryStatusRank('delivered')
                ? resolveEffectiveDeliveryStatus(c.last_message)
                : 'delivered';
            return {
              ...c,
              last_message: {
                ...c.last_message,
                delivered_at: c.last_message.delivered_at || data.delivered_at,
                delivery_status: nextStatus,
              },
            };
          }),
        }));
      },
      onDmMessageRead: (data) => {
        set((state) => ({
          activeConversationMessages: state.activeConversationMessages.map((m) =>
            m.conversation_id === data.conversation_id && m.is_mine
              ? {
                  ...m,
                  delivered_at: m.delivered_at || data.read_at,
                  read_at: m.read_at || data.read_at,
                  delivery_status: 'read',
                }
              : m
          ),
          conversations: state.conversations.map((c) =>
            c.id === data.conversation_id && c.last_message && c.last_message.is_mine
              ? {
                  ...c,
                  last_message: {
                    ...c.last_message,
                    delivered_at: c.last_message.delivered_at || data.read_at,
                    read_at: c.last_message.read_at || data.read_at,
                    delivery_status: 'read',
                  },
                }
              : c
          ),
        }));
      },
      onDmConversationUpdated: (data) => {
        set((state) => ({
          conversations: state.conversations.map((c) => {
            if (c.id !== data.conversation_id) return c;
            const nextLast = c.last_message && c.last_message.id === data.last_message.id
              ? mergeSingleMessage(c.last_message, data.last_message)
              : data.last_message;
            return {
              ...c,
              last_message: nextLast,
              updated_at: nextLast.created_at || c.updated_at,
            };
          }),
        }));
      },
      onCommunityMessageCreated: (msg) => {
        const myId = get().onlineUser?.id || get().currentUser.id;
        const normalizedMsg: ChannelMessageDto = {
          ...msg,
          is_mine: msg.is_mine ?? (myId ? msg.sender_id === myId : false),
          delivery_status: 'sent',
        };
        const cur = get();
        const isActiveChannel =
          cur.activeCommunityId === normalizedMsg.community_id &&
          cur.activeChannelId === normalizedMsg.channel_id;
        const isViewingActiveChannel = isActiveChannel && cur.activeTab === 'communities';

        set((state) => {
          const nextMessages = isActiveChannel
            ? mergeAndSortChannelMessages(state.activeCommunityChannelMessages, [normalizedMsg])
            : state.activeCommunityChannelMessages;

          const shouldIncrementUnread = !normalizedMsg.is_mine && !isViewingActiveChannel;
          const nextSnapshot =
            shouldIncrementUnread && state.communitySnapshot?.community.id === normalizedMsg.community_id
              ? {
                  ...state.communitySnapshot,
                  channels: state.communitySnapshot.channels.map((ch) =>
                    ch.id === normalizedMsg.channel_id
                      ? { ...ch, unread_count: (ch.unread_count || 0) + 1 }
                      : ch
                  ),
                }
              : state.communitySnapshot;

          const nextCommunities = shouldIncrementUnread
            ? state.communities.map((c) =>
                c.id === normalizedMsg.community_id
                  ? { ...c, unread_count: (c.unread_count || 0) + 1 }
                  : c
              )
            : state.communities;

          return {
            activeCommunityChannelMessages: nextMessages,
            communitySnapshot: nextSnapshot,
            communities: nextCommunities,
          };
        });

        if (isViewingActiveChannel && !normalizedMsg.is_mine) {
          void get().markChannelRead(
            normalizedMsg.community_id,
            normalizedMsg.channel_id,
            normalizedMsg.id
          );
        }
      },
      onCommunityMessageUpdated: (msg) => {
        const myId = get().onlineUser?.id || get().currentUser.id;
        const normalizedMsg: ChannelMessageDto = {
          ...msg,
          is_mine: msg.is_mine ?? (myId ? msg.sender_id === myId : false),
          delivery_status: 'sent',
        };
        set((state) => {
          if (
            state.activeCommunityId !== normalizedMsg.community_id ||
            state.activeChannelId !== normalizedMsg.channel_id
          ) {
            return state;
          }
          return {
            activeCommunityChannelMessages: mergeAndSortChannelMessages(
              state.activeCommunityChannelMessages,
              [normalizedMsg]
            ),
          };
        });
      },
      onCommunityMessageDeleted: (data) => {
        set((state) => {
          if (state.activeChannelId !== data.channel_id) {
            return state;
          }
          return {
            activeCommunityChannelMessages: state.activeCommunityChannelMessages.map((m) =>
              m.id === data.id
                ? {
                    ...m,
                    content: '[Mensagem apagada]',
                    deleted_at: data.deleted_at || m.deleted_at || new Date().toISOString(),
                  }
                : m
            ),
          };
        });
      },
      onCommunityChannelCreated: (channel) => {
        set((state) => {
          if (state.communitySnapshot?.community.id !== channel.community_id) {
            return state;
          }
          const exists = state.communitySnapshot.channels.some((c) => c.id === channel.id);
          const nextChannels = (
            exists
              ? state.communitySnapshot.channels.map((c) => (c.id === channel.id ? channel : c))
              : [...state.communitySnapshot.channels, channel]
          ).sort((a, b) => a.position - b.position);
          return {
            communitySnapshot: {
              ...state.communitySnapshot,
              channels: nextChannels,
            },
          };
        });
      },
      onCommunityChannelUpdated: (channel) => {
        set((state) => {
          if (state.communitySnapshot?.community.id !== channel.community_id) {
            return state;
          }
          const exists = state.communitySnapshot.channels.some((c) => c.id === channel.id);
          const nextChannels = (
            exists
              ? state.communitySnapshot.channels.map((c) => (c.id === channel.id ? channel : c))
              : [...state.communitySnapshot.channels, channel]
          ).sort((a, b) => a.position - b.position);
          return {
            communitySnapshot: {
              ...state.communitySnapshot,
              channels: nextChannels,
            },
          };
        });
      },
      onCommunityChannelDeleted: (data) => {
        set((state) => {
          if (state.communitySnapshot?.community.id !== data.community_id) {
            return state;
          }
          const remaining = state.communitySnapshot.channels.filter((c) => c.id !== data.id);
          const wasActive = state.activeChannelId === data.id;
          return {
            communitySnapshot: {
              ...state.communitySnapshot,
              channels: remaining,
            },
            ...(wasActive
              ? {
                  activeChannelId: null,
                  activeCommunityChannelMessages: [],
                  communityMessagesHasMore: false,
                  communityMessagesNextBefore: null,
                }
              : {}),
          };
        });
      },
      onCommunityCategoryUpdated: (data) => {
        set((state) => {
          if (state.communitySnapshot?.community.id !== data.community_id) {
            return state;
          }
          if (data.action === 'deleted' && data.category_id) {
            return {
              communitySnapshot: {
                ...state.communitySnapshot,
                categories: state.communitySnapshot.categories.filter(
                  (cat) => cat.id !== data.category_id
                ),
              },
            };
          }
          if (data.category) {
            const cat = data.category;
            const exists = state.communitySnapshot.categories.some((c) => c.id === cat.id);
            const nextCategories = (
              exists
                ? state.communitySnapshot.categories.map((c) => (c.id === cat.id ? cat : c))
                : [...state.communitySnapshot.categories, cat]
            ).sort((a, b) => a.position - b.position);
            return {
              communitySnapshot: {
                ...state.communitySnapshot,
                categories: nextCategories,
              },
            };
          }
          return state;
        });
        if (get().authStatus === 'authenticated' && get().activeCommunityId === data.community_id) {
          void get().loadCommunitySnapshot(data.community_id);
        }
      },
      onCommunityMemberJoined: (data) => {
        set((state) => {
          const nextCommunities = state.communities.map((c) =>
            c.id === data.community_id ? { ...c, member_count: (c.member_count || 0) + 1 } : c
          );
          if (state.communitySnapshot?.community.id !== data.community_id || !data.member) {
            return { communities: nextCommunities };
          }
          const alreadyExists = state.communitySnapshot.members.some(
            (m) => m.user_id === data.member!.user_id
          );
          const rawMembers = alreadyExists
            ? state.communitySnapshot.members.map((m) =>
                m.user_id === data.member!.user_id ? data.member! : m
              )
            : [...state.communitySnapshot.members, data.member];
          const syncedMembers = syncCommunityMembersPresence(
            rawMembers,
            state.friends,
            state.currentUser
          );
          return {
            communities: nextCommunities,
            communitySnapshot: {
              ...state.communitySnapshot,
              community: {
                ...state.communitySnapshot.community,
                member_count: syncedMembers.length,
              },
              members: syncedMembers,
            },
          };
        });
        if (
          !data.member &&
          get().authStatus === 'authenticated' &&
          get().activeCommunityId === data.community_id
        ) {
          void get().loadCommunitySnapshot(data.community_id);
        }
      },
      onCommunityMemberLeft: (data) => {
        const myId = get().onlineUser?.id || get().currentUser.id;
        if (myId && data.user_id === myId) {
          set((state) => {
            const wasActive = state.activeCommunityId === data.community_id;
            return {
              communities: state.communities.filter((c) => c.id !== data.community_id),
              ...(wasActive ? clearActiveCommunityState() : {}),
            };
          });
          return;
        }
        set((state) => {
          const nextCommunities = state.communities.map((c) =>
            c.id === data.community_id
              ? { ...c, member_count: Math.max(0, (c.member_count || 1) - 1) }
              : c
          );
          if (state.communitySnapshot?.community.id !== data.community_id) {
            return { communities: nextCommunities };
          }
          const nextMembers = state.communitySnapshot.members.filter(
            (m) => m.user_id !== data.user_id
          );
          return {
            communities: nextCommunities,
            communitySnapshot: {
              ...state.communitySnapshot,
              community: {
                ...state.communitySnapshot.community,
                member_count: nextMembers.length,
              },
              members: nextMembers,
            },
          };
        });
      },
      onCommunityMemberUpdated: (data) => {
        if (data.member) {
          const updatedMember = data.member;
          set((state) => {
            if (state.communitySnapshot?.community.id !== data.community_id) {
              return state;
            }
            const exists = state.communitySnapshot.members.some(
              (m) => m.user_id === updatedMember.user_id
            );
            const rawMembers = exists
              ? state.communitySnapshot.members.map((m) =>
                  m.user_id === updatedMember.user_id ? updatedMember : m
                )
              : [...state.communitySnapshot.members, updatedMember];
            return {
              communitySnapshot: {
                ...state.communitySnapshot,
                members: syncCommunityMembersPresence(
                  rawMembers,
                  state.friends,
                  state.currentUser
                ),
              },
            };
          });
        }
        const myId = get().onlineUser?.id || get().currentUser.id;
        if (
          get().authStatus === 'authenticated' &&
          get().activeCommunityId === data.community_id &&
          (!data.member || (myId && data.member.user_id === myId))
        ) {
          void get().loadCommunitySnapshot(data.community_id);
        }
      },
      onCommunityRoleUpdated: (data) => {
        if (get().authStatus === 'authenticated' && get().activeCommunityId === data.community_id) {
          void get().loadCommunitySnapshot(data.community_id);
        }
      },
      onCommunityUpdated: (community) => {
        set((state) => ({
          communities: state.communities.map((c) => (c.id === community.id ? community : c)),
          communitySnapshot:
            state.communitySnapshot?.community.id === community.id
              ? { ...state.communitySnapshot, community }
              : state.communitySnapshot,
        }));
      },
      onCommunityDeleted: (data) => {
        set((state) => {
          const wasActive = state.activeCommunityId === data.community_id;
          return {
            communities: state.communities.filter((c) => c.id !== data.community_id),
            ...(wasActive ? clearActiveCommunityState() : {}),
          };
        });
      },
      onCommunityAccessRevoked: (data) => {
        set((state) => {
          if (data.channel_id) {
            const isActiveComm = state.communitySnapshot?.community.id === data.community_id;
            const wasActiveChannel = state.activeChannelId === data.channel_id;
            return {
              ...(isActiveComm && state.communitySnapshot
                ? {
                    communitySnapshot: {
                      ...state.communitySnapshot,
                      channels: state.communitySnapshot.channels.filter(
                        (ch) => ch.id !== data.channel_id
                      ),
                    },
                  }
                : {}),
              ...(wasActiveChannel
                ? {
                    activeChannelId: null,
                    activeCommunityChannelMessages: [],
                    communityMessagesHasMore: false,
                    communityMessagesNextBefore: null,
                  }
                : {}),
            };
          }

          const wasActiveComm = state.activeCommunityId === data.community_id;
          return {
            communities: state.communities.filter((c) => c.id !== data.community_id),
            ...(wasActiveComm ? clearActiveCommunityState() : {}),
          };
        });
      },
      onRoomJoined: (data) => {
        const selfUserId = get().onlineUser?.id || get().currentUser.id;
        const canSpeak = data.can_speak !== false;
        const initialMuted = !canSpeak;
        set((state) => ({
          voiceRoomState: 'connected',
          activeVoiceCommunityId: data.community_id,
          activeVoiceChannelId: data.channel_id,
          voiceRoomMaxParticipants: data.max_participants || 4,
          voiceRoomCanSpeak: canSpeak,
          voiceRoomCanScreenShare: data.can_screen_share !== false,
          voiceRoomParticipants: data.participants,
          voiceRoomMuted: initialMuted,
          voiceRoomDeafened: false,
          voiceRoomScreenSharing: false,
          voiceRoomScreenReceivers: {},
          voiceRoomError: null,
          communityVoiceRooms: {
            ...state.communityVoiceRooms,
            [data.community_id]: {
              ...(state.communityVoiceRooms[data.community_id] || {}),
              [data.channel_id]: data.participants,
            },
          },
        }));

        if (selfUserId) {
          void meshRoomService.startRoomSession({
            selfUserId,
            communityId: data.community_id,
            channelId: data.channel_id,
            participants: data.participants,
            maxParticipants: data.max_participants,
            canSpeak,
            initialVolumes: get().voiceRoomParticipantVolumes,
          });
        }
      },
      onRoomLeft: (data) => {
        const { activeVoiceCommunityId, activeVoiceChannelId } = get();
        if (
          activeVoiceCommunityId === data.community_id &&
          activeVoiceChannelId === data.channel_id
        ) {
          void meshRoomService.leaveRoom();
          set({
            voiceRoomState: 'idle',
            activeVoiceCommunityId: null,
            activeVoiceChannelId: null,
            voiceRoomParticipants: [],
            voiceRoomMuted: false,
            voiceRoomDeafened: false,
            voiceRoomScreenSharing: false,
            voiceRoomPeerStatuses: {},
            voiceRoomRemoteStreams: {},
            voiceRoomMetrics: null,
            voiceRoomError: data.reason || null,
          });
        }
      },
      onRoomParticipantJoined: (data) => {
        set((state) => {
          const isCurrentRoom =
            state.activeVoiceCommunityId === data.community_id &&
            state.activeVoiceChannelId === data.channel_id;
          if (!isCurrentRoom) return state;

          const exists = state.voiceRoomParticipants.some(
            (p) => p.user_id === data.participant.user_id
          );
          const nextParticipants = exists
            ? state.voiceRoomParticipants.map((p) =>
                p.user_id === data.participant.user_id ? data.participant : p
              )
            : [...state.voiceRoomParticipants, data.participant];

          return {
            voiceRoomParticipants: nextParticipants,
            communityVoiceRooms: {
              ...state.communityVoiceRooms,
              [data.community_id]: {
                ...(state.communityVoiceRooms[data.community_id] || {}),
                [data.channel_id]: nextParticipants,
              },
            },
          };
        });

        const state = get();
        if (
          state.activeVoiceCommunityId === data.community_id &&
          state.activeVoiceChannelId === data.channel_id
        ) {
          void meshRoomService.addParticipant(data.participant);
        }
      },
      onRoomParticipantLeft: (data) => {
        const state = get();
        if (
          state.activeVoiceCommunityId === data.community_id &&
          state.activeVoiceChannelId === data.channel_id
        ) {
          meshRoomService.removeParticipant(data.user_id);
        }

        set((prev) => {
          const isCurrentRoom =
            prev.activeVoiceCommunityId === data.community_id &&
            prev.activeVoiceChannelId === data.channel_id;
          if (!isCurrentRoom) return prev;

          const nextParticipants = prev.voiceRoomParticipants.filter(
            (p) => p.user_id !== data.user_id
          );
          const nextPeerStatuses = { ...prev.voiceRoomPeerStatuses };
          delete nextPeerStatuses[data.user_id];
          const nextStreams = { ...prev.voiceRoomRemoteStreams };
          delete nextStreams[data.user_id];

          return {
            voiceRoomParticipants: nextParticipants,
            voiceRoomPeerStatuses: nextPeerStatuses,
            voiceRoomRemoteStreams: nextStreams,
            communityVoiceRooms: {
              ...prev.communityVoiceRooms,
              [data.community_id]: {
                ...(prev.communityVoiceRooms[data.community_id] || {}),
                [data.channel_id]: nextParticipants,
              },
            },
          };
        });
      },
      onRoomParticipantUpdated: (data) => {
        const current = get();
        if (current.activeVoiceCommunityId === data.community_id && current.activeVoiceChannelId === data.channel_id &&
          data.participant.user_id !== current.onlineUser?.id &&
          data.participant.is_screen_sharing === false) {
          meshRoomService.closeRemoteScreen(data.participant.user_id);
        }
        set((state) => {
          const isCurrentRoom =
            state.activeVoiceCommunityId === data.community_id &&
            state.activeVoiceChannelId === data.channel_id;
          if (!isCurrentRoom) return state;

          const nextParticipants = state.voiceRoomParticipants.map((p) =>
            p.user_id === data.participant.user_id ? { ...p, ...data.participant } : p
          );
          return {
            voiceRoomParticipants: nextParticipants,
            communityVoiceRooms: {
              ...state.communityVoiceRooms,
              [data.community_id]: {
                ...(state.communityVoiceRooms[data.community_id] || {}),
                [data.channel_id]: nextParticipants,
              },
            },
          };
        });
      },
      onCommunityVoiceStateUpdated: (data) => {
        const current = get();
        const isCurrentRoom = current.activeVoiceCommunityId === data.community_id && current.activeVoiceChannelId === data.channel_id;
        if (isCurrentRoom) {
          for (const participant of current.voiceRoomParticipants) {
            const next = data.participants.find((p) => p.user_id === participant.user_id);
            if (!next) meshRoomService.removeParticipant(participant.user_id);
            else if (participant.user_id !== current.onlineUser?.id && !next.is_screen_sharing) meshRoomService.closeRemoteScreen(participant.user_id);
          }
        }
        set((state) => ({
          ...(isCurrentRoom ? { voiceRoomParticipants: data.participants } : {}),
          communityVoiceRooms: {
            ...state.communityVoiceRooms,
            [data.community_id]: {
              ...(state.communityVoiceRooms[data.community_id] || {}),
              [data.channel_id]: data.participants,
            },
          },
        }));
      },
      onRoomWebrtcOffer: (data) => {
        const { activeVoiceCommunityId, activeVoiceChannelId } = get();
        if (
          activeVoiceCommunityId === data.community_id &&
          activeVoiceChannelId === data.channel_id
        ) {
          void meshRoomService.handleRemoteOffer(data.sender_id, data.sdp, data.stream_kind);
        }
      },
      onRoomWebrtcAnswer: (data) => {
        const { activeVoiceCommunityId, activeVoiceChannelId } = get();
        if (
          activeVoiceCommunityId === data.community_id &&
          activeVoiceChannelId === data.channel_id
        ) {
          void meshRoomService.handleRemoteAnswer(data.sender_id, data.sdp, data.stream_kind);
        }
      },
      onRoomWebrtcIceCandidate: (data) => {
        const { activeVoiceCommunityId, activeVoiceChannelId } = get();
        if (
          activeVoiceCommunityId === data.community_id &&
          activeVoiceChannelId === data.channel_id
        ) {
          void meshRoomService.handleRemoteIceCandidate(
            data.sender_id,
            data.candidate,
            data.stream_kind
          );
        }
      },
      onRoomError: (data) => {
        set((state) => ({
          voiceRoomError: data.message,
          voiceRoomState: state.voiceRoomState === 'joining' ? 'error' : state.voiceRoomState,
        }));
      },
      onReconnected: () => {
        get().loadFriends();
        get().loadFriendRequests();
        get().loadConversations();
        const activeId = get().activeConversationId;
        if (activeId) {
          get().selectConversation(activeId);
        }
        if (get().authStatus === 'offline' && get().onlineUser) {
          set({ authStatus: 'authenticated', authMode: 'authenticated' });
        }
        if (get().authStatus === 'authenticated') {
          void get().loadCommunities();
          const activeCommId = get().activeCommunityId;
          const activeChanId = get().activeChannelId;
          if (activeCommId) {
            void get().loadCommunitySnapshot(activeCommId);
            if (activeChanId) {
              void get().loadChannelMessages(activeCommId, activeChanId);
            }
          }
        }
      },
      onConnectionChange: (connected) => {
        set({ isWsConnected: connected, gatewayConnected: connected });
      },
    });

    gatewayClient.connect();
  },

  closeWebSocket: () => {
    if (wsUnsubscribe) {
      wsUnsubscribe();
      wsUnsubscribe = null;
    }
    gatewayClient.disconnect();
    set({ isWsConnected: false, gatewayConnected: false });
  },

  // Phase 2.3: DM Actions
  loadConversations: async () => {
    const status = get().authStatus;
    if (status !== 'authenticated' && status !== 'offline') {
      return;
    }
    const expectedUserId = get().onlineUser?.id;
    if (!expectedUserId) {
      return;
    }
    set({ isLoadingConversations: true });
    try {
      const convs = await dmRepository.listConversations(expectedUserId);
      // Guard against stale response if user logged out or switched account during await
      if (get().onlineUser?.id !== expectedUserId) {
        return;
      }
      set({ conversations: convs, isLoadingConversations: false });
    } catch (err) {
      console.warn('[useAppStore] loadConversations failed:', err);
      if (get().onlineUser?.id === expectedUserId) {
        set({ isLoadingConversations: false });
      }
    }
  },

  selectConversation: async (conversationId: string) => {
    const expectedUserId = get().onlineUser?.id;
    set((state) => ({
      activeConversationId: conversationId,
      // Keep only already-loaded messages belonging to this conversation while fetching
      activeConversationMessages:
        state.activeConversationId === conversationId ? state.activeConversationMessages : [],
      isLoadingMessages: true,
      dmError: null,
    }));
    try {
      const messages = await dmRepository.getMessages(
        conversationId,
        50,
        undefined,
        expectedUserId
      );
      // Race guard: discard stale HTTP response if user switched conversation or account while waiting
      if (
        get().activeConversationId !== conversationId ||
        get().onlineUser?.id !== expectedUserId
      ) {
        return;
      }
      const merged = mergeAndSortMessages(
        get().activeConversationMessages.filter((m) => m.conversation_id === conversationId),
        messages
      );
      set({ activeConversationMessages: merged, isLoadingMessages: false });
      if (merged.length > 0) {
        const lastMsg = merged[merged.length - 1];
        await dmRepository.markRead(conversationId, lastMsg.id, expectedUserId);
        gatewayClient.sendReadAck(conversationId, lastMsg.id);
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === conversationId ? { ...c, unread_count: 0 } : c
          ),
        }));
      }
    } catch (err: any) {
      if (
        get().activeConversationId === conversationId &&
        get().onlineUser?.id === expectedUserId
      ) {
        set({ isLoadingMessages: false, dmError: err?.message || String(err) });
      }
    }
  },

  startConversationWithUser: async (targetUserId?: string, username?: string) => {
    try {
      const user = get().onlineUser;
      const conv = await dmRepository.getOrCreateConversation(targetUserId, username, user?.id);
      if (get().onlineUser?.id !== user?.id) {
        return null;
      }
      set((state) => ({
        conversations: [conv, ...state.conversations.filter((c) => c.id !== conv.id)],
      }));
      await get().selectConversation(conv.id);
      return conv.id;
    } catch (err: any) {
      set({ dmError: err?.message || String(err) });
      return null;
    }
  },

  sendDirectMessage: async (content: string) => {
    const convId = get().activeConversationId;
    if (!convId || !content.trim()) return false;
    set({ isSendingDm: true, dmError: null });

    const clientMsgId =
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `local_${Date.now()}`;
    const user = get().onlineUser;
    const expectedUserId = user?.id;

    const optimisticMsg: DirectMessageDto = {
      id: `opt_${clientMsgId}`,
      conversation_id: convId,
      sender_id: user?.id || 'usr_me',
      client_message_id: clientMsgId,
      content: content.trim(),
      created_at: new Date().toISOString(),
      edited_at: null,
      deleted_at: null,
      delivered_at: null,
      read_at: null,
      is_mine: true,
      delivery_status: 'sending',
    };

    set((state) => ({
      activeConversationMessages: mergeAndSortMessages(state.activeConversationMessages, [
        optimisticMsg,
      ]),
    }));

    try {
      const sent = await dmRepository.sendMessage(
        convId,
        content.trim(),
        clientMsgId,
        expectedUserId
      );
      if (get().onlineUser?.id !== expectedUserId) {
        return false;
      }
      set((state) => ({
        isSendingDm: false,
        activeConversationMessages:
          state.activeConversationId === convId
            ? mergeAndSortMessages(state.activeConversationMessages, [sent])
            : state.activeConversationMessages,
        conversations: state.conversations.map((c) => {
          if (c.id !== convId) return c;
          const mergedLast =
            c.last_message &&
            (c.last_message.id === sent.id ||
              c.last_message.client_message_id === sent.client_message_id)
              ? mergeSingleMessage(c.last_message, sent)
              : sent;
          return { ...c, last_message: mergedLast, updated_at: mergedLast.created_at };
        }),
      }));
      return true;
    } catch (err: any) {
      if (get().onlineUser?.id === expectedUserId) {
        set((state) => ({
          isSendingDm: false,
          dmError: err?.message || String(err),
          activeConversationMessages: state.activeConversationMessages.map((m) =>
            m.client_message_id === clientMsgId && m.delivery_status === 'sending'
              ? { ...m, delivery_status: 'failed' }
              : m
          ),
        }));
      }
      return false;
    }
  },

  editDirectMessage: async (messageId: string, content: string) => {
    try {
      const user = get().onlineUser;
      const edited = await dmRepository.editMessage(messageId, content, user?.id);
      set((state) => ({
        activeConversationMessages: state.activeConversationMessages.map((m) =>
          m.id === messageId ? mergeSingleMessage(m, edited) : m
        ),
        conversations: state.conversations.map((c) =>
          c.last_message?.id === messageId
            ? { ...c, last_message: mergeSingleMessage(c.last_message, edited) }
            : c
        ),
      }));
      return true;
    } catch (err: any) {
      set({ dmError: err?.message || String(err) });
      return false;
    }
  },

  deleteDirectMessage: async (messageId: string) => {
    try {
      const user = get().onlineUser;
      const deleted = await dmRepository.deleteMessage(messageId, user?.id);
      set((state) => ({
        activeConversationMessages: state.activeConversationMessages.map((m) =>
          m.id === messageId
            ? {
                ...m,
                ...deleted,
                content: '[Mensagem apagada]',
                deleted_at: deleted.deleted_at || new Date().toISOString(),
              }
            : m
        ),
        conversations: state.conversations.map((c) =>
          c.last_message?.id === messageId
            ? {
                ...c,
                last_message: {
                  ...c.last_message,
                  content: '[Mensagem apagada]',
                  deleted_at: deleted.deleted_at || new Date().toISOString(),
                },
              }
            : c
        ),
      }));
      return true;
    } catch (err: any) {
      set({ dmError: err?.message || String(err) });
      return false;
    }
  },

  markActiveConversationRead: async () => {
    const convId = get().activeConversationId;
    const messages = get().activeConversationMessages;
    const user = get().onlineUser;
    if (!convId || messages.length === 0) return;
    const lastMsg = messages[messages.length - 1];
    await dmRepository.markRead(convId, lastMsg.id, user?.id);
    gatewayClient.sendReadAck(convId, lastMsg.id);
    set((state) => ({
      conversations: state.conversations.map((c) =>
        c.id === convId ? { ...c, unread_count: 0 } : c
      ),
    }));
  },

  loadOlderMessages: async () => {
    const convId = get().activeConversationId;
    const messages = get().activeConversationMessages;
    if (!convId || messages.length === 0) return;
    const oldestId = messages[0].id;
    const expectedUserId = get().onlineUser?.id;

    try {
      const older = await dmRepository.getMessages(convId, 30, oldestId, expectedUserId);
      if (
        get().activeConversationId !== convId ||
        get().onlineUser?.id !== expectedUserId
      ) {
        return;
      }
      if (older.length > 0) {
        set((state) => ({
          activeConversationMessages: mergeAndSortMessages(
            older,
            state.activeConversationMessages
          ),
        }));
      }
    } catch (err) {
      console.warn('[useAppStore] loadOlderMessages failed:', err);
    }
  },

  // ==========================================
  // Phase B2: Communities Actions
  // ==========================================

  loadCommunities: async () => {
    if (get().authStatus === 'unauthenticated' || !get().onlineUser) {
      set({ communities: [] });
      return;
    }
    if (get().authStatus !== 'authenticated') {
      return;
    }
    const expectedUserId = get().onlineUser?.id;
    set({ isLoadingCommunities: true, communityError: null });
    try {
      const communities = await communityRepository.listCommunities();
      if (get().onlineUser?.id !== expectedUserId) return;

      const currentActiveId = get().activeCommunityId;
      const activeStillExists =
        currentActiveId && communities.some((c) => c.id === currentActiveId);

      set({
        communities,
        isLoadingCommunities: false,
        ...(currentActiveId && !activeStillExists
          ? {
              activeCommunityId: null,
              activeChannelId: null,
              communitySnapshot: null,
              activeCommunityChannelMessages: [],
              communityMessagesHasMore: false,
              communityMessagesNextBefore: null,
            }
          : {}),
      });

      if (activeStillExists && currentActiveId) {
        await get().loadCommunitySnapshot(currentActiveId);
      }
    } catch (err: any) {
      if (get().onlineUser?.id === expectedUserId) {
        set({
          isLoadingCommunities: false,
          communityError: err?.message || String(err),
        });
      }
    }
  },

  selectCommunity: async (communityId) => {
    set({
      activeCommunityId: communityId,
      activeChannelId: null,
      activeCommunityChannelMessages: [],
      communityMessagesHasMore: false,
      communityMessagesNextBefore: null,
      communityBans: [],
      communityAuditLogs: [],
      communityInvites: [],
      communityError: null,
    });
    settingsRepository.savePreferences({
      activeCommunityId: communityId,
      activeChannelId: null,
    });

    if (!communityId) {
      set({ communitySnapshot: null });
      return;
    }

    const snapshot = await get().loadCommunitySnapshot(communityId);
    if (snapshot && get().activeCommunityId === communityId && !get().activeChannelId) {
      const firstTextChannel =
        snapshot.channels.find((ch) => ch.channel_type === 'text') ||
        snapshot.channels[0] ||
        null;
      if (firstTextChannel) {
        await get().selectCommunityChannel(firstTextChannel.id);
      }
    }
  },

  loadCommunitySnapshot: async (communityId) => {
    const expectedUserId = get().onlineUser?.id;
    set({ isLoadingCommunitySnapshot: true, communityError: null });
    try {
      const snapshot = await communityRepository.getSnapshot(communityId);
      if (get().onlineUser?.id !== expectedUserId) return null;

      const syncedSnapshot: CommunitySnapshotDto = {
        ...snapshot,
        members: syncCommunityMembersPresence(
          snapshot.members,
          get().friends,
          get().currentUser
        ),
      };

      set((state) => ({
        isLoadingCommunitySnapshot: false,
        communitySnapshot:
          state.activeCommunityId === communityId ? syncedSnapshot : state.communitySnapshot,
        communities: state.communities.some((c) => c.id === syncedSnapshot.community.id)
          ? state.communities.map((c) =>
              c.id === syncedSnapshot.community.id ? syncedSnapshot.community : c
            )
          : [syncedSnapshot.community, ...state.communities],
      }));
      return syncedSnapshot;
    } catch (err: any) {
      if (get().onlineUser?.id === expectedUserId) {
        set({
          isLoadingCommunitySnapshot: false,
          communityError: err?.message || String(err),
        });
      }
      return null;
    }
  },

  createCommunity: async (payload) => {
    set({ communityError: null });
    try {
      const created = await communityRepository.createCommunity(payload);
      set((state) => ({
        communities: [created, ...state.communities.filter((c) => c.id !== created.id)],
      }));
      await get().selectCommunity(created.id);
      return created;
    } catch (err: any) {
      set({ communityError: err?.message || String(err) });
      throw err;
    }
  },

  updateCommunity: async (communityId, payload) => {
    set({ communityError: null });
    try {
      const updated = await communityRepository.updateCommunity(communityId, payload);
      set((state) => ({
        communities: state.communities.map((c) => (c.id === communityId ? updated : c)),
        communitySnapshot:
          state.communitySnapshot?.community.id === communityId
            ? { ...state.communitySnapshot, community: updated }
            : state.communitySnapshot,
      }));
      return updated;
    } catch (err: any) {
      set({ communityError: err?.message || String(err) });
      throw err;
    }
  },

  deleteCommunity: async (communityId, payload) => {
    set({ communityError: null });
    try {
      await communityRepository.deleteCommunity(communityId, payload);
      const wasActive = get().activeCommunityId === communityId;
      set((state) => ({
        communities: state.communities.filter((c) => c.id !== communityId),
        ...(wasActive
          ? {
              activeCommunityId: null,
              activeChannelId: null,
              communitySnapshot: null,
              activeCommunityChannelMessages: [],
              communityMessagesHasMore: false,
              communityMessagesNextBefore: null,
            }
          : {}),
      }));
      if (wasActive) {
        settingsRepository.savePreferences({
          activeCommunityId: null,
          activeChannelId: null,
        });
      }
      return true;
    } catch (err: any) {
      set({ communityError: err?.message || String(err) });
      throw err;
    }
  },

  transferCommunityOwnership: async (communityId, payload) => {
    set({ communityError: null });
    try {
      const updated = await communityRepository.transferOwnership(communityId, payload);
      set((state) => ({
        communities: state.communities.map((c) => (c.id === communityId ? updated : c)),
      }));
      if (get().activeCommunityId === communityId) {
        await get().loadCommunitySnapshot(communityId);
      }
      return updated;
    } catch (err: any) {
      set({ communityError: err?.message || String(err) });
      throw err;
    }
  },

  leaveCommunity: async (communityId) => {
    set({ communityError: null });
    try {
      await communityRepository.leaveCommunity(communityId);
      const wasActive = get().activeCommunityId === communityId;
      set((state) => ({
        communities: state.communities.filter((c) => c.id !== communityId),
        ...(wasActive
          ? {
              activeCommunityId: null,
              activeChannelId: null,
              communitySnapshot: null,
              activeCommunityChannelMessages: [],
              communityMessagesHasMore: false,
              communityMessagesNextBefore: null,
            }
          : {}),
      }));
      if (wasActive) {
        settingsRepository.savePreferences({
          activeCommunityId: null,
          activeChannelId: null,
        });
      }
      return true;
    } catch (err: any) {
      set({ communityError: err?.message || String(err) });
      throw err;
    }
  },

  createCommunityCategory: async (communityId, payload) => {
    set({ communityError: null });
    try {
      const created = await communityRepository.createCategory(communityId, payload);
      set((state) => ({
        communitySnapshot:
          state.communitySnapshot?.community.id === communityId
            ? {
                ...state.communitySnapshot,
                categories: (
                  state.communitySnapshot.categories.some((c) => c.id === created.id)
                    ? state.communitySnapshot.categories.map((c) =>
                        c.id === created.id ? created : c
                      )
                    : [...state.communitySnapshot.categories, created]
                ).sort((a, b) => a.position - b.position),
              }
            : state.communitySnapshot,
      }));
      return created;
    } catch (err: any) {
      set({ communityError: err?.message || String(err) });
      throw err;
    }
  },

  updateCommunityCategory: async (communityId, categoryId, payload) => {
    set({ communityError: null });
    try {
      const updated = await communityRepository.updateCategory(communityId, categoryId, payload);
      set((state) => ({
        communitySnapshot:
          state.communitySnapshot?.community.id === communityId
            ? {
                ...state.communitySnapshot,
                categories: state.communitySnapshot.categories
                  .map((cat) => (cat.id === categoryId ? updated : cat))
                  .sort((a, b) => a.position - b.position),
              }
            : state.communitySnapshot,
      }));
      return updated;
    } catch (err: any) {
      set({ communityError: err?.message || String(err) });
      throw err;
    }
  },

  deleteCommunityCategory: async (communityId, categoryId) => {
    set({ communityError: null });
    try {
      await communityRepository.deleteCategory(communityId, categoryId);
      set((state) => ({
        communitySnapshot:
          state.communitySnapshot?.community.id === communityId
            ? {
                ...state.communitySnapshot,
                categories: state.communitySnapshot.categories.filter(
                  (cat) => cat.id !== categoryId
                ),
                channels: state.communitySnapshot.channels.map((ch) =>
                  ch.category_id === categoryId ? { ...ch, category_id: null } : ch
                ),
              }
            : state.communitySnapshot,
      }));
      return true;
    } catch (err: any) {
      set({ communityError: err?.message || String(err) });
      throw err;
    }
  },

  reorderCommunityCategories: async (communityId, items) => {
    set({ communityError: null });
    try {
      const categories = await communityRepository.reorderCategories(communityId, items);
      set((state) => ({
        communitySnapshot:
          state.communitySnapshot?.community.id === communityId
            ? {
                ...state.communitySnapshot,
                categories: [...categories].sort((a, b) => a.position - b.position),
              }
            : state.communitySnapshot,
      }));
      return true;
    } catch (err: any) {
      set({ communityError: err?.message || String(err) });
      throw err;
    }
  },

  createCommunityChannel: async (communityId, payload) => {
    set({ communityError: null });
    try {
      const created = await communityRepository.createChannel(communityId, payload);
      set((state) => ({
        communitySnapshot:
          state.communitySnapshot?.community.id === communityId
            ? {
                ...state.communitySnapshot,
                channels: (
                  state.communitySnapshot.channels.some((c) => c.id === created.id)
                    ? state.communitySnapshot.channels.map((c) =>
                        c.id === created.id ? created : c
                      )
                    : [...state.communitySnapshot.channels, created]
                ).sort((a, b) => a.position - b.position),
              }
            : state.communitySnapshot,
      }));
      return created;
    } catch (err: any) {
      set({ communityError: err?.message || String(err) });
      throw err;
    }
  },

  updateCommunityChannel: async (communityId, channelId, payload) => {
    set({ communityError: null });
    try {
      const updated = await communityRepository.updateChannel(communityId, channelId, payload);
      set((state) => ({
        communitySnapshot:
          state.communitySnapshot?.community.id === communityId
            ? {
                ...state.communitySnapshot,
                channels: state.communitySnapshot.channels
                  .map((ch) => (ch.id === channelId ? updated : ch))
                  .sort((a, b) => a.position - b.position),
              }
            : state.communitySnapshot,
      }));
      return updated;
    } catch (err: any) {
      set({ communityError: err?.message || String(err) });
      throw err;
    }
  },

  deleteCommunityChannel: async (communityId, channelId) => {
    set({ communityError: null });
    try {
      await communityRepository.deleteChannel(communityId, channelId);
      const wasActiveChannel = get().activeChannelId === channelId;
      set((state) => ({
        communitySnapshot:
          state.communitySnapshot?.community.id === communityId
            ? {
                ...state.communitySnapshot,
                channels: state.communitySnapshot.channels.filter((ch) => ch.id !== channelId),
              }
            : state.communitySnapshot,
        ...(wasActiveChannel
          ? {
              activeChannelId: null,
              activeCommunityChannelMessages: [],
              communityMessagesHasMore: false,
              communityMessagesNextBefore: null,
            }
          : {}),
      }));
      if (wasActiveChannel) {
        settingsRepository.savePreferences({ activeChannelId: null });
      }
      return true;
    } catch (err: any) {
      set({ communityError: err?.message || String(err) });
      throw err;
    }
  },

  reorderCommunityChannels: async (communityId, items) => {
    set({ communityError: null });
    try {
      const channels = await communityRepository.reorderChannels(communityId, items);
      set((state) => ({
        communitySnapshot:
          state.communitySnapshot?.community.id === communityId
            ? {
                ...state.communitySnapshot,
                channels: [...channels].sort((a, b) => a.position - b.position),
              }
            : state.communitySnapshot,
      }));
      return true;
    } catch (err: any) {
      set({ communityError: err?.message || String(err) });
      throw err;
    }
  },

  selectCommunityChannel: async (channelId) => {
    const communityId = get().activeCommunityId;
    set({
      activeChannelId: channelId,
      activeCommunityChannelMessages: [],
      communityMessagesHasMore: false,
      communityMessagesNextBefore: null,
      communityError: null,
    });
    settingsRepository.savePreferences({ activeChannelId: channelId });

    if (communityId && channelId) {
      await get().loadChannelMessages(communityId, channelId);
    }
  },

  listChannelOverwrites: async (communityId, channelId) => {
    const overwrites = await communityRepository.listChannelOverwrites(communityId, channelId);
    set((state) => ({
      communitySnapshot:
        state.communitySnapshot?.community.id === communityId
          ? {
              ...state.communitySnapshot,
              channels: state.communitySnapshot.channels.map((ch) =>
                ch.id === channelId ? { ...ch, overwrites } : ch
              ),
            }
          : state.communitySnapshot,
    }));
    return overwrites;
  },

  upsertChannelOverwrite: async (communityId, channelId, payload) => {
    set({ communityError: null });
    try {
      const overwrite = await communityRepository.upsertChannelOverwrite(
        communityId,
        channelId,
        payload
      );
      if (get().activeCommunityId === communityId) {
        await get().loadCommunitySnapshot(communityId);
      }
      return overwrite;
    } catch (err: any) {
      set({ communityError: err?.message || String(err) });
      throw err;
    }
  },

  deleteChannelOverwrite: async (communityId, channelId, targetType, targetId) => {
    set({ communityError: null });
    try {
      await communityRepository.deleteChannelOverwrite(
        communityId,
        channelId,
        targetType,
        targetId
      );
      if (get().activeCommunityId === communityId) {
        await get().loadCommunitySnapshot(communityId);
      }
      return true;
    } catch (err: any) {
      set({ communityError: err?.message || String(err) });
      throw err;
    }
  },

  loadChannelMessages: async (communityId, channelId, before, limit = 50) => {
    const expectedUserId = get().onlineUser?.id;
    set({ isLoadingChannelMessages: true, communityError: null });
    try {
      const page = await communityRepository.listChannelMessages(
        communityId,
        channelId,
        before,
        limit
      );
      if (
        get().onlineUser?.id !== expectedUserId ||
        get().activeCommunityId !== communityId ||
        get().activeChannelId !== channelId
      ) {
        return;
      }

      const existingForChannel = before
        ? get().activeCommunityChannelMessages
        : get().activeCommunityChannelMessages.filter((m) => m.channel_id === channelId);
      const merged = mergeAndSortChannelMessages(existingForChannel, page.messages);
      set({
        activeCommunityChannelMessages: merged,
        communityMessagesHasMore: page.has_more,
        communityMessagesNextBefore: page.next_before ?? null,
        isLoadingChannelMessages: false,
      });

      if (!before && merged.length > 0) {
        const lastMsg = merged[merged.length - 1];
        await get().markChannelRead(communityId, channelId, lastMsg.id);
      }
    } catch (err: any) {
      if (
        get().onlineUser?.id === expectedUserId &&
        get().activeCommunityId === communityId &&
        get().activeChannelId === channelId
      ) {
        set({
          isLoadingChannelMessages: false,
          communityError: err?.message || String(err),
        });
      }
    }
  },

  refreshActiveChannelMessages: async () => {
    const communityId = get().activeCommunityId;
    const channelId = get().activeChannelId;
    const expectedUserId = get().onlineUser?.id;
    if (!communityId || !channelId || get().authStatus !== 'authenticated') return;

    try {
      const page = await communityRepository.listChannelMessages(
        communityId,
        channelId,
        undefined,
        50
      );
      if (
        get().onlineUser?.id !== expectedUserId ||
        get().activeCommunityId !== communityId ||
        get().activeChannelId !== channelId
      ) {
        return;
      }

      const existing = get().activeCommunityChannelMessages;
      const merged = mergeAndSortChannelMessages(existing, page.messages);
      if (merged.length !== existing.length || page.messages.length > 0) {
        set({ activeCommunityChannelMessages: merged });
      }
    } catch {
      // Silent background poll failure
    }
  },

  loadOlderChannelMessages: async () => {
    const communityId = get().activeCommunityId;
    const channelId = get().activeChannelId;
    const nextBefore = get().communityMessagesNextBefore;
    if (!communityId || !channelId || !get().communityMessagesHasMore || !nextBefore) {
      return;
    }
    await get().loadChannelMessages(communityId, channelId, nextBefore, 50);
  },

  sendChannelMessage: async (content, replyToMessageId = null) => {
    const communityId = get().activeCommunityId;
    const channelId = get().activeChannelId;
    const trimmed = content.trim();
    if (!communityId || !channelId || !trimmed) return false;

    const user = get().onlineUser;
    const currentUser = get().currentUser;
    const expectedUserId = user?.id;
    const clientMsgId =
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const optimisticMsg: ChannelMessageDto = {
      id: `opt_${clientMsgId}`,
      channel_id: channelId,
      community_id: communityId,
      sender_id: user?.id || currentUser.id,
      author: {
        id: user?.id || currentUser.id,
        username: currentUser.username,
        display_name: currentUser.displayName,
        avatar_url: currentUser.avatarUrl ?? null,
      },
      reply_to_message_id: replyToMessageId ?? null,
      content: trimmed,
      client_message_id: clientMsgId,
      attachments: [],
      created_at: new Date().toISOString(),
      edited_at: null,
      deleted_at: null,
      is_mine: true,
      delivery_status: 'sending',
    };

    set((state) => ({
      isSendingChannelMessage: true,
      communityError: null,
      activeCommunityChannelMessages: mergeAndSortChannelMessages(
        state.activeCommunityChannelMessages,
        [optimisticMsg]
      ),
    }));

    try {
      const sent = await communityRepository.sendChannelMessage(communityId, channelId, {
        content: trimmed,
        client_message_id: clientMsgId,
        reply_to_message_id: replyToMessageId ?? null,
      });
      if (get().onlineUser?.id !== expectedUserId) return false;

      set((state) => ({
        isSendingChannelMessage: false,
        activeCommunityChannelMessages:
          state.activeChannelId === channelId
            ? mergeAndSortChannelMessages(state.activeCommunityChannelMessages, [sent])
            : state.activeCommunityChannelMessages,
      }));
      return true;
    } catch (err: any) {
      if (get().onlineUser?.id === expectedUserId) {
        set((state) => ({
          isSendingChannelMessage: false,
          communityError: err?.message || String(err),
          activeCommunityChannelMessages: state.activeCommunityChannelMessages.map((m) =>
            m.client_message_id === clientMsgId && m.delivery_status === 'sending'
              ? { ...m, delivery_status: 'failed' }
              : m
          ),
        }));
      }
      return false;
    }
  },

  editChannelMessage: async (messageId, content) => {
    const communityId = get().activeCommunityId;
    const channelId = get().activeChannelId;
    if (!communityId || !channelId || !content.trim()) return false;
    set({ communityError: null });
    try {
      const edited = await communityRepository.editChannelMessage(
        communityId,
        channelId,
        messageId,
        content.trim()
      );
      set((state) => ({
        activeCommunityChannelMessages: state.activeCommunityChannelMessages.map((m) =>
          m.id === messageId ? mergeSingleChannelMessage(m, edited) : m
        ),
      }));
      return true;
    } catch (err: any) {
      set({ communityError: err?.message || String(err) });
      return false;
    }
  },

  deleteChannelMessage: async (messageId) => {
    const communityId = get().activeCommunityId;
    const channelId = get().activeChannelId;
    if (!communityId || !channelId) return false;
    set({ communityError: null });
    try {
      const deleted = await communityRepository.deleteChannelMessage(
        communityId,
        channelId,
        messageId
      );
      const deletedAt =
        deleted && typeof deleted === 'object' && 'deleted_at' in deleted && deleted.deleted_at
          ? deleted.deleted_at
          : new Date().toISOString();
      set((state) => ({
        activeCommunityChannelMessages: state.activeCommunityChannelMessages.map((m) =>
          m.id === messageId
            ? {
                ...m,
                ...(deleted && typeof deleted === 'object' ? deleted : {}),
                content: '[Mensagem apagada]',
                deleted_at: deletedAt,
              }
            : m
        ),
      }));
      return true;
    } catch (err: any) {
      set({ communityError: err?.message || String(err) });
      return false;
    }
  },

  markChannelRead: async (communityIdArg, channelIdArg, lastReadMessageId) => {
    const communityId = communityIdArg || get().activeCommunityId;
    const channelId = channelIdArg || get().activeChannelId;
    if (!communityId || !channelId) return;

    const messages = get().activeCommunityChannelMessages;
    const resolvedLastId =
      lastReadMessageId !== undefined
        ? lastReadMessageId
        : messages.length > 0
        ? messages[messages.length - 1].id
        : null;

    if (!resolvedLastId || resolvedLastId.startsWith('opt_')) return;

    try {
      await communityRepository.markChannelRead(communityId, channelId, resolvedLastId);
      set((state) => {
        const snapshot = state.communitySnapshot;
        let nextSnapshot = snapshot;
        let nextTotalUnread = 0;
        if (snapshot && snapshot.community.id === communityId) {
          const nextChannels = snapshot.channels.map((ch) =>
            ch.id === channelId ? { ...ch, unread_count: 0 } : ch
          );
          nextTotalUnread = nextChannels.reduce((acc, ch) => acc + (ch.unread_count || 0), 0);
          nextSnapshot = {
            ...snapshot,
            channels: nextChannels,
            community: { ...snapshot.community, unread_count: nextTotalUnread },
          };
        }
        return {
          communitySnapshot: nextSnapshot,
          communities: state.communities.map((c) =>
            c.id === communityId
              ? {
                  ...c,
                  unread_count:
                    nextSnapshot && nextSnapshot.community.id === communityId
                      ? nextTotalUnread
                      : c.unread_count,
                }
              : c
          ),
        };
      });
    } catch {
      // Non-fatal read state sync failure
    }
  },

  createCommunityRole: async (communityId, payload) => {
    set({ communityError: null });
    try {
      const created = await communityRepository.createRole(communityId, payload);
      set((state) => ({
        communitySnapshot:
          state.communitySnapshot?.community.id === communityId
            ? {
                ...state.communitySnapshot,
                roles: (
                  state.communitySnapshot.roles.some((r) => r.id === created.id)
                    ? state.communitySnapshot.roles.map((r) =>
                        r.id === created.id ? created : r
                      )
                    : [...state.communitySnapshot.roles, created]
                ).sort((a, b) => b.position - a.position),
              }
            : state.communitySnapshot,
      }));
      return created;
    } catch (err: any) {
      set({ communityError: err?.message || String(err) });
      throw err;
    }
  },

  updateCommunityRole: async (communityId, roleId, payload) => {
    set({ communityError: null });
    try {
      const updated = await communityRepository.updateRole(communityId, roleId, payload);
      if (get().activeCommunityId === communityId) {
        await get().loadCommunitySnapshot(communityId);
      }
      return updated;
    } catch (err: any) {
      set({ communityError: err?.message || String(err) });
      throw err;
    }
  },

  deleteCommunityRole: async (communityId, roleId) => {
    set({ communityError: null });
    try {
      await communityRepository.deleteRole(communityId, roleId);
      if (get().activeCommunityId === communityId) {
        await get().loadCommunitySnapshot(communityId);
      }
      return true;
    } catch (err: any) {
      set({ communityError: err?.message || String(err) });
      throw err;
    }
  },

  reorderCommunityRoles: async (communityId, items) => {
    set({ communityError: null });
    try {
      const roles = await communityRepository.reorderRoles(communityId, items);
      set((state) => ({
        communitySnapshot:
          state.communitySnapshot?.community.id === communityId
            ? {
                ...state.communitySnapshot,
                roles: [...roles].sort((a, b) => b.position - a.position),
              }
            : state.communitySnapshot,
      }));
      return true;
    } catch (err: any) {
      set({ communityError: err?.message || String(err) });
      throw err;
    }
  },

  updateCommunityMember: async (communityId, userId, payload) => {
    set({ communityError: null });
    try {
      const updated = await communityRepository.updateMember(communityId, userId, payload);
      set((state) => ({
        communitySnapshot:
          state.communitySnapshot?.community.id === communityId
            ? {
                ...state.communitySnapshot,
                members: syncCommunityMembersPresence(
                  state.communitySnapshot.members.map((m) =>
                    m.user_id === userId ? updated : m
                  ),
                  state.friends,
                  state.currentUser
                ),
              }
            : state.communitySnapshot,
      }));
      return updated;
    } catch (err: any) {
      set({ communityError: err?.message || String(err) });
      throw err;
    }
  },

  setCommunityMemberRoles: async (communityId, userId, roleIds) => {
    set({ communityError: null });
    try {
      const updated = await communityRepository.setMemberRoles(communityId, userId, roleIds);
      if (get().activeCommunityId === communityId) {
        await get().loadCommunitySnapshot(communityId);
      }
      return updated;
    } catch (err: any) {
      set({ communityError: err?.message || String(err) });
      throw err;
    }
  },

  addCommunityMemberRole: async (communityId, userId, roleId) => {
    set({ communityError: null });
    try {
      const updated = await communityRepository.addMemberRole(communityId, userId, roleId);
      if (get().activeCommunityId === communityId) {
        await get().loadCommunitySnapshot(communityId);
      }
      return updated;
    } catch (err: any) {
      set({ communityError: err?.message || String(err) });
      throw err;
    }
  },

  removeCommunityMemberRole: async (communityId, userId, roleId) => {
    set({ communityError: null });
    try {
      const updated = await communityRepository.removeMemberRole(communityId, userId, roleId);
      if (get().activeCommunityId === communityId) {
        await get().loadCommunitySnapshot(communityId);
      }
      return updated;
    } catch (err: any) {
      set({ communityError: err?.message || String(err) });
      throw err;
    }
  },

  kickCommunityMember: async (communityId, userId, payload = {}) => {
    set({ communityError: null });
    try {
      await communityRepository.kickMember(communityId, userId, payload);
      set((state) => ({
        communitySnapshot:
          state.communitySnapshot?.community.id === communityId
            ? {
                ...state.communitySnapshot,
                members: state.communitySnapshot.members.filter((m) => m.user_id !== userId),
                community: {
                  ...state.communitySnapshot.community,
                  member_count: Math.max(0, state.communitySnapshot.community.member_count - 1),
                },
              }
            : state.communitySnapshot,
      }));
      return true;
    } catch (err: any) {
      set({ communityError: err?.message || String(err) });
      throw err;
    }
  },

  banCommunityMember: async (communityId, userId, payload = {}) => {
    set({ communityError: null });
    try {
      const ban = await communityRepository.banMember(communityId, userId, payload);
      set((state) => ({
        communityBans: [ban, ...state.communityBans.filter((b) => b.user_id !== userId)],
        communitySnapshot:
          state.communitySnapshot?.community.id === communityId
            ? {
                ...state.communitySnapshot,
                members: state.communitySnapshot.members.filter((m) => m.user_id !== userId),
                community: {
                  ...state.communitySnapshot.community,
                  member_count: Math.max(0, state.communitySnapshot.community.member_count - 1),
                },
              }
            : state.communitySnapshot,
      }));
      return true;
    } catch (err: any) {
      set({ communityError: err?.message || String(err) });
      throw err;
    }
  },

  unbanCommunityMember: async (communityId, userId) => {
    set({ communityError: null });
    try {
      await communityRepository.unbanMember(communityId, userId);
      set((state) => ({
        communityBans: state.communityBans.filter((b) => b.user_id !== userId),
      }));
      return true;
    } catch (err: any) {
      set({ communityError: err?.message || String(err) });
      throw err;
    }
  },

  loadCommunityBans: async (communityId) => {
    set({ communityError: null });
    try {
      const bans = await communityRepository.listBans(communityId);
      if (get().activeCommunityId === communityId) {
        set({ communityBans: bans });
      }
      return bans;
    } catch (err: any) {
      set({ communityError: err?.message || String(err) });
      throw err;
    }
  },

  muteCommunityMember: async (communityId, userId, payload) => {
    set({ communityError: null });
    try {
      const mute = await communityRepository.muteMember(communityId, userId, payload);
      set((state) => ({
        communitySnapshot:
          state.communitySnapshot?.community.id === communityId
            ? {
                ...state.communitySnapshot,
                members: state.communitySnapshot.members.map((m) =>
                  m.user_id === userId
                    ? {
                        ...m,
                        text_muted_until: mute.text_muted_until ?? null,
                        voice_muted_until: mute.voice_muted_until ?? null,
                        server_voice_muted: mute.server_voice_muted,
                      }
                    : m
                ),
                my_mute:
                  userId === state.onlineUser?.id ? mute : state.communitySnapshot.my_mute,
              }
            : state.communitySnapshot,
      }));
      return mute;
    } catch (err: any) {
      set({ communityError: err?.message || String(err) });
      throw err;
    }
  },

  loadCommunityAuditLogs: async (communityId, query = {}) => {
    set({ communityError: null });
    try {
      const logs = await communityRepository.listAuditLogs(communityId, query);
      if (get().activeCommunityId === communityId) {
        set({ communityAuditLogs: logs });
      }
      return logs;
    } catch (err: any) {
      set({ communityError: err?.message || String(err) });
      throw err;
    }
  },

  createCommunityInvite: async (communityId, payload = {}) => {
    set({ communityError: null });
    try {
      const invite = await communityRepository.createInvite(communityId, payload);
      set((state) => ({
        communityInvites: [invite, ...state.communityInvites],
      }));
      return invite;
    } catch (err: any) {
      set({ communityError: err?.message || String(err) });
      throw err;
    }
  },

  loadCommunityInvites: async (communityId) => {
    set({ communityError: null });
    try {
      const invites = await communityRepository.listInvites(communityId);
      if (get().activeCommunityId === communityId) {
        set({ communityInvites: invites });
      }
      return invites;
    } catch (err: any) {
      set({ communityError: err?.message || String(err) });
      throw err;
    }
  },

  revokeCommunityInvite: async (communityId, inviteId) => {
    set({ communityError: null });
    try {
      await communityRepository.revokeInvite(communityId, inviteId);
      set((state) => ({
        communityInvites: state.communityInvites.filter((i) => i.id !== inviteId),
      }));
      return true;
    } catch (err: any) {
      set({ communityError: err?.message || String(err) });
      throw err;
    }
  },

  previewCommunityInvite: async (code) => {
    set({ communityError: null });
    try {
      return await communityRepository.getInvitePreview(code);
    } catch (err: any) {
      set({ communityError: err?.message || String(err) });
      throw err;
    }
  },

  acceptCommunityInvite: async (code) => {
    set({ communityError: null });
    try {
      const res = await communityRepository.acceptInvite(code);
      set((state) => ({
        communities: [
          res.community,
          ...state.communities.filter((c) => c.id !== res.community.id),
        ],
      }));
      await get().selectCommunity(res.community.id);
      if (res.channel_id) {
        await get().selectCommunityChannel(res.channel_id);
      }
      return res;
    } catch (err: any) {
      set({ communityError: err?.message || String(err) });
      throw err;
    }
  },

  clearCommunityError: () => set({ communityError: null }),

  // Phase B3.2: Multi-participant Voice Room Actions
  loadCommunityVoiceRooms: async (communityId) => {
    try {
      let raw: any = null;
      const isTauriRuntime =
        typeof window !== 'undefined' && Boolean((window as any).__TAURI_INTERNALS__);

      if (isTauriRuntime) {
        try {
          const { invoke } = await import('@tauri-apps/api/core');
          raw = await invoke('communities_get_voice_rooms', { communityId });
        } catch {
          raw = null;
        }
      }

      if (!raw && typeof window !== 'undefined' && typeof fetch === 'function') {
        const apiBase = window.localStorage?.getItem('nexus_test_api_base')?.trim();
        const token = window.localStorage?.getItem('nexus_test_token')?.trim();
        if (apiBase && token) {
          const resp = await fetch(
            `${apiBase.replace(/\/+$/, '')}/v1/communities/${communityId}/voice-rooms`,
            { headers: { Authorization: `Bearer ${token}` } }
          );
          if (resp.ok) {
            raw = await resp.json();
          }
        }
      }

      if (!raw) return;

      const byChannel: Record<string, RoomParticipantDto[]> = {};
      const list = Array.isArray(raw) ? raw : Array.isArray(raw?.rooms) ? raw.rooms : null;
      if (list) {
        for (const item of list) {
          if (item?.channel_id && Array.isArray(item.participants)) {
            byChannel[item.channel_id] = item.participants;
          }
        }
      } else if (typeof raw === 'object') {
        for (const [chId, participants] of Object.entries(raw)) {
          if (Array.isArray(participants)) {
            byChannel[chId] = participants as RoomParticipantDto[];
          }
        }
      }

      set((state) => ({
        communityVoiceRooms: {
          ...state.communityVoiceRooms,
          [communityId]: byChannel,
        },
      }));
    } catch (err: any) {
      console.warn('[useAppStore] Falha ao carregar salas de voz:', err);
    }
  },

  joinVoiceChannel: async (communityId, channelId) => {
    const current = get();
    if (
      current.activeVoiceCommunityId === communityId &&
      current.activeVoiceChannelId === channelId &&
      (current.voiceRoomState === 'connected' || current.voiceRoomState === 'joining')
    ) {
      return;
    }

    if (current.activeVoiceCommunityId && current.activeVoiceChannelId) {
      await get().leaveVoiceChannel();
    }

    set({
      voiceRoomState: 'joining',
      activeVoiceCommunityId: communityId,
      activeVoiceChannelId: channelId,
      voiceRoomScreenReceivers: {},
      voiceRoomError: null,
      voiceRoomPeerStatuses: {},
      voiceRoomRemoteStreams: {},
      voiceRoomMetrics: null,
    });

    gatewayClient.sendRoomJoin(communityId, channelId);
  },

  leaveVoiceChannel: async () => {
    const { activeVoiceCommunityId, activeVoiceChannelId } = get();
    if (activeVoiceCommunityId && activeVoiceChannelId) {
      gatewayClient.sendRoomLeave(activeVoiceCommunityId, activeVoiceChannelId);
    }
    await meshRoomService.leaveRoom();
    set({
      voiceRoomState: 'idle',
      activeVoiceCommunityId: null,
      activeVoiceChannelId: null,
      voiceRoomParticipants: [],
      voiceRoomMuted: false,
      voiceRoomDeafened: false,
      voiceRoomScreenSharing: false,
      voiceRoomPeerStatuses: {},
      voiceRoomRemoteStreams: {},
      voiceRoomMetrics: null,
      voiceRoomScreenReceivers: {},
      voiceRoomError: null,
    });
  },

  toggleVoiceRoomMute: () => {
    const {
      activeVoiceCommunityId,
      activeVoiceChannelId,
      voiceRoomMuted,
      voiceRoomCanSpeak,
    } = get();
    if (!activeVoiceCommunityId || !activeVoiceChannelId) return;
    if (voiceRoomMuted && !voiceRoomCanSpeak) {
      set({ voiceRoomError: 'Você não tem permissão para falar neste canal.' });
      return;
    }
    const nextMuted = !voiceRoomMuted;
    meshRoomService.setMuted(nextMuted);
    set({ voiceRoomMuted: nextMuted });
    gatewayClient.sendRoomStateUpdate(activeVoiceCommunityId, activeVoiceChannelId, {
      is_muted: nextMuted,
    });
  },

  toggleVoiceRoomDeafen: () => {
    const { activeVoiceCommunityId, activeVoiceChannelId, voiceRoomDeafened } = get();
    if (!activeVoiceCommunityId || !activeVoiceChannelId) return;
    const nextDeafened = !voiceRoomDeafened;
    meshRoomService.setDeafened(nextDeafened);
    set({ voiceRoomDeafened: nextDeafened });
    gatewayClient.sendRoomStateUpdate(activeVoiceCommunityId, activeVoiceChannelId, {
      is_deafened: nextDeafened,
    });
  },

  setVoiceRoomParticipantVolume: (peerUserId, volume) => {
    const clamped = Math.max(0, Math.min(200, Math.round(volume)));
    meshRoomService.setParticipantVolume(peerUserId, clamped);
    set((state) => ({
      voiceRoomParticipantVolumes: {
        ...state.voiceRoomParticipantVolumes,
        [peerUserId]: clamped,
      },
    }));
  },

  startVoiceRoomScreenShare: async (preset) => {
    const {
      activeVoiceCommunityId,
      activeVoiceChannelId,
      voiceRoomCanScreenShare,
      voiceRoomQuality,
    } = get();
    if (!activeVoiceCommunityId || !activeVoiceChannelId) return false;
    if (!voiceRoomCanScreenShare) {
      set({ voiceRoomError: 'Você não tem permissão para compartilhar tela neste canal.' });
      return false;
    }

    const chosenPreset = preset ?? voiceRoomQuality;
    const ok = await meshRoomService.startScreenShare(chosenPreset);
    if (ok) {
      set({ voiceRoomScreenSharing: true, voiceRoomQuality: chosenPreset, voiceRoomError: null });
    }
    return ok;
  },

  stopVoiceRoomScreenShare: async () => {
    set({
      voiceRoomScreenSharing: false,
      nativeCaptureStatus: null,
      nativeScreenStats: null,
    });
    await meshRoomService.stopScreenShare();
  },

  setVoiceRoomQuality: async (preset) => {
    set({ voiceRoomQuality: preset });
    await meshRoomService.setScreenShareQuality(preset);
  },

  retryVoiceRoomScreen: (peerUserId) => meshRoomService.retryRemoteScreen(peerUserId),
  clearVoiceRoomError: () => set({ voiceRoomError: null }),

  setActiveTab: (tab) => {
    set({ activeTab: tab });
    settingsRepository.savePreferences({ activeTab: tab });
  },

  toggleSidebar: () => {
    const next = !get().isSidebarCollapsed;
    set({ isSidebarCollapsed: next });
    settingsRepository.savePreferences({ isSidebarCollapsed: next });
  },

  setSidebarCollapsed: (collapsed) => {
    set({ isSidebarCollapsed: collapsed });
    settingsRepository.savePreferences({ isSidebarCollapsed: collapsed });
  },

  setActiveCommunity: (id) => {
    set({ activeCommunityId: id });
    settingsRepository.savePreferences({ activeCommunityId: id });
  },

  setActiveChannel: (id) => {
    set({ activeChannelId: id });
    settingsRepository.savePreferences({ activeChannelId: id });
  },

  setActiveDm: (id) => {
    set({ activeDmId: id });
    settingsRepository.savePreferences({ activeDmId: id });
  },

  toggleMic: () =>
    set((state) => {
      const nextMuted = !state.isMicMuted;
      return {
        isMicMuted: nextMuted,
        callParticipants: state.callParticipants.map((p) =>
          p.id === 'usr_me'
            ? { ...p, isMuted: nextMuted, isSpeaking: nextMuted ? false : p.isSpeaking }
            : p
        ),
      };
    }),

  toggleDeafen: () =>
    set((state) => {
      const nextDeafened = !state.isDeafened;
      return {
        isDeafened: nextDeafened,
        isMicMuted: nextDeafened ? true : state.isMicMuted,
        callParticipants: state.callParticipants.map((p) =>
          p.id === 'usr_me'
            ? {
                ...p,
                isDeafened: nextDeafened,
                isMuted: nextDeafened ? true : p.isMuted,
                isSpeaking: nextDeafened ? false : p.isSpeaking,
              }
            : p
        ),
      };
    }),

  toggleCam: () =>
    set((state) => {
      const nextCam = !state.isCamOn;
      return {
        isCamOn: nextCam,
        callParticipants: state.callParticipants.map((p) =>
          p.id === 'usr_me' ? { ...p, isCamOn: nextCam } : p
        ),
      };
    }),

  openScreenSourcePicker: async (target) => {
    set({ screenPickerTarget: target, screenShareError: null });
    await get().refreshNativeCaptureSources();
  },

  closeScreenSourcePicker: () => {
    set({ screenPickerTarget: null });
  },

  refreshNativeCaptureSources: async () => {
    if (!screenCaptureService.isNativeCaptureSupported()) {
      set({ nativeCaptureSources: null, isLoadingNativeSources: false });
      return null;
    }
    set({ isLoadingNativeSources: true });
    try {
      const sources = await screenCaptureService.listNativeSources();
      set({ nativeCaptureSources: sources, isLoadingNativeSources: false });
      return sources;
    } catch (err: any) {
      const msg =
        typeof err === 'string'
          ? err
          : err?.message || (err ? String(err) : 'Falha ao listar monitores e janelas.');
      console.error('[ScreenCapture] Falha ao listar fontes nativas:', err);
      set({
        isLoadingNativeSources: false,
        screenShareError: msg,
      });
      return null;
    }
  },

  startNativeVoiceRoomScreenShare: async (options) => {
    const {
      activeVoiceCommunityId,
      activeVoiceChannelId,
      voiceRoomCanScreenShare,
      voiceRoomQuality,
    } = get();
    if (!activeVoiceCommunityId || !activeVoiceChannelId) return false;
    if (!voiceRoomCanScreenShare) {
      set({ voiceRoomError: 'Você não tem permissão para compartilhar tela neste canal.' });
      return false;
    }

    const chosenPreset = options.preset ?? voiceRoomQuality;
    try {
      const status = await meshRoomService.startNativeScreenShare({
        ...options,
        preset: chosenPreset,
      });
      if (!status) return false;
      set({
        voiceRoomScreenSharing: true,
        voiceRoomQuality: chosenPreset,
        voiceRoomError: null,
        screenPickerTarget: null,
        nativeCaptureStatus: status,
      });
      return true;
    } catch (err: any) {
      const msg =
        typeof err === 'string'
          ? err
          : err?.message || (err ? String(err) : 'Falha ao iniciar compartilhamento de tela nativo.');
      console.error('[VoiceRoom] Falha ao iniciar compartilhamento nativo:', err);
      set({
        voiceRoomError: msg,
      });
      return false;
    }
  },

  startNativeCallScreenShare: async (options) => {
    try {
      const status = await callService.startNativeScreenShare(options);
      if (!status) return false;
      set({
        screenPickerTarget: null,
        nativeCaptureStatus: status,
        screenShareError: null,
      });
      return true;
    } catch (err: any) {
      const msg =
        typeof err === 'string'
          ? err
          : err?.message || (err ? String(err) : 'Falha ao iniciar captura nativa de tela.');
      console.error('[Call] Falha ao iniciar compartilhamento nativo:', err);
      set({
        screenShareError: msg,
      });
      return false;
    }
  },

  startScreenShare: async (preset) => {
    return callService.startScreenShare(preset);
  },

  stopScreenShare: () => {
    callService.stopScreenShare();
  },

  setScreenShareQuality: async (preset) => {
    await callService.setScreenShareQuality(preset);
  },

  clearScreenShareError: () => {
    screenCaptureService.clearError();
  },

  toggleScreenShare: () => {
    callService.toggleScreenShare();
  },

  setRemoteScreenStream: (stream, track) =>
    set({
      isRemoteScreenSharing: Boolean(stream && track),
      remoteScreenStream: stream,
      remoteScreenTrack: track,
      isRemoteScreenMuted: false,
    }),

  setRemoteScreenMuted: (isRemoteScreenMuted) => set({ isRemoteScreenMuted }),

  toggleCallParticipants: () =>
    set((state) => ({ isCallParticipantsOpen: !state.isCallParticipantsOpen })),

  disconnectCall: () => {
    screenCaptureService.stopCapture();
    set({
      isCallActive: false,
      isCamOn: false,
      isScreenSharing: false,
    });
  },

  joinCall: (roomName) =>
    set({
      isCallActive: true,
      activeCallRoom: roomName,
    }),

  // Phase 2.4 Voice Call Actions
  setVoiceCallState: (voiceCallState) => set({ voiceCallState }),
  setActiveCall: (activeCallId, activeCallPeer) => set({ activeCallId, activeCallPeer }),
  setIncomingCall: (incomingCall) => set({ incomingCall }),
  setCallDurationSecs: (callDurationSecs) => set({ callDurationSecs }),
  setSpeakingState: (target, isSpeaking) =>
    set(target === 'local' ? { isLocalSpeaking: isSpeaking } : { isRemoteSpeaking: isSpeaking }),
  setPeerMuted: (isPeerMuted) => set({ isPeerMuted }),
  setCallErrorMessage: (callErrorMessage) => set({ callErrorMessage }),
  setCallDeviceNotice: (callDeviceNotice) => set({ callDeviceNotice }),
  setReconnectStatus: (reconnectAttempt, maxReconnectAttempts = 3) =>
    set({ reconnectAttempt, maxReconnectAttempts }),
  setParticipantVolume: (peerId, volume) => {
    callService.setParticipantVolume(peerId, volume);
  },
  setCallStageSplitRatio: (ratio) => {
    const clamped = Math.max(30, Math.min(85, Math.round(ratio)));
    get().updateAudioVideo({ callStageSplitRatio: clamped });
  },
  setCallLayoutMode: (callLayoutMode) => set({ callLayoutMode }),

  setUserStatus: (status) => {
    set((state) => ({
      currentUser: { ...state.currentUser, status },
      communitySnapshot: state.communitySnapshot
        ? {
            ...state.communitySnapshot,
            members: state.communitySnapshot.members.map((m) =>
              m.user_id === state.currentUser.id ? { ...m, status } : m
            ),
          }
        : null,
    }));

    if (get().authStatus === 'authenticated') {
      presenceRepository.updatePresence({ preferredStatus: status, status }).catch(console.error);
      gatewayClient.sendPresence(status, get().currentUser.customStatus);
    }
  },

  updateProfile: (profileUpdate) =>
    set((state) => ({
      settings: {
        ...state.settings,
        profile: { ...state.settings.profile, ...profileUpdate },
      },
      currentUser: {
        ...state.currentUser,
        displayName: profileUpdate.displayName ?? state.currentUser.displayName,
        customStatus: profileUpdate.customStatus ?? state.currentUser.customStatus,
        bio: profileUpdate.bio ?? state.currentUser.bio,
        avatarUrl: profileUpdate.avatarUrl !== undefined ? profileUpdate.avatarUrl : state.currentUser.avatarUrl,
      },
    })),

  saveProfile: async (updates) => {
    if (updates.avatarUrl !== undefined) {
      settingsRepository.savePreferences({ avatarUrl: updates.avatarUrl });
    }
    if (get().authStatus === 'authenticated') {
      const updated = await authRepository.updateProfile(updates);
      set((state) => createAuthenticatedState(state, {
        ...updated,
        avatarUrl: updates.avatarUrl ?? updated.avatarUrl,
      }));
      if (updates.customStatus !== undefined) {
        gatewayClient.sendPresence(get().currentUser.status, updates.customStatus);
      }
    } else {
      // Offline / Demo mode
      set((state) => ({
        currentUser: {
          ...state.currentUser,
          username: updates.username ?? state.currentUser.username,
          displayName: updates.displayName ?? state.currentUser.displayName,
          bio: updates.bio ?? state.currentUser.bio,
          customStatus: updates.customStatus ?? state.currentUser.customStatus,
          avatarUrl: updates.avatarUrl !== undefined ? updates.avatarUrl : state.currentUser.avatarUrl,
        },
        settings: {
          ...state.settings,
          profile: {
            ...state.settings.profile,
            ...updates,
          },
        },
      }));
    }
  },

  updateAppearance: (appearanceUpdate) => {
    const currentTheme = get().settings.appearance.theme;
    const newTheme = (appearanceUpdate.theme ?? currentTheme) as 'nexus-dark' | 'midnight-black' | 'cyber-slate';

    if (appearanceUpdate.theme) {
      if (typeof document !== 'undefined') {
        document.documentElement.setAttribute('data-theme', newTheme);
      }
      if (typeof window !== 'undefined' && window.localStorage) {
        try {
          window.localStorage.setItem('nexus_theme', newTheme);
        } catch {}
      }
    }

    set((state) => ({
      settings: {
        ...state.settings,
        appearance: { ...state.settings.appearance, ...appearanceUpdate },
      },
    }));
    settingsRepository.savePreferences({
      theme: newTheme,
      compactMode: appearanceUpdate.compactMode ?? get().settings.appearance.compactMode,
      fontSize: appearanceUpdate.fontSize ?? get().settings.appearance.fontSize,
    });
  },

  updateAudioVideo: (audioVideoUpdate) => {
    set((state) => ({
      settings: {
        ...state.settings,
        audioVideo: { ...state.settings.audioVideo, ...audioVideoUpdate },
      },
    }));
    const currentAv = get().settings.audioVideo;
    settingsRepository.savePreferences({
      inputDevice: audioVideoUpdate.inputDevice ?? currentAv.inputDevice,
      outputDevice: audioVideoUpdate.outputDevice ?? currentAv.outputDevice,
      inputSensitivity: audioVideoUpdate.inputSensitivity ?? currentAv.inputSensitivity,
      voiceAutoSensitivity: currentAv.voiceAutoSensitivity ?? true,
      voiceHangoverMs: currentAv.voiceHangoverMs ?? 400,
      voiceSoftGate: currentAv.voiceSoftGate ?? false,
      outputVolume: audioVideoUpdate.outputVolume ?? currentAv.outputVolume,
      noiseSuppression: audioVideoUpdate.noiseSuppression ?? currentAv.noiseSuppression,
      echoCancellation: audioVideoUpdate.echoCancellation ?? currentAv.echoCancellation,
      autoGainControl: audioVideoUpdate.autoGainControl ?? currentAv.autoGainControl ?? true,
      screenShareQuality: audioVideoUpdate.screenShareQuality ?? currentAv.screenShareQuality ?? 'auto',
      participantVolumes: audioVideoUpdate.participantVolumes ?? currentAv.participantVolumes ?? {},
      callStageSplitRatio: audioVideoUpdate.callStageSplitRatio ?? currentAv.callStageSplitRatio ?? 65,
    });
  },

  updateNotifications: (notificationsUpdate) => {
    set((state) => ({
      settings: {
        ...state.settings,
        notifications: { ...state.settings.notifications, ...notificationsUpdate },
      },
    }));
    settingsRepository.savePreferences({
      desktopAlerts: notificationsUpdate.desktopAlerts ?? get().settings.notifications.desktopAlerts,
      soundEffects: notificationsUpdate.soundEffects ?? get().settings.notifications.soundEffects,
      mentionsOnly: notificationsUpdate.mentionsOnly ?? get().settings.notifications.mentionsOnly,
      dndMode: notificationsUpdate.dndMode ?? get().settings.notifications.dndMode,
    });
  },

  updatePrivacy: (privacyUpdate) => {
    set((state) => ({
      settings: {
        ...state.settings,
        privacy: { ...state.settings.privacy, ...privacyUpdate },
      },
    }));
    settingsRepository.savePreferences({
      allowDmsFrom: privacyUpdate.allowDmsFrom ?? get().settings.privacy.allowDmsFrom,
      showGameActivity: privacyUpdate.showGameActivity ?? get().settings.privacy.showGameActivity,
      streamerMode: privacyUpdate.streamerMode ?? get().settings.privacy.streamerMode,
    });
  },
}));

// Sincroniza o estado do ScreenCaptureService em tempo real com o store Zustand
screenCaptureService.addListener((state) => {
  useAppStore.setState({
    isScreenSharing: state.isCapturing,
    isStartingScreenShare: state.isStarting,
    screenStream: state.stream,
    screenShareLabel: state.sourceLabel,
    screenShareQuality: state.qualityPreset,
    screenEffectiveWidth: state.effectiveWidth,
    screenEffectiveHeight: state.effectiveHeight,
    screenEffectiveFps: state.effectiveFrameRate,
    screenQualityFallbackNotice: state.qualityFallbackNotice,
    screenCaptureNotice: state.captureNotice,
    screenDisplaySurface: state.displaySurface,
    screenShareError: state.error,
  });
});

if (typeof window !== 'undefined') {
  (window as any).__NEXUS_STORE__ = useAppStore;
}

meshRoomService.setCallbacks({
  onSendOffer: (peerUserId, sdp, streamKind) => {
    const { activeVoiceCommunityId, activeVoiceChannelId } = useAppStore.getState();
    if (activeVoiceCommunityId && activeVoiceChannelId) {
      gatewayClient.sendRoomWebrtcOffer(
        activeVoiceCommunityId,
        activeVoiceChannelId,
        peerUserId,
        sdp,
        streamKind
      );
    }
  },
  onSendAnswer: (peerUserId, sdp, streamKind) => {
    const { activeVoiceCommunityId, activeVoiceChannelId } = useAppStore.getState();
    if (activeVoiceCommunityId && activeVoiceChannelId) {
      gatewayClient.sendRoomWebrtcAnswer(
        activeVoiceCommunityId,
        activeVoiceChannelId,
        peerUserId,
        sdp,
        streamKind
      );
    }
  },
  onSendIceCandidate: (peerUserId, candidate, streamKind) => {
    const { activeVoiceCommunityId, activeVoiceChannelId } = useAppStore.getState();
    if (activeVoiceCommunityId && activeVoiceChannelId) {
      gatewayClient.sendRoomWebrtcIceCandidate(
        activeVoiceCommunityId,
        activeVoiceChannelId,
        peerUserId,
        candidate,
        streamKind
      );
    }
  },
  onNativeStatusChange: (status) => {
    useAppStore.setState({ nativeCaptureStatus: status });
  },
  onNativeStats: (stats) => {
    useAppStore.setState({ nativeScreenStats: stats });
  },
  onNativeScreenEnded: () => {
    useAppStore.setState({
      voiceRoomScreenSharing: false,
      nativeCaptureStatus: null,
      nativeScreenStats: null,
    });
  },
  onScreenSharingChange: (sharing) => {
    const { activeVoiceCommunityId, activeVoiceChannelId } = useAppStore.getState();
    useAppStore.setState({ voiceRoomScreenSharing: sharing });
    if (activeVoiceCommunityId && activeVoiceChannelId) {
      gatewayClient.sendRoomStateUpdate(activeVoiceCommunityId, activeVoiceChannelId, { is_screen_sharing: sharing });
    }
  },
  onPeerStatusChange: (peerUserId, status) => {
    useAppStore.setState((state) => ({
      voiceRoomPeerStatuses: {
        ...state.voiceRoomPeerStatuses,
        [peerUserId]: status,
      },
    }));
  },
  onLocalSpeaking: (isSpeaking) => {
    const state = useAppStore.getState();
    const selfId = state.onlineUser?.id || state.currentUser.id;
    if (!state.activeVoiceCommunityId || !state.activeVoiceChannelId || !selfId) return;
    useAppStore.setState((prev) => ({
      voiceRoomParticipants: prev.voiceRoomParticipants.map((p) =>
        p.user_id === selfId ? { ...p, is_speaking: isSpeaking } : p
      ),
    }));
    gatewayClient.sendRoomStateUpdate(state.activeVoiceCommunityId, state.activeVoiceChannelId, {
      is_speaking: isSpeaking,
    });
  },
  onPeerSpeaking: (peerUserId, isSpeaking) => {
    useAppStore.setState((prev) => ({
      voiceRoomParticipants: prev.voiceRoomParticipants.map((p) =>
        p.user_id === peerUserId ? { ...p, is_speaking: isSpeaking } : p
      ),
    }));
  },
  onScreenReceiverState: (peerUserId, status) => {
    useAppStore.setState(prev => {
      const receivers = { ...prev.voiceRoomScreenReceivers };
      if (status === 'closed') delete receivers[peerUserId]; else receivers[peerUserId] = status;
      return { voiceRoomScreenReceivers: receivers };
    });
  },
  onRemoteVideoStreamsChange: (streams) => {
    const record: Record<string, MediaStream> = {};
    streams.forEach((stream, uid) => {
      record[uid] = stream;
    });
    useAppStore.setState({ voiceRoomRemoteStreams: record });
  },
  onMetricsUpdate: (snapshot) => {
    useAppStore.setState({ voiceRoomMetrics: snapshot });
  },
  onError: (message) => {
    useAppStore.setState({ voiceRoomError: message });
  },
});

