/**
 * NEXUS - WebRTC 1:1 Voice Call Engine (Phase 2.4B)
 * Gerencia a captura de microfone com consentimento explícito, DTLS-SRTP,
 * VAD (Voice Activity Detection) e reprodução de áudio Opus.
 */

import { useAppStore } from '../stores/useAppStore';
import { audioDeviceService } from './AudioDeviceService';

export type WebRtcConnectionState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'failed'
  | 'closed';

export type WebRtcCallbacks = {
  onIceCandidate: (candidate: RTCIceCandidateInit) => void;
  onConnectionStateChange: (state: WebRtcConnectionState) => void;
  onLocalSpeaking: (isSpeaking: boolean) => void;
  onRemoteSpeaking: (isSpeaking: boolean) => void;
  onError: (error: string) => void;
};

export class WebRtcService {
  private peerConnection: RTCPeerConnection | null = null;
  private localStream: MediaStream | null = null;
  private remoteStream: MediaStream | null = null;
  private remoteAudioElement: HTMLAudioElement | null = null;

  private localAudioContext: AudioContext | null = null;
  private localAnalyser: AnalyserNode | null = null;
  private remoteAudioContext: AudioContext | null = null;
  private remoteAnalyser: AnalyserNode | null = null;
  private vadInterval: any = null;

  private callbacks: WebRtcCallbacks;
  private isMuted = false;
  private isDeafened = false;
  private candidateQueue: RTCIceCandidateInit[] = [];
  private isRemoteDescriptionSet = false;
  private isDestroyed = false;

  constructor(callbacks: WebRtcCallbacks) {
    this.callbacks = callbacks;
  }

