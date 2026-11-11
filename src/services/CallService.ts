/**
 * NEXUS - 1:1 Voice & Screen Call Coordinator (Calls & Streaming 2.0)
 * Coordena a sinalização WebSocket via GatewayClient e o motor de mídia WebRtcService,
 * garantindo máquina de estados determinística, proteção contra eventos atrasados/duplicados,
 * controle de volume individual, seleção de qualidade de transmissão, recuperação controlada
 * de reconexão com backoff exponencial (ICE Restart) e limpeza completa de recursos.
 */

import { gatewayClient } from './GatewayClient';
import {
  WebRtcService,
  WebRtcConnectionState,
  WebRtcTransportDiagnostics,
  DEFAULT_ICE_DISCONNECT_TIMEOUT_MS,
} from './WebRtcService';
import { useAppStore } from '../stores/useAppStore';
import { callHistoryRepository } from '../repositories/CallHistoryRepository';
import { soundEffects } from '../lib/soundEffects';
import { screenCaptureService } from './ScreenCaptureService';
import { audioDeviceService } from './AudioDeviceService';
import { ScreenShareQualityPreset } from '../lib/types';

export const DEFAULT_CALLING_TIMEOUT_MS = 47000;
export const DEFAULT_CONNECTING_TIMEOUT_MS = 20000;
export const DEFAULT_RECONNECTING_TIMEOUT_MS = 15000;
export const DEFAULT_MAX_RECONNECT_ATTEMPTS = 3;
export const DEFAULT_RECONNECT_BACKOFF_BASE_MS = 1800;
const MAX_TERMINATED_CALL_IDS = 128;

export class CallService {
  private webRtc: WebRtcService | null = null;
  private durationTimer: any = null;
  private callingTimer: any = null;
  private connectingTimer: any = null;
  private reconnectingTimer: any = null;
  private reconnectAttemptTimer: any = null;
  private localSpeakingTimer: any = null;
  private remoteSpeakingTimer: any = null;

  private callingTimeoutMs = DEFAULT_CALLING_TIMEOUT_MS;
  private connectingTimeoutMs = DEFAULT_CONNECTING_TIMEOUT_MS;
  private reconnectingTimeoutMs = DEFAULT_RECONNECTING_TIMEOUT_MS;
  private iceDisconnectTimeoutMs = DEFAULT_ICE_DISCONNECT_TIMEOUT_MS;
  private maxReconnectAttempts = DEFAULT_MAX_RECONNECT_ATTEMPTS;
  private reconnectBackoffBaseMs = DEFAULT_RECONNECT_BACKOFF_BASE_MS;

  private initialized = false;
  private isCleaningUp = false;
  private callSessionToken = 0;
  private pendingCancelBeforeRinging = false;
  private offerSentForCallId: string | null = null;
  private terminatedCallIds: Set<string> = new Set();

  public configureTimeouts(options: {
    callingTimeoutMs?: number;
    connectingTimeoutMs?: number;
    reconnectingTimeoutMs?: number;
    iceDisconnectTimeoutMs?: number;
    maxReconnectAttempts?: number;
    reconnectBackoffBaseMs?: number;
  }): void {
    if (options.callingTimeoutMs !== undefined) {
      this.callingTimeoutMs = options.callingTimeoutMs;
    }
    if (options.connectingTimeoutMs !== undefined) {
      this.connectingTimeoutMs = options.connectingTimeoutMs;
    }
    if (options.reconnectingTimeoutMs !== undefined) {
      this.reconnectingTimeoutMs = options.reconnectingTimeoutMs;
    }
    if (options.iceDisconnectTimeoutMs !== undefined) {
      this.iceDisconnectTimeoutMs = options.iceDisconnectTimeoutMs;
    }
    if (options.maxReconnectAttempts !== undefined) {
      this.maxReconnectAttempts = Math.max(1, options.maxReconnectAttempts);
    }
    if (options.reconnectBackoffBaseMs !== undefined) {
      this.reconnectBackoffBaseMs = Math.max(50, options.reconnectBackoffBaseMs);
    }
  }

  private markCallTerminated(callId?: string | null): void {
    if (!callId) return;
    if (this.terminatedCallIds.size >= MAX_TERMINATED_CALL_IDS) {
      const oldest = this.terminatedCallIds.values().next().value;
      if (oldest) {
        this.terminatedCallIds.delete(oldest);
      }
    }
    this.terminatedCallIds.add(callId);
  }

  private isTerminatedCall(callId?: string | null): boolean {
    return Boolean(callId && this.terminatedCallIds.has(callId));
  }

  private isMatchingActiveOrPendingCall(callId?: string | null): boolean {
    if (!callId || this.isTerminatedCall(callId)) return false;
    const store = useAppStore.getState();
    if (store.activeCallId === callId) return true;
    if (store.incomingCall?.callId === callId) return true;
    if (store.voiceCallState === 'calling' && store.activeCallId === null) {
      return true;
    }
    return false;
  }

