export type UserStatus = 'online' | 'idle' | 'dnd' | 'invisible' | 'offline';

export type MainTab = 'home' | 'messages' | 'communities' | 'calls' | 'settings';

export interface UserProfile {
  id: string;
  username: string;
  displayName: string;
  tag?: string;
  avatarUrl?: string;
  bio?: string;
  status: UserStatus;
  customStatus?: string;
  hasPassword?: boolean;
  hasGoogle?: boolean;
  activity?: {
    type: 'playing' | 'coding' | 'listening';
    name: string;
    details?: string;
  };
}

export interface Friend {
  id: string;
  name: string;
  username?: string;
  tag: string;
  avatarUrl?: string;
  status: UserStatus;
  customStatus?: string;
  activity?: string;
  lastSeenAt?: string;
}

export interface FriendRequest {
  id: string;
  userId: string;
  username: string;
  tag: string;
  displayName: string;
  avatarUrl?: string;
  status: string;
  createdAt: string;
}

export interface FriendRequestsData {
  incoming: FriendRequest[];
  outgoing: FriendRequest[];
}

export interface UserSearchResult {
  id: string;
  username: string;
  tag: string;
  displayName: string;
  avatarUrl?: string;
  isFriend: boolean;
  hasPendingRequest: boolean;
}

export interface Channel {
  id: string;
  name: string;
  type: 'text' | 'voice';
  unreadCount?: number;
  topic?: string;
}

export interface Community {
  id: string;
  name: string;
  initials: string;
  iconBg: string;
  unreadCount?: number;
  channels: Channel[];
}

export interface ChatMessage {
  id: string;
  authorId: string;
  authorName: string;
  authorAvatar?: string;
  content: string;
  timestamp: string;
  rawTimestamp?: number;
  dateKey: string; // e.g. "Hoje", "Ontem", "28 de Outubro"
  reactions?: { emoji: string; count: number; userReacted?: boolean }[];
  attachments?: { name: string; size: string; type: string }[];
}

export interface DirectMessageSummary {
  id: string;
  friendId: string;
  lastMessage: string;
  timestamp: string;
  unreadCount: number;
}

export interface CallParticipant {
  id: string;
  name: string;
  avatarUrl?: string;
  isSpeaking: boolean;
  isMuted: boolean;
  isDeafened: boolean;
  isCamOn: boolean;
  isScreenSharing: boolean;
  role?: string;
}

export type ScreenShareQualityPreset = 'auto' | '720p30' | '720p60' | '1080p30' | '1080p60';
export type StreamKind = 'voice' | 'screen';

export interface AppSettings {
  profile: {
    displayName: string;
    username: string;
    tag?: string;
    bio: string;
    customStatus: string;
    avatarUrl?: string;
  };
  appearance: {
    theme: 'nexus-dark' | 'midnight-black' | 'cyber-slate';
    compactMode: boolean;
    fontSize: 'sm' | 'base' | 'lg';
  };
  audioVideo: {
    inputDevice: string;
    outputDevice: string;
    inputSensitivity: number;
    outputVolume: number;
    noiseSuppression: boolean;
    echoCancellation: boolean;
    autoGainControl?: boolean;
    screenShareQuality?: ScreenShareQualityPreset;
    participantVolumes?: Record<string, number>;
    callStageSplitRatio?: number;
    cameraDevice: string;
    voiceAutoSensitivity?: boolean;
    voiceHangoverMs?: number;
    voiceSoftGate?: boolean;
  };
  notifications: {
    desktopAlerts: boolean;
    soundEffects: boolean;
    mentionsOnly: boolean;
    dndMode: boolean;
  };
  privacy: {
    allowDmsFrom: 'all' | 'friends' | 'none';
    showGameActivity: boolean;
    streamerMode: boolean;
  };
}

export interface DbConversation {
  id: string;
  type: 'dm' | 'channel';
  title: string;
  updated_at: number;
}

export interface DbMessage {
  id: string;
  conversation_id: string;
  sender_id: string;
  content: string;
  created_at: number;
  delivery_status: string;
}

