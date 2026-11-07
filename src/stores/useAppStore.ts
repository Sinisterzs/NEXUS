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
import { gatewayClient } from '../services/GatewayClient';
import { networkManager, DEFAULT_NETWORK_STATUS } from '../services/NetworkManager';

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
  isScreenSharing: boolean;
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

function createAuthenticatedState(state: AppState, user: AuthUserProfile) {
  const normUser = normalizeAuthUser(user);
  return {
    authStatus: 'authenticated' as const,
    authMode: 'authenticated' as const,
    onlineUser: normUser,
    backendAvailable: true,
    currentUser: {
      id: normUser.id,
      username: normUser.username,
      displayName: normUser.displayName || normUser.username,
      tag: undefined,
      avatarUrl: normUser.avatarUrl,
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
  isScreenSharing: false,
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

      set({
        activeTab: finalTab,
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

  checkSession: async () => {
    try {
      const netStatus = await networkManager.checkNetwork();
      set({ networkStatus: netStatus });

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
        set((state) => createAuthenticatedState(state, user));

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
        set({
          authStatus: 'unauthenticated',
          authMode: 'offline_demo',
          onlineUser: null,
          currentUser: mockCurrentUser,
          friends: [],
          friendRequests: { incoming: [], outgoing: [] },
          isAuthModalOpen: false,
          settings: {
            ...get().settings,
            profile: initialAppSettings.profile,
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
      const user = await authRepository.login(login, password);
      set((state) => createAuthenticatedState(state, user));

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
      const user = await authRepository.register(username, email, password, displayName);
      set((state) => createAuthenticatedState(state, user));

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
      const user = await authRepository.loginGoogle();
      set((state) => ({
        ...createAuthenticatedState(state, user),
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
    get().closeWebSocket();
    await authRepository.logout();
    set({
      authStatus: 'unauthenticated',
      authMode: 'offline_demo',
      onlineUser: null,
      currentUser: mockCurrentUser,
      friends: [],
      friendRequests: { incoming: [], outgoing: [] },
      conversations: [],
      activeConversationId: null,
      activeConversationMessages: [],
      isAuthModalOpen: false,
      settings: {
        ...get().settings,
        profile: initialAppSettings.profile,
      },
    });
  },

  setOfflineDemoMode: () => {
    get().closeWebSocket();
    set({
      authStatus: 'unauthenticated',
      authMode: 'offline_demo',
      onlineUser: null,
      currentUser: mockCurrentUser,
      friends: [],
      friendRequests: { incoming: [], outgoing: [] },
      conversations: [],
      activeConversationId: null,
      activeConversationMessages: [],
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
        // Cache locally in SQLite
        dmRepository.cacheIncomingMessage(msg, state.onlineUser?.id);

        if (state.activeConversationId === msg.conversation_id) {
          set((curr) => {
            const exists = curr.activeConversationMessages.some(
              (m) => m.id === msg.id || m.client_message_id === msg.client_message_id
            );
            const updated = exists
              ? curr.activeConversationMessages.map((m) =>
                  m.id === msg.id || m.client_message_id === msg.client_message_id ? msg : m
                )
              : [...curr.activeConversationMessages, msg];

            return { activeConversationMessages: updated };
          });
          get().markActiveConversationRead();
        }

        set((curr) => {
          const convExists = curr.conversations.some((c) => c.id === msg.conversation_id);
          let convs = curr.conversations;
          if (convExists) {
            convs = curr.conversations.map((c) =>
              c.id === msg.conversation_id
                ? {
                    ...c,
                    last_message: msg,
                    unread_count:
                      curr.activeConversationId === msg.conversation_id
                        ? 0
                        : c.unread_count + (msg.is_mine ? 0 : 1),
                    updated_at: msg.created_at,
                  }
                : c
            );
          } else {
            get().loadConversations();
          }
          convs.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
          return { conversations: convs };
        });
      },
      onDmMessageUpdated: (msg) => {
        set((state) => ({
          activeConversationMessages: state.activeConversationMessages.map((m) =>
            m.id === msg.id ? msg : m
          ),
          conversations: state.conversations.map((c) =>
            c.last_message?.id === msg.id ? { ...c, last_message: msg } : c
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
          activeConversationMessages: state.activeConversationMessages.map((m) =>
            data.message_ids.includes(m.id)
              ? {
                  ...m,
                  delivered_at: data.delivered_at,
                  delivery_status: m.delivery_status === 'sent' ? 'delivered' : m.delivery_status,
                }
              : m
          ),
        }));
      },
      onDmMessageRead: (data) => {
        set((state) => ({
          activeConversationMessages: state.activeConversationMessages.map((m) =>
            m.conversation_id === data.conversation_id && m.is_mine
              ? {
                  ...m,
                  read_at: data.read_at,
                  delivery_status: 'read',
                }
              : m
          ),
        }));
      },
      onDmConversationUpdated: (data) => {
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === data.conversation_id
              ? { ...c, last_message: data.last_message, updated_at: data.last_message.created_at }
              : c
          ),
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
    if (get().authStatus !== 'authenticated') {
      return;
    }
    set({ isLoadingConversations: true });
    try {
      const user = get().onlineUser;
      const convs = await dmRepository.listConversations(user?.id);
      set({ conversations: convs, isLoadingConversations: false });
    } catch (err) {
      console.warn('[useAppStore] loadConversations failed:', err);
      set({ isLoadingConversations: false });
    }
  },

  selectConversation: async (conversationId: string) => {
    set({ activeConversationId: conversationId, isLoadingMessages: true, dmError: null });
    try {
      const user = get().onlineUser;
      const messages = await dmRepository.getMessages(conversationId, 50, undefined, user?.id);
      set({ activeConversationMessages: messages, isLoadingMessages: false });
      if (messages.length > 0) {
        const lastMsg = messages[messages.length - 1];
        await dmRepository.markRead(conversationId, lastMsg.id);
        gatewayClient.sendReadAck(conversationId, lastMsg.id);
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === conversationId ? { ...c, unread_count: 0 } : c
          ),
        }));
      }
    } catch (err: any) {
      set({ isLoadingMessages: false, dmError: err?.message || String(err) });
    }
  },

  startConversationWithUser: async (targetUserId?: string, username?: string) => {
    try {
      const user = get().onlineUser;
      const conv = await dmRepository.getOrCreateConversation(targetUserId, username, user?.id);
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
      activeConversationMessages: [...state.activeConversationMessages, optimisticMsg],
    }));

    try {
      const sent = await dmRepository.sendMessage(convId, content.trim(), clientMsgId, user?.id);
      set((state) => ({
        isSendingDm: false,
        activeConversationMessages: state.activeConversationMessages.map((m) =>
          m.client_message_id === clientMsgId
            ? { ...sent, delivery_status: sent.delivered_at ? 'delivered' : 'sent' }
            : m
        ),
        conversations: state.conversations.map((c) =>
          c.id === convId ? { ...c, last_message: sent, updated_at: sent.created_at } : c
        ),
      }));
      return true;
    } catch (err: any) {
      set((state) => ({
        isSendingDm: false,
        dmError: err?.message || String(err),
        activeConversationMessages: state.activeConversationMessages.map((m) =>
          m.client_message_id === clientMsgId ? { ...m, delivery_status: 'failed' } : m
        ),
      }));
      return false;
    }
  },

  editDirectMessage: async (messageId: string, content: string) => {
    try {
      const edited = await dmRepository.editMessage(messageId, content);
      set((state) => ({
        activeConversationMessages: state.activeConversationMessages.map((m) =>
          m.id === messageId ? edited : m
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
      const deleted = await dmRepository.deleteMessage(messageId);
      set((state) => ({
        activeConversationMessages: state.activeConversationMessages.map((m) =>
          m.id === messageId ? deleted : m
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
    if (!convId || messages.length === 0) return;
    const lastMsg = messages[messages.length - 1];
    await dmRepository.markRead(convId, lastMsg.id);
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
    const user = get().onlineUser;

    try {
      const older = await dmRepository.getMessages(convId, 30, oldestId, user?.id);
      if (older.length > 0) {
        set((state) => ({
          activeConversationMessages: [
            ...older.filter((o) => !state.activeConversationMessages.some((m) => m.id === o.id)),
            ...state.activeConversationMessages,
          ],
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

  toggleScreenShare: () =>
    set((state) => {
      const nextScreen = !state.isScreenSharing;
      return {
        isScreenSharing: nextScreen,
        callParticipants: state.callParticipants.map((p) =>
          p.id === 'usr_me' ? { ...p, isScreenSharing: nextScreen } : p
        ),
      };
    }),

  toggleCallParticipants: () =>
    set((state) => ({ isCallParticipantsOpen: !state.isCallParticipantsOpen })),

  disconnectCall: () =>
    set({
      isCallActive: false,
      isCamOn: false,
      isScreenSharing: false,
    }),

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