  init(): void {
    if (this.initialized) return;
    this.initialized = true;

    // 1. Sincroniza encerramentos locais de tela com a chamada WebRTC
    screenCaptureService.addListener((state) => {
      if (!state.isCapturing && this.webRtc && !this.isCleaningUp) {
        const store = useAppStore.getState();
        if (store.activeCallId && store.activeCallPeer?.id && store.voiceCallState === 'connected') {
          this.webRtc.detachScreenTrack().then((offerSdp) => {
            if (offerSdp && store.activeCallId && store.activeCallPeer?.id) {
              gatewayClient.sendCallWebrtcOffer(store.activeCallId, store.activeCallPeer.id, offerSdp);
            }
          }).catch(() => {});
        }
      }
    });

    // 2. Monitora conexão/desconexão física de periféricos de áudio durante a sessão
    audioDeviceService.onDeviceChange((devices) => {
      const store = useAppStore.getState();
      const currentInput = store.settings.audioVideo.inputDevice;
      const currentOutput = store.settings.audioVideo.outputDevice;

      const inputCheck = audioDeviceService.resolveValidDeviceId(currentInput, devices.inputs);
      if (inputCheck.didFallback) {
        console.warn('[CallService] Microfone selecionado removido do sistema. Fallback para padrão.');
        store.updateAudioVideo({ inputDevice: 'default' });
        if (store.voiceCallState !== 'idle') {
          store.setCallDeviceNotice(
            'Microfone desconectado. Alternado automaticamente para o microfone padrão.'
          );
          this.webRtc?.switchInputDevice('default').catch(() => {});
        }
      }

      const outputCheck = audioDeviceService.resolveValidDeviceId(currentOutput, devices.outputs);
      if (outputCheck.didFallback) {
        console.warn('[CallService] Dispositivo de saída removido do sistema. Fallback para padrão.');
        store.updateAudioVideo({ outputDevice: 'default' });
        if (store.voiceCallState !== 'idle') {
          store.setCallDeviceNotice(
            'Saída de áudio desconectada. Alternado automaticamente para o dispositivo padrão.'
          );
          this.webRtc?.switchOutputDevice('default').catch(() => {});
        }
      }
    });

    gatewayClient.addListener({
      onCallRinging: (data) => {
        console.log('[CallService] Confirmação de toque no servidor (call.ringing):', data.callId);
        if (this.isTerminatedCall(data.callId)) {
          gatewayClient.sendCallCancel(data.callId);
          return;
        }

        if (this.pendingCancelBeforeRinging) {
          this.pendingCancelBeforeRinging = false;
          this.markCallTerminated(data.callId);
          gatewayClient.sendCallCancel(data.callId);
          return;
        }

        const store = useAppStore.getState();
        const peerMatches =
          !data.calleeId ||
          !store.activeCallPeer?.id ||
          store.activeCallPeer.id === data.calleeId;
        const callIdMatches =
          store.activeCallId === null || store.activeCallId === data.callId;

        if (store.voiceCallState === 'calling' && peerMatches && callIdMatches) {
          store.setActiveCall(data.callId, store.activeCallPeer);
          if (store.isMicMuted || store.isDeafened) {
            this.webRtc?.setMuted(true);
            gatewayClient.sendCallMute(data.callId, true);
          }
        } else {
          this.markCallTerminated(data.callId);
          gatewayClient.sendCallCancel(data.callId);
          if (store.activeCallId === data.callId) {
            this.cleanup();
          }
        }
      },

      onCallIncoming: (data) => {
        console.log('[CallService] Convite de chamada recebido (call.incoming):', data);
        if (!data?.callId || this.isTerminatedCall(data.callId)) {
          return;
        }

        const store = useAppStore.getState();
        const currentState = store?.voiceCallState ?? 'idle';

        if (currentState === 'incoming' && store.incomingCall?.callId === data.callId) {
          return;
        }

        const isCallingSamePeer =
          currentState === 'calling' &&
          Boolean(data.caller?.id && store.activeCallPeer?.id === data.caller.id);
        const localUserId = store.currentUser?.id || '';
        const shouldYieldToIncoming =
          isCallingSamePeer &&
          (store.activeCallId === null ||
            (Boolean(localUserId) && localUserId > data.caller.id));

        if (shouldYieldToIncoming) {
          console.log(
            `[CallService] Convite simultâneo detectado com ${data.caller.username}. Cedendo para a chamada recebida ${data.callId}.`
          );
          if (store.activeCallId && store.activeCallId !== data.callId) {
            this.markCallTerminated(store.activeCallId);
            gatewayClient.sendCallCancel(store.activeCallId);
          } else {
            this.pendingCancelBeforeRinging = true;
          }
          this.clearStateTimers();
          if (this.webRtc) {
            const rtc = this.webRtc;
            this.webRtc = null;
            rtc.destroy(false);
          }
          this.callSessionToken++;
          this.offerSentForCallId = null;
          store.setActiveCall(null, null);
          store.setIncomingCall(data);
          store.setVoiceCallState('incoming');
          return;
        }

        if (
          currentState === 'calling' ||
          currentState === 'connecting' ||
          currentState === 'connected' ||
          currentState === 'reconnecting' ||
          (currentState === 'incoming' &&
            store.incomingCall &&
            store.incomingCall.callId !== data.callId)
        ) {
          console.warn(
            `[CallService] Rejeitando chamada ${data.callId} pois usuário está ocupado em estado: ${currentState}`
          );
          this.markCallTerminated(data.callId);
          gatewayClient.sendCallReject(data.callId, 'O usuário está ocupado em outra chamada.');
          return;
        }

        console.log(
          `[CallService] Apresentando notificação de chamada ${data.callId} de ${data.caller?.username || 'desconhecido'}`
        );
        store.setIncomingCall(data);
        store.setVoiceCallState('incoming');
      },

      onCallAccepted: async (data) => {
        console.log('[CallService] Chamada aceita pelo destinatário (call.accepted):', data);
        if (!data?.callId || this.isTerminatedCall(data.callId)) {
          return;
        }

        const store = useAppStore.getState();
        const isMatchingCall =
          store.activeCallId === data.callId ||
          (store.activeCallId === null && store.activeCallPeer?.id === data.peerId);

        if (store.voiceCallState !== 'calling' || !isMatchingCall) {
          console.warn(
            `[CallService] Ignorando call.accepted (${data.callId}) pois state=${store.voiceCallState} e activeCallId=${store.activeCallId}`
          );
          return;
        }

        if (this.offerSentForCallId === data.callId) {
          console.warn('[CallService] Ignorando call.accepted duplicado para a mesma chamada.');
          return;
        }

        this.offerSentForCallId = data.callId;
        const token = this.callSessionToken;

        store.setActiveCall(data.callId, store.activeCallPeer);
        store.setVoiceCallState('connecting');
        this.startConnectingTimer();

        try {
          if (!this.webRtc) {
            this.webRtc = this.createWebRtcInstance();
          }

          const sdp = await this.webRtc.createOffer();
          const latestStore = useAppStore.getState();
          if (
            token !== this.callSessionToken ||
            latestStore.activeCallId !== data.callId ||
            this.isTerminatedCall(data.callId)
          ) {
            return;
          }

          gatewayClient.sendCallWebrtcOffer(data.callId, data.peerId, sdp);
        } catch (err: any) {
          if (token !== this.callSessionToken) return;
          console.error('[CallService] Falha ao criar SDP Offer:', err);
          this.endCall('Falha na negociação de áudio.');
        }
      },

      onCallRejected: (data) => {
        console.log('[CallService] Chamada recusada (call.rejected):', data);
        if (!this.isMatchingActiveOrPendingCall(data?.callId)) {
          return;
        }
        this.markCallTerminated(data.callId);
        const store = useAppStore.getState();
        store.setCallErrorMessage(data.reason || 'Chamada recusada.');
        this.cleanup('rejected');
      },

      onCallCanceled: (data) => {
        console.log('[CallService] Chamada cancelada pelo chamador (call.canceled):', data);
        if (!this.isMatchingActiveOrPendingCall(data?.callId)) {
          return;
        }
        this.markCallTerminated(data.callId);
        const store = useAppStore.getState();
        store.setIncomingCall(null);
        this.cleanup('canceled');
      },

      onCallEnded: (data) => {
        console.log('[CallService] Chamada encerrada pelo peer (call.ended):', data);
        if (!this.isMatchingActiveOrPendingCall(data?.callId)) {
          return;
        }
        this.markCallTerminated(data.callId);
        const store = useAppStore.getState();
        store.setCallErrorMessage(data.reason || 'Chamada encerrada.');
        this.cleanup();
      },

      onCallParticipantMuted: (data) => {
        const store = useAppStore.getState();
        if (data.callId && store.activeCallId && data.callId !== store.activeCallId) {
          return;
        }
        console.log('[CallService] Estado de microfone do peer atualizado:', data);
        store.setPeerMuted(Boolean(data.isMuted));
      },

      onCallAcceptedByUser: (data) => {
        console.log('[CallService] Chamada atendida em outra sessão/dispositivo:', data.callId);
        const store = useAppStore.getState();
        if (store.incomingCall?.callId === data.callId && store.voiceCallState === 'incoming') {
          this.markCallTerminated(data.callId);
          store.setIncomingCall(null);
          store.setVoiceCallState('idle');
        }
      },

      onCallWebrtcOffer: async (data) => {
        console.log('[CallService] SDP Offer recebida do chamador (call.webrtc.offer).');
        if (!data?.callId || this.isTerminatedCall(data.callId)) {
          return;
        }

        const store = useAppStore.getState();
        if (
          store.activeCallId !== data.callId ||
          (store.voiceCallState !== 'connecting' &&
            store.voiceCallState !== 'connected' &&
            store.voiceCallState !== 'reconnecting')
        ) {
          console.log(
            `[CallService] Ignorando SDP Offer pois esta instância não é o participante ativo da chamada ${data.callId} (state=${store.voiceCallState})`
          );
          return;
        }

        if (
          store.activeCallPeer?.id &&
          data.senderId &&
          store.activeCallPeer.id !== data.senderId
        ) {
          return;
        }

        const token = this.callSessionToken;
        try {
          if (!this.webRtc) {
            console.warn('[CallService] webRtc não inicializado ao receber offer, criando...');
            this.webRtc = this.createWebRtcInstance();
          }

          const answerSdp = await this.webRtc.handleOffer(data.sdp);
          if (!answerSdp) {
            return;
          }
          const latestStore = useAppStore.getState();
          if (
            token !== this.callSessionToken ||
            latestStore.activeCallId !== data.callId ||
            this.isTerminatedCall(data.callId)
          ) {
            return;
          }

          gatewayClient.sendCallWebrtcAnswer(data.callId, data.senderId, answerSdp);
        } catch (err: any) {
          if (token !== this.callSessionToken) return;
          console.error('[CallService] Falha ao processar SDP Offer:', err);
          if (useAppStore.getState().voiceCallState === 'connecting') {
            this.endCall('Falha ao negociar conexão de áudio.');
          }
        }
      },

      onCallWebrtcAnswer: async (data) => {
        console.log('[CallService] SDP Answer recebida do destinatário (call.webrtc.answer).');
        if (!data?.callId || this.isTerminatedCall(data.callId)) {
          return;
        }

        const store = useAppStore.getState();
        if (
          store.activeCallId !== data.callId ||
          (store.voiceCallState !== 'connecting' &&
            store.voiceCallState !== 'connected' &&
            store.voiceCallState !== 'reconnecting')
        ) {
          return;
        }

        if (
          store.activeCallPeer?.id &&
          data.senderId &&
          store.activeCallPeer.id !== data.senderId
        ) {
          return;
        }

        const token = this.callSessionToken;
        try {
          if (this.webRtc) {
            await this.webRtc.handleAnswer(data.sdp);
          }
        } catch (err: any) {
          if (token !== this.callSessionToken) return;
          console.error('[CallService] Falha ao processar SDP Answer:', err);
          if (useAppStore.getState().voiceCallState === 'connecting') {
            this.endCall('Falha ao estabelecer conexão de áudio.');
          }
        }
      },

      onCallWebrtcIceCandidate: async (data) => {
        if (!data?.callId || this.isTerminatedCall(data.callId)) {
          return;
        }

        const store = useAppStore.getState();
        if (
          store.activeCallId !== data.callId ||
          (store.voiceCallState !== 'connecting' &&
            store.voiceCallState !== 'connected' &&
            store.voiceCallState !== 'reconnecting')
        ) {
          return;
        }

        if (
          store.activeCallPeer?.id &&
          data.senderId &&
          store.activeCallPeer.id !== data.senderId
        ) {
          return;
        }

        if (this.webRtc) {
          await this.webRtc.addIceCandidate(data.candidate);
        }
      },

      onCallError: (data) => {
        console.warn('[CallService] Erro recebido na chamada:', data.message);
        const store = useAppStore.getState();
        if (store.voiceCallState === 'incoming' && store.incomingCall) {
          return;
        }
        store.setCallErrorMessage(data.message);
        if (store.voiceCallState === 'calling' || store.voiceCallState === 'connecting') {
          this.cleanup();
        }
      },

      onConnectionChange: (connected) => {
        const store = useAppStore.getState();
        if (!connected) {
          if (
            store.voiceCallState === 'connected' ||
            store.voiceCallState === 'connecting'
          ) {
            store.setVoiceCallState('reconnecting');
            this.startReconnectingTimer();
          } else if (store.voiceCallState === 'calling' || store.voiceCallState === 'incoming') {
            this.cleanup();
          }
        } else {
          if (store.voiceCallState === 'reconnecting') {
            if (this.webRtc?.isMediaConnected()) {
              this.clearReconnectingTimer();
              store.setReconnectStatus(0, this.maxReconnectAttempts);
              store.setVoiceCallState('connected');
            } else {
              // WebSocket reconectou, mas a mídia P2P precisa de ICE Restart
              this.triggerIceRestartAttempt();
            }
          }
        }
      },

      onReconnected: () => {
        const store = useAppStore.getState();
        if (store.voiceCallState === 'reconnecting') {
          if (this.webRtc?.isMediaConnected()) {
            this.clearReconnectingTimer();
            store.setReconnectStatus(0, this.maxReconnectAttempts);
            store.setVoiceCallState('connected');
          } else {
            this.triggerIceRestartAttempt();
          }
        }
      },
    });
  }

