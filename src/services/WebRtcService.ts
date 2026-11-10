/**
 * NEXUS - WebRTC 1:1 Voice & Screen Call Engine (Calls & Streaming 2.0)
 * Gerencia captura de microfone com consentimento explícito, seleção e fallback
 * dinâmico de periféricos, controle de volume individual por participante,
 * DSP (AEC, NS, AGC), compartilhamento de tela com controle de qualidade/bitrate,
 * ICE Restart controlado e diagnóstico de mídia via getStats().
 */

import { useAppStore } from '../stores/useAppStore';
import { audioDeviceService } from './AudioDeviceService';
import { screenCaptureService } from './ScreenCaptureService';
import { ScreenShareQualityPreset } from '../lib/types';

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
  onRemoteVideoTrack?: (track: MediaStreamTrack, stream: MediaStream) => void;
  onRemoteVideoMuteChange?: (isMuted: boolean) => void;
  onRemoteVideoEnded?: () => void;
  onDeviceFallback?: (kind: 'input' | 'output', reason: string) => void;
};

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
}

export const MAX_CANDIDATE_QUEUE_SIZE = 256;
export const DEFAULT_ICE_DISCONNECT_TIMEOUT_MS = 12000;

function classifyCandidateAddressPair(
  localAddr?: string | null,
  remoteAddr?: string | null
): WebRtcTransportDiagnostics['networkClassification'] {
  const isTailscaleV4 = (ip?: string | null): boolean => {
    if (!ip) return false;
    const parts = ip.trim().split('.');
    if (parts.length !== 4) return false;
    const nums = parts.map((p) => Number(p));
    if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
    return nums[0] === 100 && nums[1] >= 64 && nums[1] <= 127;
  };

  const isTailscaleV6 = (ip?: string | null): boolean => {
    if (!ip) return false;
    return ip.trim().toLowerCase().startsWith('fd7a:115c:a1e0:');
  };

  const isLoopback = (ip?: string | null): boolean => {
    if (!ip) return false;
    const clean = ip.trim().toLowerCase();
    return clean === '127.0.0.1' || clean === '::1' || clean === 'localhost';
  };

  if (isTailscaleV4(localAddr) && isTailscaleV4(remoteAddr)) {
    return 'tailscale-cg-nat';
  }
  if (isTailscaleV6(localAddr) && isTailscaleV6(remoteAddr)) {
    return 'tailscale-ipv6-ula';
  }
  if (isLoopback(localAddr) && isLoopback(remoteAddr)) {
    return 'loopback';
  }
  if (localAddr || remoteAddr) {
    return 'lan-or-reflexive';
  }
  return 'unknown';
}

export class WebRtcService {
  private peerConnection: RTCPeerConnection | null = null;
  private localStream: MediaStream | null = null;
  private remoteStream: MediaStream | null = null;
  private remoteAudioElement: HTMLAudioElement | null = null;

  private localAudioContext: AudioContext | null = null;
  private localAnalyser: AnalyserNode | null = null;
  private remoteAudioContext: AudioContext | null = null;
  private remoteAnalyser: AnalyserNode | null = null;
  private remoteBoostGain: GainNode | null = null;
  private vadInterval: any = null;
  private iceDisconnectTimer: any = null;
  private iceDisconnectTimeoutMs = DEFAULT_ICE_DISCONNECT_TIMEOUT_MS;

  private callbacks: WebRtcCallbacks;
  private isPolite = false;
  private screenVideoTrack: MediaStreamTrack | null = null;
  private screenVideoSender: RTCRtpSender | null = null;
  private remoteVideoStream: MediaStream | null = null;
  private isMuted = false;
  private isDeafened = false;
  private outputVolumePercent = 85;
  private peerVolumePercent = 100;
  private boundLocalMicEndedHandler: (() => void) | null = null;
  private boundLocalMicTrack: MediaStreamTrack | null = null;

  private candidateQueue: RTCIceCandidateInit[] = [];
  private isRemoteDescriptionSet = false;
  private isFlushingCandidates = false;
  private hasAppliedRemoteAnswer = false;
  private lastAnsweredOfferSdp: string | null = null;
  private lastGeneratedAnswerSdp: string | null = null;
  private signalingChain: Promise<any> = Promise.resolve();
  private currentState: WebRtcConnectionState = 'idle';
  private lastDiagnostics: WebRtcTransportDiagnostics | null = null;
  private prevStatsSnapshot: {
    timestampMs: number;
    audioBytes: number;
    videoBytes: number;
  } | null = null;
  private isDestroyed = false;
  private cachedIceServers: RTCIceServer[] | null = null;
  private lastIceServersFetch = 0;

  constructor(
    callbacks: WebRtcCallbacks,
    options?: {
      iceDisconnectTimeoutMs?: number;
      isPolite?: boolean;
      outputVolumePercent?: number;
      peerVolumePercent?: number;
    }
  ) {
    this.callbacks = callbacks;
    if (options?.iceDisconnectTimeoutMs !== undefined) {
      this.iceDisconnectTimeoutMs = options.iceDisconnectTimeoutMs;
    }
    if (options?.isPolite !== undefined) {
      this.isPolite = options.isPolite;
    }
    if (options?.outputVolumePercent !== undefined) {
      this.outputVolumePercent = Math.max(0, Math.min(100, options.outputVolumePercent));
    }
    if (options?.peerVolumePercent !== undefined) {
      this.peerVolumePercent = Math.max(0, Math.min(200, options.peerVolumePercent));
    }
  }

  public setPolite(polite: boolean): void {
    this.isPolite = polite;
  }

  public getRemoteVideoStream(): MediaStream | null {
    return this.remoteVideoStream;
  }

  public getOutputVolume(): number {
    return this.outputVolumePercent;
  }

  public getPeerVolume(): number {
    return this.peerVolumePercent;
  }

  private enqueueSignaling<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.signalingChain.then(operation, operation);
    this.signalingChain = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  public getConnectionState(): WebRtcConnectionState {
    return this.currentState;
  }

  public isMediaConnected(): boolean {
    if (this.isDestroyed || !this.peerConnection) return false;
    const connState = this.peerConnection.connectionState;
    const iceState = this.peerConnection.iceConnectionState;
    return (
      connState === 'connected' ||
      iceState === 'connected' ||
      iceState === 'completed'
    );
  }

  public getLastDiagnostics(): WebRtcTransportDiagnostics | null {
    return this.lastDiagnostics;
  }

