import {
  Friend,
  FriendRequest,
  UserStatus,
  GatewayEvent,
  DirectMessageDto,
  ChannelMessageDto,
  CommunityCategoryDto,
  CommunityChannelDto,
  CommunityDto,
  CommunityMemberDto,
  CommunityRoleDto,
  RoomParticipantDto,
  StreamKind,
} from '../lib/types';

function parseStreamKind(raw: unknown): StreamKind | undefined {
  return raw === 'screen' || raw === 'voice' ? raw : undefined;
}

export type GatewayEventListener = {
  onConnectionReady?: (data: { userId: string; friends: Friend[] }) => void;
  onPresenceUpdated?: (update: {
    userId: string;
    status: UserStatus;
    customStatus?: string;
    activity?: string;
    lastSeenAt?: string;
  }) => void;
  onFriendRequestReceived?: (request: FriendRequest) => void;
  onFriendRequestAccepted?: (friend: Friend) => void;
  onFriendRequestRejected?: (requestId: string) => void;
  onFriendRemoved?: (friendId: string) => void;
  onFriendBlocked?: (userId: string) => void;
  onDmMessageCreated?: (message: DirectMessageDto) => void;
  onDmMessageUpdated?: (message: DirectMessageDto) => void;
  onDmMessageDeleted?: (data: { id: string; conversation_id: string; deleted_at: string }) => void;
  onDmMessageDelivered?: (data: { conversation_id: string; message_ids: string[]; delivered_at: string }) => void;
  onDmMessageRead?: (data: {
    conversation_id: string;
    reader_id: string;
    message_ids: string[];
    last_read_message_id?: string;
    read_at: string;
  }) => void;
  onDmConversationUpdated?: (data: { conversation_id: string; last_message: DirectMessageDto }) => void;
  onConnectionChange?: (connected: boolean) => void;
  onReconnected?: () => void;
  // Voice Calls (Phase 2.4)
  onCallRinging?: (data: { callId: string; calleeId?: string }) => void;
  onCallIncoming?: (data: {
    callId: string;
    caller: {
      id: string;
      username: string;
      displayName?: string;
      avatarUrl?: string;
    };
  }) => void;
  onCallAccepted?: (data: { callId: string; peerId: string }) => void;
  onCallAcceptedByUser?: (data: { callId: string }) => void;
  onCallRejected?: (data: { callId: string; reason: string }) => void;
  onCallCanceled?: (data: { callId: string }) => void;
  onCallEnded?: (data: { callId: string; reason: string }) => void;
  onCallParticipantMuted?: (data: { callId: string; userId: string; isMuted: boolean }) => void;
  onCallScreenStopped?: (data: { callId: string; senderId: string; shareId: string }) => void;
  onCallWebrtcOffer?: (data: { callId: string; senderId: string; sdp: string; stream_kind?: StreamKind }) => void;
  onCallWebrtcAnswer?: (data: { callId: string; senderId: string; sdp: string; stream_kind?: StreamKind }) => void;
  onCallWebrtcIceCandidate?: (data: { callId: string; senderId: string; candidate: any; stream_kind?: StreamKind }) => void;
  onCallError?: (data: { message: string }) => void;
  // Communities (Phase B3.1)
  onCommunityMessageCreated?: (message: ChannelMessageDto) => void;
  onCommunityMessageUpdated?: (message: ChannelMessageDto) => void;
  onCommunityMessageDeleted?: (data: {
    id: string;
    channel_id: string;
    community_id?: string;
    deleted_at?: string;
  }) => void;
  onCommunityChannelCreated?: (channel: CommunityChannelDto) => void;
  onCommunityChannelUpdated?: (channel: CommunityChannelDto) => void;
  onCommunityChannelDeleted?: (data: { id: string; community_id: string }) => void;
  onCommunityCategoryUpdated?: (data: {
    community_id: string;
    category?: CommunityCategoryDto;
    category_id?: string;
    action?: string;
  }) => void;
  onCommunityMemberJoined?: (data: { community_id: string; member?: CommunityMemberDto }) => void;
  onCommunityMemberLeft?: (data: { community_id: string; user_id: string }) => void;
  onCommunityMemberUpdated?: (data: {
    community_id: string;
    member?: CommunityMemberDto;
    user_id?: string;
  }) => void;
  onCommunityRoleUpdated?: (data: {
    community_id: string;
    role?: CommunityRoleDto;
    role_id?: string;
    action?: string;
  }) => void;
  onCommunityUpdated?: (community: CommunityDto) => void;
  onCommunityDeleted?: (data: { community_id: string }) => void;
  onCommunityAccessRevoked?: (data: {
    community_id: string;
    channel_id?: string | null;
    reason?: string;
  }) => void;
  // Voice Rooms (Phase B3.2)
  onRoomJoined?: (data: {
    community_id: string;
    channel_id: string;
    max_participants: number;
    participants: RoomParticipantDto[];
    can_speak: boolean;
    can_screen_share: boolean;
  }) => void;
  onRoomLeft?: (data: {
    community_id: string;
    channel_id: string;
    reason?: string | null;
  }) => void;
  onRoomParticipantJoined?: (data: {
    community_id: string;
    channel_id: string;
    participant: RoomParticipantDto;
  }) => void;
  onRoomParticipantLeft?: (data: {
    community_id: string;
    channel_id: string;
    user_id: string;
  }) => void;
  onRoomParticipantUpdated?: (data: {
    community_id: string;
    channel_id: string;
    participant: RoomParticipantDto;
  }) => void;
  onCommunityVoiceStateUpdated?: (data: {
    community_id: string;
    channel_id: string;
    participants: RoomParticipantDto[];
  }) => void;
  onRoomWebrtcOffer?: (data: {
    community_id: string;
    channel_id: string;
    sender_id: string;
    sdp: string;
    stream_kind?: StreamKind;
  }) => void;
  onRoomWebrtcAnswer?: (data: {
    community_id: string;
    channel_id: string;
    sender_id: string;
    sdp: string;
    stream_kind?: StreamKind;
  }) => void;
  onRoomWebrtcIceCandidate?: (data: {
    community_id: string;
    channel_id: string;
    sender_id: string;
    candidate: any;
    stream_kind?: StreamKind;
  }) => void;
  onRoomError?: (data: {
    community_id?: string | null;
    channel_id?: string | null;
    message: string;
  }) => void;
};

