import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const ROOT = process.cwd();

function readSrc(relPath: string) {
  return readFile(path.join(ROOT, relPath), 'utf8');
}

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function buildIsolatedStorePlugin(harnessGlobalKey: string) {
  return {
    name: 'isolated-store-env',
    setup(builder: any) {
      builder.onResolve(
        {
          filter:
            /(?:services\/(?:DiagnosticsService|SyntheticPeerDiagnostics|GatewayClient|CallService|MeshRoomService|ScreenCaptureService|NetworkManager|UpdateService)|repositories\/(?:SettingsRepository|AuthRepository|FriendRepository|PresenceRepository|DmRepository|CommunityRepository|ConversationRepository|MessageRepository|CallHistoryRepository)|^\.\.\/mocks)$/,
        },
        (args: any) => ({
          path: args.path,
          namespace: 'store-stub',
        })
      );

      builder.onLoad({ filter: /.*/, namespace: 'store-stub' }, (args: any) => {
        const p = args.path;
        if (p.endsWith('/mocks') || p === '../mocks') {
          return {
            contents: `
              export const mockCurrentUser = {
                id: 'user-self',
                username: 'kelman',
                displayName: 'Kelman',
                status: 'online',
                customStatus: '',
                avatarUrl: null,
              };
              export const initialAppSettings = {
                profile: { username: 'kelman', displayName: 'Kelman', bio: '', customStatus: '', avatarUrl: null },
                appearance: { theme: 'nexus-dark', fontSize: 'base', compactMode: false },
                notifications: { enabled: true, sound: true, desktop: true, mentionsOnly: false },
                voiceAudio: {
                  inputDeviceId: 'default',
                  outputDeviceId: 'default',
                  inputVolume: 100,
                  outputVolume: 100,
                  voiceActivitySensitivity: 55,
                  noiseSuppression: true,
                  echoCancellation: true,
                  autoGainControl: true,
                },
                privacy: { showOnlineStatus: true, allowDirectMessages: 'everyone' },
              };
            `,
            loader: 'js',
          };
        }
        if (p.includes('GatewayClient')) {
          return {
            contents: `
              const h = () => globalThis[${JSON.stringify(harnessGlobalKey)}];
              export const gatewayClient = {
                addListener(cb) { h().listeners.add(cb); return () => h().listeners.delete(cb); },
                isConnected() { return Boolean(h().gatewayConnected); },
                sendRoomJoin(communityId, channelId) {
                  h().joinCalls.push({ communityId, channelId });
                  if (h().throwOnJoin) throw new Error(h().throwOnJoin);
                },
                sendRoomLeave(communityId, channelId) {
                  h().leaveCalls.push({ communityId, channelId });
                },
                sendPresence() {},
                sendRoomMediaState() {},
                sendCallAnswer() {},
                sendCallOffer() {},
                sendCallReject() {},
                sendCallEnd() {},
                connect() {},
                disconnect() {},
              };
            `,
            loader: 'js',
          };
        }
        if (p.includes('MeshRoomService')) {
          return {
            contents: `
              const h = () => globalThis[${JSON.stringify(harnessGlobalKey)}];
              export const meshRoomService = {
                setCallbacks() {},
                async startRoomSession(params) { h().startSessionCalls.push(params); },
                async leaveRoom() {
                  h().meshLeaveCalls++;
                  if (h().nextMeshLeaveDeferred) {
                    const d = h().nextMeshLeaveDeferred;
                    h().nextMeshLeaveDeferred = null;
                    await d.promise;
                  }
                },
                setMuted() {},
                setDeafened() {},
                async stopScreenShare() {},
                async startScreenShare() {},
                retryRemoteScreen() { return true; },
                setPeerVolume() {},
                setQualityPreset() {},
                async addParticipant() {},
                async removeParticipant() {},
                handlePeerMediaState() {},
                async handleRemoteOffer() {},
                async handleRemoteAnswer() {},
                async handleRemoteIceCandidate() {},
                async applyAudioSettings() {},
              };
            `,
            loader: 'js',
          };
        }
        if (p.includes('CommunityRepository')) {
          return {
            contents: `
              const h = () => globalThis[${JSON.stringify(harnessGlobalKey)}];
              export const communityRepository = new Proxy({}, {
                get(_t, prop) {
                  if (prop === 'listChannelMessages') {
                    return async (communityId, channelId, before, limit) => {
                      h().listMessagesCalls.push({ communityId, channelId, before, limit });
                      return {
                        messages: h().messagesByChannel[channelId] || [],
                        has_more: false,
                        next_before: null,
                      };
                    };
                  }
                  if (prop === 'sendChannelMessage') {
                    return async (communityId, channelId, payload) => {
                      h().sentMessages.push({ communityId, channelId, payload });
                      return {
                        id: 'msg-srv-' + h().sentMessages.length,
                        channel_id: channelId,
                        community_id: communityId,
                        sender_id: 'user-self',
                        author: { id: 'user-self', username: 'kelman', display_name: 'Kelman', avatar_url: null },
                        reply_to_message_id: payload.reply_to_message_id ?? null,
                        content: payload.content,
                        client_message_id: payload.client_message_id,
                        attachments: [],
                        created_at: new Date().toISOString(),
                        edited_at: null,
                        deleted_at: null,
                        is_mine: true,
                      };
                    };
                  }
                  if (prop === 'markChannelRead') {
                    return async () => {};
                  }
                  return async () => [];
                }
              });
            `,
            loader: 'js',
          };
        }
        if (p.includes('SettingsRepository')) {
          return {
            contents: `
              export const settingsRepository = {
                setAccountId() {},
                getUpdateChannelSync() { return 'beta'; },
                savePreferences() {},
                async loadPreferences() { return {}; },
                async loadSettings() { return null; },
                async saveSettings() {},
              };
            `,
            loader: 'js',
          };
        }
        if (p.includes('NetworkManager')) {
          return {
            contents: `
              export const DEFAULT_NETWORK_STATUS = {
                tailscale_installed: false,
                tailscale_service_running: false,
                tailscale_authenticated: false,
                tailscale_state: 'idle',
                tailscale_ips: [],
                tailscale_self_name: null,
                tailscale_auth_url: null,
                server_reachability: 'connected',
                server_url: 'https://nexus.local',
                server_latency_ms: 12,
                is_magic_dns: false,
                detected_peers: [],
                pending_server_identity: null,
                approved_server_id: null,
                verified_server_identity: null,
                error_message: null,
              };
              export const networkManager = {
                addListener() { return () => {}; },
                async checkNetwork() { return DEFAULT_NETWORK_STATUS; },
                async approveServer() {},
                async setServerAddress(u) { return u; },
                async getServerAddress() { return 'https://nexus.local'; },
                async openTailscale() {},
              };
            `,
            loader: 'js',
          };
        }
        if (p.includes('AuthRepository')) {
          return {
            contents: `
              export const normalizeAuthUser = (u) => u;
              export const authRepository = new Proxy({}, { get: () => async () => null });
            `,
            loader: 'js',
          };
        }
        if (p.includes('DiagnosticsService') || p.includes('SyntheticPeerDiagnostics')) {
          return {
            contents: `
              export const isSyntheticCandidate = () => false;
              export const syntheticPeerDiagnostics = new Proxy({}, { get: () => () => {} });
              export const diagnosticsService = new Proxy({}, { get: () => () => {} });
            `,
            loader: 'js',
          };
        }
        if (p.includes('CallService')) {
          return {
            contents: `
              export const callService = { init() {}, endCall() {}, toggleMute() {}, toggleDeafen() {} };
            `,
            loader: 'js',
          };
        }
        if (p.includes('ScreenCaptureService')) {
          return {
            contents: `
              export const screenCaptureService = {
                addListener() { return () => {}; },
                getState() {
                  return {
                    isCapturing: false,
                    isStarting: false,
                    stream: null,
                    sourceLabel: null,
                    qualityPreset: 'auto',
                    effectiveWidth: 0,
                    effectiveHeight: 0,
                    effectiveFrameRate: 0,
                    qualityFallbackNotice: null,
                    captureNotice: null,
                    displaySurface: null,
                    error: null,
                  };
                },
                isNativeCaptureSupported: () => false,
                async listNativeSources() { return { monitors: [], windows: [] }; },
                async stopNativeCapture() {},
                async startNativeShare() { return null; },
                async stopNativeShare() {},
                async subscribeNativeEvents() { return () => {}; },
                clearError() {},
                stopCapture() {},
              };
            `,
            loader: 'js',
          };
        }
        if (p.includes('UpdateService')) {
          return {
            contents: `
              export const updateService = { async checkForUpdates() { return null; } };
            `,
            loader: 'js',
          };
        }
        const exportedRepoName = p.includes('FriendRepository')
          ? 'friendRepository'
          : p.includes('PresenceRepository')
          ? 'presenceRepository'
          : p.includes('DmRepository')
          ? 'dmRepository'
          : p.includes('ConversationRepository')
          ? 'conversationRepository'
          : p.includes('MessageRepository')
          ? 'messageRepository'
          : 'callHistoryRepository';
        return {
          contents: `
            export const ${exportedRepoName} = {
              setAccountId() {},
              async list() { return []; },
              async getFriends() { return []; },
              async getFriendRequests() { return { incoming: [], outgoing: [] }; },
              async listConversations() { return []; },
              async listCallHistory() { return []; },
            };
          `,
          loader: 'js',
        };
      });
    },
  };
}

