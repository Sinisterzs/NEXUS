/**
 * NEXUS - 1:1 Voice Call Coordinator (Phase 2.4B)
 * Coordina a sinalização WebSocket via GatewayClient e o motor de mídia WebRtcService.
 */

import { gatewayClient } from './GatewayClient';
import { WebRtcService, WebRtcConnectionState } from './WebRtcService';
import { useAppStore } from '../stores/useAppStore';
import { callHistoryRepository } from '../repositories/CallHistoryRepository';
import { soundEffects } from '../lib/soundEffects';

export class CallService {
  private webRtc: WebRtcService | null = null;
  private durationTimer: any = null;
  private initialized = false;
  private isCleaningUp = false;

  init(): void {
    if (this.initialized) return;
    this.initialized = true;

    gatewayClient.addListener({
      onCallRinging: (data) => {
        console.log('[CallService] Confirmação de toque no servidor (call.ringing):', data.callId);
        const store = useAppStore.getState();
        if (store.voiceCallState === 'calling') {
          store.setActiveCall(data.callId, store.activeCallPeer);
        }
      },

      onCallIncoming: (data) => {
        console.log('[CallService] Convite de chamada recebido (call.incoming):', data);
        const store = useAppStore.getState();
        const currentState = store?.voiceCallState ?? 'idle';

        // Rejeita automaticamente APENAS se o usuário estiver de fato em chamada ativa, conectando ou discando
        if (
          currentState === 'calling' ||
          currentState === 'connecting' ||
          currentState === 'connected' ||
          currentState === 'reconnecting'
        ) {
          console.warn(
            `[CallService] Rejeitando chamada ${data.callId} pois usuário está ocupado em estado: ${currentState}`
          );
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
        const store = useAppStore.getState();
        if (store.voiceCallState !== 'calling' && store.activeCallId !== data.callId) {
          console.warn('[CallService] Ignorando call.accepted pois não corresponde ao estado do chamador');
          return;
        }

        store.setActiveCall(data.callId, store.activeCallPeer);
        store.setVoiceCallState('connecting');

        // Como chamador, gera SDP Offer e envia ao peer
        try {
          if (!this.webRtc) {
            this.webRtc = this.createWebRtcInstance();
          }

          const sdp = await this.webRtc.createOffer();
          gatewayClient.sendCallWebrtcOffer(data.callId, data.peerId, sdp);
        } catch (err: any) {
          console.error('[CallService] Falha ao criar SDP Offer:', err);
          this.endCall('Falha na negociação de áudio.');
        }
      },

      onCallRejected: (data) => {
        console.log('[CallService] Chamada recusada (call.rejected):', data);
        const store = useAppStore.getState();
        if (
          store.activeCallId === data.callId ||
          store.incomingCall?.callId === data.callId ||
          store.voiceCallState === 'calling'
        ) {
          store.setCallErrorMessage(data.reason || 'Chamada recusada.');
          this.cleanup();
        }
      },

      onCallCanceled: (data) => {
        console.log('[CallService] Chamada cancelada pelo chamador (call.canceled):', data);
        const store = useAppStore.getState();
        if (
          store.incomingCall?.callId === data.callId ||
          store.activeCallId === data.callId ||
          store.voiceCallState === 'incoming'
        ) {
          store.setIncomingCall(null);
          this.cleanup();
        }
      },

      onCallEnded: (data) => {
        console.log('[CallService] Chamada encerrada pelo peer (call.ended):', data);
        const store = useAppStore.getState();
        if (
          store.activeCallId === data.callId ||
          store.incomingCall?.callId === data.callId ||
          store.voiceCallState !== 'idle'
        ) {
          store.setCallErrorMessage(data.reason || 'Chamada encerrada.');
          this.cleanup();
        }
      },

      onCallParticipantMuted: (data) => {
        console.log('[CallService] Estado de microfone do peer atualizado:', data);
        const store = useAppStore.getState();
        store.setPeerMuted(Boolean(data.isMuted));
      },

      onCallWebrtcOffer: async (data) => {
        console.log('[CallService] SDP Offer recebida do chamador (call.webrtc.offer).');
        const store = useAppStore.getState();
        if (store.activeCallId !== data.callId && store.incomingCall?.callId !== data.callId) return;

        try {
          if (!this.webRtc) {
            this.webRtc = this.createWebRtcInstance();
          }

          const answerSdp = await this.webRtc.handleOffer(data.sdp);
          gatewayClient.sendCallWebrtcAnswer(data.callId, data.senderId, answerSdp);
        } catch (err: any) {
          console.error('[CallService] Falha ao processar SDP Offer:', err);
          this.endCall('Falha ao negociar conexão de áudio.');
        }
      },

      onCallWebrtcAnswer: async (data) => {
        console.log('[CallService] SDP Answer recebida do destinatário (call.webrtc.answer).');
        const store = useAppStore.getState();
        if (store.activeCallId !== data.callId) return;

        try {
          if (this.webRtc) {
            await this.webRtc.handleAnswer(data.sdp);
          }
        } catch (err: any) {
          console.error('[CallService] Falha ao processar SDP Answer:', err);
          this.endCall('Falha ao estabelecer conexão de áudio.');
        }
      },

      onCallWebrtcIceCandidate: async (data) => {
        const store = useAppStore.getState();
        if (store.activeCallId !== data.callId && store.incomingCall?.callId !== data.callId) return;

        if (this.webRtc) {
          await this.webRtc.addIceCandidate(data.candidate);
        }
      },

      onCallError: (data) => {
        console.warn('[CallService] Erro recebido na chamada:', data.message);
        const store = useAppStore.getState();
        store.setCallErrorMessage(data.message);
        if (store.voiceCallState === 'calling' || store.voiceCallState === 'connecting') {
          this.cleanup();
        }
      },

      onConnectionChange: (connected) => {
        if (!connected) {
          const store = useAppStore.getState();
          if (store.voiceCallState === 'connected') {
            store.setVoiceCallState('reconnecting');
          } else if (store.voiceCallState !== 'idle') {
            this.cleanup();
          }
        }
      },
    });
  }

  private createWebRtcInstance(): WebRtcService {
    return new WebRtcService({
      onIceCandidate: (candidate) => {
        const store = useAppStore.getState();
        if (store.activeCallId && store.activeCallPeer?.id) {
          gatewayClient.sendCallWebrtcIceCandidate(
            store.activeCallId,
            store.activeCallPeer.id,
            candidate
          );
        }
      },
      onConnectionStateChange: (state: WebRtcConnectionState) => {
        const store = useAppStore.getState();
        if (state === 'connected') {
          store.setVoiceCallState('connected');
          this.startDurationTimer();
        } else if (state === 'reconnecting') {
          store.setVoiceCallState('reconnecting');
        } else if (state === 'failed') {
          store.setCallErrorMessage('Falha na conexão de mídia P2P.');
          this.endCall('Falha na conectividade WebRTC.');
        } else if (state === 'closed') {
          if (store.voiceCallState !== 'idle') {
            this.cleanup();
          }
        }
      },
      onLocalSpeaking: (isSpeaking) => {
        useAppStore.getState().setSpeakingState('local', isSpeaking);
      },
      onRemoteSpeaking: (isSpeaking) => {
        useAppStore.getState().setSpeakingState('remote', isSpeaking);
      },
      onError: (errMsg) => {
        useAppStore.getState().setCallErrorMessage(errMsg);
      },
    });
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

    store.setCallErrorMessage(null);
    store.setVoiceCallState('calling');
    store.setActiveCall(null, targetUser);

    try {
      this.webRtc = this.createWebRtcInstance();
      // Captura áudio local solicitando consentimento explícito
      await this.webRtc.initLocalAudio();
      this.webRtc.createPeerConnection();

      // Dispara convite no backend
      gatewayClient.sendCallInvite(targetUser.id);
    } catch (err: any) {
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
    if (!inc) return;

    store.setCallErrorMessage(null);
    store.setVoiceCallState('connecting');
    store.setActiveCall(inc.callId, {
      id: inc.caller.id,
      name: inc.caller.displayName || inc.caller.username,
      username: inc.caller.username,
      avatarUrl: inc.caller.avatarUrl,
    });
    store.setIncomingCall(null);

    try {
      this.webRtc = this.createWebRtcInstance();
      await this.webRtc.initLocalAudio();
      this.webRtc.createPeerConnection();

      // Responde aceite ao backend
      gatewayClient.sendCallAccept(inc.callId);
    } catch (err: any) {
      console.error('[CallService] Falha ao aceitar chamada:', err);
      gatewayClient.sendCallReject(inc.callId, 'Dispositivo de microfone indisponível.');
      store.setCallErrorMessage(err?.message || 'Falha ao acessar microfone.');
      this.cleanup();
    }
  }

  /**
   * Recusa chamada recebida
   */
  rejectCall(reason?: string): void {
    const store = useAppStore.getState();
    const inc = store.incomingCall;
    if (inc) {
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
      gatewayClient.sendCallCancel(store.activeCallId);
    }
    this.cleanup();
  }

  /**
   * Encerra chamada ativa
   */
  endCall(reason?: string): void {
    const store = useAppStore.getState();
    if (store.activeCallId) {
      gatewayClient.sendCallEnd(store.activeCallId);
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
    const store = useAppStore.getState();
    const nextMuted = !store.isMicMuted;
    store.toggleMic();

    if (nextMuted) {
      soundEffects.playMute();
    } else {
      soundEffects.playUnmute();
    }

    if (this.webRtc) {
      this.webRtc.setMuted(nextMuted);
    }
    if (store.activeCallId) {
      gatewayClient.sendCallMute(store.activeCallId, nextMuted);
    }
  }

  /**
   * Alterna ensurdecimento (deafen)
   */
  toggleDeafen(): void {
    const store = useAppStore.getState();
    const nextDeafened = !store.isDeafened;
    store.toggleDeafen();

    if (nextDeafened) {
      soundEffects.playMute();
    } else {
      soundEffects.playUnmute();
    }

    if (this.webRtc) {
      this.webRtc.setDeafened(nextDeafened);
    }
  }

  private startDurationTimer(): void {
    this.stopDurationTimer();
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

  private cleanup(): void {
    if (this.isCleaningUp) return;
    this.isCleaningUp = true;

    try {
      this.stopDurationTimer();

      const store = useAppStore.getState();
      const peer = store.activeCallPeer;
      const duration = store.callDurationSecs;
      const state = store.voiceCallState;

      // Grava no histórico de chamadas se havia um participante envolvido
      if (peer) {
        const status =
          state === 'connected' || duration > 0
            ? 'completed'
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

      store.setVoiceCallState('idle');
      store.setActiveCall(null, null);
      store.setIncomingCall(null);
      store.setCallDurationSecs(0);
      store.setSpeakingState('local', false);
      store.setSpeakingState('remote', false);
      store.setPeerMuted(false);
    } finally {
      this.isCleaningUp = false;
    }
  }

  /**
   * Atualiza restrições de cancelamento de eco e supressão de ruído no stream ativo
   */
  applyAudioConstraints(noiseSuppression: boolean, echoCancellation: boolean): void {
    if (this.webRtc) {
      this.webRtc.applyAudioConstraints(noiseSuppression, echoCancellation).catch(console.warn);
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
