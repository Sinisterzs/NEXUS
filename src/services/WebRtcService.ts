import { screenIceServers, assertScreenCandidate, assertScreenSdp, assertVoiceOnlySdp, guardScreenP2P, SCREEN_P2P_ERROR, SCREEN_DEDICATED_REQUIRED } from './ScreenP2PPolicy.ts';
/**
 * NEXUS - WebRTC 1:1 Voice & Screen Call Engine (Calls & Streaming 2.0)
 * Gerencia captura de microfone com consentimento explícito, seleção e fallback
 * dinâmico de periféricos, controle de volume individual por participante,
 * DSP (AEC, NS, AGC), compartilhamento de tela com controle de qualidade/bitrate,
 * ICE Restart controlado e diagnóstico de mídia via getStats().
 */

import { audioDeviceService } from './AudioDeviceService.ts';
import { processAnalyserFrame, type VoiceActivityDetector } from '../lib/voiceActivity.ts';
import { screenCaptureService, applyTrackContentHint } from './ScreenCaptureService.ts';
import { startScreenReceiveDiagnostics } from './ScreenReceiveDiagnostics.ts';
import { releaseScreenStream, screenSessionId } from './screenReceiverLifecycle.ts';
import type {
  ScreenShareQualityPreset,
  WebRtcTransportDiagnostics,
  BitrateRampStage,
} from '../lib/types.ts';

function getRuntimeAppStoreState(): {
  activeCallPeer?: { id?: string } | null;
  settings: {
    audioVideo: {
      inputDevice?: string;
      outputDevice?: string;
      inputSensitivity?: number;
      voiceHangoverMs?: number;
      outputVolume?: number;
      noiseSuppression?: boolean;
      echoCancellation?: boolean;
      autoGainControl?: boolean;
      participantVolumes?: Record<string, number>;
    };
  };
} {
  try {
    const store = (globalThis as any).__NEXUS_STORE__;
    if (store && typeof store.getState === 'function') {
      return store.getState();
    }
  } catch {}
  return {
    activeCallPeer: null,
    settings: {
      audioVideo: {
        inputDevice: 'default',
        outputDevice: 'default',
        inputSensitivity: 78,
        voiceHangoverMs: 400,
        outputVolume: 85,
        noiseSuppression: true,
        echoCancellation: true,
        autoGainControl: true,
        participantVolumes: {},
      },
    },
  };
}

export type { WebRtcTransportDiagnostics, BitrateRampStage };

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
  onScreenReceiveWarning?: (message: string) => void;
  onDeviceFallback?: (kind: 'input' | 'output', reason: string) => void;
};

export interface VideoStatsSnapshot {
  timestampMs: number;
  audioBytes: number;
  videoBytes: number;
  framesCaptured: number | null;
  captureTimestampMs: number | null;
  framesEncoded: number | null;
  framesSent: number | null;
  outboundVideoTimestampMs: number | null;
  framesReceived: number | null;
  framesDecoded: number | null;
  inboundVideoTimestampMs: number | null;
}

export const MAX_CANDIDATE_QUEUE_SIZE = 256;
export const DEFAULT_ICE_DISCONNECT_TIMEOUT_MS = 12000;
export const BITRATE_RAMP_STAGE_1_DELAY_MS = 900;
export const BITRATE_RAMP_STAGE_2_DELAY_MS = 1800;

/**
 * Ordena codecs de vídeo priorizando H.264 (packetization-mode=1 / MediaFoundation)
 * e VP9 sobre VP8 software, preservando integralmente codecs auxiliares (rtx, red, ulpfec).
 */
export function rankVideoCodecsForScreenShare<
  T extends { mimeType: string; sdpFmtpLine?: string }
>(codecs: readonly T[]): T[] {
  if (!Array.isArray(codecs) || codecs.length === 0) return [];

  const getScore = (codec: T): number => {
    const mime = (codec.mimeType || '').toLowerCase();
    const fmtp = (codec.sdpFmtpLine || '').toLowerCase();

    if (mime === 'video/h264') {
      const hasPacketization1 = fmtp.includes('packetization-mode=1');
      const isHighOrMainOrConstrained =
        fmtp.includes('42e0') || fmtp.includes('4d00') || fmtp.includes('6400');
      if (hasPacketization1 && isHighOrMainOrConstrained) return 10;
      if (hasPacketization1) return 15;
      return 20;
    }
    if (mime === 'video/vp9') {
      if (fmtp.includes('profile-id=0') || !fmtp.includes('profile-id=')) return 30;
      return 35;
    }
    if (mime === 'video/av1') return 40;
    if (mime === 'video/vp8') return 50;
    if (
      mime === 'video/rtx' ||
      mime === 'video/red' ||
      mime === 'video/ulpfec' ||
      mime === 'video/flexfec-03'
    ) {
      return 90;
    }
    return 70;
  };

  return codecs
    .map((codec, idx) => ({ codec, idx, score: getScore(codec) }))
    .sort((a, b) => (a.score !== b.score ? a.score - b.score : a.idx - b.idx))
    .map((entry) => entry.codec);
}

/**
 * Calcula os parâmetros do RTCRtpSender e contentHint para cada estágio da rampa progressiva:
 * - warmup (t=0ms): trava resolução nativa (maintain-resolution + scaleResolutionDownBy=1 + detail)
 *   com bitrate inicial seguro (~65%) para evitar borrado no início sem saturar o BWE no frame 1.
 * - ramping (t=900ms): eleva bitrate para ~85% mantendo resolução integral.
 * - steady (t=1800ms): libera 100% do maxBitrate e, para 1080p60, ativa contentHint='motion' + 'balanced'.
 */