export interface DbConversationState {
  conversation_id: string;
  last_read_message_id?: string | null;
  draft_text?: string | null;
}

export interface PersistedPreferences {
  theme: 'nexus-dark' | 'midnight-black' | 'cyber-slate';
  compactMode: boolean;
  fontSize: 'sm' | 'base' | 'lg';
  isSidebarCollapsed: boolean;
  activeTab: MainTab;
  activeCommunityId: string | null;
  activeChannelId: string | null;
  activeDmId: string | null;
  inputDevice: string;
  outputDevice: string;
  inputSensitivity: number;
  outputVolume: number;
  noiseSuppression: boolean;
  echoCancellation: boolean;
  autoGainControl?: boolean;
  screenShareQuality?: ScreenShareQualityPreset;
  participantVolumes?: Record<string, number>;
  callStageSplitRatio?: number;
  desktopAlerts: boolean;
  soundEffects: boolean;
  mentionsOnly: boolean;
  dndMode: boolean;
  allowDmsFrom: 'all' | 'friends' | 'none';
  showGameActivity: boolean;
  streamerMode: boolean;
  avatarUrl?: string;
  updateChannel?: 'stable' | 'beta';
  voiceAutoSensitivity?: boolean;
  voiceHangoverMs?: number;
  voiceSoftGate?: boolean;
}

export interface AuthUserProfile {
  id: string;
  username: string;
  email: string;
  displayName: string;
  avatarUrl?: string;
  bio?: string;
  status: string;
  customStatus?: string;
  activity?: string;
  hasPassword?: boolean;
  hasGoogle?: boolean;
  createdAt: string;
}

export type AuthStatus = 'initializing' | 'authenticated' | 'unauthenticated' | 'offline';
export type AuthMode = 'checking' | 'authenticated' | 'offline_demo' | 'reconnecting';

// Phase 2.2: Friends, Presence & Gateway
export interface FriendRequest {
  id: string;
  userId: string;
  username: string;
  tag: string;
  displayName: string;
  avatarUrl?: string;
  status: string;
  createdAt: string;
}

export interface FriendRequestsData {
  incoming: FriendRequest[];
  outgoing: FriendRequest[];
}

export interface UserSearchResult {
  id: string;
  username: string;
  tag: string;
  displayName: string;
  avatarUrl?: string;
  isFriend: boolean;
  hasPendingRequest: boolean;
  isBlocked: boolean;
}

export interface PresenceData {
  userId: string;
  status: string;
  preferredStatus: string;
  customStatus?: string;
  activity?: string;
  allowFriendRequests: boolean;
  lastSeenAt?: string;
}

export interface GatewayEvent {
  id: string;
  type: string;
  version: string;
  payload: any;
}

// Phase 2.3: Direct Messages (DM)
export type DeliveryStatus =
  | 'pending'
  | 'sending'
  | 'sent'
  | 'delivered'
  | 'read'
  | 'failed'
  | 'local_saved';

export interface DirectMessageDto {
  id: string;
  conversation_id: string;
  sender_id: string;
  client_message_id: string;
  content: string;
  created_at: string;
  edited_at?: string | null;
  deleted_at?: string | null;
  delivered_at?: string | null;
  read_at?: string | null;
  is_mine: boolean;
  delivery_status?: DeliveryStatus;
}

export interface DirectConversationDto {
  id: string;
  other_user: Friend;
  last_message?: DirectMessageDto | null;
  unread_count: number;
  created_at: string;
  updated_at: string;
}

// Tailscale & Private Network Status
export type NetworkReachability =
  | 'connected'
  | 'connecting'
  | 'server_unreachable'
  | 'network_disconnected'
  | 'needs_approval';

export interface VerifiedServerIdentity {
  server_id: string;
  public_key: string;
  bound_endpoint: string;
  is_approved: boolean;
}

export interface TailscalePeerSummary {
  host_name: string;
  dns_name: string;
  tailscale_ips: string[];
  online: boolean;
  is_likely_server: boolean;
  node_key?: string | null;
  server_id?: string | null;
  is_approved?: boolean;
}