  private createWebRtcInstance(): WebRtcService {
    const instanceToken = this.callSessionToken;
    const store = useAppStore.getState();
    const myId = store.onlineUser?.id || '';
    const peerId = store.activeCallPeer?.id || '';
    const isPolite = myId ? (peerId ? myId > peerId : false) : true;
    const outputVolumePercent = store.settings.audioVideo.outputVolume ?? 85;
    const peerVolumePercent =
      peerId && store.settings.audioVideo.participantVolumes?.[peerId] !== undefined
        ? store.settings.audioVideo.participantVolumes[peerId]
        : 100;

    return new WebRtcService(
      {
        onIceCandidate: (candidate) => {
          if (instanceToken !== this.callSessionToken) return;
          const currentStore = useAppStore.getState();
          if (currentStore.activeCallId && currentStore.activeCallPeer?.id) {
            gatewayClient.sendCallWebrtcIceCandidate(
              currentStore.activeCallId,
              currentStore.activeCallPeer.id,
              candidate
            );
          }
        },
        onConnectionStateChange: (state: WebRtcConnectionState) => {
          if (instanceToken !== this.callSessionToken) return;
          const currentStore = useAppStore.getState();
          if (state === 'connected') {
            this.clearConnectingTimer();
            this.clearReconnectingTimer();
            currentStore.setReconnectStatus(0, this.maxReconnectAttempts);
            currentStore.setVoiceCallState('connected');
            this.startDurationTimer();
          } else if (state === 'reconnecting') {
            if (
              currentStore.voiceCallState === 'connected' ||
              currentStore.voiceCallState === 'connecting'
            ) {
              currentStore.setVoiceCallState('reconnecting');
              this.startReconnectingTimer();
            }
          } else if (state === 'failed') {
            currentStore.setCallErrorMessage('Falha na conexão de mídia P2P.');
            this.endCall('Falha na conectividade WebRTC.');
          } else if (state === 'closed') {
            if (currentStore.voiceCallState !== 'idle') {
              this.cleanup();
            }
          }
        },
        onLocalSpeaking: (isSpeaking) => {
          if (instanceToken !== this.callSessionToken) return;
          this.handleSpeakingEvent('local', isSpeaking);
        },
        onRemoteSpeaking: (isSpeaking) => {
          if (instanceToken !== this.callSessionToken) return;
          this.handleSpeakingEvent('remote', isSpeaking);
        },
        onError: (errMsg) => {
          if (instanceToken !== this.callSessionToken) return;
          useAppStore.getState().setCallErrorMessage(errMsg);
        },
        onDeviceFallback: (_kind, reason) => {
          if (instanceToken !== this.callSessionToken) return;
          useAppStore.getState().setCallDeviceNotice(reason);
        },
        onRemoteVideoTrack: (track, stream) => {
          if (instanceToken !== this.callSessionToken) return;
          console.log('[CallService] Exibindo transmissão de tela remota:', track.id);
          useAppStore.getState().setRemoteScreenStream(stream, track);
        },
        onRemoteVideoMuteChange: (isMuted) => {
          if (instanceToken !== this.callSessionToken) return;
          useAppStore.getState().setRemoteScreenMuted(isMuted);
        },
        onRemoteVideoEnded: () => {
          if (instanceToken !== this.callSessionToken) return;
          console.log('[CallService] Transmissão de tela remota finalizada.');
          useAppStore.getState().setRemoteScreenStream(null, null);
        },
      },
      {
        iceDisconnectTimeoutMs: this.iceDisconnectTimeoutMs,
        isPolite,
        outputVolumePercent,
        peerVolumePercent,
      }
    );
  }

