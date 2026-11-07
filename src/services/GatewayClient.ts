import { Friend, FriendRequest, UserStatus, GatewayEvent, DirectMessageDto } from '../lib/types';

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
  onCallWebrtcOffer?: (data: { callId: string; senderId: string; sdp: string }) => void;
  onCallWebrtcAnswer?: (data: { callId: string; senderId: string; sdp: string }) => void;
  onCallWebrtcIceCandidate?: (data: { callId: string; senderId: string; candidate: any }) => void;
  onCallError?: (data: { message: string }) => void;
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
      const { invoke } = await import('@tauri-apps/api/core');
      const wsUrl = await invoke<string>('gateway_get_ws_url');

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
        console.log('[GatewayClient] Socket aberto. Solicitando ticket efêmero para autenticação...');
        try {
          // Request ephemeral single-use 60s ticket from Rust backend (never expose persistent token to WebView)
          const ticket = await invoke<string>('gateway_get_ticket');

          if (this.socket !== sock || currentGen !== this.connectGeneration || this.isExplicitlyClosed) {
            try {
              sock.close();
            } catch {}
            return;
          }

          if (sock.readyState === WebSocket.OPEN) {
            sock.send(JSON.stringify({ op: 'authenticate', ticket }));
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

      case 'call.webrtc.offer': {
        const callId = payload?.call_id || payload?.callId;
        const senderId = payload?.sender_id || payload?.senderId;
        const sdp = payload?.sdp;
        if (callId && senderId && sdp) {
          this.listeners.forEach((l) =>
            l.onCallWebrtcOffer?.({
              callId,
              senderId,
              sdp,
            })
          );
        }
        break;
      }

      case 'call.webrtc.answer': {
        const callId = payload?.call_id || payload?.callId;
        const senderId = payload?.sender_id || payload?.senderId;
        const sdp = payload?.sdp;
        if (callId && senderId && sdp) {
          this.listeners.forEach((l) =>
            l.onCallWebrtcAnswer?.({
              callId,
              senderId,
              sdp,
            })
          );
        }
        break;
      }

      case 'call.webrtc.ice_candidate': {
        const callId = payload?.call_id || payload?.callId;
        const senderId = payload?.sender_id || payload?.senderId;
        const candidate = payload?.candidate;
        if (callId && senderId && candidate) {
          this.listeners.forEach((l) =>
            l.onCallWebrtcIceCandidate?.({
              callId,
              senderId,
              candidate,
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

      case 'pong':
        break;

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

  sendCallWebrtcOffer(callId: string, targetUserId: string, sdp: string): void {
    this.sendJson({ op: 'call.webrtc.offer', call_id: callId, target_user_id: targetUserId, sdp });
  }

  sendCallWebrtcAnswer(callId: string, targetUserId: string, sdp: string): void {
    this.sendJson({ op: 'call.webrtc.answer', call_id: callId, target_user_id: targetUserId, sdp });
  }

  sendCallWebrtcIceCandidate(callId: string, targetUserId: string, candidate: any): void {
    this.sendJson({ op: 'call.webrtc.ice_candidate', call_id: callId, target_user_id: targetUserId, candidate });
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