  /**
   * Captura o microfone com autorização explícita e configurações reais de DSP (Echo / Noise Suppression)
   */
  async initLocalAudio(selectedDeviceId?: string): Promise<MediaStream> {
    try {
      this.isDestroyed = false;

      // 1. Sinaliza permissão explícita no runtime nativo Tauri
      const { invoke } = await import('@tauri-apps/api/core');
      try {
        await invoke('call_set_mic_consent', { granted: true });
      } catch (nativeErr) {
        console.warn('[WebRtcService] Falha ao registrar consentimento nativo:', nativeErr);
      }

      // 2. Lê configurações reais do usuário (Dispositivo, Supressão de Ruído e Cancelamento de Eco)
      const audioSettings = useAppStore.getState().settings.audioVideo;
      const deviceIdToUse =
        selectedDeviceId ||
        (audioSettings.inputDevice && audioSettings.inputDevice !== 'default'
          ? audioSettings.inputDevice
          : undefined);

      const constraints: MediaStreamConstraints = {
        audio: {
          deviceId: deviceIdToUse ? { ideal: deviceIdToUse } : undefined,
          echoCancellation: Boolean(audioSettings.echoCancellation),
          noiseSuppression: Boolean(audioSettings.noiseSuppression),
          autoGainControl: true,
        },
        video: false,
      };

      console.log(
        `[WebRtcService] Inicializando captura com restrições reais: EchoCancellation=${audioSettings.echoCancellation}, NoiseSuppression=${audioSettings.noiseSuppression}, DeviceId=${deviceIdToUse || 'default'}`
      );

      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia(constraints);
      } catch (err: any) {
        console.warn('[WebRtcService] Falha com restrições solicitadas, tentando fallback resiliente:', err);
        try {
          // Fallback 1: mantém DSP mas remove restrição de deviceId para evitar OverconstrainedError
          stream = await navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation: Boolean(audioSettings.echoCancellation),
              noiseSuppression: Boolean(audioSettings.noiseSuppression),
              autoGainControl: true,
            },
            video: false,
          });
        } catch (fallbackErr) {
          console.warn('[WebRtcService] Fallback com DSP falhou, capturando áudio padrão do sistema:', fallbackErr);
          // Fallback 2: áudio padrão absoluto
          stream = await navigator.mediaDevices.getUserMedia({
            audio: true,
            video: false,
          });
        }
      }

      this.localStream = stream;

      // 3. Inicializa Voice Activity Detection (VAD) local
      this.setupLocalVad(stream);

      return stream;
    } catch (err: any) {
      // Revoga consentimento nativo em caso de erro
      this.revokeMicConsent();
      const msg =
        err?.name === 'NotAllowedError' || err?.name === 'PermissionDeniedError'
          ? 'Permissão de microfone negada pelo usuário.'
          : `Falha ao acessar dispositivo de áudio: ${err?.message || err}`;
      this.callbacks.onError(msg);
      throw new Error(msg);
    }
  }

  /**
   * Inicializa RTCPeerConnection para chamada 1:1
   */
  createPeerConnection(): RTCPeerConnection {
    this.cleanupPeerConnection();

    // Configuração com fallback STUN para descoberta de reflexivos quando necessário
    const config: RTCConfiguration = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
      ],
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
      iceCandidatePoolSize: 2,
    };

    const pc = new RTCPeerConnection(config);
    this.peerConnection = pc;

    // Adiciona tracks de áudio local se já capturados
    if (this.localStream) {
      this.localStream.getAudioTracks().forEach((track) => {
        pc.addTrack(track, this.localStream!);
      });
    }

    // ICE Candidate gerado
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        // Diagnóstico seguro: registra tipo e protocolo sem expor IP privado nos logs
        const cand = event.candidate;
        console.log(
          `[WebRtcService] ICE Candidate gerado: tipo=${cand.type || 'desconhecido'}, proto=${cand.protocol || 'udp'}, mid=${cand.sdpMid}`
        );
        this.callbacks.onIceCandidate(cand.toJSON());
      }
    };

    // Track de áudio remoto recebido
    pc.ontrack = (event) => {
      console.log('[WebRtcService] Track de áudio remoto recebido:', event.track.kind);
      if (event.track.kind === 'audio') {
        const stream = event.streams[0] || new MediaStream([event.track]);
        this.remoteStream = stream;
        this.playRemoteAudio(stream);
        this.setupRemoteVad(stream);
      }
    };

    // Monitoramento do estado da conexão
    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      console.log('[WebRtcService] connectionState alterado para:', state);
      switch (state) {
        case 'new':
        case 'connecting':
          this.callbacks.onConnectionStateChange('connecting');
          break;
        case 'connected':
          this.callbacks.onConnectionStateChange('connected');
          break;
        case 'disconnected':
          this.callbacks.onConnectionStateChange('reconnecting');
          break;
        case 'failed':
          this.callbacks.onConnectionStateChange('failed');
          break;
        case 'closed':
          this.callbacks.onConnectionStateChange('closed');
          break;
      }
    };

    pc.oniceconnectionstatechange = () => {
      const iceState = pc.iceConnectionState;
      console.log('[WebRtcService] iceConnectionState alterado para:', iceState);
      if (iceState === 'disconnected' || iceState === 'failed') {
        this.callbacks.onConnectionStateChange('reconnecting');
      }
    };

    return pc;
  }

  /**
   * Cria SDP Offer (Chamador)
   */
  async createOffer(): Promise<string> {
    const pc = this.peerConnection || this.createPeerConnection();
    const offer = await pc.createOffer({
      offerToReceiveAudio: true,
      offerToReceiveVideo: false,
    });
    await pc.setLocalDescription(offer);
    console.log('[WebRtcService] SDP Offer criada e aplicada localmente.');
    return offer.sdp || '';
  }

  /**
   * Processa SDP Offer e cria SDP Answer (Destinatário)
   */
  async handleOffer(sdp: string): Promise<string> {
    const pc = this.peerConnection || this.createPeerConnection();

    // Idempotência: se a remoteDescription já possui este mesmo SDP e já temos uma localDescription (answer), reutiliza
    if (pc.remoteDescription?.sdp === sdp && pc.localDescription?.sdp) {
      console.log('[WebRtcService] Offer idêntica já processada com sucesso anteriormente. Reenviando answer existente.');
      return pc.localDescription.sdp;
    }

    if (pc.signalingState === 'have-remote-offer') {
      console.warn('[WebRtcService] Conexão já em have-remote-offer, gerando answer sem re-executar setRemoteDescription.');
    } else {
      await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp }));
    }

    this.isRemoteDescriptionSet = true;
    await this.flushQueuedCandidates();

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    console.log('[WebRtcService] SDP Answer criada e aplicada localmente.');
    return answer.sdp || '';
  }

  /**
   * Processa SDP Answer (Chamador)
   */
  async handleAnswer(sdp: string): Promise<void> {
    if (!this.peerConnection) return;

    if (this.peerConnection.signalingState !== 'have-local-offer') {
      console.warn(
        `[WebRtcService] Ignorando SDP Answer redundante pois signalingState atual é ${this.peerConnection.signalingState}`
      );
      return;
    }

    await this.peerConnection.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp }));
    this.isRemoteDescriptionSet = true;
    await this.flushQueuedCandidates();
    console.log('[WebRtcService] SDP Answer aplicada localmente. Conexão em negociação.');
  }

  /**
   * Adiciona ICE Candidate recebido do peer remoto
   */
  async addIceCandidate(candidateInit: RTCIceCandidateInit): Promise<void> {
    if (!this.peerConnection || !this.isRemoteDescriptionSet) {
      this.candidateQueue.push(candidateInit);
      return;
    }

    try {
      await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidateInit));
      console.log('[WebRtcService] ICE Candidate remoto adicionado com sucesso.');
    } catch (err) {
      console.warn('[WebRtcService] Erro ao adicionar ICE Candidate remoto:', err);
    }
  }

  private async flushQueuedCandidates(): Promise<void> {
    if (!this.peerConnection) return;
    while (this.candidateQueue.length > 0) {
      const cand = this.candidateQueue.shift();
      if (cand) {
        try {
          await this.peerConnection.addIceCandidate(new RTCIceCandidate(cand));
        } catch (e) {
          console.warn('[WebRtcService] Falha ao aplicar candidato enfileirado:', e);
        }
      }
    }
  }

  /**
   * Reproduz o áudio remoto em elemento <audio> dedicado
   */
  private playRemoteAudio(stream: MediaStream): void {
    if (!this.remoteAudioElement) {
      this.remoteAudioElement = new Audio();
      this.remoteAudioElement.autoplay = true;
      // Garante que não apareça na tela
      this.remoteAudioElement.style.display = 'none';
      document.body.appendChild(this.remoteAudioElement);
    }

    this.remoteAudioElement.srcObject = stream;
    this.remoteAudioElement.muted = this.isDeafened;

    // Aplica dispositivo de saída configurado pelo usuário se houver
    const outputDevice = useAppStore.getState().settings.audioVideo.outputDevice;
    if (outputDevice && outputDevice !== 'default') {
      audioDeviceService.setAudioSink(this.remoteAudioElement, outputDevice).catch(() => {});
    }

    this.remoteAudioElement.play().catch((err) => {
      console.warn('[WebRtcService] Autoplay de áudio remoto impedido:', err);
    });
  }

  /**
   * Aplica configurações de DSP nativo (Echo Cancellation & Noise Suppression) em tempo real
   */
  async applyAudioConstraints(noiseSuppression: boolean, echoCancellation: boolean): Promise<void> {
    if (this.localStream) {
      const audioTracks = this.localStream.getAudioTracks();
      for (const track of audioTracks) {
        try {
          await track.applyConstraints({
            noiseSuppression,
            echoCancellation,
            autoGainControl: true,
          });
          console.log(
            `[WebRtcService] DSP atualizado com sucesso: NS=${noiseSuppression}, EC=${echoCancellation}`
          );
        } catch (err) {
          console.warn('[WebRtcService] Falha ao aplicar restrições de áudio:', err);
        }
      }
    }
  }

  /**
   * Troca o microfone ativo durante a chamada sem desconectar
   */
  async switchInputDevice(deviceId: string): Promise<void> {
    if (!this.peerConnection || !this.localStream) return;

    try {
      const audioSettings = useAppStore.getState().settings.audioVideo;
      let newStream: MediaStream;
      try {
        newStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: deviceId && deviceId !== 'default' ? { ideal: deviceId } : undefined,
            echoCancellation: Boolean(audioSettings.echoCancellation),
            noiseSuppression: Boolean(audioSettings.noiseSuppression),
            autoGainControl: true,
          },
          video: false,
        });
      } catch (e) {
        console.warn('[WebRtcService] Falha ao trocar dispositivo com ideal, tentando padrão:', e);
        newStream = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: false,
        });
      }

      const newTrack = newStream.getAudioTracks()[0];
      const senders = this.peerConnection.getSenders();
      const audioSender = senders.find((s) => s.track && s.track.kind === 'audio');

      if (audioSender && newTrack) {
        await audioSender.replaceTrack(newTrack);
      }

      // Finaliza stream anterior
      this.localStream.getAudioTracks().forEach((t) => t.stop());
      this.localStream = newStream;
      this.setupLocalVad(newStream);

      console.log(`[WebRtcService] Microfone alterado com sucesso para: ${deviceId}`);
    } catch (err) {
      console.warn('[WebRtcService] Falha ao trocar dispositivo de microfone:', err);
    }
  }

  /**
   * Troca o dispositivo de saída (alto-falante / fone)
   */
  async switchOutputDevice(deviceId: string): Promise<void> {
    if (this.remoteAudioElement) {
      await audioDeviceService.setAudioSink(this.remoteAudioElement, deviceId);
    }
  }

  /**
   * Configura VAD (Voice Activity Detection) para o microfone local
   */
  private setupLocalVad(stream: MediaStream): void {
    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioCtx) return;

      this.localAudioContext = new AudioCtx();
      const source = this.localAudioContext.createMediaStreamSource(stream);
      this.localAnalyser = this.localAudioContext.createAnalyser();
      this.localAnalyser.fftSize = 256;
      source.connect(this.localAnalyser);

      this.startVadLoop();
    } catch (e) {
      console.warn('[WebRtcService] Falha ao iniciar VAD local:', e);
    }
  }

  /**
   * Configura VAD (Voice Activity Detection) para o áudio remoto
   */
  private setupRemoteVad(stream: MediaStream): void {
    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioCtx) return;

      this.remoteAudioContext = new AudioCtx();
      const source = this.remoteAudioContext.createMediaStreamSource(stream);
      this.remoteAnalyser = this.remoteAudioContext.createAnalyser();
      this.remoteAnalyser.fftSize = 256;
      source.connect(this.remoteAnalyser);
    } catch (e) {
      console.warn('[WebRtcService] Falha ao iniciar VAD remoto:', e);
    }
  }

  /**
   * Loop de análise de energia sonora em tempo real (100ms)
   */
  private startVadLoop(): void {
    if (this.vadInterval) clearInterval(this.vadInterval);

    const dataArrayLocal = new Uint8Array(128);
    const dataArrayRemote = new Uint8Array(128);
    const VAD_THRESHOLD = 18; // Sensibilidade de fala

    let lastLocalSpeaking = false;
    let lastRemoteSpeaking = false;

    this.vadInterval = setInterval(() => {
      // Local
      if (this.localAnalyser && !this.isMuted) {
        this.localAnalyser.getByteFrequencyData(dataArrayLocal);
        const sum = dataArrayLocal.reduce((acc, val) => acc + val, 0);
        const avg = sum / dataArrayLocal.length;
        const isSpeaking = avg > VAD_THRESHOLD;
        if (isSpeaking !== lastLocalSpeaking) {
          lastLocalSpeaking = isSpeaking;
          this.callbacks.onLocalSpeaking(isSpeaking);
        }
      } else if (lastLocalSpeaking) {
        lastLocalSpeaking = false;
        this.callbacks.onLocalSpeaking(false);
      }

      // Remoto
      if (this.remoteAnalyser && !this.isDeafened) {
        this.remoteAnalyser.getByteFrequencyData(dataArrayRemote);
        const sum = dataArrayRemote.reduce((acc, val) => acc + val, 0);
        const avg = sum / dataArrayRemote.length;
        const isSpeaking = avg > VAD_THRESHOLD;
        if (isSpeaking !== lastRemoteSpeaking) {
          lastRemoteSpeaking = isSpeaking;
          this.callbacks.onRemoteSpeaking(isSpeaking);
        }
      } else if (lastRemoteSpeaking) {
        lastRemoteSpeaking = false;
        this.callbacks.onRemoteSpeaking(false);
      }
    }, 100);
  }

  /**
   * Silencia ou reativa o microfone local
   */
  setMuted(muted: boolean): void {
    this.isMuted = muted;
    if (this.localStream) {
      this.localStream.getAudioTracks().forEach((track) => {
        track.enabled = !muted;
      });
    }
  }

  /**
   * Desativa ou reativa o áudio de saída
   */
  setDeafened(deafened: boolean): void {
    this.isDeafened = deafened;
    if (this.remoteAudioElement) {
      this.remoteAudioElement.muted = deafened;
    }
  }

  /**
   * Encerramento completo e liberação rigorosa de recursos
   */
  destroy(emitClosed = false): void {
    if (this.isDestroyed) return;
    this.isDestroyed = true;
    console.log('[WebRtcService] Destruindo sessão WebRTC e liberando microfone...');

    if (this.vadInterval) {
      clearInterval(this.vadInterval);
      this.vadInterval = null;
    }

    // Interrompe captura de microfone imediatamente
    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch {}
      });
      this.localStream = null;
    }

    if (this.remoteStream) {
      this.remoteStream.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch {}
      });
      this.remoteStream = null;
    }

    if (this.localAudioContext) {
      this.localAudioContext.close().catch(() => {});
      this.localAudioContext = null;
      this.localAnalyser = null;
    }

    if (this.remoteAudioContext) {
      this.remoteAudioContext.close().catch(() => {});
      this.remoteAudioContext = null;
      this.remoteAnalyser = null;
    }

    if (this.remoteAudioElement) {
      this.remoteAudioElement.srcObject = null;
      this.remoteAudioElement.remove();
      this.remoteAudioElement = null;
    }

    this.cleanupPeerConnection();
    this.revokeMicConsent();

    try {
      this.callbacks.onLocalSpeaking(false);
      this.callbacks.onRemoteSpeaking(false);
      if (emitClosed) {
        this.callbacks.onConnectionStateChange('closed');
      }
    } catch {}
  }

  private cleanupPeerConnection(): void {
    if (this.peerConnection) {
      this.peerConnection.onicecandidate = null;
      this.peerConnection.ontrack = null;
      this.peerConnection.onconnectionstatechange = null;
      this.peerConnection.oniceconnectionstatechange = null;
      this.peerConnection.close();
      this.peerConnection = null;
    }
    this.candidateQueue = [];
    this.isRemoteDescriptionSet = false;
  }

  private revokeMicConsent(): void {
    import('@tauri-apps/api/core')
      .then(({ invoke }) => {
        invoke('call_set_mic_consent', { granted: false }).catch(() => {});
      })
      .catch(() => {});
  }
}