export class GatewayClient {
  private socket: WebSocket | null = null;
  private listeners: GatewayEventListener[] = [];
  private reconnectTimeout: any = null;
  private pingInterval: any = null;
  private isExplicitlyClosed = false;
  private isConnecting = false;
  private connectGeneration = 0;
  private reconnectAttempts = 0;
  private maxReconnectDelay = 15000;
  private hasConnectedBefore = false;

  addListener(listener: GatewayEventListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  async connect(): Promise<void> {
    if (
      this.isConnecting ||
      (this.socket &&
        (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING))
    ) {
      console.log('[GatewayClient] Socket já conectado ou em processo de conexão. Ignorando chamada redundante.');
      return;
    }

    this.disconnect();
    this.isExplicitlyClosed = false;
    this.isConnecting = true;
    const currentGen = ++this.connectGeneration;

    try {
      const isTauriRuntime =
        typeof window !== 'undefined' && Boolean((window as any).__TAURI_INTERNALS__);
      const testWsUrl =
        !isTauriRuntime && typeof localStorage !== 'undefined'
          ? localStorage.getItem('nexus_test_ws_url')
          : null;
      const testToken =
        !isTauriRuntime && typeof localStorage !== 'undefined'
          ? localStorage.getItem('nexus_test_token')
          : null;
      const useBrowserTestWs = Boolean(!isTauriRuntime && testWsUrl && testToken);

      const tauriCore = useBrowserTestWs ? null : await import('@tauri-apps/api/core');
      const wsUrl = useBrowserTestWs
        ? (testWsUrl as string)
        : await tauriCore!.invoke<string>('gateway_get_ws_url');

      if (currentGen !== this.connectGeneration || this.isExplicitlyClosed) {
        this.isConnecting = false;
        return;
      }

      console.log('[GatewayClient] Conectando ao Gateway NEXUS em:', wsUrl);
      const sock = new WebSocket(wsUrl);
      this.socket = sock;
      this.isConnecting = false;

      sock.onopen = async () => {
        if (this.socket !== sock || currentGen !== this.connectGeneration || this.isExplicitlyClosed) {
          try {
            sock.close();
          } catch {}
          return;
        }
        try {
          if (useBrowserTestWs) {
            if (sock.readyState === WebSocket.OPEN) {
              sock.send(JSON.stringify({ op: 'authenticate', token: testToken }));
            }
          } else {
            console.log('[GatewayClient] Socket aberto. Solicitando ticket efêmero para autenticação...');
            // Request ephemeral single-use 60s ticket from Rust backend (never expose persistent token to WebView)
            const ticket = await tauriCore!.invoke<string>('gateway_get_ticket');

            if (this.socket !== sock || currentGen !== this.connectGeneration || this.isExplicitlyClosed) {
              try {
                sock.close();
              } catch {}
              return;
            }

            if (sock.readyState === WebSocket.OPEN) {
              sock.send(JSON.stringify({ op: 'authenticate', ticket }));
            }
          }
        } catch (authErr: any) {
          const errStr = String(authErr?.message || authErr || '');
          console.warn('[GatewayClient] Falha ao obter ticket efêmero do Gateway:', errStr);
          if (errStr.includes('Sessão expirada') || errStr.includes('Nenhuma sessão')) {
            this.disconnect();
          } else {
            try {
              sock.close();
            } catch {}
          }
          return;
        }

        this.startHeartbeat();
      };

      sock.onmessage = (event) => {
        if (this.socket !== sock) return;
        try {
          const data: GatewayEvent = JSON.parse(event.data);
          this.handleGatewayEvent(data);
        } catch (err) {
          console.warn('[GatewayClient] Falha ao analisar frame recebido:', err);
        }
      };

      sock.onerror = (err) => {
        if (this.socket !== sock) return;
        console.warn('[GatewayClient] Evento de erro no socket:', err);
      };

      sock.onclose = (event) => {
        if (this.socket !== sock) return;
        console.log(`[GatewayClient] Conexão encerrada (código ${event.code}).`);
        this.stopHeartbeat();
        this.notifyConnectionChange(false);
        this.socket = null;

        if (!this.isExplicitlyClosed) {
          this.scheduleReconnect();
        }
      };
    } catch (err) {
      this.isConnecting = false;
      console.warn('[GatewayClient] Erro ao inicializar conexão do Gateway:', err);
      this.scheduleReconnect();
    }
  }

  private handleGatewayEvent(event: GatewayEvent) {
    const { type, payload } = event;

    switch (type) {
      case 'connection.ready':
      case 'connected':
        if (this.hasConnectedBefore) {
          console.log('[GatewayClient] Reconexão autenticada. Solicitando ressincronização autoritativa via REST...');
          this.listeners.forEach((l) => l.onReconnected?.());
        }
        this.hasConnectedBefore = true;
        this.reconnectAttempts = 0;
        this.notifyConnectionChange(true);

        if (Array.isArray(payload?.friends)) {
          const friends: Friend[] = payload.friends.map((f: any) => ({
            id: f.id,
            name: f.display_name || f.username,
            username: f.username,
            tag: f.tag,
            avatarUrl: f.avatar_url,
            status: (f.status as UserStatus) || 'offline',
            customStatus: f.custom_status,
            activity: f.activity,
            lastSeenAt: f.last_seen_at,
          }));
          this.listeners.forEach((l) =>
            l.onConnectionReady?.({
              userId: payload.user_id,
              friends,
            })
          );
        }
        break;

      case 'presence.updated':
      case 'presence_update':
        if (payload?.user_id) {
          this.listeners.forEach((l) =>
            l.onPresenceUpdated?.({
              userId: payload.user_id,
              status: (payload.status as UserStatus) || 'offline',
              customStatus: payload.custom_status,
              activity: payload.activity,
              lastSeenAt: payload.last_seen_at,
            })
          );
        }
        break;

      case 'friend.request.received':
      case 'friend_request_received':
        if (payload?.request) {
          const r = payload.request;
          const req: FriendRequest = {
            id: r.id,
            userId: r.user_id,
            username: r.username,
            tag: r.tag,
            displayName: r.display_name,
            avatarUrl: r.avatar_url,
            status: r.status,
            createdAt: r.created_at,
          };
          this.listeners.forEach((l) => l.onFriendRequestReceived?.(req));
        }
        break;

      case 'friend.request.accepted':
      case 'friend_request_accepted':
        if (payload?.friend) {
          const f = payload.friend;
          const friend: Friend = {
            id: f.id,
            name: f.display_name || f.username,
            username: f.username,
            tag: f.tag,
            avatarUrl: f.avatar_url,
            status: (f.status as UserStatus) || 'online',
            customStatus: f.custom_status,
            activity: f.activity,
            lastSeenAt: f.last_seen_at,
          };
          this.listeners.forEach((l) => l.onFriendRequestAccepted?.(friend));
        }
        break;

      case 'friend.request.rejected':
        if (payload?.request_id) {
          this.listeners.forEach((l) => l.onFriendRequestRejected?.(payload.request_id));
        }
        break;

      case 'friend.removed':
      case 'friend_removed':
        if (payload?.friend_id) {
          this.listeners.forEach((l) => l.onFriendRemoved?.(payload.friend_id));
        }
        break;

      case 'friend.blocked':
        if (payload?.user_id) {
          this.listeners.forEach((l) => l.onFriendBlocked?.(payload.user_id));
        }
        break;

      // DM events (Phase 2.3)
      case 'dm.message.created':
        if (payload?.message) {
          const msg = payload.message as DirectMessageDto;
          // If message is for me, immediately ack delivery
          if (!msg.is_mine && msg.id) {
            this.sendDeliveryAck([msg.id]);
          }
          this.listeners.forEach((l) => l.onDmMessageCreated?.(msg));
        }
        break;

      case 'dm.message.updated':
        if (payload?.message) {
          this.listeners.forEach((l) => l.onDmMessageUpdated?.(payload.message));
        }
        break;

      case 'dm.message.deleted':
        if (payload?.id) {
          this.listeners.forEach((l) => l.onDmMessageDeleted?.(payload));
        }
        break;

      case 'dm.message.delivered':
        if (payload?.conversation_id) {
          this.listeners.forEach((l) => l.onDmMessageDelivered?.(payload));
        }
        break;

      case 'dm.message.read':
        if (payload?.conversation_id) {
          this.listeners.forEach((l) => l.onDmMessageRead?.(payload));
        }
        break;

      case 'dm.conversation.updated':
        if (payload?.conversation_id) {
          this.listeners.forEach((l) => l.onDmConversationUpdated?.(payload));
        }
        break;

      case 'call.ringing': {
        const callId = payload?.call_id || payload?.callId;
        const calleeId = payload?.callee_id || payload?.calleeId;
        if (callId) {
          console.log('[GatewayClient] Recebido call.ringing:', { callId, calleeId });
          this.listeners.forEach((l) => l.onCallRinging?.({ callId, calleeId }));
        }
        break;
      }

      case 'call.incoming': {
        const callId = payload?.call_id || payload?.callId;
        const caller = payload?.caller;
        if (callId && caller) {
          const normalized = {
            callId,
            caller: {
              id: caller.id,
              username: caller.username || 'Usuário',
              displayName: caller.display_name || caller.displayName || caller.username,
              avatarUrl: caller.avatar_url || caller.avatarUrl,
            },
          };
          console.log('[GatewayClient] Recebido e despachando call.incoming:', normalized);
          this.listeners.forEach((l) => l.onCallIncoming?.(normalized));
        } else {
          console.warn('[GatewayClient] call.incoming recebido com payload inválido:', payload);
        }
        break;
      }

      case 'call.accepted': {
        const callId = payload?.call_id || payload?.callId;
        const peerId = payload?.peer_id || payload?.peerId;
        if (callId && peerId) {
          console.log('[GatewayClient] Recebido call.accepted:', { callId, peerId });
          this.listeners.forEach((l) =>
            l.onCallAccepted?.({
              callId,
              peerId,
            })
          );
        }
        break;
      }

      case 'call.accepted_by_user': {
        const callId = payload?.call_id || payload?.callId;
        if (callId) {
          console.log('[GatewayClient] Recebido call.accepted_by_user (atendida em outra sessão):', { callId });
          this.listeners.forEach((l) =>
            l.onCallAcceptedByUser?.({
              callId,
            })
          );
        }
        break;
      }

      case 'call.rejected': {
        const callId = payload?.call_id || payload?.callId;
        if (callId) {
          const reason = payload.reason || 'Chamada recusada.';
          console.log('[GatewayClient] Recebido call.rejected:', { callId, reason });
          this.listeners.forEach((l) =>
            l.onCallRejected?.({
              callId,
              reason,
            })
          );
        }
        break;
      }

      case 'call.canceled': {
        const callId = payload?.call_id || payload?.callId;
        if (callId) {
          console.log('[GatewayClient] Recebido call.canceled:', { callId });
          this.listeners.forEach((l) =>
            l.onCallCanceled?.({
              callId,
            })
          );
        }
        break;
      }

      case 'call.ended': {
        const callId = payload?.call_id || payload?.callId;
        if (callId) {
          const reason = payload.reason || 'Chamada encerrada.';
          console.log('[GatewayClient] Recebido call.ended:', { callId, reason });
          this.listeners.forEach((l) =>
            l.onCallEnded?.({
              callId,
              reason,
            })
          );
        }
        break;
      }

      case 'call.participant_muted': {
        const callId = payload?.call_id || payload?.callId;
        const userId = payload?.user_id ?? payload?.userId;
        if (callId && userId !== undefined) {
          const isMuted = !!(payload.is_muted ?? payload.isMuted);
          this.listeners.forEach((l) =>
            l.onCallParticipantMuted?.({
              callId,
              userId,
              isMuted,
            })
          );
        }
        break;
      }

      case 'call.screen_stopped': {
        if (payload?.call_id && payload?.sender_id && typeof payload.share_id === 'string' && /^[0-9]{1,64}$/.test(payload.share_id)) {
          this.listeners.forEach((listener) => listener.onCallScreenStopped?.({
            callId: payload.call_id, senderId: payload.sender_id, shareId: payload.share_id,
          }));
        }
        break;
      }

      case 'call.webrtc.offer': {
        const callId = payload?.call_id || payload?.callId;
        const senderId = payload?.sender_id || payload?.senderId;
        const sdp = payload?.sdp;
        const stream_kind = parseStreamKind(payload?.stream_kind);
        if (callId && senderId && sdp) {
          this.listeners.forEach((l) =>
            l.onCallWebrtcOffer?.({
              callId,
              senderId,
              sdp,
              ...(stream_kind ? { stream_kind } : {}),
            })
          );
        }
        break;
      }

      case 'call.webrtc.answer': {
        const callId = payload?.call_id || payload?.callId;
        const senderId = payload?.sender_id || payload?.senderId;
        const sdp = payload?.sdp;
        const stream_kind = parseStreamKind(payload?.stream_kind);
        if (callId && senderId && sdp) {
          this.listeners.forEach((l) =>
            l.onCallWebrtcAnswer?.({
              callId,
              senderId,
              sdp,
              ...(stream_kind ? { stream_kind } : {}),
            })
          );
        }
        break;
      }

      case 'call.webrtc.ice_candidate': {
        const callId = payload?.call_id || payload?.callId;
        const senderId = payload?.sender_id || payload?.senderId;
        const candidate = payload?.candidate;
        const stream_kind = parseStreamKind(payload?.stream_kind);
        if (callId && senderId && candidate) {
          this.listeners.forEach((l) =>
            l.onCallWebrtcIceCandidate?.({
              callId,
              senderId,
              candidate,
              ...(stream_kind ? { stream_kind } : {}),
            })
          );
        }
        break;
      }

      case 'call.error':
        if (payload?.message) {
          this.listeners.forEach((l) =>
            l.onCallError?.({
              message: payload.message,
            })
          );
        }
        break;

      // Communities (Phase B3.1)
      case 'community_message_created':
      case 'community.message.created': {
        const msg = (payload?.message ?? payload) as ChannelMessageDto;
        if (msg?.id && msg?.channel_id) {
          this.listeners.forEach((l) => l.onCommunityMessageCreated?.(msg));
        }
        break;
      }

      case 'community_message_updated':
      case 'community.message.updated': {
        const msg = (payload?.message ?? payload) as ChannelMessageDto;
        if (msg?.id && msg?.channel_id) {
          this.listeners.forEach((l) => l.onCommunityMessageUpdated?.(msg));
        }
        break;
      }

      case 'community_message_deleted':
      case 'community.message.deleted': {
        const id = payload?.id ?? payload?.message_id;
        const channel_id = payload?.channel_id;
        if (id && channel_id) {
          this.listeners.forEach((l) =>
            l.onCommunityMessageDeleted?.({
              id,
              channel_id,
              community_id: payload?.community_id,
              deleted_at: payload?.deleted_at,
            })
          );
        }
        break;
      }

      case 'community_channel_created':
      case 'community.channel.created': {
        const channel = (payload?.channel ?? payload) as CommunityChannelDto;
        if (channel?.id && channel?.community_id) {
          this.listeners.forEach((l) => l.onCommunityChannelCreated?.(channel));
        }
        break;
      }

      case 'community_channel_updated':
      case 'community.channel.updated': {
        const channel = (payload?.channel ?? payload) as CommunityChannelDto;
        if (channel?.id && channel?.community_id) {
          this.listeners.forEach((l) => l.onCommunityChannelUpdated?.(channel));
        }
        break;
      }

      case 'community_channel_deleted':
      case 'community.channel.deleted': {
        const id = payload?.id ?? payload?.channel_id;
        const community_id = payload?.community_id;
        if (id && community_id) {
          this.listeners.forEach((l) => l.onCommunityChannelDeleted?.({ id, community_id }));
        }
        break;
      }

      case 'community_category_updated':
      case 'community.category.updated': {
        const community_id = payload?.community_id;
        if (community_id) {
          const category = (payload?.category ?? (payload?.id ? payload : undefined)) as
            | CommunityCategoryDto
            | undefined;
          this.listeners.forEach((l) =>
            l.onCommunityCategoryUpdated?.({
              community_id,
              category,
              category_id: payload?.category_id ?? category?.id,
              action: payload?.action,
            })
          );
        }
        break;
      }

      case 'community_member_joined':
      case 'community.member.joined': {
        const community_id = payload?.community_id;
        if (community_id) {
          this.listeners.forEach((l) =>
            l.onCommunityMemberJoined?.({
              community_id,
              member: payload?.member as CommunityMemberDto | undefined,
            })
          );
        }
        break;
      }

      case 'community_member_left':
      case 'community.member.left': {
        const community_id = payload?.community_id;
        const user_id = payload?.user_id;
        if (community_id && user_id) {
          this.listeners.forEach((l) => l.onCommunityMemberLeft?.({ community_id, user_id }));
        }
        break;
      }

      case 'community_member_updated':
      case 'community.member.updated': {
        const community_id = payload?.community_id;
        if (community_id) {
          this.listeners.forEach((l) =>
            l.onCommunityMemberUpdated?.({
              community_id,
              member: payload?.member as CommunityMemberDto | undefined,
              user_id: payload?.user_id ?? payload?.member?.user_id,
            })
          );
        }
        break;
      }

      case 'community_role_updated':
      case 'community.role.updated': {
        const community_id = payload?.community_id;
        if (community_id) {
          this.listeners.forEach((l) =>
            l.onCommunityRoleUpdated?.({
              community_id,
              role: payload?.role as CommunityRoleDto | undefined,
              role_id: payload?.role_id ?? payload?.role?.id,
              action: payload?.action,
            })
          );
        }
        break;
      }

      case 'community_updated':
      case 'community.updated': {
        const community = (payload?.community ?? payload) as CommunityDto;
        if (community?.id) {
          this.listeners.forEach((l) => l.onCommunityUpdated?.(community));
        }
        break;
      }

      case 'community_deleted':
      case 'community.deleted': {
        const community_id = payload?.community_id ?? payload?.id;
        if (community_id) {
          this.listeners.forEach((l) => l.onCommunityDeleted?.({ community_id }));
        }
        break;
      }

      case 'community_access_revoked':
      case 'community.access.revoked': {
        const community_id = payload?.community_id;
        if (community_id) {
          this.listeners.forEach((l) =>
            l.onCommunityAccessRevoked?.({
              community_id,
              channel_id: payload?.channel_id ?? null,
              reason: payload?.reason,
            })
          );
        }
        break;
      }

      case 'pong':
        break;

      // Voice Rooms (Phase B3.2)
      case 'room_joined':
      case 'room.joined': {
        const community_id = payload?.community_id;
        const channel_id = payload?.channel_id;
        if (community_id && channel_id) {
          this.listeners.forEach((l) =>
            l.onRoomJoined?.({
              community_id,
              channel_id,
              max_participants: typeof payload?.max_participants === 'number' ? payload.max_participants : 4,
              participants: Array.isArray(payload?.participants) ? payload.participants : [],
              can_speak: payload?.can_speak !== false,
              can_screen_share: payload?.can_screen_share !== false,
            })
          );
        }
        break;
      }

      case 'room_left':
      case 'room.left': {
        const community_id = payload?.community_id;
        const channel_id = payload?.channel_id;
        if (community_id && channel_id) {
          this.listeners.forEach((l) =>
            l.onRoomLeft?.({
              community_id,
              channel_id,
              reason: payload?.reason ?? null,
            })
          );
        }
        break;
      }

      case 'room_participant_joined':
      case 'room.participant.joined': {
        const community_id = payload?.community_id;
        const channel_id = payload?.channel_id;
        const participant = payload?.participant as RoomParticipantDto | undefined;
        if (community_id && channel_id && participant?.user_id) {
          this.listeners.forEach((l) =>
            l.onRoomParticipantJoined?.({ community_id, channel_id, participant })
          );
        }
        break;
      }

      case 'room_participant_left':
      case 'room.participant.left': {
        const community_id = payload?.community_id;
        const channel_id = payload?.channel_id;
        const user_id = payload?.user_id;
        if (community_id && channel_id && user_id) {
          this.listeners.forEach((l) =>
            l.onRoomParticipantLeft?.({ community_id, channel_id, user_id })
          );
        }
        break;
      }

      case 'room_participant_updated':
      case 'room.participant.updated': {
        const community_id = payload?.community_id;
        const channel_id = payload?.channel_id;
        const participant = payload?.participant as RoomParticipantDto | undefined;
        if (community_id && channel_id && participant?.user_id) {
          this.listeners.forEach((l) =>
            l.onRoomParticipantUpdated?.({ community_id, channel_id, participant })
          );
        }
        break;
      }

      case 'community_voice_state_updated':
      case 'community.voice_state.updated': {
        const community_id = payload?.community_id;
        const channel_id = payload?.channel_id;
        if (community_id && channel_id) {
          this.listeners.forEach((l) =>
            l.onCommunityVoiceStateUpdated?.({
              community_id,
              channel_id,
              participants: Array.isArray(payload?.participants) ? payload.participants : [],
            })
          );
        }
        break;
      }

      case 'room_webrtc_offer':
      case 'room.webrtc.offer': {
        const community_id = payload?.community_id;
        const channel_id = payload?.channel_id;
        const sender_id = payload?.sender_id;
        const sdp = payload?.sdp;
        const stream_kind = parseStreamKind(payload?.stream_kind);
        if (community_id && channel_id && sender_id && sdp) {
          this.listeners.forEach((l) =>
            l.onRoomWebrtcOffer?.({
              community_id,
              channel_id,
              sender_id,
              sdp,
              ...(stream_kind ? { stream_kind } : {}),
            })
          );
        }
        break;
      }

      case 'room_webrtc_answer':
      case 'room.webrtc.answer': {
        const community_id = payload?.community_id;
        const channel_id = payload?.channel_id;
        const sender_id = payload?.sender_id;
        const sdp = payload?.sdp;
        const stream_kind = parseStreamKind(payload?.stream_kind);
        if (community_id && channel_id && sender_id && sdp) {
          this.listeners.forEach((l) =>
            l.onRoomWebrtcAnswer?.({
              community_id,
              channel_id,
              sender_id,
              sdp,
              ...(stream_kind ? { stream_kind } : {}),
            })
          );
        }
        break;
      }

      case 'room_webrtc_ice_candidate':
      case 'room.webrtc.ice_candidate': {
        const community_id = payload?.community_id;
        const channel_id = payload?.channel_id;
        const sender_id = payload?.sender_id;
        const candidate = payload?.candidate;
        const stream_kind = parseStreamKind(payload?.stream_kind);
        if (community_id && channel_id && sender_id && candidate) {
          this.listeners.forEach((l) =>
            l.onRoomWebrtcIceCandidate?.({
              community_id,
              channel_id,
              sender_id,
              candidate,
              ...(stream_kind ? { stream_kind } : {}),
            })
          );
        }
        break;
      }

      case 'room_error':
      case 'room.error': {
        if (payload?.message) {
          this.listeners.forEach((l) =>
            l.onRoomError?.({
              community_id: payload?.community_id ?? null,
              channel_id: payload?.channel_id ?? null,
              message: payload.message,
            })
          );
        }
        break;
      }

      case 'error':
        console.warn('[GatewayClient] Erro recebido do servidor:', payload?.message);
        break;

      case 'session.revoked':
        console.warn('[GatewayClient] Sessão revogada pelo servidor. Encerrando WebSocket.');
        this.disconnect();
        break;

      default:
        break;
    }
  }

  sendDeliveryAck(messageIds: string[]): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN && messageIds.length > 0) {
      this.socket.send(
        JSON.stringify({
          op: 'dm.delivery_ack',
          message_ids: messageIds,
        })
      );
    }
  }

  sendReadAck(conversationId: string, lastMessageId?: string): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(
        JSON.stringify({
          op: 'dm.read_ack',
          conversation_id: conversationId,
          last_message_id: lastMessageId || null,
        })
      );
    }
  }

  sendPresence(status: UserStatus, customStatus?: string, activity?: string): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      const msg = {
        op: 'set_presence',
        status,
        custom_status: customStatus || null,
        activity: activity || null,
      };
      this.socket.send(JSON.stringify(msg));
    }
  }

  // Phase 2.4: Call Signaling Methods
  sendCallInvite(targetUserId: string): void {
    this.sendJson({ op: 'call.invite', target_user_id: targetUserId });
  }

  sendCallAccept(callId: string): void {
    this.sendJson({ op: 'call.accept', call_id: callId });
  }

  sendCallReject(callId: string, reason?: string): void {
    this.sendJson({ op: 'call.reject', call_id: callId, reason: reason || null });
  }

  sendCallCancel(callId: string): void {
    this.sendJson({ op: 'call.cancel', call_id: callId });
  }

  sendCallEnd(callId: string): void {
    this.sendJson({ op: 'call.end', call_id: callId });
  }

  sendCallMute(callId: string, isMuted: boolean): void {
    this.sendJson({ op: 'call.mute', call_id: callId, is_muted: isMuted });
  }

  sendCallScreenStopped(callId: string, targetUserId: string, shareId: string): void {
    this.sendJson({ op: 'call.screen_stopped', call_id: callId, target_user_id: targetUserId, share_id: shareId });
  }

  sendCallWebrtcOffer(callId: string, targetUserId: string, sdp: string, streamKind?: StreamKind): void {
    this.sendJson({
      op: 'call.webrtc.offer',
      call_id: callId,
      target_user_id: targetUserId,
      sdp,
      ...(streamKind ? { stream_kind: streamKind } : {}),
    });
  }

  sendCallWebrtcAnswer(callId: string, targetUserId: string, sdp: string, streamKind?: StreamKind): void {
    this.sendJson({
      op: 'call.webrtc.answer',
      call_id: callId,
      target_user_id: targetUserId,
      sdp,
      ...(streamKind ? { stream_kind: streamKind } : {}),
    });
  }

  sendCallWebrtcIceCandidate(
    callId: string,
    targetUserId: string,
    candidate: any,
    streamKind?: StreamKind
  ): void {
    this.sendJson({
      op: 'call.webrtc.ice_candidate',
      call_id: callId,
      target_user_id: targetUserId,
      candidate,
      ...(streamKind ? { stream_kind: streamKind } : {}),
    });
  }

  // Phase B3.2: Multi-participant Voice Room Signaling Methods
  sendRoomJoin(communityId: string, channelId: string): void {
    this.sendJson({ op: 'room_join', community_id: communityId, channel_id: channelId });
  }

  sendRoomLeave(communityId: string, channelId: string): void {
    this.sendJson({ op: 'room_leave', community_id: communityId, channel_id: channelId });
  }

  sendRoomStateUpdate(
    communityId: string,
    channelId: string,
    state: {
      is_muted?: boolean;
      is_deafened?: boolean;
      is_speaking?: boolean;
      is_screen_sharing?: boolean;
    }
  ): void {
    this.sendJson({
      op: 'room_state_update',
      community_id: communityId,
      channel_id: channelId,
      ...state,
    });
  }

  sendRoomWebrtcOffer(
    communityId: string,
    channelId: string,
    targetUserId: string,
    sdp: string,
    streamKind?: StreamKind
  ): void {
    this.sendJson({
      op: 'room_webrtc_offer',
      community_id: communityId,
      channel_id: channelId,
      target_user_id: targetUserId,
      sdp,
      ...(streamKind ? { stream_kind: streamKind } : {}),
    });
  }

  sendRoomWebrtcAnswer(
    communityId: string,
    channelId: string,
    targetUserId: string,
    sdp: string,
    streamKind?: StreamKind
  ): void {
    this.sendJson({
      op: 'room_webrtc_answer',
      community_id: communityId,
      channel_id: channelId,
      target_user_id: targetUserId,
      sdp,
      ...(streamKind ? { stream_kind: streamKind } : {}),
    });
  }

  sendRoomWebrtcIceCandidate(
    communityId: string,
    channelId: string,
    targetUserId: string,
    candidate: any,
    streamKind?: StreamKind
  ): void {
    this.sendJson({
      op: 'room_webrtc_ice_candidate',
      community_id: communityId,
      channel_id: channelId,
      target_user_id: targetUserId,
      candidate,
      ...(streamKind ? { stream_kind: streamKind } : {}),
    });
  }

  private sendJson(data: any): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(data));
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.pingInterval = setInterval(() => {
      if (this.socket && this.socket.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify({ op: 'ping' }));
      }
    }, 25000);
  }

  private stopHeartbeat(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  disconnect(): void {
    this.isExplicitlyClosed = true;
    this.isConnecting = false;
    this.connectGeneration++;
    this.stopHeartbeat();
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    if (this.socket) {
      const sock = this.socket;
      this.socket = null;
      // Desanexa handlers para impedir que o encerramento assíncrono dispare reconexão ou zere conexões novas
      sock.onopen = null;
      sock.onmessage = null;
      sock.onerror = null;
      sock.onclose = null;
      try {
        sock.close();
      } catch {}
    }
    this.notifyConnectionChange(false);
  }

  private scheduleReconnect(): void {
    if (this.isExplicitlyClosed) return;
    this.reconnectAttempts++;
    // Exponential backoff with jitter
    const base = Math.min(1000 * Math.pow(1.5, this.reconnectAttempts), this.maxReconnectDelay);
    const jitter = Math.random() * 600;
    const delay = Math.round(base + jitter);

    console.log(`[GatewayClient] Reconectando em ${delay}ms (tentativa ${this.reconnectAttempts})...`);
    this.reconnectTimeout = setTimeout(() => {
      this.connect();
    }, delay);
  }

  private notifyConnectionChange(connected: boolean) {
    this.listeners.forEach((l) => l.onConnectionChange?.(connected));
  }
}

export const gatewayClient = new GatewayClient();