  public async getTransportDiagnostics(): Promise<WebRtcTransportDiagnostics | null> {
    if (!this.webRtc) return null;
    return this.webRtc.collectTransportDiagnostics();
  }

  /**
   * Inicia chamada 1:1 com um amigo
   */
  async startCall(targetUser: {
    id: string;
    name: string;
    username: string;
    avatarUrl?: string;
  }): Promise<void> {
    const store = useAppStore.getState();
    if (store.voiceCallState !== 'idle') return;

    const attemptToken = ++this.callSessionToken;
    this.pendingCancelBeforeRinging = false;
    this.offerSentForCallId = null;

    const initialMuted = Boolean(store.isMicMuted || store.isDeafened);
    const initialDeafened = Boolean(store.isDeafened);

    store.setCallErrorMessage(null);
    store.setCallDeviceNotice(null);
    store.setReconnectStatus(0, this.maxReconnectAttempts);
    store.setVoiceCallState('calling');
    store.setActiveCall(null, targetUser);
    this.startCallingTimer();

    try {
      const rtc = this.createWebRtcInstance();
      rtc.setMuted(initialMuted);
      rtc.setDeafened(initialDeafened);
      this.webRtc = rtc;

      await rtc.initLocalAudio();

      if (
        attemptToken !== this.callSessionToken ||
        this.webRtc !== rtc ||
        useAppStore.getState().voiceCallState !== 'calling'
      ) {
        rtc.destroy(false);
        return;
      }

      const latestStore = useAppStore.getState();
      rtc.setMuted(Boolean(latestStore.isMicMuted || latestStore.isDeafened));
      rtc.setDeafened(Boolean(latestStore.isDeafened));
      await rtc.fetchIceServers().catch(() => {});
      rtc.createPeerConnection();

      gatewayClient.sendCallInvite(targetUser.id);
    } catch (err: any) {
      if (attemptToken !== this.callSessionToken) {
        return;
      }
      console.error('[CallService] Falha ao iniciar chamada:', err);
      store.setCallErrorMessage(err?.message || 'Falha ao acessar microfone.');
      this.cleanup();
    }
  }