  private emitConnectionState(nextState: WebRtcConnectionState): void {
    if (this.isDestroyed && nextState !== 'closed') return;
    if (this.currentState === nextState) return;
    this.currentState = nextState;
    this.callbacks.onConnectionStateChange(nextState);
  }

  private clearIceDisconnectTimer(): void {
    if (this.iceDisconnectTimer) {
      clearTimeout(this.iceDisconnectTimer);
      this.iceDisconnectTimer = null;
    }
  }

  private scheduleIceDisconnectTimeout(pc: RTCPeerConnection): void {
    this.clearIceDisconnectTimer();
    this.iceDisconnectTimer = setTimeout(() => {
      this.iceDisconnectTimer = null;
      if (this.isDestroyed || this.peerConnection !== pc) return;
      const connState = pc.connectionState;
      const iceState = pc.iceConnectionState;
      if (
        connState === 'disconnected' ||
        connState === 'failed' ||
        iceState === 'disconnected' ||
        iceState === 'failed'
      ) {
        console.warn('[WebRtcService] Timeout de recuperação ICE atingido. Declarando falha na conexão P2P.');
        this.emitConnectionState('failed');
      }
    }, this.iceDisconnectTimeoutMs);
  }

  private attachLocalMicEndedListener(track: MediaStreamTrack | null): void {
    this.detachLocalMicEndedListener();
    if (!track || typeof track.addEventListener !== 'function') return;

    this.boundLocalMicTrack = track;
    this.boundLocalMicEndedHandler = () => {
      if (this.isDestroyed || this.boundLocalMicTrack !== track) return;
      console.warn('[WebRtcService] Microfone ativo desconectado inesperadamente (ended). Acionando fallback padrão...');
      this.callbacks.onDeviceFallback?.(
        'input',
        'O microfone em uso foi desconectado. Alternado automaticamente para o microfone padrão.'
      );
      this.switchInputDevice('default').catch((err) => {
        console.warn('[WebRtcService] Falha no fallback automático de microfone:', err);
      });
    };
    track.addEventListener('ended', this.boundLocalMicEndedHandler);
  }

  private detachLocalMicEndedListener(): void {
    if (this.boundLocalMicTrack && this.boundLocalMicEndedHandler) {
      try {
        this.boundLocalMicTrack.removeEventListener('ended', this.boundLocalMicEndedHandler);
      } catch {}
    }
    this.boundLocalMicTrack = null;
    this.boundLocalMicEndedHandler = null;
  }