export interface NetworkStatus {
  tailscale_installed: boolean;
  tailscale_service_running: boolean;
  tailscale_authenticated: boolean;
  tailscale_state: string; // 'running' | 'needs_login' | 'stopped' | 'service_stopped' | 'not_installed' | 'starting'
  tailscale_ips: string[];
  tailscale_self_name?: string | null;
  tailscale_auth_url?: string | null;
  server_reachability: NetworkReachability;
  server_url: string;
  server_latency_ms?: number | null;
  is_magic_dns: boolean;
  detected_peers: TailscalePeerSummary[];
  pending_server_identity?: VerifiedServerIdentity | null;
  approved_server_id?: string | null;
  verified_server_identity?: VerifiedServerIdentity | null;
  error_message?: string | null;
}

// Streaming & WebRTC Diagnostics (Nightly 2 - Problems 1 & 5)
export type BitrateRampStage = 'warmup' | 'ramping' | 'steady' | 'idle';

export interface WebRtcTransportDiagnostics {
  connectionState: RTCPeerConnectionState | 'closed';
  iceConnectionState: RTCIceConnectionState | 'closed';
  selectedCandidatePairState: string | null;
  localCandidateType: string | null;
  remoteCandidateType: string | null;
  transportProtocol: string | null;
  networkClassification:
    | 'tailscale-cg-nat'
    | 'tailscale-ipv6-ula'
    | 'loopback'
    | 'lan-or-reflexive'
    | 'unknown';
  rttMs: number | null;
  packetsLostInbound: number;
  packetsReceived: number;
  packetsSent: number;
  packetLossPercent: number;
  bytesReceived: number;
  bytesSent: number;
  jitterMs: number | null;
  audioBitrateKbps: number;
  videoBitrateKbps: number;
  videoWidth: number | null;
  videoHeight: number | null;
  videoFps: number | null;
  qualityLimitationReason: string | null;

  // Separated FPS metrics (Problem 5: never confuse preset FPS with effective FPS)
  requestedFps: number | null;
  capturedFps: number | null;
  encodedFps: number | null;
  sentFps: number | null;
  receivedFps: number | null;
  decodedFps: number | null;
  /** Unavailable until presentation is measured on the video element. */
  renderedFps: number | null;

  // Separated resolution metrics (Problem 1 & 5: requested vs captured vs encoded vs received)
  requestedWidth: number | null;
  requestedHeight: number | null;
  capturedWidth: number | null;
  capturedHeight: number | null;
  encodedWidth: number | null;
  encodedHeight: number | null;
  receivedWidth: number | null;
  receivedHeight: number | null;

  // Codec, hardware/software implementation & adaptation counters
  videoCodec: string | null;
  encoderImplementation: string | null;
  decoderImplementation: string | null;
  powerEfficientEncoder: boolean | null;
  powerEfficientDecoder: boolean | null;
  qualityLimitationDurations: Record<string, number> | null;
  qualityLimitationResolutionChanges: number | null;
  framesEncoded: number | null;
  framesSent: number | null;
  framesReceived: number | null;
  framesDecoded: number | null;
  framesDropped: number | null;
  keyFramesEncoded: number | null;
  keyFramesDecoded: number | null;
  pliCount: number | null;
  nackCount: number | null;
  targetVideoBitrateKbps: number | null;
  bitrateRampStage: BitrateRampStage;
}
export interface VoiceActivityConfig {
  sensitivity: number;
  autoSensitivity: boolean;
  hangoverMs: number;
  hysteresisOffset: number;
  softGateEnabled: boolean;
}

// ==========================================
// Phase B1/B2: Communities, Channels, Roles, Moderation & Invites
// ==========================================

export type CommunityPrivacy = 'public' | 'invite_only' | 'private';
export type CommunityChannelType = 'text' | 'voice';
export type OverwriteTargetType = 'role' | 'user';