  /**
   * Aceita uma chamada recebida
   */
  async acceptCall(): Promise<void> {
    const store = useAppStore.getState();
    const inc = store.incomingCall;
    if (!inc || this.isTerminatedCall(inc.callId)) return;

    const attemptToken = ++this.callSessionToken;
    this.pendingCancelBeforeRinging = false;
    this.offerSentForCallId = null;

    const initialMuted = Boolean(store.isMicMuted || store.isDeafened);
    const initialDeafened = Boolean(store.isDeafened);

    store.setCallErrorMessage(null);
    store.setCallDeviceNotice(null);
    store.setReconnectStatus(0, this.maxReconnectAttempts);
    store.setVoiceCallState('connecting');
    store.setActiveCall(inc.callId, {
      id: inc.caller.id,
      name: inc.caller.displayName || inc.caller.username,
      username: inc.caller.username,
      avatarUrl: inc.caller.avatarUrl,
    });
    store.setIncomingCall(null);
    this.startConnectingTimer();

    try {
      const rtc = this.createWebRtcInstance();
      rtc.setMuted(initialMuted);
      rtc.setDeafened(initialDeafened);
      this.webRtc = rtc;

      await rtc.initLocalAudio();

      if (
        attemptToken !== this.callSessionToken ||
        this.webRtc !== rtc ||
        useAppStore.getState().voiceCallState === 'idle' ||
        this.isTerminatedCall(inc.callId)
      ) {
        rtc.destroy(false);
        return;
      }

      const currentMuted = Boolean(
        useAppStore.getState().isMicMuted || useAppStore.getState().isDeafened
      );
      rtc.setMuted(currentMuted);
      rtc.setDeafened(Boolean(useAppStore.getState().isDeafened));
      await rtc.fetchIceServers().catch(() => {});
      rtc.createPeerConnection();

      gatewayClient.sendCallAccept(inc.callId);
      if (currentMuted) {
        gatewayClient.sendCallMute(inc.callId, true);
      }
    } catch (err: any) {
      if (attemptToken !== this.callSessionToken) {
        return;
      }
      console.error('[CallService] Falha ao aceitar chamada:', err);
      this.markCallTerminated(inc.callId);
      gatewayClient.sendCallReject(inc.callId, 'Dispositivo de microfone indisponível.');
      store.setCallErrorMessage(err?.message || 'Falha ao acessar microfone.');
      this.cleanup('rejected');
    }
  }

  /**
   * Recusa chamada recebida
   */
  rejectCall(reason?: string): void {
    const store = useAppStore.getState();
    const inc = store.incomingCall;
    if (inc) {
      this.markCallTerminated(inc.callId);
      gatewayClient.sendCallReject(inc.callId, reason || 'Chamada recusada.');
      store.setIncomingCall(null);
      store.setVoiceCallState('idle');
    }
  }

  /**
   * Cancela chamada pendente (ainda tocando)
   */
  cancelCall(): void {
    const store = useAppStore.getState();
    if (store.activeCallId) {
      this.markCallTerminated(store.activeCallId);
      gatewayClient.sendCallCancel(store.activeCallId);
    } else if (store.voiceCallState === 'calling') {
      this.pendingCancelBeforeRinging = true;
    }
    this.cleanup('canceled');
  }

  /**
   * Encerra chamada ativa
   */
  endCall(reason?: string): void {
    const store = useAppStore.getState();
    if (store.activeCallId) {
      this.markCallTerminated(store.activeCallId);
      if (store.voiceCallState === 'calling') {
        gatewayClient.sendCallCancel(store.activeCallId);
      } else {
        gatewayClient.sendCallEnd(store.activeCallId);
      }
    } else if (store.voiceCallState === 'calling') {
      this.pendingCancelBeforeRinging = true;
    }
    if (reason) {
      store.setCallErrorMessage(reason);
    }
    this.cleanup();
  }