  /**
   * Captura o microfone com autorização explícita e configurações reais de DSP (AEC / NS / AGC)
   */
  async initLocalAudio(selectedDeviceId?: string): Promise<MediaStream> {
    try {
      this.isDestroyed = false;

      // 1. Sinaliza permissão explícita no runtime nativo Tauri
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('call_set_mic_consent', { granted: true });
      } catch (nativeErr) {
        console.warn('[WebRtcService] Falha ao registrar consentimento nativo:', nativeErr);
      }

      if (this.isDestroyed) {
        this.revokeMicConsent();
        throw new Error('Captura de áudio cancelada pois a chamada já foi encerrada.');
      }

      // 2. Lê configurações reais do usuário (Dispositivo, Supressão de Ruído, Cancelamento de Eco e AGC)
      const audioSettings = useAppStore.getState().settings.audioVideo;
      const caps = audioDeviceService.getCapabilities();
      const deviceIdToUse =
        selectedDeviceId ||
        (audioSettings.inputDevice && audioSettings.inputDevice !== 'default'
          ? audioSettings.inputDevice
          : undefined);

      const useEcho = caps.echoCancellation ? Boolean(audioSettings.echoCancellation) : false;
      const useNoise = caps.noiseSuppression ? Boolean(audioSettings.noiseSuppression) : false;
      const useAgc = caps.autoGainControl ? Boolean(audioSettings.autoGainControl ?? true) : false;

      const constraints: MediaStreamConstraints = {
        audio: {
          deviceId: deviceIdToUse ? { ideal: deviceIdToUse } : undefined,
          echoCancellation: useEcho,
          noiseSuppression: useNoise,
          autoGainControl: useAgc,
        },
        video: false,
      };

      console.log(
        `[WebRtcService] Inicializando captura: AEC=${useEcho}, NS=${useNoise}, AGC=${useAgc}, DeviceId=${deviceIdToUse || 'default'}`
      );

      let stream: MediaStream;
      let didFallbackDevice = false;
      try {
        stream = await navigator.mediaDevices.getUserMedia(constraints);
      } catch (err: any) {
        const errName = err?.name || '';
        if (errName === 'NotAllowedError' || errName === 'PermissionDeniedError') {
          throw err;
        }
        console.warn('[WebRtcService] Falha com restrições solicitadas, tentando fallback resiliente:', err);
        didFallbackDevice = Boolean(deviceIdToUse);
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation: useEcho,
              noiseSuppression: useNoise,
              autoGainControl: useAgc,
            },
            video: false,
          });
        } catch (fallbackErr) {
          console.warn('[WebRtcService] Fallback com DSP falhou, capturando áudio padrão do sistema:', fallbackErr);
          stream = await navigator.mediaDevices.getUserMedia({
            audio: true,
            video: false,
          });
        }
      }

      if (this.isDestroyed) {
        stream.getTracks().forEach((track) => {
          try {
            track.stop();
          } catch {}
        });
        this.revokeMicConsent();
        throw new Error('Captura de áudio cancelada pois a chamada já foi encerrada.');
      }

      if (didFallbackDevice) {
        this.callbacks.onDeviceFallback?.(
          'input',
          'Dispositivo de microfone selecionado indisponível; utilizando microfone padrão do sistema.'
        );
      }

      // Garante que o estado real da faixa de áudio corresponda ao mute atual desde o primeiro frame
      const audioTrack = stream.getAudioTracks()[0] || null;
      stream.getAudioTracks().forEach((track) => {
        track.enabled = !this.isMuted;
      });

      this.localStream = stream;
      this.attachLocalMicEndedListener(audioTrack);

      // 3. Inicializa Voice Activity Detection (VAD) local
      this.setupLocalVad(stream);

      return stream;
    } catch (err: any) {
      this.revokeMicConsent();
      const msg =
        err?.name === 'NotAllowedError' || err?.name === 'PermissionDeniedError'
          ? 'Permissão de microfone negada pelo usuário.'
          : `Falha ao acessar dispositivo de áudio: ${err?.message || err}`;
      if (!this.isDestroyed) {
        this.callbacks.onError(msg);
      }
      throw new Error(msg);
    }
  }

  /**
   * Consulta os servidores ICE (/v1/webrtc/ice-servers) no backend autenticado com fallback local
   */
  public async fetchIceServers(): Promise<RTCIceServer[]> {
    const now = Date.now();
    if (this.cachedIceServers && now - this.lastIceServersFetch < 600_000) {
      return this.cachedIceServers;
    }

    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const servers = await invoke<Array<{ urls: string | string[]; username?: string; credential?: string }>>(
        'webrtc_get_ice_servers'
      );
      if (servers && servers.length > 0) {
        this.cachedIceServers = servers as RTCIceServer[];
        this.lastIceServersFetch = now;
        return this.cachedIceServers;
      }
    } catch (err) {
      console.warn('[WebRtcService] Falha ao consultar /v1/webrtc/ice-servers, usando fallback STUN:', err);
    }

    const fallback: RTCIceServer[] = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
    ];
    this.cachedIceServers = fallback;
    this.lastIceServersFetch = now;
    return fallback;
  }

  /**
   * Inicializa RTCPeerConnection para chamada 1:1 preservando candidatos ICE recebidos antecipadamente
   */
  createPeerConnection(customIceServers?: RTCIceServer[]): RTCPeerConnection {
    if (this.peerConnection) {
      this.cleanupPeerConnection(false);
    }

    const iceServers = customIceServers || this.cachedIceServers || [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
    ];

    const config: RTCConfiguration = {
      iceServers,
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
      iceCandidatePoolSize: 2,
    };

    const pc = new RTCPeerConnection(config);
    this.peerConnection = pc;
    this.isRemoteDescriptionSet = false;
    this.hasAppliedRemoteAnswer = false;
    this.lastAnsweredOfferSdp = null;
    this.lastGeneratedAnswerSdp = null;

    if (this.localStream) {
      this.localStream.getAudioTracks().forEach((track) => {
        track.enabled = !this.isMuted;
        pc.addTrack(track, this.localStream!);
      });
    }

    pc.onicecandidate = (event) => {
      if (this.isDestroyed || this.peerConnection !== pc) return;
      if (event.candidate && event.candidate.candidate) {
        const cand = event.candidate;
        console.log(
          `[WebRtcService] ICE Candidate gerado: tipo=${cand.type || 'desconhecido'}, proto=${cand.protocol || 'udp'}, mid=${cand.sdpMid}`
        );
        const jsonCand = typeof cand.toJSON === 'function' ? cand.toJSON() : {
          candidate: cand.candidate,
          sdpMid: cand.sdpMid,
          sdpMLineIndex: cand.sdpMLineIndex,
        };
        this.callbacks.onIceCandidate(jsonCand);
      }
    };

    pc.ontrack = (event) => {
      if (this.isDestroyed || this.peerConnection !== pc) return;
      console.log('[WebRtcService] Track remoto recebido:', event.track.kind, event.track.id);
      if (event.track.kind === 'audio') {
        const stream =
          event.streams && event.streams[0]
            ? event.streams[0]
            : new MediaStream([event.track]);
        this.remoteStream = stream;
        this.playRemoteAudio(stream);
        this.setupRemoteVad(stream);
      } else if (event.track.kind === 'video') {
        const stream =
          event.streams && event.streams[0]
            ? event.streams[0]
            : new MediaStream([event.track]);
        this.remoteVideoStream = stream;
        console.log('[WebRtcService] Faixa de vídeo remoto de tela recebida:', event.track.id);
        this.callbacks.onRemoteVideoTrack?.(event.track, stream);

        event.track.onmute = () => {
          console.log('[WebRtcService] Faixa de vídeo remoto pausada (mute).');
          this.callbacks.onRemoteVideoMuteChange?.(true);
        };
        event.track.onunmute = () => {
          console.log('[WebRtcService] Faixa de vídeo remoto retomada (unmute).');
          this.callbacks.onRemoteVideoMuteChange?.(false);
        };
        event.track.onended = () => {
          console.log('[WebRtcService] Faixa de vídeo remoto finalizada (ended).');
          this.remoteVideoStream = null;
          this.callbacks.onRemoteVideoEnded?.();
        };
      }
    };

    pc.onconnectionstatechange = () => {
      if (this.isDestroyed || this.peerConnection !== pc) return;
      const state = pc.connectionState;
      console.log('[WebRtcService] connectionState alterado para:', state);
      switch (state) {
        case 'new':
        case 'connecting':
          this.emitConnectionState('connecting');
          break;
        case 'connected':
          this.clearIceDisconnectTimer();
          this.emitConnectionState('connected');
          this.collectTransportDiagnostics().catch(() => {});
          break;
        case 'disconnected':
          this.emitConnectionState('reconnecting');
          this.scheduleIceDisconnectTimeout(pc);
          break;
        case 'failed':
          this.clearIceDisconnectTimer();
          this.emitConnectionState('failed');
          break;
        case 'closed':
          this.clearIceDisconnectTimer();
          this.emitConnectionState('closed');
          break;
      }
    };

    pc.oniceconnectionstatechange = () => {
      if (this.isDestroyed || this.peerConnection !== pc) return;
      const iceState = pc.iceConnectionState;
      console.log('[WebRtcService] iceConnectionState alterado para:', iceState);
      if (iceState === 'connected' || iceState === 'completed') {
        this.clearIceDisconnectTimer();
        this.emitConnectionState('connected');
      } else if (iceState === 'disconnected') {
        this.emitConnectionState('reconnecting');
        this.scheduleIceDisconnectTimeout(pc);
      } else if (iceState === 'failed') {
        this.clearIceDisconnectTimer();
        this.emitConnectionState('failed');
      } else if (iceState === 'closed') {
        this.clearIceDisconnectTimer();
        this.emitConnectionState('closed');
      }
    };

    return pc;
  }

  /**
   * Aplica parâmetros de bitrate e framerate no RTCRtpSender de vídeo conforme o preset de qualidade
   */
  public async applySenderQualityParameters(preset?: ScreenShareQualityPreset): Promise<void> {
    if (!this.screenVideoSender || typeof this.screenVideoSender.getParameters !== 'function') {
      return;
    }

    const targets = screenCaptureService.getEncodingTargets(preset);
    try {
      const params = this.screenVideoSender.getParameters();
      if (!params.encodings || params.encodings.length === 0) {
        params.encodings = [{}];
      }
      params.encodings[0].maxBitrate = targets.maxBitrate;
      params.encodings[0].maxFramerate = targets.maxFramerate;
      if (typeof this.screenVideoSender.setParameters === 'function') {
        await this.screenVideoSender.setParameters(params);
      }
      console.log(
        `[WebRtcService] Parâmetros de codificação de vídeo aplicados: maxBitrate=${targets.maxBitrate} bps, maxFramerate=${targets.maxFramerate} fps`
      );
    } catch (paramErr) {
      console.warn('[WebRtcService] Aviso ao configurar parâmetros do sender de vídeo:', paramErr);
    }
  }

  /**
   * Vincula a track de vídeo de tela local à conexão WebRTC existente e retorna o novo SDP Offer
   */
  async attachScreenTrack(
    track: MediaStreamTrack,
    stream: MediaStream,
    preset?: ScreenShareQualityPreset
  ): Promise<string> {
    return this.enqueueSignaling(async () => {
      if (this.isDestroyed) {
        throw new Error('Sessão WebRTC já encerrada.');
      }
      const pc = this.peerConnection || this.createPeerConnection();
      this.screenVideoTrack = track;

      const existingSender = pc.getSenders().find(
        (s) => s.track?.kind === 'video' || (s.track === null && (s as any).kind === 'video')
      );

      if (existingSender) {
        this.screenVideoSender = existingSender;
        await existingSender.replaceTrack(track);
        console.log('[WebRtcService] Track de vídeo substituído no sender existente via replaceTrack.');
      } else {
        this.screenVideoSender = pc.addTrack(track, stream);
        console.log('[WebRtcService] Nova faixa de vídeo anexada via addTrack.');
      }

      await this.applySenderQualityParameters(preset);

      this.hasAppliedRemoteAnswer = false;
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      console.log('[WebRtcService] SDP Offer de renegociação (vídeo adicionado) criada com sucesso.');
      return offer.sdp || '';
    });
  }

  /**
   * Desvincula a faixa de vídeo de tela sem reiniciar o peer connection nem fechar áudio
   */
  async detachScreenTrack(): Promise<string | null> {
    return this.enqueueSignaling(async () => {
      if (this.isDestroyed || !this.peerConnection) return null;
      const pc = this.peerConnection;

      if (this.screenVideoSender) {
        try {
          await this.screenVideoSender.replaceTrack(null);
          pc.removeTrack(this.screenVideoSender);
        } catch (err) {
          console.warn('[WebRtcService] Aviso ao remover faixa de vídeo:', err);
        }
        this.screenVideoSender = null;
      }
      this.screenVideoTrack = null;

      if (pc.signalingState === 'stable') {
        this.hasAppliedRemoteAnswer = false;
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        console.log('[WebRtcService] SDP Offer de renegociação (vídeo removido) criada com sucesso.');
        return offer.sdp || null;
      }
      return null;
    });
  }

  /**
   * Cria SDP Offer (Chamador) de forma serializada e idempotente
   */
  async createOffer(): Promise<string> {
    return this.enqueueSignaling(async () => {
      if (this.isDestroyed) {
        throw new Error('Sessão WebRTC já encerrada.');
      }

      const pc = this.peerConnection || this.createPeerConnection();

      if (pc.signalingState === 'have-local-offer' && pc.localDescription?.sdp) {
        console.log('[WebRtcService] Reutilizando SDP Offer local já ativa (have-local-offer).');
        return pc.localDescription.sdp;
      }

      this.hasAppliedRemoteAnswer = false;

      const offer = await pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: this.screenVideoTrack !== null,
      });

      if (this.isDestroyed || this.peerConnection !== pc) {
        throw new Error('Sessão WebRTC encerrada durante createOffer.');
      }

      await pc.setLocalDescription(offer);
      console.log('[WebRtcService] SDP Offer criada e aplicada localmente.');
      return offer.sdp || '';
    });
  }

  /**
   * Cria SDP Offer com iceRestart=true para recuperar conexão de mídia após oscilação de rede
   */
  async createIceRestartOffer(): Promise<string | null> {
    return this.enqueueSignaling(async () => {
      if (this.isDestroyed || !this.peerConnection) {
        return null;
      }
      const pc = this.peerConnection;

      try {
        if (typeof pc.restartIce === 'function') {
          pc.restartIce();
        }
      } catch {}

      if (pc.signalingState !== 'stable') {
        console.warn(
          `[WebRtcService] Aguardando estado stable para ICE Restart (atual=${pc.signalingState}).`
        );
        return null;
      }

      this.hasAppliedRemoteAnswer = false;
      const offer = await pc.createOffer({
        iceRestart: true,
        offerToReceiveAudio: true,
        offerToReceiveVideo: this.screenVideoTrack !== null,
      });

      if (this.isDestroyed || this.peerConnection !== pc) {
        return null;
      }

      await pc.setLocalDescription(offer);
      console.log('[WebRtcService] SDP Offer de ICE Restart gerada com sucesso.');
      return offer.sdp || null;
    });
  }

  /**
   * Processa SDP Offer e cria SDP Answer (Destinatário) de forma serializada e idempotente
   */
  async handleOffer(sdp: string): Promise<string> {
    return this.enqueueSignaling(async () => {
      if (this.isDestroyed) {
        throw new Error('Sessão WebRTC já encerrada.');
      }

      const pc = this.peerConnection || this.createPeerConnection();

      if (
        (this.lastAnsweredOfferSdp === sdp || pc.remoteDescription?.sdp === sdp) &&
        (this.lastGeneratedAnswerSdp || pc.localDescription?.sdp)
      ) {
        console.log(
          '[WebRtcService] Offer duplicada detectada. Reenviando SDP Answer já estabelecida sem renegociar.'
        );
        return this.lastGeneratedAnswerSdp || pc.localDescription?.sdp || '';
      }

      const isOfferCollision = pc.signalingState === 'have-local-offer';
      if (isOfferCollision) {
        if (!this.isPolite) {
          console.warn('[WebRtcService] Colisão de ofertas detectada. Peer impolite ignora oferta concorrente.');
          return this.lastGeneratedAnswerSdp || pc.localDescription?.sdp || '';
        }
        console.log('[WebRtcService] Colisão de ofertas detectada. Peer polite realiza rollback local.');
        try {
          await pc.setLocalDescription({ type: 'rollback' });
        } catch (rollbackErr) {
          console.warn('[WebRtcService] Falha ao executar rollback no peer polite:', rollbackErr);
        }
      }

      if (pc.signalingState === 'have-remote-offer') {
        console.warn(
          '[WebRtcService] Conexão já em have-remote-offer, gerando answer sem re-executar setRemoteDescription.'
        );
      } else {
        await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp }));
      }

      if (this.isDestroyed || this.peerConnection !== pc) {
        throw new Error('Sessão WebRTC encerrada durante handleOffer.');
      }

      this.isRemoteDescriptionSet = true;
      await this.flushQueuedCandidates();

      const answer = await pc.createAnswer();
      if (this.isDestroyed || this.peerConnection !== pc) {
        throw new Error('Sessão WebRTC encerrada durante createAnswer.');
      }

      await pc.setLocalDescription(answer);
      const answerSdp = answer.sdp || '';
      this.lastAnsweredOfferSdp = sdp;
      this.lastGeneratedAnswerSdp = answerSdp;

      await this.flushQueuedCandidates();
      console.log('[WebRtcService] SDP Answer criada e aplicada localmente.');
      return answerSdp;
    });
  }

  /**
   * Processa SDP Answer (Chamador) de forma serializada e idempotente
   */
  async handleAnswer(sdp: string): Promise<void> {
    return this.enqueueSignaling(async () => {
      if (this.isDestroyed || !this.peerConnection) return;
      const pc = this.peerConnection;

      if (this.hasAppliedRemoteAnswer || pc.signalingState === 'stable') {
        console.log(
          `[WebRtcService] Ignorando SDP Answer duplicada ou tardia (signalingState=stable).`
        );
        return;
      }

      if (pc.signalingState !== 'have-local-offer') {
        console.warn(
          `[WebRtcService] Ignorando SDP Answer fora de estado esperado (signalingState=${pc.signalingState}).`
        );
        return;
      }

      await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp }));
      if (this.isDestroyed || this.peerConnection !== pc) return;

      this.isRemoteDescriptionSet = true;
      this.hasAppliedRemoteAnswer = true;
      await this.flushQueuedCandidates();
      console.log('[WebRtcService] SDP Answer aplicada localmente. Conexão renegociada com sucesso.');
    });
  }

  /**
   * Adiciona ICE Candidate recebido do peer remoto preservando ordem FIFO estrita
   */
  async addIceCandidate(candidateInput: RTCIceCandidateInit | string): Promise<void> {
    if (this.isDestroyed || !candidateInput) return;

    let candidateInit: RTCIceCandidateInit;
    if (typeof candidateInput === 'string') {
      try {
        candidateInit = JSON.parse(candidateInput);
      } catch {
        candidateInit = { candidate: candidateInput, sdpMid: '0', sdpMLineIndex: 0 };
      }
    } else {
      candidateInit = candidateInput;
    }

    if (
      !candidateInit ||
      (!candidateInit.candidate &&
        candidateInit.sdpMid == null &&
        candidateInit.sdpMLineIndex == null)
    ) {
      return;
    }

    if (this.candidateQueue.length >= MAX_CANDIDATE_QUEUE_SIZE) {
      this.candidateQueue.shift();
    }
    this.candidateQueue.push(candidateInit);

    if (this.peerConnection && this.isRemoteDescriptionSet) {
      await this.flushQueuedCandidates();
    }
  }

  private async flushQueuedCandidates(): Promise<void> {
    if (
      this.isFlushingCandidates ||
      this.isDestroyed ||
      !this.peerConnection ||
      !this.isRemoteDescriptionSet
    ) {
      return;
    }

    this.isFlushingCandidates = true;
    try {
      while (
        this.candidateQueue.length > 0 &&
        !this.isDestroyed &&
        this.peerConnection &&
        this.isRemoteDescriptionSet
      ) {
        const cand = this.candidateQueue.shift();
        if (!cand || !cand.candidate) continue;
        try {
          await this.peerConnection.addIceCandidate(new RTCIceCandidate(cand));
        } catch (e) {
          console.warn('[WebRtcService] Candidato ICE inválido ou obsoleto ignorado:', e);
        }
      }
    } finally {
      this.isFlushingCandidates = false;
    }
  }

  /**
   * Coleta diagnóstico seguro de transporte e mídia (áudio + vídeo) via RTCPeerConnection.getStats()
   * Nunca expõe endereços IP brutos, SDP ou credenciais nos logs ou retorno.
   */
  async collectTransportDiagnostics(): Promise<WebRtcTransportDiagnostics | null> {
    if (this.isDestroyed || !this.peerConnection || typeof this.peerConnection.getStats !== 'function') {
      return null;
    }

    try {
      const pc = this.peerConnection;
      const report = await pc.getStats();
      if (this.isDestroyed || this.peerConnection !== pc) return null;

      let selectedPair: any = null;
      let selectedPairId: string | null = null;
      const statsById = new Map<string, any>();

      report.forEach((stat: any) => {
        if (stat && stat.id) {
          statsById.set(stat.id, stat);
        }
        if (stat?.type === 'transport' && stat.selectedCandidatePairId) {
          selectedPairId = stat.selectedCandidatePairId;
        }
      });

      if (selectedPairId && statsById.has(selectedPairId)) {
        selectedPair = statsById.get(selectedPairId);
      } else {
        report.forEach((stat: any) => {
          if (
            stat?.type === 'candidate-pair' &&
            (stat.selected || (stat.nominated && stat.state === 'succeeded'))
          ) {
            selectedPair = stat;
          }
        });
      }

      const localCand =
        selectedPair?.localCandidateId ? statsById.get(selectedPair.localCandidateId) : null;
      const remoteCand =
        selectedPair?.remoteCandidateId ? statsById.get(selectedPair.remoteCandidateId) : null;

      const localAddr = localCand?.address || localCand?.ip || null;
      const remoteAddr = remoteCand?.address || remoteCand?.ip || null;
      const networkClassification = classifyCandidateAddressPair(localAddr, remoteAddr);

      let packetsLostInbound = 0;
      let packetsReceived = 0;
      let bytesReceived = 0;
      let jitterMs: number | null = null;
      let packetsSent = 0;
      let bytesSent = 0;

      let totalAudioBytes = 0;
      let totalVideoBytes = 0;
      let videoWidth: number | null = null;
      let videoHeight: number | null = null;
      let videoFps: number | null = null;
      let qualityLimitationReason: string | null = null;

      report.forEach((stat: any) => {
        const mediaKind = stat?.kind || stat?.mediaType;
        if (stat?.type === 'inbound-rtp') {
          const rxBytes = Number(stat.bytesReceived || 0);
          const rxPkts = Number(stat.packetsReceived || 0);
          const lostPkts = Number(stat.packetsLost || 0);
          packetsLostInbound += Math.max(0, lostPkts);
          packetsReceived += rxPkts;
          bytesReceived += rxBytes;

          if (!mediaKind || mediaKind === 'audio') {
            totalAudioBytes += rxBytes;
            if (typeof stat.jitter === 'number') {
              jitterMs = Math.round(stat.jitter * 1000);
            }
          } else if (mediaKind === 'video') {
            totalVideoBytes += rxBytes;
            if (typeof stat.frameWidth === 'number' && stat.frameWidth > 0) {
              videoWidth = stat.frameWidth;
            }
            if (typeof stat.frameHeight === 'number' && stat.frameHeight > 0) {
              videoHeight = stat.frameHeight;
            }
            if (typeof stat.framesPerSecond === 'number' && stat.framesPerSecond > 0) {
              videoFps = Math.round(stat.framesPerSecond);
            }
          }
        } else if (stat?.type === 'outbound-rtp') {
          const txBytes = Number(stat.bytesSent || 0);
          const txPkts = Number(stat.packetsSent || 0);
          packetsSent += txPkts;
          bytesSent += txBytes;

          if (!mediaKind || mediaKind === 'audio') {
            totalAudioBytes += txBytes;
          } else if (mediaKind === 'video') {
            totalVideoBytes += txBytes;
            if (typeof stat.frameWidth === 'number' && stat.frameWidth > 0) {
              videoWidth = stat.frameWidth;
            }
            if (typeof stat.frameHeight === 'number' && stat.frameHeight > 0) {
              videoHeight = stat.frameHeight;
            }
            if (typeof stat.framesPerSecond === 'number' && stat.framesPerSecond > 0) {
              videoFps = Math.round(stat.framesPerSecond);
            }
            if (typeof stat.qualityLimitationReason === 'string') {
              qualityLimitationReason = stat.qualityLimitationReason;
            }
          }
        }
      });

      // Fallback para configurações reais da faixa de vídeo ativa caso o WebRTC report ainda não traga frameWidth
      if (!videoWidth || !videoHeight || !videoFps) {
        const activeVideoTrack =
          this.screenVideoTrack || this.remoteVideoStream?.getVideoTracks()[0] || null;
        if (activeVideoTrack && typeof activeVideoTrack.getSettings === 'function') {
          try {
            const trackSettings = activeVideoTrack.getSettings();
            if (!videoWidth && typeof trackSettings.width === 'number' && trackSettings.width > 0) {
              videoWidth = trackSettings.width;
            }
            if (!videoHeight && typeof trackSettings.height === 'number' && trackSettings.height > 0) {
              videoHeight = trackSettings.height;
            }
            if (!videoFps && typeof trackSettings.frameRate === 'number' && trackSettings.frameRate > 0) {
              videoFps = Math.round(trackSettings.frameRate);
            }
          } catch {}
        }
      }

      const nowMs = Date.now();
      let audioBitrateKbps = 0;
      let videoBitrateKbps = 0;

      if (this.prevStatsSnapshot && nowMs > this.prevStatsSnapshot.timestampMs) {
        const elapsedSec = (nowMs - this.prevStatsSnapshot.timestampMs) / 1000;
        if (elapsedSec >= 0.2) {
          const deltaAudio = Math.max(0, totalAudioBytes - this.prevStatsSnapshot.audioBytes);
          const deltaVideo = Math.max(0, totalVideoBytes - this.prevStatsSnapshot.videoBytes);
          audioBitrateKbps = Math.round((deltaAudio * 8) / 1000 / elapsedSec);
          videoBitrateKbps = Math.round((deltaVideo * 8) / 1000 / elapsedSec);
        }
      }

      this.prevStatsSnapshot = {
        timestampMs: nowMs,
        audioBytes: totalAudioBytes,
        videoBytes: totalVideoBytes,
      };

      const totalExpectedInbound = packetsReceived + Math.max(0, packetsLostInbound);
      const packetLossPercent =
        totalExpectedInbound > 0
          ? Number(((Math.max(0, packetsLostInbound) / totalExpectedInbound) * 100).toFixed(1))
          : 0;

      const rttMs =
        typeof selectedPair?.currentRoundTripTime === 'number'
          ? Math.round(selectedPair.currentRoundTripTime * 1000)
          : null;

      const diagnostics: WebRtcTransportDiagnostics = {
        connectionState: pc.connectionState,
        iceConnectionState: pc.iceConnectionState,
        selectedCandidatePairState: selectedPair?.state || null,
        localCandidateType: localCand?.candidateType || null,
        remoteCandidateType: remoteCand?.candidateType || null,
        transportProtocol: localCand?.protocol || remoteCand?.protocol || null,
        networkClassification,
        rttMs,
        packetsLostInbound,
        packetsReceived,
        packetsSent,
        packetLossPercent,
        bytesReceived,
        bytesSent,
        jitterMs,
        audioBitrateKbps,
        videoBitrateKbps,
        videoWidth,
        videoHeight,
        videoFps,
        qualityLimitationReason,
      };

      this.lastDiagnostics = diagnostics;
      return diagnostics;
    } catch (err) {
      console.warn('[WebRtcService] Falha ao coletar getStats():', err);
      return null;
    }
  }

  /**
   * Calcula e aplica o volume efetivo combinando volume geral de saída (0-100%)
   * e volume individual do participante (0-200%), respeitando estado de Deafen.
   */
  private applyEffectiveRemoteVolume(): void {
    const combinedRatio = (this.outputVolumePercent / 100) * (this.peerVolumePercent / 100);

    if (this.remoteAudioElement) {
      this.remoteAudioElement.muted = this.isDeafened || combinedRatio <= 0;
      this.remoteAudioElement.volume = this.isDeafened
        ? 0
        : Math.max(0, Math.min(1, combinedRatio));
    }

    if (this.remoteBoostGain) {
      if (this.isDeafened || combinedRatio <= 1) {
        this.remoteBoostGain.gain.value = 0;
      } else {
        // Ganho adicional para faixa 101% a 200% (0.0 a 1.0 extra somado ao 1.0 do elemento de áudio)
        this.remoteBoostGain.gain.value = Math.min(1, combinedRatio - 1);
      }
    }
  }

  public setOutputVolume(volumePercent: number): void {
    this.outputVolumePercent = Math.max(0, Math.min(100, Math.round(volumePercent)));
    this.applyEffectiveRemoteVolume();
  }

  public setPeerVolume(volumePercent: number): void {
    this.peerVolumePercent = Math.max(0, Math.min(200, Math.round(volumePercent)));
    this.applyEffectiveRemoteVolume();
  }

  /**
   * Reproduz o áudio remoto em elemento <audio> dedicado com suporte a volume individual e setSinkId
   */
  private playRemoteAudio(stream: MediaStream): void {
    if (this.isDestroyed) return;

    if (!this.remoteAudioElement) {
      this.remoteAudioElement = new Audio();
      this.remoteAudioElement.autoplay = true;
      this.remoteAudioElement.style.display = 'none';
      if (typeof document !== 'undefined' && document.body) {
        document.body.appendChild(this.remoteAudioElement);
      }
    }

    const storeState = useAppStore.getState();
    const audioSettings = storeState.settings.audioVideo;
    this.outputVolumePercent = audioSettings.outputVolume ?? 85;
    const peerId = storeState.activeCallPeer?.id;
    if (peerId && audioSettings.participantVolumes && typeof audioSettings.participantVolumes[peerId] === 'number') {
      this.peerVolumePercent = audioSettings.participantVolumes[peerId];
    }

    this.remoteAudioElement.srcObject = stream;
    this.applyEffectiveRemoteVolume();

    const outputDevice = audioSettings.outputDevice;
    if (outputDevice && outputDevice !== 'default') {
      audioDeviceService.setAudioSink(this.remoteAudioElement, outputDevice).then((res) => {
        if (res.didFallback) {
          this.callbacks.onDeviceFallback?.(
            'output',
            'Dispositivo de saída selecionado indisponível; áudio direcionado para a saída padrão.'
          );
        }
      }).catch(() => {});
    }

    const playPromise = this.remoteAudioElement.play();
    if (playPromise && typeof playPromise.catch === 'function') {
      playPromise.catch((err) => {
        console.warn('[WebRtcService] Autoplay de áudio remoto impedido:', err);
      });
    }
  }

  /**
   * Aplica configurações de DSP nativo (Echo Cancellation, Noise Suppression, Auto Gain Control) em tempo real
   */
  async applyAudioConstraints(
    noiseSuppression: boolean,
    echoCancellation: boolean,
    autoGainControl = true
  ): Promise<void> {
    if (this.localStream) {
      const caps = audioDeviceService.getCapabilities();
      const audioTracks = this.localStream.getAudioTracks();
      for (const track of audioTracks) {
        try {
          await track.applyConstraints({
            noiseSuppression: caps.noiseSuppression ? noiseSuppression : undefined,
            echoCancellation: caps.echoCancellation ? echoCancellation : undefined,
            autoGainControl: caps.autoGainControl ? autoGainControl : undefined,
          });
          console.log(
            `[WebRtcService] DSP atualizado: NS=${noiseSuppression}, AEC=${echoCancellation}, AGC=${autoGainControl}`
          );
        } catch (err) {
          console.warn('[WebRtcService] Falha ao aplicar restrições de áudio:', err);
        }
      }
    }
  }

  /**
   * Troca o microfone ativo durante a chamada sem desconectar e preservando o estado de mute/deafen
   */
  async switchInputDevice(deviceId: string): Promise<boolean> {
    if (this.isDestroyed || !this.peerConnection) return false;

    try {
      const audioSettings = useAppStore.getState().settings.audioVideo;
      const caps = audioDeviceService.getCapabilities();
      const useEcho = caps.echoCancellation ? Boolean(audioSettings.echoCancellation) : false;
      const useNoise = caps.noiseSuppression ? Boolean(audioSettings.noiseSuppression) : false;
      const useAgc = caps.autoGainControl ? Boolean(audioSettings.autoGainControl ?? true) : false;

      let newStream: MediaStream;
      let didFallback = false;
      try {
        newStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: deviceId && deviceId !== 'default' ? { exact: deviceId } : undefined,
            echoCancellation: useEcho,
            noiseSuppression: useNoise,
            autoGainControl: useAgc,
          },
          video: false,
        });
      } catch (e) {
        console.warn('[WebRtcService] Falha ao trocar dispositivo com exact, tentando padrão:', e);
        didFallback = Boolean(deviceId && deviceId !== 'default');
        newStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: useEcho,
            noiseSuppression: useNoise,
            autoGainControl: useAgc,
          },
          video: false,
        });
      }

      if (this.isDestroyed || !this.peerConnection) {
        newStream.getTracks().forEach((t) => {
          try {
            t.stop();
          } catch {}
        });
        return false;
      }

      const newTrack = newStream.getAudioTracks()[0];
      if (newTrack) {
        newTrack.enabled = !this.isMuted;
      }
      const senders = this.peerConnection.getSenders();
      const audioSender = senders.find(
        (s) => s.track?.kind === 'audio' || (s.track === null && (s as any).kind === 'audio')
      );

      if (audioSender && newTrack) {
        await audioSender.replaceTrack(newTrack);
      } else if (newTrack) {
        this.peerConnection.addTrack(newTrack, newStream);
      }

      if (this.isDestroyed || !this.peerConnection) {
        newStream.getTracks().forEach((t) => {
          try {
            t.stop();
          } catch {}
        });
        return false;
      }

      newStream.getAudioTracks().forEach((t) => {
        t.enabled = !this.isMuted;
      });

      this.detachLocalMicEndedListener();
      if (this.localStream) {
        this.localStream.getAudioTracks().forEach((t) => {
          try {
            t.stop();
          } catch {}
        });
      }
      this.localStream = newStream;
      this.attachLocalMicEndedListener(newTrack || null);
      this.setupLocalVad(newStream);

      if (didFallback) {
        this.callbacks.onDeviceFallback?.(
          'input',
          'O microfone solicitado não pôde ser ativado; mantendo o microfone padrão do sistema.'
        );
      }

      console.log(`[WebRtcService] Microfone alterado com sucesso para: ${didFallback ? 'default' : deviceId}`);
      return true;
    } catch (err) {
      console.warn('[WebRtcService] Falha ao trocar dispositivo de microfone:', err);
      return false;
    }
  }

  /**
   * Troca o dispositivo de saída (alto-falante / fone) com fallback automático para o padrão
   */
  async switchOutputDevice(deviceId: string): Promise<boolean> {
    if (!this.remoteAudioElement) return false;
    const res = await audioDeviceService.setAudioSink(this.remoteAudioElement, deviceId);
    if (res.didFallback) {
      this.callbacks.onDeviceFallback?.(
        'output',
        'Dispositivo de saída desconectado ou indisponível. Alternado para a saída padrão do sistema.'
      );
    }
    return res.applied;
  }

  /**
   * Configura VAD (Voice Activity Detection) para o microfone local
   */
  private setupLocalVad(stream: MediaStream): void {
    try {
      if (this.localAudioContext) {
        this.localAudioContext.close().catch(() => {});
        this.localAudioContext = null;
        this.localAnalyser = null;
      }

      if (typeof window === 'undefined') return;
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
   * Configura VAD (Voice Activity Detection) e amplificação (boost > 100%) para o áudio remoto
   */
  private setupRemoteVad(stream: MediaStream): void {
    try {
      if (this.remoteAudioContext) {
        this.remoteAudioContext.close().catch(() => {});
        this.remoteAudioContext = null;
        this.remoteAnalyser = null;
        this.remoteBoostGain = null;
      }

      if (typeof window === 'undefined') return;
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioCtx) return;

      this.remoteAudioContext = new AudioCtx();
      const source = this.remoteAudioContext.createMediaStreamSource(stream);
      this.remoteAnalyser = this.remoteAudioContext.createAnalyser();
      this.remoteAnalyser.fftSize = 256;
      source.connect(this.remoteAnalyser);

      if (typeof this.remoteAudioContext.createGain === 'function' && this.remoteAudioContext.destination) {
        this.remoteBoostGain = this.remoteAudioContext.createGain();
        this.remoteBoostGain.gain.value = 0;
        source.connect(this.remoteBoostGain);
        this.remoteBoostGain.connect(this.remoteAudioContext.destination);
        this.applyEffectiveRemoteVolume();
      }
    } catch (e) {
      console.warn('[WebRtcService] Falha ao iniciar VAD remoto:', e);
    }
  }

  /**
   * Loop de análise de energia sonora em tempo real (100ms) com sensibilidade ajustável
   */
  private startVadLoop(): void {
    if (this.vadInterval) clearInterval(this.vadInterval);

    const dataArrayLocal = new Uint8Array(128);
    const dataArrayRemote = new Uint8Array(128);
    const REMOTE_VAD_THRESHOLD = 16;

    let lastLocalSpeaking = false;
    let lastRemoteSpeaking = false;

    this.vadInterval = setInterval(() => {
      if (this.isDestroyed) return;

      const sensitivity = useAppStore.getState().settings.audioVideo.inputSensitivity ?? 78;
      const localThreshold = Math.max(5, Math.round(46 - sensitivity * 0.36));

      // Local
      if (this.localAnalyser && !this.isMuted) {
        this.localAnalyser.getByteFrequencyData(dataArrayLocal);
        const sum = dataArrayLocal.reduce((acc, val) => acc + val, 0);
        const avg = sum / dataArrayLocal.length;
        const isSpeaking = avg > localThreshold;
        if (isSpeaking !== lastLocalSpeaking) {
          lastLocalSpeaking = isSpeaking;
          this.callbacks.onLocalSpeaking(isSpeaking);
        }
      } else if (lastLocalSpeaking) {
        lastLocalSpeaking = false;
        this.callbacks.onLocalSpeaking(false);
      }

      // Remoto
      if (this.remoteAnalyser && !this.isDeafened && this.peerVolumePercent > 0 && this.outputVolumePercent > 0) {
        this.remoteAnalyser.getByteFrequencyData(dataArrayRemote);
        const sum = dataArrayRemote.reduce((acc, val) => acc + val, 0);
        const avg = sum / dataArrayRemote.length;
        const isSpeaking = avg > REMOTE_VAD_THRESHOLD;
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
    if (muted) {
      this.callbacks.onLocalSpeaking(false);
    }
  }

  /**
   * Desativa ou reativa o áudio de saída
   */
  setDeafened(deafened: boolean): void {
    this.isDeafened = deafened;
    this.applyEffectiveRemoteVolume();
    if (deafened) {
      this.callbacks.onRemoteSpeaking(false);
    }
  }

  /**
   * Encerramento completo e liberação rigorosa de recursos
   */
  destroy(emitClosed = false): void {
    if (this.isDestroyed) return;
    this.isDestroyed = true;
    this.currentState = 'closed';
    console.log('[WebRtcService] Destruindo sessão WebRTC e liberando microfone...');

    this.clearIceDisconnectTimer();
    this.detachLocalMicEndedListener();

    if (this.vadInterval) {
      clearInterval(this.vadInterval);
      this.vadInterval = null;
    }

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
      this.remoteBoostGain = null;
    }

    if (this.remoteAudioElement) {
      try {
        this.remoteAudioElement.pause();
      } catch {}
      this.remoteAudioElement.srcObject = null;
      try {
        this.remoteAudioElement.remove();
      } catch {}
      this.remoteAudioElement = null;
    }

    this.prevStatsSnapshot = null;
    this.cleanupPeerConnection(true);
    this.revokeMicConsent();

    try {
      this.callbacks.onLocalSpeaking(false);
      this.callbacks.onRemoteSpeaking(false);
      if (emitClosed) {
        this.emitConnectionState('closed');
      }
    } catch {}
  }

  private cleanupPeerConnection(clearQueue = true): void {
    this.clearIceDisconnectTimer();
    if (this.screenVideoTrack) {
      try {
        this.screenVideoTrack.stop();
      } catch {}
      this.screenVideoTrack = null;
    }
    this.screenVideoSender = null;
    this.remoteVideoStream = null;

    if (this.peerConnection) {
      this.peerConnection.onicecandidate = null;
      this.peerConnection.ontrack = null;
      this.peerConnection.onconnectionstatechange = null;
      this.peerConnection.oniceconnectionstatechange = null;
      try {
        this.peerConnection.close();
      } catch {}
      this.peerConnection = null;
    }
    if (clearQueue) {
      this.candidateQueue = [];
    }
    this.isRemoteDescriptionSet = false;
    this.hasAppliedRemoteAnswer = false;
    this.lastAnsweredOfferSdp = null;
    this.lastGeneratedAnswerSdp = null;
  }

  private revokeMicConsent(): void {
    import('@tauri-apps/api/core')
      .then(({ invoke }) => {
        invoke('call_set_mic_consent', { granted: false }).catch(() => {});
      })
      .catch(() => {});
  }
}