export function computeProgressiveBitrateStage(
  preset: ScreenShareQualityPreset,
  stage: BitrateRampStage
): {
  targetBitrateBps: number;
  maxFramerate: number;
  scaleResolutionDownBy: number;
  degradationPreference: 'maintain-resolution' | 'balanced' | 'maintain-framerate';
  contentHint: 'detail' | 'motion';
} {
  const targets = screenCaptureService.getEncodingTargets(preset);
  if (stage === 'warmup') {
    return {
      targetBitrateBps: targets.initialBitrate,
      maxFramerate: targets.maxFramerate,
      scaleResolutionDownBy: 1,
      degradationPreference: 'maintain-resolution',
      contentHint: 'detail',
    };
  }
  if (stage === 'ramping') {
    const midBitrate = Math.round(
      targets.initialBitrate + (targets.maxBitrate - targets.initialBitrate) * 0.55
    );
    return {
      targetBitrateBps: midBitrate,
      maxFramerate: targets.maxFramerate,
      scaleResolutionDownBy: 1,
      degradationPreference: 'maintain-resolution',
      contentHint: 'detail',
    };
  }
  return {
    targetBitrateBps: targets.maxBitrate,
    maxFramerate: targets.maxFramerate,
    scaleResolutionDownBy: 1,
    degradationPreference: targets.degradationPreference,
    contentHint: targets.steadyContentHint,
  };
}

/**
 * Extrai métricas separadas de FPS (solicitado, capturado, codificado, enviado, recebido, renderizado),
 * resolução por estágio e contadores de codificação/decodificação a partir de um relatório getStats().
 * NUNCA usa o FPS do preset como fallback para FPS efetivo (encoded/sent/received/rendered/videoFps).
 */
