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

export type ScreenShareQualityPreset = 'auto' | '720p30' | '1080p30' | '1080p60';

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