export const COMMUNITY_PERMISSIONS = {
  MANAGE_COMMUNITY: 1n << 0n,
  MANAGE_CHANNELS: 1n << 1n,
  MANAGE_ROLES: 1n << 2n,
  CREATE_INVITES: 1n << 3n,
  SEND_MESSAGES: 1n << 4n,
  CONNECT_VOICE: 1n << 5n,
  SPEAK: 1n << 6n,
  SCREEN_SHARE: 1n << 7n,
  MODERATE_MEMBERS: 1n << 8n,
  VIEW_CHANNEL: 1n << 9n,
  READ_MESSAGE_HISTORY: 1n << 10n,
  MANAGE_MESSAGES: 1n << 11n,
  MUTE_MEMBERS_VOICE: 1n << 12n,
  VIEW_AUDIT_LOG: 1n << 13n,
  ADMINISTRATOR: 1n << 62n,
} as const;

export type CommunityPermissionFlag = keyof typeof COMMUNITY_PERMISSIONS;

export const ALL_COMMUNITY_PERMISSIONS: bigint = Object.values(COMMUNITY_PERMISSIONS).reduce(
  (acc, bit) => acc | bit,
  0n
);

export const DEFAULT_EVERYONE_PERMISSIONS: bigint =
  COMMUNITY_PERMISSIONS.VIEW_CHANNEL |
  COMMUNITY_PERMISSIONS.READ_MESSAGE_HISTORY |
  COMMUNITY_PERMISSIONS.CREATE_INVITES |
  COMMUNITY_PERMISSIONS.SEND_MESSAGES |
  COMMUNITY_PERMISSIONS.CONNECT_VOICE |
  COMMUNITY_PERMISSIONS.SPEAK |
  COMMUNITY_PERMISSIONS.SCREEN_SHARE;

export function parseCommunityBitmask(
  bitmask: string | bigint | number | null | undefined
): bigint {
  if (typeof bitmask === 'bigint') {
    return bitmask >= 0n ? bitmask : 0n;
  }
  if (typeof bitmask === 'number') {
    if (!Number.isSafeInteger(bitmask) || bitmask < 0) return 0n;
    return BigInt(bitmask);
  }
  if (typeof bitmask === 'string') {
    const trimmed = bitmask.trim();
    if (!/^\d+$/.test(trimmed)) return 0n;
    try {
      const parsed = BigInt(trimmed);
      return parsed >= 0n ? parsed : 0n;
    } catch {
      return 0n;
    }
  }
  return 0n;
}

export function hasCommunityPermission(
  bitmask: string | bigint | null | undefined,
  required: bigint | CommunityPermissionFlag
): boolean {
  const mask = parseCommunityBitmask(bitmask);
  const reqBit = typeof required === 'string' ? COMMUNITY_PERMISSIONS[required] : required;
  if (reqBit === undefined || reqBit < 0n) return false;
  return (mask & reqBit) === reqBit;
}

export function flagsToBitmaskStr(flags: readonly (CommunityPermissionFlag | string)[]): string {
  let mask = 0n;
  for (const rawFlag of flags) {
    const key = rawFlag.trim() as CommunityPermissionFlag;
    const bit = COMMUNITY_PERMISSIONS[key];
    if (bit !== undefined) {
      mask |= bit;
    }
  }
  return mask.toString();
}

export function bitmaskStrToFlags(
  bitmask: string | bigint | null | undefined
): CommunityPermissionFlag[] {
  const mask = parseCommunityBitmask(bitmask);
  if (mask <= 0n) return [];
  const result: CommunityPermissionFlag[] = [];
  for (const [flag, bit] of Object.entries(COMMUNITY_PERMISSIONS) as [
    CommunityPermissionFlag,
    bigint,
  ][]) {
    if ((mask & bit) === bit) {
      result.push(flag);
    }
  }
  return result;
}

export interface CommunityDto {
  id: string;
  owner_id: string;
  name: string;
  description?: string | null;
  icon_url?: string | null;
  initials: string;
  icon_bg: string;
  accent_color: string;
  appearance_preset: string;
  privacy: CommunityPrivacy | string;
  effective_permissions: string;
  effective_permissions_flags: CommunityPermissionFlag[];
  unread_count: number;
  member_count: number;
  created_at: string;
  updated_at: string;
}

export interface CommunityCategoryDto {
  id: string;
  community_id: string;
  name: string;
  position: number;
  created_at: string;
  updated_at: string;
}