export function computeVideoStatsMetrics(params: {
  statsReport: Iterable<any> | Map<string, any> | Array<any>;
  prevSnapshot: VideoStatsSnapshot | null;
  nowMs: number;
  isLocalScreenSharing: boolean;
  activePreset: ScreenShareQualityPreset;
  localTrackSettings?: { width?: number; height?: number; frameRate?: number } | null;
}) {
  const {
    statsReport,
    prevSnapshot,
    nowMs,
    isLocalScreenSharing,
    activePreset,
    localTrackSettings,
  } = params;

  const statsList: any[] = [];
  const statsById = new Map<string, any>();
  if (statsReport && typeof (statsReport as any).forEach === 'function') {
    (statsReport as any).forEach((stat: any) => {
      if (stat) {
        statsList.push(stat);
        if (stat.id) statsById.set(stat.id, stat);
      }
    });
  } else if (statsReport && Symbol.iterator in Object(statsReport)) {
    for (const stat of statsReport as Iterable<any>) {
      if (stat) {
        statsList.push(stat);
        if (stat.id) statsById.set(stat.id, stat);
      }
    }
  }

  const presetTargets = screenCaptureService.getEncodingTargets(activePreset);
  const requestedFps = isLocalScreenSharing ? presetTargets.maxFramerate : null;
  const requestedWidth = isLocalScreenSharing ? presetTargets.targetWidth : null;
  const requestedHeight = isLocalScreenSharing ? presetTargets.targetHeight : null;

  let capturedWidth: number | null =
    localTrackSettings?.width && localTrackSettings.width > 0 ? localTrackSettings.width : null;
  let capturedHeight: number | null =
    localTrackSettings?.height && localTrackSettings.height > 0 ? localTrackSettings.height : null;
  let mediaSourceFps: number | null = null;
  let framesCaptured: number | null = null;
  let captureTimestampMs: number | null = null;

  let encodedWidth: number | null = null;
  let encodedHeight: number | null = null;
  let outboundDirectFps: number | null = null;
  let framesEncoded: number | null = null;
  let framesSent: number | null = null;
  let keyFramesEncoded: number | null = null;
  let outboundVideoTimestampMs: number | null = null;
  let qualityLimitationReason: string | null = null;
  let qualityLimitationDurations: Record<string, number> | null = null;
  let qualityLimitationResolutionChanges: number | null = null;
  let encoderImplementation: string | null = null;
  let powerEfficientEncoder: boolean | null = null;
  let outboundCodecId: string | null = null;

  let receivedWidth: number | null = null;
  let receivedHeight: number | null = null;
  let inboundDirectFps: number | null = null;
  let framesReceived: number | null = null;
  let framesDecoded: number | null = null;
  let framesDropped: number | null = null;
  let keyFramesDecoded: number | null = null;
  let inboundVideoTimestampMs: number | null = null;
  let decoderImplementation: string | null = null;
  let powerEfficientDecoder: boolean | null = null;
  let inboundCodecId: string | null = null;

  let pliCount: number | null = null;
  let nackCount: number | null = null;

  for (const stat of statsList) {
    const mediaKind = stat?.kind || stat?.mediaType;
    if (stat?.type === 'media-source' && mediaKind === 'video') {
      if (typeof stat.width === 'number' && stat.width > 0) capturedWidth = stat.width;
      if (typeof stat.height === 'number' && stat.height > 0) capturedHeight = stat.height;
      if (typeof stat.framesPerSecond === 'number' && stat.framesPerSecond >= 0) {
        mediaSourceFps = Math.round(stat.framesPerSecond);
      }
      if (typeof stat.frames === 'number' && stat.frames >= 0) {
        framesCaptured = stat.frames;
      }
      if (typeof stat.timestamp === 'number' && stat.timestamp > 0) {
        captureTimestampMs = stat.timestamp;
      }
    } else if (stat?.type === 'outbound-rtp' && mediaKind === 'video') {
      if (typeof stat.frameWidth === 'number' && stat.frameWidth > 0) {
        encodedWidth = stat.frameWidth;
      }
      if (typeof stat.frameHeight === 'number' && stat.frameHeight > 0) {
        encodedHeight = stat.frameHeight;
      }
      if (typeof stat.framesPerSecond === 'number' && stat.framesPerSecond >= 0) {
        outboundDirectFps = Math.round(stat.framesPerSecond);
      }
      if (typeof stat.framesEncoded === 'number' && stat.framesEncoded >= 0) {
        framesEncoded = stat.framesEncoded;
      }
      if (typeof stat.framesSent === 'number' && stat.framesSent >= 0) {
        framesSent = stat.framesSent;
      }
      if (typeof stat.keyFramesEncoded === 'number' && stat.keyFramesEncoded >= 0) {
        keyFramesEncoded = stat.keyFramesEncoded;
      }
      if (typeof stat.timestamp === 'number' && stat.timestamp > 0) {
        outboundVideoTimestampMs = stat.timestamp;
      }
      if (typeof stat.qualityLimitationReason === 'string') {
        qualityLimitationReason = stat.qualityLimitationReason;
      }
      if (stat.qualityLimitationDurations && typeof stat.qualityLimitationDurations === 'object') {
        qualityLimitationDurations = { ...stat.qualityLimitationDurations };
      }
      if (typeof stat.qualityLimitationResolutionChanges === 'number') {
        qualityLimitationResolutionChanges = stat.qualityLimitationResolutionChanges;
      }
      if (typeof stat.encoderImplementation === 'string') {
        encoderImplementation = stat.encoderImplementation;
      }
      if (typeof stat.powerEfficientEncoder === 'boolean') {
        powerEfficientEncoder = stat.powerEfficientEncoder;
      }
      if (typeof stat.codecId === 'string') {
        outboundCodecId = stat.codecId;
      }
      if (typeof stat.pliCount === 'number') {
        pliCount = (pliCount ?? 0) + stat.pliCount;
      }
      if (typeof stat.nackCount === 'number') {
        nackCount = (nackCount ?? 0) + stat.nackCount;
      }
    } else if (stat?.type === 'inbound-rtp' && mediaKind === 'video') {
      if (typeof stat.frameWidth === 'number' && stat.frameWidth > 0) {
        receivedWidth = stat.frameWidth;
      }
      if (typeof stat.frameHeight === 'number' && stat.frameHeight > 0) {
        receivedHeight = stat.frameHeight;
      }
      if (typeof stat.framesPerSecond === 'number' && stat.framesPerSecond >= 0) {
        inboundDirectFps = Math.round(stat.framesPerSecond);
      }
      if (typeof stat.framesReceived === 'number' && stat.framesReceived >= 0) {
        framesReceived = stat.framesReceived;
      }
      if (typeof stat.framesDecoded === 'number' && stat.framesDecoded >= 0) {
        framesDecoded = stat.framesDecoded;
      }
      if (typeof stat.framesDropped === 'number' && stat.framesDropped >= 0) {
        framesDropped = stat.framesDropped;
      }
      if (typeof stat.keyFramesDecoded === 'number' && stat.keyFramesDecoded >= 0) {
        keyFramesDecoded = stat.keyFramesDecoded;
      }
      if (typeof stat.timestamp === 'number' && stat.timestamp > 0) {
        inboundVideoTimestampMs = stat.timestamp;
      }
      if (typeof stat.decoderImplementation === 'string') {
        decoderImplementation = stat.decoderImplementation;
      }
      if (typeof stat.powerEfficientDecoder === 'boolean') {
        powerEfficientDecoder = stat.powerEfficientDecoder;
      }
      if (typeof stat.codecId === 'string') {
        inboundCodecId = stat.codecId;
      }
      if (typeof stat.pliCount === 'number' && pliCount === null) {
        pliCount = stat.pliCount;
      }
      if (typeof stat.nackCount === 'number' && nackCount === null) {
        nackCount = stat.nackCount;
      }
    }
  }

  // Delta calculations using stat timestamps (or wall-clock fallback)
  let deltaCapturedFps: number | null = null;
  if (prevSnapshot && framesCaptured !== null && prevSnapshot.framesCaptured !== null) {
    const currTs = captureTimestampMs ?? nowMs;
    const prevTs = prevSnapshot.captureTimestampMs ?? prevSnapshot.timestampMs;
    const elapsedSec = (currTs - prevTs) / 1000;
    if (elapsedSec >= 0.2 && framesCaptured >= prevSnapshot.framesCaptured) {
      deltaCapturedFps = Math.round((framesCaptured - prevSnapshot.framesCaptured) / elapsedSec);
    }
  }

  let deltaEncodedFps: number | null = null;
  let deltaSentFps: number | null = null;
  if (prevSnapshot) {
    const currTs = outboundVideoTimestampMs ?? nowMs;
    const prevTs = prevSnapshot.outboundVideoTimestampMs ?? prevSnapshot.timestampMs;
    const elapsedSec = (currTs - prevTs) / 1000;
    if (elapsedSec >= 0.2) {
      if (
        framesEncoded !== null &&
        prevSnapshot.framesEncoded !== null &&
        framesEncoded >= prevSnapshot.framesEncoded
      ) {
        deltaEncodedFps = Math.round((framesEncoded - prevSnapshot.framesEncoded) / elapsedSec);
      }
      if (
        framesSent !== null &&
        prevSnapshot.framesSent !== null &&
        framesSent >= prevSnapshot.framesSent
      ) {
        deltaSentFps = Math.round((framesSent - prevSnapshot.framesSent) / elapsedSec);
      }
    }
  }

  let deltaReceivedFps: number | null = null;
  let deltaDecodedFps: number | null = null;
  if (prevSnapshot) {
    const currTs = inboundVideoTimestampMs ?? nowMs;
    const prevTs = prevSnapshot.inboundVideoTimestampMs ?? prevSnapshot.timestampMs;
    const elapsedSec = (currTs - prevTs) / 1000;
    if (elapsedSec >= 0.2) {
      if (
        framesReceived !== null &&
        prevSnapshot.framesReceived !== null &&
        framesReceived >= prevSnapshot.framesReceived
      ) {
        deltaReceivedFps = Math.round((framesReceived - prevSnapshot.framesReceived) / elapsedSec);
      }
      if (
        framesDecoded !== null &&
        prevSnapshot.framesDecoded !== null &&
        framesDecoded >= prevSnapshot.framesDecoded
      ) {
        deltaDecodedFps = Math.round((framesDecoded - prevSnapshot.framesDecoded) / elapsedSec);
      }
    }
  }

  // Track settings describe configuration, not a measured frame cadence.
  const capturedFps = mediaSourceFps ?? deltaCapturedFps;

  const encodedFps = deltaEncodedFps ?? outboundDirectFps;
  const sentFps = deltaSentFps ?? encodedFps;
  const receivedFps = deltaReceivedFps ?? inboundDirectFps;
  const decodedFps = deltaDecodedFps ?? inboundDirectFps;
  // getStats() does not measure presentation by the HTMLVideoElement.
  const renderedFps: number | null = null;

  // Effective videoFps and videoWidth/videoHeight: strictly from real RTP stats (never preset!)
  const hasInboundVideo =
    receivedWidth !== null ||
    receivedHeight !== null ||
    receivedFps !== null ||
    decodedFps !== null ||
    (framesReceived !== null && framesReceived > 0);
  const videoFps = hasInboundVideo ? (decodedFps ?? receivedFps) : (sentFps ?? encodedFps);
  const videoWidth = hasInboundVideo ? receivedWidth : encodedWidth;
  const videoHeight = hasInboundVideo ? receivedHeight : encodedHeight;

  // Codec lookup
  let videoCodec: string | null = null;
  const codecStatId = outboundCodecId || inboundCodecId;
  if (codecStatId && statsById.has(codecStatId)) {
    const codecStat = statsById.get(codecStatId);
    if (typeof codecStat?.mimeType === 'string') {
      videoCodec = codecStat.mimeType.replace(/^video\//i, '');
    }
  }

  return {
    requestedFps,
    capturedFps,
    encodedFps,
    sentFps,
    receivedFps,
    decodedFps,
    renderedFps,
    videoFps,
    requestedWidth,
    requestedHeight,
    capturedWidth,
    capturedHeight,
    encodedWidth,
    encodedHeight,
    receivedWidth,
    receivedHeight,
    videoWidth,
    videoHeight,
    videoCodec,
    encoderImplementation,
    decoderImplementation,
    powerEfficientEncoder,
    powerEfficientDecoder,
    qualityLimitationReason,
    qualityLimitationDurations,
    qualityLimitationResolutionChanges,
    framesCaptured,
    captureTimestampMs,
    framesEncoded,
    framesSent,
    outboundVideoTimestampMs,
    framesReceived,
    framesDecoded,
    framesDropped,
    inboundVideoTimestampMs,
    keyFramesEncoded,
    keyFramesDecoded,
    pliCount,
    nackCount,
  };
}

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
  private localVad: VoiceActivityDetector | null = null;
  private iceDisconnectTimer: any = null;
  private iceDisconnectTimeoutMs = DEFAULT_ICE_DISCONNECT_TIMEOUT_MS;

  private callbacks: WebRtcCallbacks;
  private isPolite = false;
  private screenVideoTrack: MediaStreamTrack | null = null;
  private screenVideoSender: RTCRtpSender | null = null;
  private remoteVideoStream: MediaStream | null = null;
  private screenReceiverPc: RTCPeerConnection | null = null;
  private screenReceiverStream: MediaStream | null = null;
  private screenReceiverGeneration = 0;
  private remoteScreenSessionId: string | null = null;
  private screenReceiverStopped = false;
  private stopScreenDiagnostics: (() => void) | null = null;
  private stopScreenP2P: (() => void) | null = null;
  private screenReceiverCandidateQueue: RTCIceCandidateInit[] = [];
  private onScreenReceiverIceCallback: ((candidate: RTCIceCandidateInit) => void) | null = null;
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
  private prevStatsSnapshot: VideoStatsSnapshot | null = null;
  private activeScreenPreset: ScreenShareQualityPreset = 'auto';
  private bitrateRampStage: BitrateRampStage = 'idle';
  private screenRampPendingNegotiation = false;
  private currentTargetVideoBitrateKbps: number | null = null;
  private bitrateRampTimers: any[] = [];
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
      const audioSettings = getRuntimeAppStoreState().settings.audioVideo;
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

  private clearBitrateRampTimers(): void {
    for (const timer of this.bitrateRampTimers) {
      clearTimeout(timer);
    }
    this.bitrateRampTimers = [];
  }

  public getBitrateRampStage(): BitrateRampStage {
    return this.bitrateRampStage;
  }

  /**
   * Configura preferência de codecs de vídeo (H.264 -> VP9 -> AV1 -> VP8) no transceiver
   * para evitar gargalo de CPU (~32 FPS) do VP8 software em 1080p60 sem exigir GPU dedicada.
   */
  public applyPreferredVideoCodecs(pc?: RTCPeerConnection | null): boolean {
    const targetPc = pc || this.peerConnection;
    if (!targetPc || typeof targetPc.getTransceivers !== 'function') {
      return false;
    }
    if (
      typeof RTCRtpSender === 'undefined' ||
      typeof RTCRtpSender.getCapabilities !== 'function'
    ) {
      return false;
    }

    try {
      const capabilities = RTCRtpSender.getCapabilities('video');
      if (!capabilities || !Array.isArray(capabilities.codecs) || capabilities.codecs.length === 0) {
        return false;
      }

      const rankedCodecs = rankVideoCodecsForScreenShare(capabilities.codecs);
      if (rankedCodecs.length === 0) return false;

      let appliedAny = false;
      for (const transceiver of targetPc.getTransceivers()) {
        const senderKind = transceiver?.sender?.track?.kind;
        const receiverKind = transceiver?.receiver?.track?.kind;
        if (
          (senderKind === 'video' || receiverKind === 'video') &&
          typeof transceiver.setCodecPreferences === 'function'
        ) {
          transceiver.setCodecPreferences(rankedCodecs);
          appliedAny = true;
        }
      }
      return appliedAny;
    } catch (err) {
      console.warn('[WebRtcService] Aviso ao aplicar setCodecPreferences de vídeo:', err);
      return false;
    }
  }

  /**
   * Aplica parâmetros de bitrate, framerate, scaleResolutionDownBy=1 e degradationPreference
   * no RTCRtpSender de vídeo conforme o preset de qualidade e estágio da rampa progressiva.
   */
  public async applySenderQualityParameters(
    preset?: ScreenShareQualityPreset,
    stageOverride?: BitrateRampStage
  ): Promise<void> {
    const resolvedPreset = preset || this.activeScreenPreset || screenCaptureService.getQualityPreset() || 'auto';
    this.activeScreenPreset = resolvedPreset;

    const effectiveStage: BitrateRampStage =
      stageOverride || (this.bitrateRampStage !== 'idle' ? this.bitrateRampStage : 'steady');
    const stageConfig = computeProgressiveBitrateStage(resolvedPreset, effectiveStage);

    this.bitrateRampStage = effectiveStage;
    this.currentTargetVideoBitrateKbps = Math.round(stageConfig.targetBitrateBps / 1000);

    if (this.screenVideoTrack) {
      applyTrackContentHint(this.screenVideoTrack, stageConfig.contentHint);
    }

    if (!this.screenVideoSender || typeof this.screenVideoSender.getParameters !== 'function') {
      return;
    }

    try {
      const params = this.screenVideoSender.getParameters() as RTCRtpSendParameters & {
        degradationPreference?: string;
      };
      if (!params.encodings || params.encodings.length === 0) {
        params.encodings = [{}];
      }
      params.degradationPreference = stageConfig.degradationPreference;
      params.encodings[0].maxBitrate = stageConfig.targetBitrateBps;
      params.encodings[0].maxFramerate = stageConfig.maxFramerate;
      params.encodings[0].scaleResolutionDownBy = stageConfig.scaleResolutionDownBy;
      (params.encodings[0] as any).priority = 'high';
      (params.encodings[0] as any).networkPriority = 'high';

      if (typeof this.screenVideoSender.setParameters === 'function') {
        await this.screenVideoSender.setParameters(params);
      }
      console.log(
        `[WebRtcService] Parâmetros de vídeo aplicados (preset=${resolvedPreset}, stage=${effectiveStage}): maxBitrate=${stageConfig.targetBitrateBps} bps, maxFramerate=${stageConfig.maxFramerate} fps, degradation=${stageConfig.degradationPreference}, scaleDown=${stageConfig.scaleResolutionDownBy}, hint=${stageConfig.contentHint}`
      );
    } catch (paramErr) {
      console.warn('[WebRtcService] Aviso ao configurar parâmetros do sender de vídeo:', paramErr);
    }
  }

  /**
   * Inicia rampa progressiva de bitrate/nitidez em 3 estágios (warmup -> ramping -> steady)
   * garantindo resolução 1080p íntegra desde o primeiro frame sem saturar o BWE inicial.
   */
  public async startBitrateRamp(preset?: ScreenShareQualityPreset): Promise<void> {
    this.clearBitrateRampTimers();
    const resolvedPreset =
      preset || this.activeScreenPreset || screenCaptureService.getQualityPreset() || 'auto';
    this.activeScreenPreset = resolvedPreset;

    await this.applySenderQualityParameters(resolvedPreset, 'warmup');

    const scheduleStage = (stage: BitrateRampStage, delayMs: number) => {
      const timer = setTimeout(() => {
        if (this.isDestroyed || !this.screenVideoSender || !this.screenVideoTrack) return;
        this.applySenderQualityParameters(this.activeScreenPreset, stage).catch(() => {});
      }, delayMs);
      if (timer && typeof (timer as any).unref === 'function') {
        (timer as any).unref();
      }
      this.bitrateRampTimers.push(timer);
    };

    scheduleStage('ramping', BITRATE_RAMP_STAGE_1_DELAY_MS);
    scheduleStage('steady', BITRATE_RAMP_STAGE_2_DELAY_MS);
  }

  private async applyNegotiatedScreenParameters(): Promise<void> {
    if (!this.screenVideoSender || !this.screenVideoTrack) return;
    if (this.screenRampPendingNegotiation) {
      this.screenRampPendingNegotiation = false;
      await this.startBitrateRamp(this.activeScreenPreset);
    } else {
      await this.applySenderQualityParameters(this.activeScreenPreset);
    }
  }

  /**
   * Vincula a track de vídeo de tela local à conexão WebRTC existente e retorna o novo SDP Offer
   */
  async attachScreenTrack(
    _track: MediaStreamTrack,
    _stream: MediaStream,
    _preset?: ScreenShareQualityPreset
  ): Promise<string> {
    throw new Error(SCREEN_DEDICATED_REQUIRED);
  }

  /**
   * Desvincula a faixa de vídeo de tela sem reiniciar o peer connection nem fechar áudio
   */
  async detachScreenTrack(): Promise<string | null> {
    return this.enqueueSignaling(async () => {
      this.clearBitrateRampTimers();
      this.bitrateRampStage = 'idle';
      this.screenRampPendingNegotiation = false;
      this.currentTargetVideoBitrateKbps = null;

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
      this.applyPreferredVideoCodecs(pc);

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
          return '';
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
        assertVoiceOnlySdp(sdp);
        await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp }));
      }

      if (this.isDestroyed || this.peerConnection !== pc) {
        throw new Error('Sessão WebRTC encerrada durante handleOffer.');
      }

      this.applyPreferredVideoCodecs(pc);
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
      await this.applyNegotiatedScreenParameters();
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

      assertVoiceOnlySdp(sdp);
      await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp }));
      if (this.isDestroyed || this.peerConnection !== pc) return;

      this.isRemoteDescriptionSet = true;
      this.hasAppliedRemoteAnswer = true;
      await this.flushQueuedCandidates();

      await this.applyNegotiatedScreenParameters();
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
          }
        }
      });

      let localTrackSettings: { width?: number; height?: number; frameRate?: number } | null = null;
      if (this.screenVideoTrack && typeof this.screenVideoTrack.getSettings === 'function') {
        try {
          localTrackSettings = this.screenVideoTrack.getSettings();
        } catch {}
      }

      const nowMs = Date.now();
      const isLocalScreenSharing = Boolean(
        this.screenVideoTrack || screenCaptureService.getState().isCapturing
      );
      const activePreset =
        this.activeScreenPreset || screenCaptureService.getQualityPreset() || 'auto';

      const videoMetrics = computeVideoStatsMetrics({
        statsReport: report,
        prevSnapshot: this.prevStatsSnapshot,
        nowMs,
        isLocalScreenSharing,
        activePreset,
        localTrackSettings,
      });

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
        framesCaptured: videoMetrics.framesCaptured,
        captureTimestampMs: videoMetrics.captureTimestampMs,
        framesEncoded: videoMetrics.framesEncoded,
        framesSent: videoMetrics.framesSent,
        outboundVideoTimestampMs: videoMetrics.outboundVideoTimestampMs,
        framesReceived: videoMetrics.framesReceived,
        framesDecoded: videoMetrics.framesDecoded,
        inboundVideoTimestampMs: videoMetrics.inboundVideoTimestampMs,
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
        videoWidth: videoMetrics.videoWidth,
        videoHeight: videoMetrics.videoHeight,
        videoFps: videoMetrics.videoFps,
        qualityLimitationReason: videoMetrics.qualityLimitationReason,
        requestedFps: videoMetrics.requestedFps,
        capturedFps: videoMetrics.capturedFps,
        encodedFps: videoMetrics.encodedFps,
        sentFps: videoMetrics.sentFps,
        receivedFps: videoMetrics.receivedFps,
        decodedFps: videoMetrics.decodedFps,
        renderedFps: videoMetrics.renderedFps,
        requestedWidth: videoMetrics.requestedWidth,
        requestedHeight: videoMetrics.requestedHeight,
        capturedWidth: videoMetrics.capturedWidth,
        capturedHeight: videoMetrics.capturedHeight,
        encodedWidth: videoMetrics.encodedWidth,
        encodedHeight: videoMetrics.encodedHeight,
        receivedWidth: videoMetrics.receivedWidth,
        receivedHeight: videoMetrics.receivedHeight,
        videoCodec: videoMetrics.videoCodec,
        encoderImplementation: videoMetrics.encoderImplementation,
        decoderImplementation: videoMetrics.decoderImplementation,
        powerEfficientEncoder: videoMetrics.powerEfficientEncoder,
        powerEfficientDecoder: videoMetrics.powerEfficientDecoder,
        qualityLimitationDurations: videoMetrics.qualityLimitationDurations,
        qualityLimitationResolutionChanges: videoMetrics.qualityLimitationResolutionChanges,
        framesEncoded: videoMetrics.framesEncoded,
        framesSent: videoMetrics.framesSent,
        framesReceived: videoMetrics.framesReceived,
        framesDecoded: videoMetrics.framesDecoded,
        framesDropped: videoMetrics.framesDropped,
        keyFramesEncoded: videoMetrics.keyFramesEncoded,
        keyFramesDecoded: videoMetrics.keyFramesDecoded,
        pliCount: videoMetrics.pliCount,
        nackCount: videoMetrics.nackCount,
        targetVideoBitrateKbps: isLocalScreenSharing ? this.currentTargetVideoBitrateKbps : null,
        bitrateRampStage: isLocalScreenSharing ? this.bitrateRampStage : 'idle',
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

    const storeState = getRuntimeAppStoreState();
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
      const audioSettings = getRuntimeAppStoreState().settings.audioVideo;
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
        this.localVad = null;
      }

      if (typeof window === 'undefined') return;
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioCtx) return;

      this.localAudioContext = new AudioCtx();
      const source = this.localAudioContext.createMediaStreamSource(stream);
      this.localAnalyser = this.localAudioContext.createAnalyser();
      this.localAnalyser.fftSize = 256;
      source.connect(this.localAnalyser);
      this.localVad = audioDeviceService.createVoiceDetector({
        sensitivity: getRuntimeAppStoreState().settings.audioVideo.inputSensitivity ?? 78,
        hangoverMs: getRuntimeAppStoreState().settings.audioVideo.voiceHangoverMs ?? 400,
      });
      this.localAudioContext.resume().catch(() => {});

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

    const dataArrayLocal = new Uint8Array(this.localAnalyser?.frequencyBinCount ?? 128);
    const dataArrayRemote = new Uint8Array(128);
    const REMOTE_VAD_THRESHOLD = 16;

    let lastLocalSpeaking = false;
    let lastRemoteSpeaking = false;

    this.vadInterval = setInterval(() => {
      if (this.isDestroyed) return;
      if (this.localAudioContext?.state === 'suspended') this.localAudioContext.resume().catch(() => {});
      if (this.remoteAudioContext?.state === 'suspended') this.remoteAudioContext.resume().catch(() => {});

      const sensitivity = getRuntimeAppStoreState().settings.audioVideo.inputSensitivity ?? 78;
      this.localVad?.setSensitivity(sensitivity);
      this.localVad?.setHangover(getRuntimeAppStoreState().settings.audioVideo.voiceHangoverMs ?? 400);

      // Local
      if (this.localAnalyser && !this.isMuted) {
        const isSpeaking = this.localVad
          ? processAnalyserFrame(this.localVad, this.localAnalyser, dataArrayLocal, 50).isSpeaking
          : false;
        if (isSpeaking !== lastLocalSpeaking) {
          lastLocalSpeaking = isSpeaking;
          this.callbacks.onLocalSpeaking(isSpeaking);
        }
      } else if (lastLocalSpeaking) {
        lastLocalSpeaking = false;
        this.localVad?.reset();
        this.callbacks.onLocalSpeaking(false);
      } else if (this.isMuted || !this.localAnalyser) {
        this.localVad?.reset();
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
    }, 50);
  }

  /**
   * Silencia ou reativa o microfone local
   */
  setMuted(muted: boolean): void {
    this.isMuted = muted;
    if (muted) this.localVad?.reset();
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
      this.localVad = null;
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
    this.clearBitrateRampTimers();
    this.bitrateRampStage = 'idle';
    this.currentTargetVideoBitrateKbps = null;
    if (this.screenVideoTrack) {
      try {
        this.screenVideoTrack.stop();
      } catch {}
      this.screenVideoTrack = null;
    }
    this.screenVideoSender = null;
    this.remoteVideoStream = null;
    this.closeScreenReceiver();

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

  public setScreenReceiverIceCallback(cb: ((candidate: RTCIceCandidateInit) => void) | null): void {
    this.onScreenReceiverIceCallback = cb;
  }

  private screenReceiverSignalingChain: Promise<void> = Promise.resolve();

  private enqueueScreenReceiverSignaling<T>(op: () => Promise<T>): Promise<T> {
    const next = this.screenReceiverSignalingChain.then(op, op);
    this.screenReceiverSignalingChain = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  public async handleRemoteScreenOffer(sdp: string): Promise<string | null> {
    try { assertScreenSdp(sdp); } catch {
      this.closeScreenReceiver(); (this.callbacks.onScreenReceiveWarning ?? this.callbacks.onError)(SCREEN_P2P_ERROR); throw new Error(SCREEN_P2P_ERROR);
    }
    const id = screenSessionId(sdp);
    if (id && this.remoteScreenSessionId && id !== this.remoteScreenSessionId) this.closeScreenReceiver();
    this.remoteScreenSessionId = id;
    this.screenReceiverStopped = false;
    const generation = this.screenReceiverGeneration;
    return this.enqueueScreenReceiverSignaling(async () => {
      const alive = () => !this.isDestroyed && generation === this.screenReceiverGeneration;
      if (!alive()) return null;
      if (!this.screenReceiverPc) {
        const iceServers = this.cachedIceServers ?? (await this.fetchIceServers());
        if (!alive()) return null;
        const pc = new RTCPeerConnection({
          iceServers: screenIceServers(iceServers),
          iceTransportPolicy: 'all',
          bundlePolicy: 'max-bundle',
          rtcpMuxPolicy: 'require',
          iceCandidatePoolSize: 2,
        });
        const stream = new MediaStream();
        this.screenReceiverPc = pc;
        this.screenReceiverStream = stream;
        this.stopScreenDiagnostics = startScreenReceiveDiagnostics(pc, stream, () => {
          if (alive()) this.callbacks.onScreenReceiveWarning?.('A transmissão conectou, mas ainda não recebeu vídeo. Tente reiniciar o compartilhamento.');
        });

        pc.onicecandidate = (event) => {
          if (this.isDestroyed || this.screenReceiverPc !== pc || !event.candidate) return;
          const init =
            typeof event.candidate.toJSON === 'function'
              ? event.candidate.toJSON()
              : {
                  candidate: event.candidate.candidate,
                  sdpMid: event.candidate.sdpMid,
                  sdpMLineIndex: event.candidate.sdpMLineIndex,
                };
          this.onScreenReceiverIceCallback?.(init);
        };

        let p2pReady = false;
        const publish = () => {
          const track = stream.getVideoTracks()[0];
          if (!p2pReady || !track || this.screenReceiverPc !== pc) return;
          this.remoteVideoStream = stream;
          this.callbacks.onRemoteVideoTrack?.(track, stream);
        };
        this.stopScreenP2P = guardScreenP2P(pc, ready => {
          p2pReady = ready; stream.getTracks().forEach(track => { track.enabled = ready; });
          if (ready) publish();
        }, message => {
          if (this.screenReceiverPc === pc) { this.closeScreenReceiver(); (this.callbacks.onScreenReceiveWarning ?? this.callbacks.onError)(message); }
        });
        pc.ontrack = (event) => {
          if (this.isDestroyed || this.screenReceiverPc !== pc) return;
          const track = event.track;
          track.enabled = p2pReady;
          if (!stream.getTracks().some((t) => t.id === track.id)) {
            stream.addTrack(track);
          }
          if (track.kind === 'video') {
            publish();
            track.onended = () => {
              if (this.screenReceiverPc === pc) this.closeScreenReceiver();
            };
          }
        };

        pc.onconnectionstatechange = () => {
          if (this.isDestroyed || this.screenReceiverPc !== pc) return;
          if (pc.connectionState === 'closed' || pc.connectionState === 'failed') {
            this.closeScreenReceiver();
          }
        };
      }

      const pc = this.screenReceiverPc;
      try {
      await pc.setRemoteDescription({ type: 'offer', sdp });
      if (!alive()) return null;
      while (this.screenReceiverCandidateQueue.length > 0) {
        const cand = this.screenReceiverCandidateQueue.shift();
        if (cand) {
          assertScreenCandidate(cand);
          await pc.addIceCandidate(cand).catch(() => {});
          if (!alive()) return null;
        }
      }
      const answer = await pc.createAnswer();
      if (!alive()) return null;
      await pc.setLocalDescription(answer);
      if (!alive()) return null;
      return pc.localDescription?.sdp ?? null;
      } catch (error) {
        if (!alive()) return null;
        this.closeScreenReceiver();
        throw error;
      }
    });
  }

  public async addScreenReceiverIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    try { assertScreenCandidate(candidate); } catch {
      this.closeScreenReceiver(); (this.callbacks.onScreenReceiveWarning ?? this.callbacks.onError)(SCREEN_P2P_ERROR); throw new Error(SCREEN_P2P_ERROR);
    }
    const generation = this.screenReceiverGeneration;
    return this.enqueueScreenReceiverSignaling(async () => {
      if (this.isDestroyed || this.screenReceiverStopped || generation !== this.screenReceiverGeneration) return;
      if (!this.screenReceiverPc || !this.screenReceiverPc.remoteDescription) {
        if (this.screenReceiverCandidateQueue.length < 256) {
          this.screenReceiverCandidateQueue.push(candidate);
        }
        return;
      }
      await this.screenReceiverPc.addIceCandidate(candidate).catch(() => {});
    });
  }

  public closeScreenReceiver(expectedSessionId?: string): void {
    if (expectedSessionId && expectedSessionId !== this.remoteScreenSessionId) return;
    this.screenReceiverGeneration++;
    this.screenReceiverStopped = true;
    this.remoteScreenSessionId = null;
    this.stopScreenP2P?.(); this.stopScreenP2P = null;
    this.stopScreenDiagnostics?.();
    this.stopScreenDiagnostics = null;
    // Keep serialization intact; generation checks cancel work already awaiting IPC/SDP.
    if (this.screenReceiverPc) {
      try {
        this.screenReceiverPc.onicecandidate = null;
        this.screenReceiverPc.ontrack = null;
        this.screenReceiverPc.onconnectionstatechange = null;
        this.screenReceiverPc.close();
      } catch {}
      this.screenReceiverPc = null;
    }
    this.screenReceiverCandidateQueue = [];
    const stream = this.screenReceiverStream;
    this.screenReceiverStream = null;
    releaseScreenStream(stream);
    if (stream && this.remoteVideoStream === stream) {
      this.remoteVideoStream = null;
      this.callbacks.onRemoteVideoEnded?.();
    }
  }
}