  /**
   * Alterna mute do microfone
   */
  toggleMute(): void {
    useAppStore.getState().toggleMic();
    const updatedStore = useAppStore.getState();
    const effectiveMuted = Boolean(updatedStore.isMicMuted || updatedStore.isDeafened);

    if (effectiveMuted) {
      if (this.localSpeakingTimer) {
        clearTimeout(this.localSpeakingTimer);
        this.localSpeakingTimer = null;
      }
      useAppStore.getState().setSpeakingState('local', false);
      soundEffects.playMute();
    } else {
      soundEffects.playUnmute();
    }

    if (this.webRtc) {
      this.webRtc.setMuted(effectiveMuted);
    }
    if (updatedStore.activeCallId) {
      gatewayClient.sendCallMute(updatedStore.activeCallId, effectiveMuted);
    }
  }

  /**
   * Alterna ensurdecimento (deafen) e sincroniza o estado real da faixa do microfone
   */
  toggleDeafen(): void {
    const store = useAppStore.getState();
    const nextDeafened = !store.isDeafened;
    store.toggleDeafen();
    const updatedStore = useAppStore.getState();
    const nextMuted = Boolean(updatedStore.isMicMuted || nextDeafened);

    if (nextDeafened) {
      this.clearSpeakingTimers();
      useAppStore.getState().setSpeakingState('local', false);
      useAppStore.getState().setSpeakingState('remote', false);
      soundEffects.playMute();
    } else {
      soundEffects.playUnmute();
    }

    if (this.webRtc) {
      this.webRtc.setDeafened(nextDeafened);
      this.webRtc.setMuted(nextMuted);
    }
    if (updatedStore.activeCallId) {
      gatewayClient.sendCallMute(updatedStore.activeCallId, nextMuted);
    }
  }

  private handleSpeakingEvent(target: 'local' | 'remote', rawSpeaking: boolean): void {
    const store = useAppStore.getState();
    const hangoverMs = store.settings.audioVideo.voiceHangoverMs ?? 400;

    if (target === 'local') {
      // WebRTC already applies attack, hysteresis and hangover. Reflect the same
      // stabilized state as the mic test instead of adding a second delay.
      if (this.localSpeakingTimer) {
        clearTimeout(this.localSpeakingTimer);
        this.localSpeakingTimer = null;
      }
      store.setSpeakingState('local', rawSpeaking && !store.isMicMuted && !store.isDeafened);
    } else {
      if (store.isDeafened) {
        if (this.remoteSpeakingTimer) {
          clearTimeout(this.remoteSpeakingTimer);
          this.remoteSpeakingTimer = null;
        }
        store.setSpeakingState('remote', false);
        return;
      }

      if (rawSpeaking) {
        if (this.remoteSpeakingTimer) {
          clearTimeout(this.remoteSpeakingTimer);
          this.remoteSpeakingTimer = null;
        }
        if (!store.isRemoteSpeaking) {
          store.setSpeakingState('remote', true);
        }
      } else {
        if (store.isRemoteSpeaking && !this.remoteSpeakingTimer) {
          this.remoteSpeakingTimer = setTimeout(() => {
            this.remoteSpeakingTimer = null;
            useAppStore.getState().setSpeakingState('remote', false);
          }, hangoverMs);
        }
      }
    }
  }

  private clearSpeakingTimers(): void {
    if (this.localSpeakingTimer) {
      clearTimeout(this.localSpeakingTimer);
      this.localSpeakingTimer = null;
    }
    if (this.remoteSpeakingTimer) {
      clearTimeout(this.remoteSpeakingTimer);
      this.remoteSpeakingTimer = null;
    }
  }

  /**
   * Define o volume individual de um participante (0% a 200%) e persiste a preferência
   */
  setParticipantVolume(peerId: string, volumePercent: number): void {
    if (!peerId) return;
    const clamped = Math.max(0, Math.min(200, Math.round(volumePercent)));
    const store = useAppStore.getState();
    const existing = store.settings.audioVideo.participantVolumes || {};
    store.updateAudioVideo({
      participantVolumes: {
        ...existing,
        [peerId]: clamped,
      },
    });

    if (this.webRtc && store.activeCallPeer?.id === peerId) {
      this.webRtc.setPeerVolume(clamped);
    }
  }

  /**
   * Obtém o volume individual configurado para um participante (padrão 100%)
   */
  getParticipantVolume(peerId?: string | null): number {
    if (!peerId) return 100;
    const vols = useAppStore.getState().settings.audioVideo.participantVolumes;
    if (vols && typeof vols[peerId] === 'number') {
      return vols[peerId];
    }
    return 100;
  }

  /**
   * Define o volume mestre de saída (0% a 100%) em tempo real
   */
  setOutputVolume(volumePercent: number): void {
    const clamped = Math.max(0, Math.min(100, Math.round(volumePercent)));
    useAppStore.getState().updateAudioVideo({ outputVolume: clamped });
    if (this.webRtc) {
      this.webRtc.setOutputVolume(clamped);
    }
  }

  /**
   * Altera o preset de qualidade da transmissão de tela (antes ou durante uma captura ativa)
   */
  async setScreenShareQuality(preset: ScreenShareQualityPreset): Promise<void> {
    const store = useAppStore.getState();
    store.updateAudioVideo({ screenShareQuality: preset });
    const res = await screenCaptureService.setQualityPreset(preset);
    if (this.webRtc) {
      await this.webRtc.applySenderQualityParameters(res.activePreset);
    }
  }

