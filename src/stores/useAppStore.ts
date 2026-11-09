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
import { conversationRepository } from '../repositories/ConversationRepository';
import { messageRepository } from '../repositories/MessageRepository';
import { callHistoryRepository } from '../repositories/CallHistoryRepository';
import { gatewayClient } from '../services/GatewayClient';
import { callService } from '../services/CallService';
import { screenCaptureService } from '../services/ScreenCaptureService';
import { networkManager, DEFAULT_NETWORK_STATUS } from '../services/NetworkManager';
import { updateService } from '../services/UpdateService';
import { DeliveryStatus } from '../lib/types';

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

let wsUnsubscribe: (() => void) | null = null;

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

  // Phase 2.3: Direct Messages State
  conversations: DirectConversationDto[];
  activeConversationId: string | null;
  activeConversationMessages: DirectMessageDto[];
  isLoadingConversations: boolean;
  isLoadingMessages: boolean;
  isSendingDm: boolean;
  dmError: string | null;

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

  // Phase 3.0: Local Screen Capture State (Preview only)
  isScreenSharing: boolean;
  isStartingScreenShare: boolean;
  screenStream: MediaStream | null;
  screenShareLabel: string | null;
  screenShareError: string | null;
  startScreenShare: () => Promise<MediaStream | null>;
  stopScreenShare: () => void;
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
  checkNetwork: () => Promise<NetworkStatus>;
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
  accountAvatarUrl?: string
) {
  const normUser = normalizeAuthUser(user);
  const previousAccountId = state.onlineUser?.id;
  const isDifferentAccount = previousAccountId !== normUser.id;
  const resolvedAvatar = normUser.avatarUrl || accountAvatarUrl;

  syncAccountRepositories(normUser.id);

  return {
    authStatus: 'authenticated' as const,
    authMode: 'authenticated' as const,
    onlineUser: normUser,
    backendAvailable: true,
    // Reset DM/friend state if switching from another account or offline demo
    ...(isDifferentAccount
      ? {
          conversations: [],
          activeConversationId: null,
          activeConversationMessages: [],
          friends: [],
          friendRequests: { incoming: [], outgoing: [] },
          userSearchResults: [],
          dmError: null,
        }
      : {}),
    currentUser: {
      id: normUser.id,
      username: normUser.username,
      displayName: normUser.displayName || normUser.username,
      tag: undefined,
      avatarUrl: resolvedAvatar,
      bio: normUser.bio || '',
      status: (normUser.status as UserStatus) || 'online',
      customStatus: normUser.customStatus || '',
      hasPassword: normUser.hasPassword,
      hasGoogle: normUser.hasGoogle,
    },
    settings: {
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
    },
    isAuthModalOpen: false,
    authError: null,
  };
}

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
  updateChannel: 'stable',

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

  // Phase 2.3: DM Initial State
  conversations: [],
  activeConversationId: null,
  activeConversationMessages: [],
  isLoadingConversations: false,
  isLoadingMessages: false,
  isSendingDm: false,
  dmError: null,

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

  // Phase 3.0 Screen Sharing Initial State (Local Preview Only)
  isScreenSharing: false,
  isStartingScreenShare: false,
  screenStream: null,
  screenShareLabel: null,
  screenShareError: null,

  // Phase 3.1 Remote Screen Share Initial State
  isRemoteScreenSharing: false,
  remoteScreenStream: null,
  remoteScreenTrack: null,
  isRemoteScreenMuted: false,

  // Settings State
  settings: initialAppSettings,

  initializeStore: async (overrideTab) => {
    try {
      const prefs = await settingsRepository.loadPreferences();

      // Check if URL search param exists
      const urlTab = typeof window !== 'undefined'
        ? (new URLSearchParams(window.location.search).get('tab') as MainTab)
        : null;

      const finalTab = overrideTab || urlTab || prefs.activeTab || 'home';
      const channel = prefs.updateChannel || 'stable';
      updateService.setChannel(channel);

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
            outputVolume: prefs.outputVolume,
            noiseSuppression: prefs.noiseSuppression,
            echoCancellation: prefs.echoCancellation,
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
          if (currentMode === 'reconnecting' || currentStatus === 'offline') {
            console.log('[useAppStore] Servidor restabelecido via Tailscale. Reconectando sessão...');
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
      await get().checkSession();
    } catch (err) {
      console.error('[useAppStore] Error during initializeStore:', err);
      set({ authStatus: 'unauthenticated', authMode: 'offline_demo' });
    } finally {
      // Mark initialized ONLY after preferences and auth state are fully resolved
      set({ isInitialized: true });
    }
  },

  checkNetwork: async () => {
    const status = await networkManager.checkNetwork();
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
    await settingsRepository.savePreferences({ updateChannel: channel });
    await settingsRepository.flushSave();
    await updateService.checkForUpdates(false, channel);
  },

  checkSession: async () => {
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
        set((state) => createAuthenticatedState(state, user, accPrefs.avatarUrl));

        // Initialize social friends & real-time presence
        get().loadFriends();
        get().loadFriendRequests();
        get().loadConversations();
        get().initWebSocket();
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
    }
  },

  loginOnline: async (login, password) => {
    set({ authError: null });
    try {
      await settingsRepository.flushSave();
      const user = await authRepository.login(login, password);
      const accPrefs = await settingsRepository.loadPreferences(user.id);
      set((state) => createAuthenticatedState(state, user, accPrefs.avatarUrl));

      // Initialize friends & real-time presence
      get().loadFriends();
      get().loadFriendRequests();
      get().loadConversations();
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
      set((state) => createAuthenticatedState(state, user, accPrefs.avatarUrl));

      // Initialize friends & real-time presence
      get().loadFriends();
      get().loadFriendRequests();
      get().loadConversations();
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
        ...createAuthenticatedState(state, user, accPrefs.avatarUrl),
        isGoogleLoading: false,
      }));

      // Initialize friends & real-time presence
      get().loadFriends();
      get().loadFriendRequests();
      get().loadConversations();
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
        set({ friends });
      },
      onPresenceUpdated: (update) => {
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
      onReconnected: () => {
        get().loadFriends();
        get().loadFriendRequests();
        get().loadConversations();
        const activeId = get().activeConversationId;
        if (activeId) {
          get().selectConversation(activeId);
        }
      },
      onConnectionChange: (connected) => {
        set({ isWsConnected: connected });
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
    set({ isWsConnected: false });
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

  startScreenShare: async () => {
    return callService.startScreenShare();
  },

  stopScreenShare: () => {
    callService.stopScreenShare();
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

  setUserStatus: (status) => {
    set((state) => ({
      currentUser: { ...state.currentUser, status },
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
    set((state) => ({
      settings: {
        ...state.settings,
        appearance: { ...state.settings.appearance, ...appearanceUpdate },
      },
    }));
    settingsRepository.savePreferences({
      theme: appearanceUpdate.theme ?? get().settings.appearance.theme,
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
    settingsRepository.savePreferences({
      inputDevice: audioVideoUpdate.inputDevice ?? get().settings.audioVideo.inputDevice,
      outputDevice: audioVideoUpdate.outputDevice ?? get().settings.audioVideo.outputDevice,
      inputSensitivity: audioVideoUpdate.inputSensitivity ?? get().settings.audioVideo.inputSensitivity,
      outputVolume: audioVideoUpdate.outputVolume ?? get().settings.audioVideo.outputVolume,
      noiseSuppression: audioVideoUpdate.noiseSuppression ?? get().settings.audioVideo.noiseSuppression,
      echoCancellation: audioVideoUpdate.echoCancellation ?? get().settings.audioVideo.echoCancellation,
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
    screenShareError: state.error,
  });
});
