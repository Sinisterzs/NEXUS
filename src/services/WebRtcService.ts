/**
 * NEXUS - WebRTC 1:1 Voice Call Engine (Phase 2.4B / 2.4.5B2)
 * Gerencia a captura de microfone com consentimento explícito, DTLS-SRTP,
 * negociação SDP/ICE serializada e idempotente, VAD (Voice Activity Detection),
 * diagnóstico seguro de transporte e reprodução de áudio Opus.
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
  bytesReceived: number;
  bytesSent: number;
  jitterMs: number | null;
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
  private vadInterval: any = null;
  private iceDisconnectTimer: any = null;
  private iceDisconnectTimeoutMs = DEFAULT_ICE_DISCONNECT_TIMEOUT_MS;

  private callbacks: WebRtcCallbacks;
  private isMuted = false;
  private isDeafened = false;
  private candidateQueue: RTCIceCandidateInit[] = [];
  private isRemoteDescriptionSet = false;
  private isFlushingCandidates = false;
  private hasAppliedRemoteAnswer = false;
  private lastAnsweredOfferSdp: string | null = null;
  private lastGeneratedAnswerSdp: string | null = null;
  private signalingChain: Promise<any> = Promise.resolve();
  private currentState: WebRtcConnectionState = 'idle';
  private lastDiagnostics: WebRtcTransportDiagnostics | null = null;
  private isDestroyed = false;

  constructor(callbacks: WebRtcCallbacks, options?: { iceDisconnectTimeoutMs?: number }) {
    this.callbacks = callbacks;
    if (options?.iceDisconnectTimeoutMs !== undefined) {
      this.iceDisconnectTimeoutMs = options.iceDisconnectTimeoutMs;
    }
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

      if (this.isDestroyed) {
        this.revokeMicConsent();
        throw new Error('Captura de áudio cancelada pois a chamada já foi encerrada.');
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

      // Se a sessão foi destruída/cancelada enquanto getUserMedia aguardava permissão ou hardware,
      // encerra imediatamente todas as trilhas recém-abertas para não manter o microfone ativo.
      if (this.isDestroyed) {
        stream.getTracks().forEach((track) => {
          try {
            track.stop();
          } catch {}
        });
        this.revokeMicConsent();
        throw new Error('Captura de áudio cancelada pois a chamada já foi encerrada.');
      }

      // Garante que o estado real da faixa de áudio corresponda ao mute atual desde o primeiro frame
      stream.getAudioTracks().forEach((track) => {
        track.enabled = !this.isMuted;
      });

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
      if (!this.isDestroyed) {
        this.callbacks.onError(msg);
      }
      throw new Error(msg);
    }
  }

  /**
   * Inicializa RTCPeerConnection para chamada 1:1 preservando candidatos ICE recebidos antecipadamente
   */
  createPeerConnection(): RTCPeerConnection {
    if (this.peerConnection) {
      this.cleanupPeerConnection(false);
    }

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
    this.isRemoteDescriptionSet = false;
    this.hasAppliedRemoteAnswer = false;
    this.lastAnsweredOfferSdp = null;
    this.lastGeneratedAnswerSdp = null;

    // Adiciona tracks de áudio local se já capturados
    if (this.localStream) {
      this.localStream.getAudioTracks().forEach((track) => {
        track.enabled = !this.isMuted;
        pc.addTrack(track, this.localStream!);
      });
    }

    // ICE Candidate gerado
    pc.onicecandidate = (event) => {
      if (this.isDestroyed || this.peerConnection !== pc) return;
      if (event.candidate && event.candidate.candidate) {
        // Diagnóstico seguro: registra tipo e protocolo sem expor IP privado nos logs
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

    // Track de áudio remoto recebido
    pc.ontrack = (event) => {
      if (this.isDestroyed || this.peerConnection !== pc) return;
      console.log('[WebRtcService] Track de áudio remoto recebido:', event.track.kind);
      if (event.track.kind === 'audio') {
        const stream =
          event.streams && event.streams[0]
            ? event.streams[0]
            : new MediaStream([event.track]);
        this.remoteStream = stream;
        this.playRemoteAudio(stream);
        this.setupRemoteVad(stream);
      }
    };

    // Monitoramento do estado da conexão
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
   * Cria SDP Offer (Chamador) de forma serializada e idempotente
   */
  async createOffer(): Promise<string> {
    return this.enqueueSignaling(async () => {
      if (this.isDestroyed) {
        throw new Error('Sessão WebRTC já encerrada.');
      }

      const pc = this.peerConnection || this.createPeerConnection();

      // Idempotência: se já geramos uma offer local ativa aguardando resposta, reutiliza o SDP
      if (pc.signalingState === 'have-local-offer' && pc.localDescription?.sdp) {
        console.log('[WebRtcService] Reutilizando SDP Offer local já ativa (have-local-offer).');
        return pc.localDescription.sdp;
      }

      if (pc.signalingState !== 'stable') {
        console.warn(
          `[WebRtcService] Estado de sinalização inesperado em createOffer (${pc.signalingState}).`
        );
        if (pc.localDescription?.sdp) {
          return pc.localDescription.sdp;
        }
      }

      const offer = await pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: false,
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
   * Processa SDP Offer e cria SDP Answer (Destinatário) de forma serializada e idempotente
   */
  async handleOffer(sdp: string): Promise<string> {
    return this.enqueueSignaling(async () => {
      if (this.isDestroyed) {
        throw new Error('Sessão WebRTC já encerrada.');
      }

      const pc = this.peerConnection || this.createPeerConnection();

      // 1. Idempotência exata: se esta mesma Offer já foi processada e respondida, retorna a Answer existente
      if (
        (this.lastAnsweredOfferSdp === sdp || pc.remoteDescription?.sdp === sdp) &&
        (this.lastGeneratedAnswerSdp || pc.localDescription?.sdp)
      ) {
        console.log(
          '[WebRtcService] Offer duplicada detectada. Reenviando SDP Answer já estabelecida sem renegociar.'
        );
        return this.lastGeneratedAnswerSdp || pc.localDescription?.sdp || '';
      }

      // 2. Se a conexão 1:1 já concluiu a negociação inicial (stable + remoteDescription aplicada),
      // não destrói o transporte ativo por uma oferta atrasada/duplicada
      if (this.isRemoteDescriptionSet && pc.signalingState === 'stable' && this.lastGeneratedAnswerSdp) {
        console.warn(
          '[WebRtcService] Offer recebida com conexão já estável. Preservando transporte atual e retornando answer.'
        );
        return this.lastGeneratedAnswerSdp;
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
          `[WebRtcService] Ignorando SDP Answer duplicada de forma idempotente (signalingState=${pc.signalingState}).`
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
      console.log('[WebRtcService] SDP Answer aplicada localmente. Conexão em negociação.');
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

    // Ignora candidato vazio de fim de coleta (end-of-candidates) para não disparar TypeError
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
          // Um candidato inválido jamais deve derrubar a chamada ou interromper os demais candidatos da fila
          console.warn('[WebRtcService] Candidato ICE inválido ou obsoleto ignorado:', e);
        }
      }
    } finally {
      this.isFlushingCandidates = false;
    }
  }

  /**
   * Coleta diagnóstico seguro de transporte via RTCPeerConnection.getStats()
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

      report.forEach((stat: any) => {
        if (stat?.type === 'inbound-rtp' && (!stat.kind || stat.kind === 'audio')) {
          packetsLostInbound += Number(stat.packetsLost || 0);
          packetsReceived += Number(stat.packetsReceived || 0);
          bytesReceived += Number(stat.bytesReceived || 0);
          if (typeof stat.jitter === 'number') {
            jitterMs = Math.round(stat.jitter * 1000);
          }
        } else if (stat?.type === 'outbound-rtp' && (!stat.kind || stat.kind === 'audio')) {
          packetsSent += Number(stat.packetsSent || 0);
          bytesSent += Number(stat.bytesSent || 0);
        }
      });

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
        bytesReceived,
        bytesSent,
        jitterMs,
      };

      this.lastDiagnostics = diagnostics;
      console.log(
        `[WebRtcService] Diagnóstico de transporte: par=${diagnostics.localCandidateType || '?'}/${diagnostics.remoteCandidateType || '?'} proto=${diagnostics.transportProtocol || '?'} rede=${diagnostics.networkClassification} rtt=${diagnostics.rttMs ?? '?'}ms rx=${diagnostics.packetsReceived} tx=${diagnostics.packetsSent} loss=${diagnostics.packetsLostInbound}`
      );
      return diagnostics;
    } catch (err) {
      console.warn('[WebRtcService] Falha ao coletar getStats():', err);
      return null;
    }
  }

  /**
   * Reproduz o áudio remoto em elemento <audio> dedicado
   */
  private playRemoteAudio(stream: MediaStream): void {
    if (this.isDestroyed) return;

    if (!this.remoteAudioElement) {
      this.remoteAudioElement = new Audio();
      this.remoteAudioElement.autoplay = true;
      // Garante que não apareça na tela
      this.remoteAudioElement.style.display = 'none';
      if (typeof document !== 'undefined' && document.body) {
        document.body.appendChild(this.remoteAudioElement);
      }
    }

    this.remoteAudioElement.srcObject = stream;
    this.remoteAudioElement.muted = this.isDeafened;

    // Aplica dispositivo de saída configurado pelo usuário se houver
    const outputDevice = useAppStore.getState().settings.audioVideo.outputDevice;
    if (outputDevice && outputDevice !== 'default') {
      audioDeviceService.setAudioSink(this.remoteAudioElement, outputDevice).catch(() => {});
    }

    const playPromise = this.remoteAudioElement.play();
    if (playPromise && typeof playPromise.catch === 'function') {
      playPromise.catch((err) => {
        console.warn('[WebRtcService] Autoplay de áudio remoto impedido:', err);
      });
    }
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
   * Troca o microfone ativo durante a chamada sem desconectar e preservando o estado de mute/deafen
   */
  async switchInputDevice(deviceId: string): Promise<void> {
    if (this.isDestroyed || !this.peerConnection || !this.localStream) return;

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

      if (this.isDestroyed || !this.peerConnection) {
        newStream.getTracks().forEach((t) => {
          try {
            t.stop();
          } catch {}
        });
        return;
      }

      const newTrack = newStream.getAudioTracks()[0];
      if (newTrack) {
        newTrack.enabled = !this.isMuted;
      }
      const senders = this.peerConnection.getSenders();
      const audioSender = senders.find((s) => s.track && s.track.kind === 'audio');

      if (audioSender && newTrack) {
        await audioSender.replaceTrack(newTrack);
      }

      if (this.isDestroyed || !this.peerConnection) {
        newStream.getTracks().forEach((t) => {
          try {
            t.stop();
          } catch {}
        });
        return;
      }

      // Garante novamente que o mute atual seja respeitado caso tenha mudado durante replaceTrack
      newStream.getAudioTracks().forEach((t) => {
        t.enabled = !this.isMuted;
      });

      // Finaliza stream anterior
      if (this.localStream) {
        this.localStream.getAudioTracks().forEach((t) => {
          try {
            t.stop();
          } catch {}
        });
      }
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
   * Configura VAD (Voice Activity Detection) para o áudio remoto
   */
  private setupRemoteVad(stream: MediaStream): void {
    try {
      if (this.remoteAudioContext) {
        this.remoteAudioContext.close().catch(() => {});
        this.remoteAudioContext = null;
        this.remoteAnalyser = null;
      }

      if (typeof window === 'undefined') return;
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
      if (this.isDestroyed) return;

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

    this.clearIceDisconnectTimer();

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
      try {
        this.remoteAudioElement.pause();
      } catch {}
      this.remoteAudioElement.srcObject = null;
      try {
        this.remoteAudioElement.remove();
      } catch {}
      this.remoteAudioElement = null;
    }

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