  /**
   * Inicia compartilhamento de tela na chamada ativa e renegocia a conexão WebRTC
   */
  async startScreenShare(preset?: ScreenShareQualityPreset): Promise<MediaStream | null> {
    const store = useAppStore.getState();
    const effectivePreset =
      preset || store.settings.audioVideo.screenShareQuality || 'auto';

    const stream = await screenCaptureService.startCapture(effectivePreset);
    if (!stream) return null;

    const videoTrack = stream.getVideoTracks()[0];
    if (!videoTrack) return null;

    const token = this.callSessionToken;
    if (this.webRtc && store.voiceCallState === 'connected' && store.activeCallId && store.activeCallPeer?.id) {
      try {
        const offerSdp = await this.webRtc.attachScreenTrack(videoTrack, stream, effectivePreset);
        if (token === this.callSessionToken && store.activeCallId && store.activeCallPeer?.id) {
          console.log('[CallService] Enviando SDP Offer de renegociação (tela iniciada).');
          gatewayClient.sendCallWebrtcOffer(store.activeCallId, store.activeCallPeer.id, offerSdp);
        }
      } catch (err) {
        console.error('[CallService] Falha ao renegociar adição de vídeo:', err);
      }
    }

    return stream;
  }

  /**
   * Interrompe compartilhamento de tela na chamada ativa e renegocia sem interromper o áudio
   */
  async stopScreenShare(): Promise<void> {
    screenCaptureService.stopCapture();

    const store = useAppStore.getState();
    const token = this.callSessionToken;

    if (this.webRtc && store.voiceCallState === 'connected' && store.activeCallId && store.activeCallPeer?.id) {
      try {
        const offerSdp = await this.webRtc.detachScreenTrack();
        if (offerSdp && token === this.callSessionToken) {
          console.log('[CallService] Enviando SDP Offer de renegociação (tela encerrada).');
          gatewayClient.sendCallWebrtcOffer(store.activeCallId, store.activeCallPeer.id, offerSdp);
        }
      } catch (err) {
        console.warn('[CallService] Aviso ao renegociar encerramento de vídeo:', err);
      }
    }
  }

  /**
   * Alterna compartilhamento de tela na chamada
   */
  async toggleScreenShare(): Promise<void> {
    const store = useAppStore.getState();
    if (store.isScreenSharing || store.isStartingScreenShare) {
      await this.stopScreenShare();
    } else {
      await this.startScreenShare();
    }
  }

  /**
   * Encerra imediatamente qualquer chamada ativa/pendente e libera microfone antes de logout
   */
  terminateOnLogout(): void {
    screenCaptureService.stopCapture();
    const store = useAppStore.getState();
    if (store.activeCallId) {
      this.markCallTerminated(store.activeCallId);
      if (store.voiceCallState === 'calling') {
        gatewayClient.sendCallCancel(store.activeCallId);
      } else {
        gatewayClient.sendCallEnd(store.activeCallId);
      }
    } else if (store.incomingCall?.callId) {
      this.markCallTerminated(store.incomingCall.callId);
      gatewayClient.sendCallReject(store.incomingCall.callId, 'Usuário encerrou a sessão.');
    } else if (store.voiceCallState === 'calling') {
      this.pendingCancelBeforeRinging = true;
    }
    this.cleanup();
  }

  private startCallingTimer(): void {
    this.clearCallingTimer();
    const token = this.callSessionToken;
    this.callingTimer = setTimeout(() => {
      this.callingTimer = null;
      const store = useAppStore.getState();
      if (token === this.callSessionToken && store.voiceCallState === 'calling') {
        store.setCallErrorMessage('O destinatário não respondeu à chamada.');
        this.cancelCall();
      }
    }, this.callingTimeoutMs);
  }

  private clearCallingTimer(): void {
    if (this.callingTimer) {
      clearTimeout(this.callingTimer);
      this.callingTimer = null;
    }
  }

  private startConnectingTimer(): void {
    this.clearCallingTimer();
    this.clearConnectingTimer();
    const token = this.callSessionToken;
    this.connectingTimer = setTimeout(() => {
      this.connectingTimer = null;
      const store = useAppStore.getState();
      if (token === this.callSessionToken && store.voiceCallState === 'connecting') {
        this.endCall('Tempo limite excedido ao negociar conexão de áudio.');
      }
    }, this.connectingTimeoutMs);
  }

  private clearConnectingTimer(): void {
    if (this.connectingTimer) {
      clearTimeout(this.connectingTimer);
      this.connectingTimer = null;
    }
  }

  private triggerIceRestartAttempt(): void {
    const store = useAppStore.getState();
    if (
      !this.webRtc ||
      store.voiceCallState !== 'reconnecting' ||
      !store.activeCallId ||
      !store.activeCallPeer?.id
    ) {
      return;
    }

    const token = this.callSessionToken;
    this.webRtc
      .createIceRestartOffer()
      .then((offerSdp) => {
        const latest = useAppStore.getState();
        if (
          offerSdp &&
          token === this.callSessionToken &&
          latest.voiceCallState === 'reconnecting' &&
          latest.activeCallId &&
          latest.activeCallPeer?.id
        ) {
          console.log('[CallService] Enviando SDP Offer de ICE Restart ao peer...');
          gatewayClient.sendCallWebrtcOffer(
            latest.activeCallId,
            latest.activeCallPeer.id,
            offerSdp
          );
        }
      })
      .catch((err) => {
        console.warn('[CallService] Aviso durante tentativa de ICE Restart:', err);
      });
  }