export interface ChannelPermissionOverwriteDto {
  id: string;
  channel_id: string;
  target_type: OverwriteTargetType | string;
  target_id: string;
  allow_bitmask: string;
  allow_flags: CommunityPermissionFlag[];
  deny_bitmask: string;
  deny_flags: CommunityPermissionFlag[];
  created_at: string;
  updated_at: string;
}

export interface CommunityChannelDto {
  id: string;
  community_id: string;
  category_id?: string | null;
  name: string;
  channel_type: CommunityChannelType | string;
  topic?: string | null;
  position: number;
  is_private: boolean;
  is_read_only: boolean;
  voice_bitrate_bps?: number | null;
  voice_user_limit?: number | null;
  effective_permissions: string;
  effective_permissions_flags: CommunityPermissionFlag[];
  unread_count: number;
  overwrites: ChannelPermissionOverwriteDto[];
  created_at: string;
  updated_at: string;
}

export interface CommunityRoleDto {
  id: string;
  community_id: string;
  name: string;
  color?: string | null;
  position: number;
  permissions_bitmask: string;
  permissions_flags: CommunityPermissionFlag[];
  is_default: boolean;
  is_hoisted: boolean;
  is_mentionable: boolean;
  created_at: string;
  updated_at: string;
}

export interface CommunityMemberRoleDto {
  id: string;
  name: string;
  color?: string | null;
  position: number;
  is_hoisted: boolean;
}

export interface CommunityMemberDto {
  community_id: string;
  user_id: string;
  username: string;
  display_name: string;
  avatar_url?: string | null;
  status: string;
  custom_status?: string | null;
  nickname?: string | null;
  is_owner: boolean;
  roles: CommunityMemberRoleDto[];
  highest_role_position: number;
  joined_at: string;
  text_muted_until?: string | null;
  voice_muted_until?: string | null;
  server_voice_muted: boolean;
}

export interface CommunityMemberMuteDto {
  community_id: string;
  user_id: string;
  muted_by?: string | null;
  reason?: string | null;
  text_muted_until?: string | null;
  voice_muted_until?: string | null;
  server_voice_muted: boolean;
  updated_at: string;
}

export interface CommunitySnapshotDto {
  community: CommunityDto;
  categories: CommunityCategoryDto[];
  channels: CommunityChannelDto[];
  roles: CommunityRoleDto[];
  members: CommunityMemberDto[];
  my_mute?: CommunityMemberMuteDto | null;
}

export interface ChannelMessageAuthorDto {
  id: string;
  username: string;
  display_name: string;
  avatar_url?: string | null;
  nickname?: string | null;
  role_color?: string | null;
}

export interface ChannelMessageDto {
  id: string;
  channel_id: string;
  community_id: string;
  sender_id: string;
  author?: ChannelMessageAuthorDto | null;
  reply_to_message_id?: string | null;
  content: string;
  client_message_id?: string | null;
  attachments: unknown[];
  created_at: string;
  edited_at?: string | null;
  deleted_at?: string | null;
  is_mine: boolean;
  delivery_status?: DeliveryStatus;
}

export interface ChannelMessagesPageDto {
  messages: ChannelMessageDto[];
  has_more: boolean;
  next_before?: string | null;
}

export interface ChannelReadStateDto {
  channel_id: string;
  user_id: string;
  last_read_message_id?: string | null;
  last_read_at: string;
}

export interface CommunityInviteDto {
  id: string;
  community_id: string;
  channel_id?: string | null;
  inviter_id: string;
  code: string;
  max_uses?: number | null;
  uses_count: number;
  expires_at?: string | null;
  revoked_at?: string | null;
  revoked_by?: string | null;
  created_at: string;
}

export interface InvitePreviewDto {
  code: string;
  community_id: string;
  community_name: string;
  community_description?: string | null;
  community_icon_url?: string | null;
  community_initials: string;
  community_icon_bg: string;
  community_accent_color: string;
  community_privacy: CommunityPrivacy | string;
  channel_id?: string | null;
  member_count: number;
  expires_at?: string | null;
  is_valid: boolean;
}