test('Phase 6 (Store #1, #3, #4): entrada direta em background, envio em #geral, 2º clique + Voltar ao chat, corrida/troca A->B e timeout', async (t) => {
  const directory = await mkdtemp(path.resolve('node_modules/.nexus-phase6-store-'));
  const harnessKey = '__NEXUS_PHASE6_STORE_HARNESS__';

  try {
    const harness: any = {
      listeners: new Set<any>(),
      gatewayConnected: true,
      throwOnJoin: null,
      joinCalls: [] as Array<{ communityId: string; channelId: string }>,
      leaveCalls: [] as Array<{ communityId: string; channelId: string }>,
      startSessionCalls: [] as any[],
      meshLeaveCalls: 0,
      nextMeshLeaveDeferred: null as ReturnType<typeof createDeferred<void>> | null,
      listMessagesCalls: [] as any[],
      sentMessages: [] as any[],
      messagesByChannel: {
        'ch-text-geral': [
          {
            id: 'msg-1',
            channel_id: 'ch-text-geral',
            community_id: 'comm-1',
            sender_id: 'user-alice',
            author: { id: 'user-alice', username: 'alice', display_name: 'Alice', avatar_url: null },
            reply_to_message_id: null,
            content: 'Mensagem inicial em #geral',
            client_message_id: null,
            attachments: [],
            created_at: '2026-11-15T12:00:00Z',
            edited_at: null,
            deleted_at: null,
            is_mine: false,
          },
        ],
      },
    };
    (globalThis as any)[harnessKey] = harness;

    const result = await build({
      stdin: {
        contents: `export { useAppStore } from './src/stores/useAppStore.ts';`,
        resolveDir: ROOT,
        loader: 'ts',
      },
      bundle: true,
      platform: 'node',
      format: 'esm',
      packages: 'external',
      write: false,
      plugins: [buildIsolatedStorePlugin(harnessKey)],
    });

    const entry = path.join(directory, 'store.mjs');
    await writeFile(entry, result.outputFiles[0].text);
    const { useAppStore } = await import(pathToFileURL(entry).href);

    useAppStore.getState().initWebSocket();
    const listener = Array.from(harness.listeners)[0];
    assert.ok(listener, 'initWebSocket must register a gateway listener');

    const textChannel = {
      id: 'ch-text-geral',
      community_id: 'comm-1',
      category_id: null,
      name: 'geral',
      channel_type: 'text',
      position: 0,
      is_private: false,
      is_read_only: false,
      effective_permissions: '2147483647',
      effective_permissions_flags: ['view_channels', 'send_messages'],
      unread_count: 0,
      overwrites: [],
      created_at: '2026-11-15T12:00:00Z',
      updated_at: '2026-11-15T12:00:00Z',
    };
    const voiceA = {
      id: 'ch-voice-a',
      community_id: 'comm-1',
      category_id: null,
      name: 'Sala Geral',
      channel_type: 'voice',
      position: 1,
      is_private: false,
      is_read_only: false,
      effective_permissions: '2147483647',
      effective_permissions_flags: ['view_channels', 'connect_voice', 'speak_voice', 'stream_screen'],
      unread_count: 0,
      overwrites: [],
      created_at: '2026-11-15T12:00:00Z',
      updated_at: '2026-11-15T12:00:00Z',
    };
    const voiceB = {
      ...voiceA,
      id: 'ch-voice-b',
      name: 'Sala Tática',
      position: 2,
    };
    const community = {
      id: 'comm-1',
      owner_id: 'user-self',
      name: 'Tropa Nexus',
      effective_permissions: '2147483647',
      effective_permissions_flags: ['view_channels', 'send_messages', 'connect_voice', 'speak_voice'],
      unread_count: 0,
      member_count: 2,
      created_at: '2026-11-15T12:00:00Z',
      updated_at: '2026-11-15T12:00:00Z',
    };

    useAppStore.setState({
      isInitialized: true,
      authStatus: 'authenticated',
      authMode: 'authenticated',
      gatewayConnected: true,
      onlineUser: { id: 'user-self', username: 'kelman', displayName: 'Kelman', email: 'k@nexus.local', status: 'online' },
      activeTab: 'communities',
      communities: [community],
      activeCommunityId: 'comm-1',
      communitySnapshot: {
        community,
        categories: [],
        channels: [textChannel, voiceA, voiceB],
        roles: [],
        members: [],
        my_mute: null,
      },
    });

    // Open #geral and populate cache
    await useAppStore.getState().selectCommunityChannel('ch-text-geral');
    assert.equal(useAppStore.getState().activeChannelId, 'ch-text-geral');
    assert.equal(useAppStore.getState().activeTextChannelId, 'ch-text-geral');
    assert.equal(useAppStore.getState().lastTextChannelByCommunity['comm-1'], 'ch-text-geral');
    assert.equal(useAppStore.getState().activeCommunityChannelMessages.length, 1);
    assert.equal(harness.listMessagesCalls.length, 1);

    // 1. Entrada direta em 1 clique permanece em #geral (background) e preserva mensagens
    const joinPromise = useAppStore.getState().joinVoiceChannel('comm-1', 'ch-voice-a');
    assert.equal(useAppStore.getState().voiceRoomState, 'joining');
    assert.equal(useAppStore.getState().activeVoiceChannelId, 'ch-voice-a');
    assert.equal(useAppStore.getState().activeChannelId, 'ch-text-geral');
    assert.equal(useAppStore.getState().activeTextChannelId, 'ch-text-geral');
    assert.equal(useAppStore.getState().activeCommunityChannelMessages.length, 1);
    await joinPromise;
    assert.deepEqual(harness.joinCalls, [{ communityId: 'comm-1', channelId: 'ch-voice-a' }]);

    // Enviar mensagem em #geral enquanto joining
    const sentWhileJoining = await useAppStore.getState().sendChannelMessage('Oi enquanto conecto');
    assert.equal(sentWhileJoining, true);
    assert.equal(useAppStore.getState().activeCommunityChannelMessages.length, 2);

    // Duplo clique em joining não dispara novo sendRoomJoin
    await useAppStore.getState().joinVoiceChannel('comm-1', 'ch-voice-a');
    await useAppStore.getState().joinVoiceChannel('comm-1', 'ch-voice-a');
    assert.equal(harness.joinCalls.length, 1, 'cliques repetidos em joining não podem enviar múltiplos room_join');

    // Gateway confirma entrada em sala A
    listener.onRoomJoined({
      community_id: 'comm-1',
      channel_id: 'ch-voice-a',
      max_participants: 8,
      can_speak: true,
      can_screen_share: true,
      participants: [
        { user_id: 'user-self', username: 'kelman', display_name: 'Kelman', is_muted: false, is_deafened: false, is_speaking: false, is_screen_sharing: false },
        { user_id: 'user-alice', username: 'alice', display_name: 'Alice', is_muted: false, is_deafened: false, is_speaking: true, is_screen_sharing: false },
      ],
    });
    assert.equal(useAppStore.getState().voiceRoomState, 'connected');
    assert.equal(useAppStore.getState().activeChannelId, 'ch-text-geral');
    assert.equal(useAppStore.getState().activeTextChannelId, 'ch-text-geral');
    assert.equal(useAppStore.getState().activeCommunityChannelMessages.length, 2);

    // Duplo clique quando já connected também ignora novo join
    await useAppStore.getState().joinVoiceChannel('comm-1', 'ch-voice-a');
    assert.equal(harness.joinCalls.length, 1);

    // 2. 2º clique abre VoiceRoomPanel mantendo activeTextChannelId e cache do chat
    await useAppStore.getState().selectCommunityChannel('ch-voice-a');
    assert.equal(useAppStore.getState().activeChannelId, 'ch-voice-a');
    assert.equal(useAppStore.getState().activeTextChannelId, 'ch-text-geral');
    assert.equal(harness.listMessagesCalls.length, 1, 'abrir VoiceRoomPanel não pode refazer fetch de mensagens de texto');
    assert.equal(useAppStore.getState().activeCommunityChannelMessages.length, 2);

    // 3. "Voltar ao chat" retorna para #geral sem sair da voz e sem limpar mensagens
    useAppStore.getState().returnToCommunityTextChannel();
    assert.equal(useAppStore.getState().activeChannelId, 'ch-text-geral');
    assert.equal(useAppStore.getState().activeTextChannelId, 'ch-text-geral');
    assert.equal(useAppStore.getState().voiceRoomState, 'connected');
    assert.equal(useAppStore.getState().activeVoiceChannelId, 'ch-voice-a');
    assert.equal(useAppStore.getState().activeCommunityChannelMessages.length, 2);
    assert.equal(harness.listMessagesCalls.length, 1, 'Voltar ao chat preserva cache sem flicker/refetch');
    assert.equal(harness.leaveCalls.length, 0);

    // 4. Troca segura Sala A -> Sala B com leaveRoom assíncrono em trânsito + descarte de eventos obsoletos
    const pendingLeave = createDeferred<void>();
    harness.nextMeshLeaveDeferred = pendingLeave;
    const switchPromise = useAppStore.getState().joinVoiceChannel('comm-1', 'ch-voice-b');

    // Estado imediato reflete nova sala em joining antes do await
    assert.equal(useAppStore.getState().voiceRoomState, 'joining');
    assert.equal(useAppStore.getState().activeVoiceChannelId, 'ch-voice-b');
    assert.equal(useAppStore.getState().voiceRoomParticipants.length, 0);
    assert.deepEqual(harness.leaveCalls, [{ communityId: 'comm-1', channelId: 'ch-voice-a' }]);

    // onRoomJoined atrasado da Sala A durante transição para Sala B deve ser descartado + enviar sendRoomLeave(A)
    listener.onRoomJoined({
      community_id: 'comm-1',
      channel_id: 'ch-voice-a',
      max_participants: 8,
      can_speak: true,
      can_screen_share: true,
      participants: [],
    });
    assert.equal(useAppStore.getState().activeVoiceChannelId, 'ch-voice-b');
    assert.equal(useAppStore.getState().voiceRoomState, 'joining');
    assert.equal(harness.leaveCalls.length, 2);

    pendingLeave.resolve();
    await switchPromise;
    assert.deepEqual(harness.joinCalls.at(-1), { communityId: 'comm-1', channelId: 'ch-voice-b' });

    // onRoomError da Sala A antiga não pode derrubar Sala B nova
    listener.onRoomError({
      community_id: 'comm-1',
      channel_id: 'ch-voice-a',
      message: 'Erro tardio da sala antiga',
    });
    assert.equal(useAppStore.getState().voiceRoomState, 'joining');
    assert.equal(useAppStore.getState().activeVoiceChannelId, 'ch-voice-b');
    assert.equal(useAppStore.getState().voiceRoomError, null);

    // Confirma entrada na Sala B e depois sai + recebe room_joined obsoleto após leaveVoiceChannel
    listener.onRoomJoined({
      community_id: 'comm-1',
      channel_id: 'ch-voice-b',
      max_participants: 8,
      can_speak: true,
      can_screen_share: true,
      participants: [],
    });
    assert.equal(useAppStore.getState().voiceRoomState, 'connected');
    await useAppStore.getState().leaveVoiceChannel();
    assert.equal(useAppStore.getState().voiceRoomState, 'idle');

    listener.onRoomJoined({
      community_id: 'comm-1',
      channel_id: 'ch-voice-b',
      max_participants: 8,
      can_speak: true,
      can_screen_share: true,
      participants: [],
    });
    assert.equal(useAppStore.getState().voiceRoomState, 'idle', 'room_joined após leaveVoiceChannel deve ser descartado');
    assert.deepEqual(harness.leaveCalls.at(-1), { communityId: 'comm-1', channelId: 'ch-voice-b' });

    // 5. Gateway desconectado -> error imediato sem travar em joining
    harness.gatewayConnected = false;
    useAppStore.setState({ gatewayConnected: false });
    const joinCountBeforeOffline = harness.joinCalls.length;
    await useAppStore.getState().joinVoiceChannel('comm-1', 'ch-voice-a');
    assert.equal(useAppStore.getState().voiceRoomState, 'error');
    assert.ok(useAppStore.getState().voiceRoomError?.includes('Sem conexão com o servidor'));
    assert.equal(harness.joinCalls.length, joinCountBeforeOffline);

    // 6. Timeout de entrada (12s) -> error + retry após erro
    harness.gatewayConnected = true;
    useAppStore.setState({ gatewayConnected: true });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    await useAppStore.getState().joinVoiceChannel('comm-1', 'ch-voice-a');
    assert.equal(useAppStore.getState().voiceRoomState, 'joining');
    const joinCountBeforeTimeout = harness.joinCalls.length;

    t.mock.timers.tick(12_000);
    assert.equal(useAppStore.getState().voiceRoomState, 'error');
    assert.equal(
      useAppStore.getState().voiceRoomError,
      'Tempo esgotado ao entrar na sala de voz. Tente novamente.'
    );
    assert.deepEqual(harness.leaveCalls.at(-1), { communityId: 'comm-1', channelId: 'ch-voice-a' });

    // Retry após erro volta a tentar entrar
    await useAppStore.getState().joinVoiceChannel('comm-1', 'ch-voice-a');
    assert.equal(useAppStore.getState().voiceRoomState, 'joining');
    assert.equal(harness.joinCalls.length, joinCountBeforeTimeout + 1);
  } finally {
    delete (globalThis as any)[harnessKey];
    await rm(directory, { recursive: true, force: true });
  }
});