  private scheduleNextReconnectAttempt(attemptNumber: number): void {
    if (this.reconnectAttemptTimer) {
      clearTimeout(this.reconnectAttemptTimer);
      this.reconnectAttemptTimer = null;
    }

    if (attemptNumber > this.maxReconnectAttempts) {
      return;
    }

    const token = this.callSessionToken;
    const delayMs = Math.round(
      this.reconnectBackoffBaseMs * Math.pow(1.6, attemptNumber - 1)
    );

    this.reconnectAttemptTimer = setTimeout(() => {
      this.reconnectAttemptTimer = null;
      const store = useAppStore.getState();
      if (token !== this.callSessionToken || store.voiceCallState !== 'reconnecting') {
        return;
      }

      if (this.webRtc?.isMediaConnected()) {
        this.clearReconnectingTimer();
        store.setReconnectStatus(0, this.maxReconnectAttempts);
        store.setVoiceCallState('connected');
        return;
      }

      store.setReconnectStatus(attemptNumber, this.maxReconnectAttempts);
      console.log(
        `[CallService] Tentativa de reconexão controlada ${attemptNumber}/${this.maxReconnectAttempts}...`
      );
      this.triggerIceRestartAttempt();

      if (attemptNumber < this.maxReconnectAttempts) {
        this.scheduleNextReconnectAttempt(attemptNumber + 1);
      }
    }, delayMs);
  }

  private startReconnectingTimer(): void {
    if (this.reconnectingTimer) return;
    const token = this.callSessionToken;
    const store = useAppStore.getState();
    store.setReconnectStatus(1, this.maxReconnectAttempts);

    this.scheduleNextReconnectAttempt(1);

    this.reconnectingTimer = setTimeout(() => {
      this.reconnectingTimer = null;
      if (this.reconnectAttemptTimer) {
        clearTimeout(this.reconnectAttemptTimer);
        this.reconnectAttemptTimer = null;
      }
      const currentStore = useAppStore.getState();
      if (token === this.callSessionToken && currentStore.voiceCallState === 'reconnecting') {
        this.endCall('Não foi possível restabelecer a conexão da chamada.');
      }
    }, this.reconnectingTimeoutMs);
  }

  private clearReconnectingTimer(): void {
    if (this.reconnectingTimer) {
      clearTimeout(this.reconnectingTimer);
      this.reconnectingTimer = null;
    }
    if (this.reconnectAttemptTimer) {
      clearTimeout(this.reconnectAttemptTimer);
      this.reconnectAttemptTimer = null;
    }
  }

  private clearStateTimers(): void {
    this.clearCallingTimer();
    this.clearConnectingTimer();
    this.clearReconnectingTimer();
  }

  private startDurationTimer(): void {
    if (this.durationTimer) return;
    const store = useAppStore.getState();
    store.setCallDurationSecs(0);

    this.durationTimer = setInterval(() => {
      const current = useAppStore.getState().callDurationSecs;
      useAppStore.getState().setCallDurationSecs(current + 1);
    }, 1000);
  }

  private stopDurationTimer(): void {
    if (this.durationTimer) {
      clearInterval(this.durationTimer);
      this.durationTimer = null;
    }
  }

  private cleanup(explicitOutcome?: 'rejected' | 'canceled'): void {
    if (this.isCleaningUp) return;
    this.isCleaningUp = true;
    this.callSessionToken++;
    this.offerSentForCallId = null;

    try {
      this.clearStateTimers();
      this.clearSpeakingTimers();
      this.stopDurationTimer();

      const store = useAppStore.getState();
      if (store.activeCallId) {
        this.markCallTerminated(store.activeCallId);
      }
      if (store.incomingCall?.callId) {
        this.markCallTerminated(store.incomingCall.callId);
      }

      const peer = store.activeCallPeer;
      const duration = store.callDurationSecs;
      const state = store.voiceCallState;

      if (peer) {
        const status =
          state === 'connected' || duration > 0
            ? 'completed'
            : explicitOutcome === 'rejected'
            ? 'rejected'
            : state === 'incoming'
            ? 'missed'
            : 'canceled';

        callHistoryRepository.addEntry({
          peerId: peer.id,
          peerName: peer.name,
          peerUsername: peer.username,
          peerAvatarUrl: peer.avatarUrl,
          direction: state === 'incoming' ? 'incoming' : 'outgoing',
          status,
          durationSecs: duration,
        });
      }

      if (this.webRtc) {
        const rtc = this.webRtc;
        this.webRtc = null;
        rtc.destroy(false);
      }

      screenCaptureService.stopCapture();
      store.setRemoteScreenStream(null, null);
      store.setRemoteScreenMuted(false);

      store.setVoiceCallState('idle');
      store.setActiveCall(null, null);
      store.setIncomingCall(null);
      store.setCallDurationSecs(0);
      store.setReconnectStatus(0, this.maxReconnectAttempts);
      store.setSpeakingState('local', false);
      store.setSpeakingState('remote', false);
      store.setPeerMuted(false);
      store.setCallDeviceNotice(null);
    } finally {
      this.isCleaningUp = false;
    }
  }

  /**
   * Atualiza restrições de cancelamento de eco, supressão de ruído e controle de ganho automático no stream ativo
   */
  applyAudioConstraints(
    noiseSuppression: boolean,
    echoCancellation: boolean,
    autoGainControl = true
  ): void {
    if (this.webRtc) {
      this.webRtc
        .applyAudioConstraints(noiseSuppression, echoCancellation, autoGainControl)
        .catch(console.warn);
    }
  }

  /**
   * Altera microfone em tempo real na chamada
   */
  switchInputDevice(deviceId: string): void {
    if (this.webRtc) {
      this.webRtc.switchInputDevice(deviceId).catch(console.warn);
    }
  }

  /**
   * Altera dispositivo de saída em tempo real na chamada
   */
  switchOutputDevice(deviceId: string): void {
    if (this.webRtc) {
      this.webRtc.switchOutputDevice(deviceId).catch(console.warn);
    }
  }
}

export const callService = new CallService();