export interface AcceptInviteResponse {
  community: CommunityDto;
  channel_id?: string | null;
  already_member: boolean;
}

export interface CommunityBanDto {
  community_id: string;
  user_id: string;
  username?: string | null;
  display_name?: string | null;
  banned_by: string;
  reason?: string | null;
  expires_at?: string | null;
  created_at: string;
}

export interface CommunityAuditLogDto {
  id: string;
  community_id: string;
  actor_id: string;
  actor_username?: string | null;
  action: string;
  target_type: string;
  target_id?: string | null;
  reason?: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

// Request Payloads
export interface CreateCommunityPayload {
  name: string;
  description?: string | null;
  icon_url?: string | null;
  initials?: string | null;
  icon_bg?: string | null;
  accent_color?: string | null;
  appearance_preset?: string | null;
  privacy?: CommunityPrivacy | string | null;
}

export interface UpdateCommunityPayload {
  name?: string;
  description?: string | null;
  icon_url?: string | null;
  initials?: string;
  icon_bg?: string;
  accent_color?: string;
  appearance_preset?: string;
  privacy?: CommunityPrivacy | string;
}

export interface DeleteCommunityPayload {
  confirm_name: string;
}

export interface TransferOwnershipPayload {
  target_user_id: string;
  confirm_name: string;
}

export interface CreateCategoryPayload {
  name: string;
  position?: number | null;
}

export interface UpdateCategoryPayload {
  name?: string;
  position?: number;
}

export interface ReorderCategoryItem {
  id: string;
  position: number;
}

export interface CreateChannelPayload {
  category_id?: string | null;
  name: string;
  channel_type: CommunityChannelType | string;
  topic?: string | null;
  position?: number | null;
  is_private?: boolean;
  is_read_only?: boolean;
  voice_bitrate_bps?: number | null;
  voice_user_limit?: number | null;
}

export interface UpdateChannelPayload {
  category_id?: string | null;
  name?: string;
  topic?: string | null;
  position?: number;
  is_private?: boolean;
  is_read_only?: boolean;
  voice_bitrate_bps?: number | null;
  voice_user_limit?: number | null;
}

export interface ReorderChannelItem {
  id: string;
  category_id?: string | null;
  position: number;
}

export interface UpsertChannelOverwritePayload {
  target_type: OverwriteTargetType | string;
  target_id: string;
  allow_bitmask?: string;
  allow_flags?: CommunityPermissionFlag[];
  deny_bitmask?: string;
  deny_flags?: CommunityPermissionFlag[];
}

export interface SendChannelMessagePayload {
  content: string;
  client_message_id?: string;
  reply_to_message_id?: string | null;
  attachments?: unknown[];
}

export interface CreateRolePayload {
  name: string;
  color?: string | null;
  position?: number | null;
  permissions_bitmask?: string;
  permissions_flags?: CommunityPermissionFlag[];
  is_hoisted?: boolean;
  is_mentionable?: boolean;
}

export interface UpdateRolePayload {
  name?: string;
  color?: string | null;
  position?: number;
  permissions_bitmask?: string;
  permissions_flags?: CommunityPermissionFlag[];
  is_hoisted?: boolean;
  is_mentionable?: boolean;
}

export interface ReorderRoleItem {
  id: string;
  position: number;
}

export interface UpdateMemberPayload {
  nickname?: string | null;
  role_ids?: string[];
}

export interface KickMemberPayload {
  reason?: string | null;
}

export interface BanMemberPayload {
  reason?: string | null;
  expires_at?: string | null;
  delete_message_hours?: number | null;
}

export interface MuteMemberPayload {
  reason?: string | null;
  text_muted_until?: string | null;
  voice_muted_until?: string | null;
  server_voice_muted?: boolean;
}

export interface CreateInvitePayload {
  channel_id?: string | null;
  max_uses?: number | null;
  expires_in_secs?: number | null;
}

export interface AuditLogsQueryPayload {
  action?: string;
  actor_id?: string;
  before?: string;
  limit?: number;
}

// Phase B3.2: Multi-participant Voice Rooms & P2P Mesh WebRTC
export type VoiceRoomQualityPreset = ScreenShareQualityPreset | '720p60';

export type VoiceRoomState = 'idle' | 'joining' | 'connected' | 'reconnecting' | 'error';

export type VoiceRoomPeerStatus =
  | 'new'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'
  | 'failed'
  | 'closed';

export interface RoomParticipantDto {
  user_id: string;
  username: string;
  display_name?: string | null;
  avatar_url?: string | null;
  is_muted: boolean;
  is_deafened: boolean;
  is_speaking: boolean;
  is_screen_sharing: boolean;
  can_speak?: boolean;
  can_screen_share?: boolean;
  joined_at?: string;
}

export interface VoiceRoomPeerMetrics {
  peerUserId: string;
  connectionState: VoiceRoomPeerStatus;
  iceConnectionState: RTCIceConnectionState | 'closed';
  rttMs: number | null;
  uploadKbps: number;
  downloadKbps: number;
  candidateType: string | null;
  packetsLost: number;
  jitterMs: number | null;
}

export interface VoiceRoomMetricsSnapshot {
  timestampMs: number;
  peerCount: number;
  avgRttMs: number | null;
  totalUploadKbps: number;
  totalDownloadKbps: number;
  totalPacketsLost: number;
  jsHeapUsedMb: number | null;
  peers: Record<string, VoiceRoomPeerMetrics>;
}

// Phase C: Native Windows Capture (DXGI/WGC + Media Foundation + WASAPI + webrtc-rs)
export type CaptureSourceKind = 'DxgiMonitor' | 'WgcMonitor' | 'WgcWindow';

export interface CaptureSourceInfo {
  id: string;
  kind: CaptureSourceKind;
  title: string;
  process_name: string;
  pid: number;
  width: number;
  height: number;
  is_primary: boolean;
  is_hdr: boolean;
  is_minimized: boolean;
  left: number;
  top: number;
  scale_factor: number;
  device_name?: string | null;
  adapter_index?: number | null;
  output_index?: number | null;
}

export interface CaptureSources {
  monitors: CaptureSourceInfo[];
  windows: CaptureSourceInfo[];
}

export interface StartScreenShareOptions {
  source_id: string;
  preset?: VoiceRoomQualityPreset;
  cursor_enabled?: boolean;
  include_app_audio?: boolean;
  force_software?: boolean;
  ice_servers?: RTCIceServer[];
}

export interface NativeCaptureStatus {
  preview_session_id?: number;
  active: boolean;
  source_id: string;
  backend_used: string;
  encoder_name: string;
  is_hardware: boolean;
  d3d_zero_copy: boolean;
  borderless_ok: boolean;
  app_audio_active: boolean;
  app_audio_mode: string;
  width: number;
  height: number;
  fps: number;
  bitrate_bps: number;
  profile_level_id: string;
}

export interface NativeScreenOfferEvent {
  peer_id: string;
  sdp: string;
  sdp_type: string;
}

export interface NativeScreenIceEvent {
  sdp_session_id?: string | null;
  peer_id: string;
  candidate: string;
  sdp_mid: string | null;
  sdp_mline_index: number | null;
}

export interface NativeScreenStatsEvent {
  encoder_name: string;
  is_hardware: boolean;
  d3d_zero_copy: boolean;
  backend_used: string;
  borderless_ok: boolean;
  app_audio_active: boolean;
  preset: string;
  src_width: number;
  src_height: number;
  dst_width: number;
  dst_height: number;
  target_fps: number;
  requested_bitrate_bps?: number;
  encoder_readback_bitrate_bps?: number | null;
  encoded_payload_bitrate_kbps?: number;
  target_bitrate_bps: number;
  send_fps: number;
  send_bitrate_kbps: number;
  frames_captured: number;
  frames_encoded: number;
  frames_sent: number;
  idr_count: number;
  pli_received: number;
  peer_count: number;
  bitrate_experiment_bps?: number;
  bitrate_reinit_count: number;
  encode_avg_ms: number;
}

export interface NativeScreenErrorEvent {
  code: string;
  message: string;
  recoverable: boolean;
}

export interface NativeScreenEndedEvent {
  reason: string;
}