test('Phase 6 (MeshRoomService): leaveRoom cancela startRoomSession em trânsito via sessionRequestSeq', async () => {
  const directory = await mkdtemp(path.resolve('node_modules/.nexus-phase6-mesh-'));
  const prevNav = (globalThis as any).navigator;
  const prevFetch = globalThis.fetch;
  const prevRtc = (globalThis as any).RTCPeerConnection;

  try {
    const iceDeferred = createDeferred<Response>();
    let rtcConstructed = 0;

    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) } },
    });
    globalThis.fetch = (() => iceDeferred.promise) as any;
    (globalThis as any).RTCPeerConnection = class MockRtc {
      constructor() {
        rtcConstructed++;
      }
      close() {}
    };

    const result = await build({
      stdin: {
        contents: `export { meshRoomService } from './src/services/MeshRoomService.ts';`,
        resolveDir: ROOT,
        loader: 'ts',
      },
      bundle: true,
      platform: 'node',
      format: 'esm',
      packages: 'external',
      write: false,
      plugins: [
        {
          name: 'mesh-deps',
          setup(builder) {
            builder.onResolve(
              {
                filter:
                  /(?:AudioDeviceService|ScreenCaptureService|ScreenReceiveDiagnostics|screenReceiverLifecycle|voiceActivity)(?:\.ts)?$/,
              },
              (args) => ({ path: args.path, namespace: 'mesh-stub' })
            );
            builder.onLoad({ filter: /.*/, namespace: 'mesh-stub' }, (args) => {
              if (args.path.includes('AudioDeviceService')) {
                return {
                  contents: `
                    export const audioDeviceService = {
                      getAudioConstraints(base) { return base; },
                      async applyAudioOutput() {},
                      async setAudioSink() {},
                      createVoiceDetector() {
                        return { reset() {}, update() { return false; } };
                      },
                    };
                  `,
                  loader: 'js',
                };
              }
              if (args.path.includes('ScreenCaptureService')) {
                return {
                  contents: `
                    export const screenCaptureService = {
                      isNativeCaptureSupported: () => false,
                      getState: () => ({ isCapturing: false }),
                      stopCapture() {},
                      async stopNativeShare() {},
                      async removeNativeScreenPeer() {},
                      async subscribeNativeEvents() { return () => {}; },
                      async startNativeShare() { return null; },
                      async setNativeScreenQuality() {},
                      async addNativeScreenPeer() { return null; },
                      async handleNativeScreenAnswer() {},
                      async handleNativeScreenIce() {},
                      async setNativeAdaptiveBitrate() {},
                    };
                    export const applyTrackContentHint = () => {};
                  `,
                  loader: 'js',
                };
              }
              if (args.path.includes('ScreenReceiveDiagnostics')) {
                return {
                  contents: `
                    export const startScreenReceiveDiagnostics = () => () => {};
                    export const screenReceiverContext = () => ({});
                    export const logScreenReceiverTermination = () => {};
                  `,
                  loader: 'js',
                };
              }
              if (args.path.includes('screenReceiverLifecycle')) {
                return {
                  contents: `
                    export const detachScreenElements = () => {};
                    export const releaseScreenStream = () => {};
                    export const screenSessionId = () => '';
                    export const screenCandidateSessionId = () => '';
                    export const tagScreenCandidate = (c) => c;
                    export const screenAnswerSessionId = () => '';
                    export const tagScreenAnswer = (a) => a;
                    export const screenCandidateInit = (c) => c;
                  `,
                  loader: 'js',
                };
              }
              return {
                contents: `export const processAnalyserFrame = () => ({ speaking: false, level: 0 });`,
                loader: 'js',
              };
            });
          },
        },
      ],
    });

    const entry = path.join(directory, 'mesh.mjs');
    await writeFile(entry, result.outputFiles[0].text);
    const { meshRoomService } = await import(pathToFileURL(entry).href);

    const startPromise = meshRoomService.startRoomSession({
      selfUserId: 'u-self',
      communityId: 'comm-1',
      channelId: 'ch-voice-a',
      participants: [
        { user_id: 'u-self', username: 'self', display_name: 'Self', is_muted: false, is_deafened: false, is_speaking: false, is_screen_sharing: false },
        { user_id: 'u-peer', username: 'peer', display_name: 'Peer', is_muted: false, is_deafened: false, is_speaking: false, is_screen_sharing: false },
      ],
    });

    // Cancela antes do fetch de ICE resolver
    await meshRoomService.leaveRoom();
    iceDeferred.resolve({ ok: false, json: async () => ({}) } as Response);
    await startPromise;

    assert.equal(rtcConstructed, 0, 'startRoomSession cancelado por leaveRoom não pode abrir RTCPeerConnection tardia');
    assert.equal(meshRoomService.getActiveRoom(), null);
  } finally {
    if (prevNav === undefined) {
      delete (globalThis as any).navigator;
    } else {
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: prevNav });
    }
    globalThis.fetch = prevFetch;
    if (prevRtc === undefined) {
      delete (globalThis as any).RTCPeerConnection;
    } else {
      (globalThis as any).RTCPeerConnection = prevRtc;
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test('Phase 6 (#2): FloatingCallDock cobre joining, connected, reconnecting, error e chamada 1:1', async () => {
  const directory = await mkdtemp(path.resolve('node_modules/.nexus-phase6-dock-'));
  try {
    const result = await build({
      stdin: {
        contents: `
          export { FloatingCallDock } from './src/components/FloatingCallDock.tsx';
          export { useAppStore } from './src/stores/useAppStore';
        `,
        resolveDir: ROOT,
        loader: 'ts',
      },
      bundle: true,
      platform: 'node',
      format: 'esm',
      packages: 'external',
      write: false,
      plugins: [
        {
          name: 'dock-env',
          setup(builder) {
            builder.onResolve({ filter: /stores\/useAppStore(?:\.ts)?$/ }, () => ({ path: 'store', namespace: 'dock' }));
            builder.onResolve({ filter: /services\/CallService(?:\.ts)?$/ }, () => ({ path: 'call', namespace: 'dock' }));
            builder.onResolve({ filter: /services\/ScreenCaptureService(?:\.ts)?$/ }, () => ({ path: 'screen', namespace: 'dock' }));
            builder.onResolve({ filter: /\.\/ScreenSourcePickerModal(?:\.tsx)?$/ }, () => ({ path: 'picker', namespace: 'dock' }));
            builder.onLoad({ filter: /.*/, namespace: 'dock' }, (args) => {
              if (args.path === 'store') {
                return {
                  contents: `
                    let state;
                    export const useAppStore = (sel) => sel(state);
                    useAppStore.setTestState = (next) => { state = next; };
                    useAppStore.getState = () => state;
                  `,
                  loader: 'js',
                };
              }
              if (args.path === 'call') return { contents: 'export const callService = { toggleMute(){}, toggleDeafen(){}, endCall(){} };', loader: 'js' };
              if (args.path === 'screen') return { contents: 'export const screenCaptureService = { isNativeCaptureSupported: () => false };', loader: 'js' };
              return { contents: 'export const ScreenSourcePickerModal = () => null;', loader: 'js' };
            });
          },
        },
      ],
    });

    const entry = path.join(directory, 'dock.mjs');
    await writeFile(entry, result.outputFiles[0].text);
    const { FloatingCallDock, useAppStore } = await import(pathToFileURL(entry).href);

    const baseState: any = {
      activeTab: 'communities',
      setActiveTab() {},
      activeCommunityId: 'comm-1',
      activeChannelId: 'ch-text-1',
      selectCommunity: async () => {},
      selectCommunityChannel: async () => {},
      communities: [{ id: 'comm-1', name: 'Tropa QA' }],
      communitySnapshot: {
        community: { id: 'comm-1', name: 'Tropa QA' },
        channels: [
          { id: 'ch-text-1', name: 'geral', channel_type: 'text' },
          { id: 'ch-voice-1', name: 'Sala Principal', channel_type: 'voice' },
        ],
        members: [],
      },
      currentUser: { id: 'me', username: 'kel', displayName: 'Kelman', avatarUrl: null },
      onlineUser: { id: 'me', username: 'kel', displayName: 'Kelman', avatarUrl: null },
      voiceRoomState: 'joining',
      activeVoiceCommunityId: 'comm-1',
      activeVoiceChannelId: 'ch-voice-1',
      voiceRoomParticipants: [],
      communityVoiceRooms: {},
      voiceRoomMuted: false,
      voiceRoomDeafened: false,
      voiceRoomScreenSharing: false,
      voiceRoomCanSpeak: true,
      voiceRoomCanScreenShare: true,
      voiceRoomQuality: 'auto',
      voiceRoomMetrics: null,
      voiceRoomError: null,
      nativeCaptureStatus: null,
      joinVoiceChannel: async () => {},
      leaveVoiceChannel: async () => {},
      toggleVoiceRoomMute() {},
      toggleVoiceRoomDeafen() {},
      startVoiceRoomScreenShare: async () => {},
      stopVoiceRoomScreenShare: async () => {},
      voiceCallState: 'idle',
      activeCallPeer: null,
      isMicMuted: false,
      isDeafened: false,
      isLocalSpeaking: false,
      isRemoteSpeaking: false,
      isScreenSharing: false,
      isRemoteScreenSharing: false,
      reconnectAttempt: 0,
      maxReconnectAttempts: 3,
      callDurationSecs: 42,
      screenPickerTarget: null,
      openScreenSourcePicker: async () => {},
      closeScreenSourcePicker() {},
    };

    // 1. joining em segundo plano mostra Abrir Sala
    useAppStore.setTestState({ ...baseState, voiceRoomState: 'joining' });
    const joiningHtml = renderToStaticMarkup(React.createElement(FloatingCallDock));
    assert.ok(joiningHtml.includes('Conectando à sala...'));
    assert.ok(joiningHtml.includes('data-testid="dock-open-room-btn"'));
    assert.ok(joiningHtml.includes('Abrir Sala'));

    // 2. connected em outra canal/aba mostra contagem e Abrir Sala
    useAppStore.setTestState({
      ...baseState,
      voiceRoomState: 'connected',
      voiceRoomParticipants: [
        { user_id: 'me', username: 'kel', display_name: 'Kelman', is_muted: false, is_deafened: false, is_speaking: false, is_screen_sharing: false },
        { user_id: 'u2', username: 'ana', display_name: 'Ana', is_muted: false, is_deafened: false, is_speaking: false, is_screen_sharing: false },
      ],
    });
    const connectedBgHtml = renderToStaticMarkup(React.createElement(FloatingCallDock));
    assert.ok(connectedBgHtml.includes('Conectado • 2 em Voz'));
    assert.ok(connectedBgHtml.includes('data-testid="dock-open-room-btn"'));

    // Quando visualizando a própria sala, oculta Abrir Sala
    useAppStore.setTestState({ ...useAppStore.getState(), activeChannelId: 'ch-voice-1' });
    const viewingRoomHtml = renderToStaticMarkup(React.createElement(FloatingCallDock));
    assert.equal(viewingRoomHtml.includes('data-testid="dock-open-room-btn"'), false);

    // 3. reconnecting
    useAppStore.setTestState({ ...useAppStore.getState(), activeChannelId: 'ch-text-1', voiceRoomState: 'reconnecting' });
    const reconnHtml = renderToStaticMarkup(React.createElement(FloatingCallDock));
    assert.ok(reconnHtml.includes('Reconectando...'));

    // 4. error exibe Tentar novamente e Dispensar
    useAppStore.setTestState({
      ...useAppStore.getState(),
      voiceRoomState: 'error',
      voiceRoomError: 'Tempo esgotado ao entrar na sala de voz. Tente novamente.',
    });
    const errHtml = renderToStaticMarkup(React.createElement(FloatingCallDock));
    assert.ok(errHtml.includes('Tempo esgotado ao entrar na sala de voz.'));
    assert.ok(errHtml.includes('aria-label="Tentar novamente"'));
    assert.ok(errHtml.includes('Tentar novamente'));
    assert.ok(errHtml.includes('aria-label="Dispensar"'));
    assert.ok(errHtml.includes('Dispensar'));

    // 5. Chamada 1:1 preservada
    useAppStore.setTestState({
      ...baseState,
      voiceRoomState: 'idle',
      activeVoiceCommunityId: null,
      activeVoiceChannelId: null,
      voiceCallState: 'connected',
      activeCallPeer: { id: 'p2', name: 'Alice Costa', avatarUrl: null },
      activeTab: 'messages',
    });
    const call11Html = renderToStaticMarkup(React.createElement(FloatingCallDock));
    assert.ok(call11Html.includes('Alice Costa'));
    assert.ok(call11Html.includes('aria-label="Abrir tela da chamada"'));
    assert.ok(call11Html.includes('aria-label="Encerrar chamada"'));
    assert.equal(call11Html.includes('data-testid="dock-open-room-btn"'), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Phase 6 (#7): VoiceRoomPanel + VoiceParticipantCard validam layoutMode 1/2/4/6, VAD real, zero controles duplicados, sem NaN, 2 streams e Modo Foco', async () => {
  const directory = await mkdtemp(path.resolve('node_modules/.nexus-phase6-panel-'));
  try {
    const result = await build({
      stdin: {
        contents: `
          export { VoiceRoomPanel } from './src/features/communities/VoiceRoomPanel.tsx';
          export { VoiceParticipantCard } from './src/components/VoiceParticipantCard.tsx';
          export { useAppStore } from './src/stores/useAppStore';
        `,
        resolveDir: ROOT,
        loader: 'ts',
      },
      bundle: true,
      platform: 'node',
      format: 'esm',
      packages: 'external',
      write: false,
      plugins: [
        {
          name: 'panel-env',
          setup(builder) {
            builder.onResolve({ filter: /stores\/useAppStore$/ }, () => ({ path: 'store', namespace: 'panel' }));
            builder.onResolve({ filter: /services\/ScreenPlayback$/ }, () => ({ path: 'playback', namespace: 'panel' }));
            builder.onResolve({ filter: /services\/MeshRoomService$/ }, () => ({ path: 'mesh', namespace: 'panel' }));
            builder.onResolve({ filter: /components\/ScreenSourcePickerModal$/ }, () => ({ path: 'picker', namespace: 'panel' }));
            builder.onLoad({ filter: /.*/, namespace: 'panel' }, (args) => {
              if (args.path === 'store') {
                return {
                  contents: `
                    let state;
                    export const useAppStore = (sel) => sel(state);
                    useAppStore.setTestState = (next) => { state = next; };
                    useAppStore.getState = () => state;
                    useAppStore.setState = (partial) => { state = { ...state, ...partial }; };
                  `,
                  loader: 'js',
                };
              }
              if (args.path === 'playback') {
                return { contents: 'export const bindScreenPlayback = () => () => {}; export const updateScreenPlaybackAudio = () => {};', loader: 'js' };
              }
              if (args.path === 'mesh') {
                return { contents: 'export const meshRoomService = { retryRemoteScreen: () => true };', loader: 'js' };
              }
              return {
                contents: `
                  export const NativeLocalScreenPreview = () => null;
                  export const NativeScreenShareBanner = () => null;
                  export const ScreenSourcePickerModal = () => null;
                `,
                loader: 'js',
              };
            });
          },
        },
      ],
    });

    const entry = path.join(directory, 'panel.mjs');
    await writeFile(entry, result.outputFiles[0].text);
    const { VoiceRoomPanel, VoiceParticipantCard, useAppStore } = await import(pathToFileURL(entry).href);

    const makeParticipant = (idx: number, opts: Partial<any> = {}) => ({
      user_id: idx === 0 ? 'me' : `u-${idx}`,
      username: `user${idx}`,
      display_name: idx === 0 ? 'Kelman' : `Participante ${idx}`,
      avatar_url: null,
      is_muted: false,
      is_deafened: false,
      is_speaking: false,
      is_screen_sharing: false,
      can_speak: true,
      can_screen_share: true,
      ...opts,
    });

    const channel = {
      id: 'ch-voice-1',
      community_id: 'comm-1',
      category_id: null,
      name: 'Sala Geral',
      channel_type: 'voice',
      position: 1,
      is_private: false,
      is_read_only: false,
      effective_permissions: '2147483647',
      effective_permissions_flags: ['view_channels', 'connect_voice', 'speak_voice', 'stream_screen'],
      unread_count: 0,
      overwrites: [],
      created_at: '2026-11-15T12:00:00Z',
      updated_at: '2026-11-15T12:00:00Z',
    };

    const basePanelState: any = {
      voiceRoomState: 'connected',
      activeVoiceCommunityId: 'comm-1',
      activeVoiceChannelId: 'ch-voice-1',
      voiceRoomMaxParticipants: 8,
      voiceRoomCanSpeak: true,
      voiceRoomParticipants: [makeParticipant(0)],
      voiceRoomDeafened: false,
      voiceRoomQuality: 'auto',
      voiceRoomPeerStatuses: {},
      voiceRoomRemoteStreams: {},
      voiceRoomParticipantVolumes: {},
      voiceRoomMetrics: {
        avgRttMs: Number.NaN,
        totalBitrateKbps: Number.POSITIVE_INFINITY,
        totalReceiveBitrateKbps: -1,
        peers: { 'u-1': { rttMs: 28, bitrateKbps: 1200, packetLossPct: 0 } },
      },
      voiceRoomScreenReceivers: {},
      retryVoiceRoomScreen: () => true,
      voiceRoomError: null,
      communityVoiceRooms: {},
      onlineUser: { id: 'me', username: 'kelman', displayName: 'Kelman' },
      currentUser: { id: 'me', username: 'kelman', displayName: 'Kelman' },
      activeTextChannelId: 'ch-text-1',
      communitySnapshot: {
        community: { id: 'comm-1', name: 'Tropa' },
        channels: [
          { id: 'ch-text-1', name: 'geral', channel_type: 'text' },
          channel,
        ],
        members: [],
      },
      preferredVoiceStreamPeerId: null,
      setPreferredVoiceStreamPeerId() {},
      returnToCommunityTextChannel() {},
      joinVoiceChannel: async () => {},
      setVoiceRoomParticipantVolume() {},
      setVoiceRoomQuality() {},
      clearVoiceRoomError() {},
      screenPickerTarget: null,
      nativeCaptureStatus: null,
      nativeScreenStats: null,
    };

    const renderWithCount = (count: number) => {
      const participants = Array.from({ length: count }, (_, idx) => makeParticipant(idx));
      useAppStore.setTestState({ ...basePanelState, voiceRoomParticipants: participants });
      return renderToStaticMarkup(
        React.createElement(VoiceRoomPanel, { communityId: 'comm-1', channel: channel as any })
      );
    };

    // Layouts 1, 2, 4, 6 + zero NaN/Infinity + sem controles duplicados
    const html1 = renderWithCount(1);
    assert.ok(html1.includes('data-layout-mode="single"'));
    assert.ok(html1.includes('data-participant-count="1"'));
    assert.ok(html1.includes('my-auto w-full flex flex-col justify-center'));
    assert.ok(html1.includes('pb-24 sm:pb-28'));
    assert.ok(html1.includes('Microfone ativo'));
    assert.ok(html1.includes('data-testid="voice-room-back-to-chat"'));
    assert.ok(html1.includes('Voltar ao chat'));
    assert.equal(html1.includes('NaN'), false);
    assert.equal(html1.includes('Infinity'), false);
    assert.equal(html1.includes('Sair da sala de voz'), false, 'VoiceRoomPanel não deve duplicar botão Sair do dock');
    assert.equal(html1.includes('Silenciar microfone'), false, 'VoiceRoomPanel não deve duplicar controle de mic do dock');
    assert.equal(html1.includes('Ensurdecer áudio'), false, 'VoiceRoomPanel não deve duplicar controle de ensurdecer do dock');

    const html2 = renderWithCount(2);
    assert.ok(html2.includes('data-layout-mode="pair"'));
    assert.ok(html2.includes('data-participant-count="2"'));
    assert.ok(html2.includes('max-w-[780px]'));

    const html4 = renderWithCount(4);
    assert.ok(html4.includes('data-layout-mode="quad"'));
    assert.ok(html4.includes('data-participant-count="4"'));
    assert.ok(html4.includes('max-w-[860px]'));

    const html6 = renderWithCount(6);
    assert.ok(html6.includes('data-layout-mode="multi"'));
    assert.ok(html6.includes('data-participant-count="6"'));
    assert.ok(html6.includes('max-w-[1120px]'));

    // VAD real em VoiceParticipantCard + ausência de animate-pulse (Fase 6.1) + rodapé simétrico no card próprio
    const speakingHtml = renderToStaticMarkup(
      React.createElement(VoiceParticipantCard, {
        participant: makeParticipant(1, { is_speaking: true, is_muted: false }),
        layoutMode: 'pair',
      })
    );
    assert.ok(speakingHtml.includes('data-speaking="true"'));
    assert.ok(speakingHtml.includes('data-layout-mode="pair"'));
    assert.ok(speakingHtml.includes('Falando'));
    assert.equal(speakingHtml.includes('animate-pulse'), false, 'Anel/borda de fala não deve usar animate-pulse');

    const selfDeafenedHtml = renderToStaticMarkup(
      React.createElement(VoiceParticipantCard, {
        participant: makeParticipant(0, { is_deafened: true, is_muted: true, is_screen_sharing: true }),
        isSelf: true,
        layoutMode: 'quad',
      })
    );
    assert.ok(selfDeafenedHtml.includes('Áudio ensurdecido'));
    assert.ok(selfDeafenedHtml.includes('Transmitindo tela'));
    assert.ok(selfDeafenedHtml.includes('Você'));

    const mutedSpeakingHtml = renderToStaticMarkup(
      React.createElement(VoiceParticipantCard, {
        participant: makeParticipant(1, { is_speaking: true, is_muted: true }),
      })
    );
    assert.ok(mutedSpeakingHtml.includes('data-speaking="false"'));
    assert.equal(mutedSpeakingHtml.includes('Falando'), false);

    // Palco + 2 streams ("Recebendo" vs "Disponível"), object-contain, preferredVoiceStreamPeerId e stream-focus-toggle
    const fakeStream = { getVideoTracks: () => [{}], getAudioTracks: () => [] };
    useAppStore.setTestState({
      ...basePanelState,
      voiceRoomParticipants: [
        makeParticipant(0),
        makeParticipant(1, { display_name: 'Alice Stream', is_screen_sharing: true }),
        makeParticipant(2, { display_name: 'Bruno Stream', is_screen_sharing: true }),
      ],
      voiceRoomRemoteStreams: { 'u-1': fakeStream },
      voiceRoomScreenReceivers: { 'u-2': 'connecting' },
      preferredVoiceStreamPeerId: null,
    });
    const twoStreamsHtml = renderToStaticMarkup(
      React.createElement(VoiceRoomPanel, { communityId: 'comm-1', channel: channel as any })
    );
    assert.ok(twoStreamsHtml.includes('data-testid="voice-room-stream-stage"'));
    assert.ok(twoStreamsHtml.includes('data-focus-mode="false"'));
    assert.ok(twoStreamsHtml.includes('object-contain bg-[#06070a]'));
    assert.ok(twoStreamsHtml.includes('data-testid="stream-selector-bar"'));
    assert.ok(twoStreamsHtml.includes('Transmissões (2):'));
    assert.ok(twoStreamsHtml.includes('Recebendo'));
    assert.ok(twoStreamsHtml.includes('Disponível'));
    assert.ok(twoStreamsHtml.includes('data-testid="stream-focus-toggle"'));
    assert.ok(twoStreamsHtml.includes('Focar transmissão'));

    // Com preferredVoiceStreamPeerId apontando para u-2 (ainda conectando), palco foca Bruno Stream sem duplicar streams
    useAppStore.setTestState({
      ...useAppStore.getState(),
      preferredVoiceStreamPeerId: 'u-2',
    });
    const preferredStreamHtml = renderToStaticMarkup(
      React.createElement(VoiceRoomPanel, { communityId: 'comm-1', channel: channel as any })
    );
    assert.ok(preferredStreamHtml.includes('Conectando à transmissão...'));
    assert.ok(preferredStreamHtml.includes('Bruno Stream'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Phase 6 (#5, #6, #7 contratos): botão nativo para teclado, Assistir em ActiveStreamCard/NowLiveCard e Escape no Modo Foco', async () => {
  const directory = await mkdtemp(path.resolve('node_modules/.nexus-phase6-cards-'));
  try {
    const result = await build({
      stdin: {
        contents: `
          export { ActiveStreamCard } from './src/components/ActiveStreamCard.tsx';
          export { CommunityContextPanel } from './src/features/communities/CommunityContextPanel.tsx';
        `,
        resolveDir: ROOT,
        loader: 'ts',
      },
      bundle: true,
      platform: 'node',
      format: 'esm',
      packages: 'external',
      write: false,
    });

    const entry = path.join(directory, 'cards.mjs');
    await writeFile(entry, result.outputFiles[0].text);
    const { ActiveStreamCard, CommunityContextPanel } = await import(pathToFileURL(entry).href);

    const activeCardHtml = renderToStaticMarkup(
      React.createElement(ActiveStreamCard, {
        streamerName: 'Alice Costa',
        streamerUserId: 'u-alice',
        voiceChannelId: 'ch-voice-1',
        voiceChannelName: 'Sala Geral',
        isWatching: false,
        onWatch() {},
      })
    );
    assert.ok(activeCardHtml.includes('<button type="button"'));
    assert.ok(activeCardHtml.includes('Assistir'));

    const contextPanelHtml = renderToStaticMarkup(
      React.createElement(CommunityContextPanel, {
        selectedChannel: { id: 'ch-text-1', name: 'geral', channel_type: 'text' } as any,
        voiceChannels: [],
        activeStreams: [
          {
            key: 'ch-voice-1:u-alice',
            streamerUserId: 'u-alice',
            streamerName: 'Alice Costa',
            voiceChannelId: 'ch-voice-1',
            voiceChannelName: 'Sala Geral',
          },
        ],
        members: [],
        currentUserId: 'me',
        onSelectChannel() {},
        onWatchStream() {},
      })
    );
    assert.ok(contextPanelHtml.includes('Ao Vivo Agora'));
    assert.ok(contextPanelHtml.includes('Assistir'));

    const voiceContextPanelHtml = renderToStaticMarkup(
      React.createElement(CommunityContextPanel, {
        selectedChannel: { id: 'ch-voice-1', name: 'Sala Geral', channel_type: 'voice' } as any,
        voiceChannels: [
          {
            channel: { id: 'ch-voice-1', name: 'Sala Geral', channel_type: 'voice' } as any,
            participants: [],
            isConnectedHere: true,
          },
        ],
        activeStreams: [
          {
            key: 'ch-voice-1:u-alice',
            streamerUserId: 'u-alice',
            streamerName: 'Alice Costa',
            voiceChannelId: 'ch-voice-1',
            voiceChannelName: 'Sala Geral',
          },
          {
            key: 'ch-voice-2:u-bruno',
            streamerUserId: 'u-bruno',
            streamerName: 'Bruno Silva',
            voiceChannelId: 'ch-voice-2',
            voiceChannelName: 'Sala Arena',
          },
        ],
        members: [],
        currentUserId: 'me',
        onSelectChannel() {},
        onWatchStream() {},
      })
    );
    assert.ok(voiceContextPanelHtml.includes('Sala de Voz Atual — Sala Geral'));
    assert.ok(voiceContextPanelHtml.includes('Transmissões Ativas'));
    assert.ok(voiceContextPanelHtml.includes('Visualizando sala'));
    assert.ok(voiceContextPanelHtml.includes('Assistir'));

    const communitiesSrc = await readSrc('src/features/communities/CommunitiesView.tsx');
    assert.ok(communitiesSrc.includes('const handleWatchStream = (voiceChannelId: string, streamerUserId?: string) =>'));
    assert.ok(communitiesSrc.includes('setPreferredVoiceStreamPeerId(streamerUserId ?? null);'));
    assert.ok(communitiesSrc.includes('handleVoiceChannelClick(target, true);'));
    assert.ok(communitiesSrc.includes('data-testid={isVoice ? `voice-channel-btn-${ch.id}` : `text-channel-btn-${ch.id}`}'));
    assert.ok(communitiesSrc.includes('<button\n            type="button"\n            onClick={() => handleVoiceChannelClick(ch)}') ||
      communitiesSrc.includes('type="button"') && communitiesSrc.includes('onClick={() => handleVoiceChannelClick(ch)}'));
    assert.ok(communitiesSrc.includes('aria-label={isVoice ? voiceButtonActionLabel :'));

    const panelSrc = await readSrc('src/features/communities/VoiceRoomPanel.tsx');
    assert.ok(panelSrc.includes("event.key === 'Escape'"));
    assert.ok(panelSrc.includes('setFocusMode(false)'));
    assert.ok(panelSrc.includes('Restaurar layout'));
    assert.ok(panelSrc.includes('Focar transmissão'));
    assert.ok(panelSrc.includes('object-contain bg-[#06070a]'));
    assert.ok(panelSrc.includes("pb-24 sm:pb-28"));
    assert.ok(panelSrc.includes("my-auto w-full flex flex-col justify-center"));
    assert.ok(panelSrc.includes("layoutMode={!hasActiveStreamStage ? layoutMode : undefined}"));
    assert.ok(panelSrc.includes('xl:grid-cols-3 2xl:grid-cols-4 auto-rows-fr'));
    assert.ok(panelSrc.includes("min-w-0 shrink-0"));
    assert.ok(panelSrc.includes("'space-y-3 min-w-0 shrink-0'"));

    const cardSrc = await readSrc('src/components/VoiceParticipantCard.tsx');
    assert.ok(cardSrc.includes('data-layout-mode={layoutMode}'));
    assert.ok(cardSrc.includes('!compact && isSelf'));
    assert.equal(cardSrc.includes('animate-pulse'), false, 'VoiceParticipantCard não deve conter animate-pulse');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
