import { screenIceServers, assertScreenCandidate, assertScreenSdp, assertVoiceOnlySdp, guardScreenP2P, SCREEN_P2P_ERROR, SCREEN_DEDICATED_REQUIRED } from './ScreenP2PPolicy.ts';
/**
 * NEXUS - WebRTC P2P Mesh Voice & Screen Room Engine (Phase B3.2)
 *
 * Independente do WebRtcService (1:1) e CallService (1:1).
 * Gerencia multiplas RTCPeerConnection por peerUserId (ate 4 participantes iniciais),
 * Perfect Negotiation (polite = selfUserId < peerUserId), ICE Restart individual,
 * STUN + TURN fallback, microfone compartilhado, audio remoto independente (0..200% + VAD),
 * multiplos streamers simultaneos e telemetria real via getStats().
 */

import { audioDeviceService } from './AudioDeviceService.ts';
import { startScreenReceiveDiagnostics, screenReceiverContext } from './ScreenReceiveDiagnostics.ts';
import { detachScreenElements, releaseScreenStream, screenSessionId, screenCandidateSessionId, tagScreenCandidate, screenAnswerSessionId, tagScreenAnswer, screenCandidateInit } from './screenReceiverLifecycle.ts';
import { screenCaptureService, applyTrackContentHint } from './ScreenCaptureService.ts';
import { processAnalyserFrame, type VoiceActivityDetector } from '../lib/voiceActivity.ts';
import type {
  NativeCaptureStatus,
  NativeScreenStatsEvent,
  RoomParticipantDto,
  ScreenShareQualityPreset,
  StartScreenShareOptions,
  StreamKind,
  VoiceRoomMetricsSnapshot,
  VoiceRoomPeerMetrics,
  VoiceRoomPeerStatus,
  VoiceRoomQualityPreset,
} from '../lib/types';

const DEFAULT_MAX_PARTICIPANTS = 4;
const DEFAULT_ICE_DISCONNECT_TIMEOUT_MS = 5000;
const MAX_ICE_RESTART_ATTEMPTS = 3;
const MAX_CANDIDATE_QUEUE_SIZE = 256;
const STATS_POLL_INTERVAL_MS = 2000;
const VAD_POLL_INTERVAL_MS = 100;

const FALLBACK_STUN_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

interface VideoEncodingPreset {
  capturePreset: ScreenShareQualityPreset;
  maxBitrate: number;
  maxFramerate: number;
  contentHint: 'detail' | 'motion';
}

const VOICE_ROOM_QUALITY_PRESETS: Record<VoiceRoomQualityPreset, VideoEncodingPreset> = {
  auto: {
    capturePreset: 'auto',
    maxBitrate: 2_500_000,
    maxFramerate: 30,
    contentHint: 'detail',
  },
  '720p30': {
    capturePreset: '720p30',
    maxBitrate: 2_200_000,
    maxFramerate: 30,
    contentHint: 'detail',
  },
  '720p60': {
    capturePreset: '720p30',
    maxBitrate: 3_200_000,
    maxFramerate: 60,
    contentHint: 'motion',
  },
  '1080p30': {
    capturePreset: '1080p30',
    maxBitrate: 3_500_000,
    maxFramerate: 30,
    contentHint: 'detail',
  },
  '1080p60': {
    capturePreset: '1080p60',
    maxBitrate: 5_000_000,
    maxFramerate: 60,
    contentHint: 'motion',
  },
};

export type ScreenReceiverState = 'connecting' | 'waiting_video' | 'failed' | 'closed';

export interface MeshRoomCallbacks {
  onSendOffer: (peerUserId: string, sdp: string, streamKind?: StreamKind) => void;
  onSendAnswer: (peerUserId: string, sdp: string, streamKind?: StreamKind) => void;
  onSendIceCandidate: (peerUserId: string, candidate: RTCIceCandidateInit, streamKind?: StreamKind) => void;
  onPeerStatusChange?: (peerUserId: string, status: VoiceRoomPeerStatus) => void;
  onLocalSpeaking?: (isSpeaking: boolean) => void;
  onPeerSpeaking?: (peerUserId: string, isSpeaking: boolean) => void;
  onScreenReceiverState?: (peerUserId: string, state: ScreenReceiverState) => void;
  onRemoteVideoStreamsChange?: (streams: Map<string, MediaStream>) => void;
  onMetricsUpdate?: (snapshot: VoiceRoomMetricsSnapshot) => void;
  onNativeStatusChange?: (status: NativeCaptureStatus | null) => void;
  onNativeStats?: (stats: NativeScreenStatsEvent | null) => void;
  onNativeScreenEnded?: (reason: string) => void;
  onScreenSharingChange?: (sharing: boolean) => void;
  onError?: (message: string) => void;
}

interface ScreenReceiverSession {
  offerSessionId: string | null;
  lastOfferSdp?: string;
  answerSdp?: string;
  diagnostics: Record<string, number>;
  stopDiagnostics: () => void;
  peerUserId: string;
  pc: RTCPeerConnection;
  stream: MediaStream;
  pendingCandidates: RTCIceCandidateInit[];
  signalingChain: Promise<void>;
}

interface PeerStatsPrev {
  timestampMs: number;
  bytesSent: number;
  bytesReceived: number;
}

interface PeerSession {
  peerUserId: string;
  pc: RTCPeerConnection;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  isSettingRemoteAnswerPending: boolean;
  pendingCandidates: RTCIceCandidateInit[];
  signalingChain: Promise<void>;
  audioSender: RTCRtpSender | null;
  videoSender: RTCRtpSender | null;
  remoteAudioStream: MediaStream | null;
  remoteAudioEl: HTMLAudioElement | null;
  remoteAudioCtx: AudioContext | null;
  remoteAnalyser: AnalyserNode | null;
  remoteBoostGain: GainNode | null;
  remoteVad: VoiceActivityDetector | null;
  lastRemoteSpeaking: boolean;
  volumePercent: number;
  status: VoiceRoomPeerStatus;
  iceDisconnectTimer: ReturnType<typeof setTimeout> | null;
  iceRestartAttempts: number;
  statsPrev: PeerStatsPrev | null;
}

function getRuntimeStoreSettings(): {
  inputDevice: string;
  outputDevice: string;
  inputSensitivity: number;
  voiceHangoverMs: number;
  outputVolume: number;
  noiseSuppression: boolean;
  echoCancellation: boolean;
  autoGainControl: boolean;
  participantVolumes: Record<string, number>;
} {
  try {
    const store = (globalThis as any).__NEXUS_STORE__;
    const av = store?.getState?.()?.settings?.audioVideo;
    if (av) {
      return {
        inputDevice: av.inputDevice ?? 'default',
        outputDevice: av.outputDevice ?? 'default',
        inputSensitivity: av.inputSensitivity ?? 78,
        voiceHangoverMs: av.voiceHangoverMs ?? 400,
        outputVolume: av.outputVolume ?? 85,
        noiseSuppression: av.noiseSuppression ?? true,
        echoCancellation: av.echoCancellation ?? true,
        autoGainControl: av.autoGainControl ?? true,
        participantVolumes: av.participantVolumes ?? {},
      };
    }
  } catch {
    // Fallback to defaults when store is not mounted yet
  }
  return {
    inputDevice: 'default',
    outputDevice: 'default',
    inputSensitivity: 78,
    voiceHangoverMs: 400,
    outputVolume: 85,
    noiseSuppression: true,
    echoCancellation: true,
    autoGainControl: true,
    participantVolumes: {},
  };
}

export class MeshRoomService {
  private callbacks: MeshRoomCallbacks | null = null;
  private selfUserId: string | null = null;
  private communityId: string | null = null;
  private channelId: string | null = null;
  private maxParticipants = DEFAULT_MAX_PARTICIPANTS;
  private iceTransportPolicy: RTCIceTransportPolicy = 'all';
  private iceDisconnectTimeoutMs = DEFAULT_ICE_DISCONNECT_TIMEOUT_MS;

  private peers = new Map<string, PeerSession>();
  private screenReceiverPeers = new Map<string, ScreenReceiverSession>();
  private screenReceiverCreations = new Map<string, Promise<ScreenReceiverSession | null>>();
  private screenReceiverVersions = new Map<string, number>();
  private screenReceiverOfferIds = new Map<string, string>();
  private earlyScreenCandidates = new Map<string, RTCIceCandidateInit[]>();
  private stoppedScreenPeers = new Set<string>();
  private departedPeers = new Set<string>();
  private roomGeneration = 0;
  private nativeScreenGeneration = 0;
  private nativeStartRequest = 0;
  private remoteVideoStreams = new Map<string, MediaStream>();
  private peerVolumes = new Map<string, number>();

  private localAudioStream: MediaStream | null = null;
  private localAudioCtx: AudioContext | null = null;
  private localAnalyser: AnalyserNode | null = null;
  private localVad: VoiceActivityDetector | null = null;
  private lastLocalSpeaking = false;

  private screenVideoTrack: MediaStreamTrack | null = null;
  private nativeScreenActive = false;
  private nativeScreenStarting = false;
  private nativeScreenReadyPeers = new Set<string>();
  private screenRetryOffers = new Map<string, string>();
  private screenRetryLimits = new Map<string, { at: number; count: number }>();
  private screenRetryPending = new Map<string, ReturnType<typeof setTimeout>>();
  private nativeScreenRetryLimits = new Map<string, { at: number; count: number }>();
  private nativeScreenOfferIds = new Map<string, string>();
  private nativeScreenPendingIce = new Map<string, RTCIceCandidateInit[]>();
  private nativeScreenPeerVersions = new Map<string, number>();
  private nativeUnlisten: (() => void) | null = null;
  private adaptiveBitrateBps = 2_500_000;
  private lastAdaptiveUpdateMs = 0;
  private prevTotalPacketsLost = 0;
  private activeQuality: VoiceRoomQualityPreset = 'auto';

  private isMuted = false;
  private isDeafened = false;

  private cachedIceServers: RTCIceServer[] | null = null;
  private lastIceServersFetch = 0;

  private vadInterval: ReturnType<typeof setInterval> | null = null;
  private statsInterval: ReturnType<typeof setInterval> | null = null;
  private isActive = false;
  private sessionInitPromise: Promise<void> | null = null;

  public setCallbacks(callbacks: MeshRoomCallbacks): void {
    this.callbacks = callbacks;
  }

  public configure(options: {
    iceTransportPolicy?: RTCIceTransportPolicy;
    iceDisconnectTimeoutMs?: number;
    maxParticipants?: number;
  }): void {
    if (options.iceTransportPolicy) {
      this.iceTransportPolicy = options.iceTransportPolicy;
    }
    if (typeof options.iceDisconnectTimeoutMs === 'number') {
      this.iceDisconnectTimeoutMs = Math.max(200, options.iceDisconnectTimeoutMs);
    }
    if (typeof options.maxParticipants === 'number') {
      this.maxParticipants = Math.max(2, options.maxParticipants);
    }
  }

  public getRemoteVideoStreams(): Map<string, MediaStream> {
    return new Map(this.remoteVideoStreams);
  }

  public getActiveRoom(): { communityId: string; channelId: string } | null {
    if (!this.isActive || !this.communityId || !this.channelId) return null;
    return { communityId: this.communityId, channelId: this.channelId };
  }

  public async fetchIceServers(forceRefresh = false): Promise<RTCIceServer[]> {
    const now = Date.now();
    if (!forceRefresh && this.cachedIceServers && now - this.lastIceServersFetch < 600_000) {
      return this.cachedIceServers;
    }

    const isTauriRuntime =
      typeof window !== 'undefined' && Boolean((window as any).__TAURI_INTERNALS__);

    if (isTauriRuntime) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const servers = await invoke<RTCIceServer[]>('webrtc_get_ice_servers');
        if (Array.isArray(servers) && servers.length > 0) {
          this.cachedIceServers = servers;
          this.lastIceServersFetch = now;
          return servers;
        }
      } catch (err) {
        console.warn('[MeshRoomService] Falha IPC webrtc_get_ice_servers, tentando fallback:', err);
      }
    } else if (typeof window !== 'undefined' && typeof fetch === 'function') {
      try {
        const apiBase = window.localStorage?.getItem('nexus_test_api_base')?.trim();
        const token = window.localStorage?.getItem('nexus_test_token')?.trim();
        if (apiBase && token) {
          const resp = await fetch(`${apiBase.replace(/\/+$/, '')}/v1/webrtc/ice-servers`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (resp.ok) {
            const data = await resp.json();
            const servers = Array.isArray(data) ? data : data?.ice_servers || data?.iceServers;
            if (Array.isArray(servers) && servers.length > 0) {
              this.cachedIceServers = servers;
              this.lastIceServersFetch = now;
              return servers;
            }
          }
        }
      } catch (err) {
        console.warn('[MeshRoomService] Falha HTTP /v1/webrtc/ice-servers, usando STUN fallback:', err);
      }
    }

    this.cachedIceServers = FALLBACK_STUN_SERVERS;
    this.lastIceServersFetch = now;
    return FALLBACK_STUN_SERVERS;
  }

  public async startRoomSession(params: {
    selfUserId: string;
    communityId: string;
    channelId: string;
    participants: RoomParticipantDto[];
    maxParticipants?: number;
    canSpeak?: boolean;
    initialVolumes?: Record<string, number>;
  }): Promise<void> {
    await this.leaveRoom();

    this.isActive = true;
    this.selfUserId = params.selfUserId;
    this.communityId = params.communityId;
    this.channelId = params.channelId;
    this.maxParticipants = params.maxParticipants ?? DEFAULT_MAX_PARTICIPANTS;
    this.isMuted = params.canSpeak === false;

    if (params.initialVolumes) {
      for (const [uid, vol] of Object.entries(params.initialVolumes)) {
        this.peerVolumes.set(uid, Math.max(0, Math.min(200, Math.round(vol))));
      }
    }

    const initPromise = (async () => {
      await this.fetchIceServers();
      await this.ensureLocalAudio();
    })();
    this.sessionInitPromise = initPromise;
    await initPromise;
    if (this.sessionInitPromise === initPromise) {
      this.sessionInitPromise = null;
    }
    if (!this.isActive) return;

    this.startVadLoop();
    this.startStatsLoop();

    for (const participant of params.participants) {
      if (participant.user_id !== this.selfUserId) {
        await this.ensurePeerConnection(participant.user_id);
      }
    }
  }

  public async addParticipant(participant: RoomParticipantDto): Promise<void> {
    if (!this.isActive || !this.selfUserId) return;
    if (participant.user_id === this.selfUserId) return;
    this.departedPeers.delete(participant.user_id);
    if (this.sessionInitPromise) {
      await this.sessionInitPromise;
      if (!this.isActive || !this.selfUserId) return;
    }
    if (this.peers.size + 1 >= this.maxParticipants && !this.peers.has(participant.user_id)) {
      this.callbacks?.onError?.(`Limite da sala atingido (${this.maxParticipants} participantes).`);
      return;
    }
    await this.ensurePeerConnection(participant.user_id);
  }

  public removeParticipant(peerUserId: string): void {
    this.nativeScreenPeerVersions.set(peerUserId, (this.nativeScreenPeerVersions.get(peerUserId) ?? 0) + 1);
    this.nativeScreenReadyPeers.delete(peerUserId);
    this.nativeScreenPendingIce.delete(peerUserId);
    this.nativeScreenOfferIds.delete(peerUserId);
    this.departedPeers.add(peerUserId);
    this.closeRemoteScreen(peerUserId);
    const peer = this.peers.get(peerUserId);
    if (peer) {
      this.cleanupPeer(peer);
      this.peers.delete(peerUserId);
    }

    const screenReceiver = this.screenReceiverPeers.get(peerUserId);
    if (screenReceiver) {
      this.cleanupScreenReceiver(screenReceiver);
      this.screenReceiverPeers.delete(peerUserId);
    }

    if (this.nativeScreenActive) {
      screenCaptureService.removeNativeScreenPeer(peerUserId).catch(() => {});
    }

    if (this.remoteVideoStreams.has(peerUserId)) {
      this.remoteVideoStreams.delete(peerUserId);
      this.callbacks?.onRemoteVideoStreamsChange?.(new Map(this.remoteVideoStreams));
    }
    if (peer) {
      this.callbacks?.onPeerStatusChange?.(peerUserId, 'closed');
    }
  }

  public async leaveRoom(): Promise<void> {
    this.isActive = false;
    this.roomGeneration++;
    this.screenReceiverCreations.clear();
    this.earlyScreenCandidates.clear();
    this.stoppedScreenPeers.clear();
    this.departedPeers.clear();
    this.screenReceiverVersions.clear();
    this.screenReceiverOfferIds.clear();
    this.screenRetryOffers.clear(); this.screenRetryLimits.clear();
    this.screenRetryPending.forEach(clearTimeout); this.screenRetryPending.clear();
    this.sessionInitPromise = null;

    if (this.vadInterval) {
      clearInterval(this.vadInterval);
      this.vadInterval = null;
    }
    if (this.statsInterval) {
      clearInterval(this.statsInterval);
      this.statsInterval = null;
    }

    for (const peer of this.peers.values()) {
      this.cleanupPeer(peer);
    }
    this.peers.clear();

    for (const receiver of this.screenReceiverPeers.values()) {
      this.cleanupScreenReceiver(receiver);
    }
    this.screenReceiverPeers.clear();

    if (this.remoteVideoStreams.size > 0) {
      this.remoteVideoStreams.clear();
      this.callbacks?.onRemoteVideoStreamsChange?.(new Map());
    }

    await this.stopScreenShare();

    this.teardownLocalAudio();

    this.selfUserId = null;
    this.communityId = null;
    this.channelId = null;
    this.lastLocalSpeaking = false;
  }

  public setMuted(muted: boolean): void {
    this.isMuted = muted;
    if (this.localAudioStream) {
      this.localAudioStream.getAudioTracks().forEach((track) => {
        track.enabled = !muted;
      });
    }
    if (muted && this.lastLocalSpeaking) {
      this.lastLocalSpeaking = false;
      this.localVad?.reset();
      this.callbacks?.onLocalSpeaking?.(false);
    }
  }

  public setDeafened(deafened: boolean): void {
    this.isDeafened = deafened;
    for (const peer of this.peers.values()) {
      this.applyPeerVolume(peer);
      if (deafened && peer.lastRemoteSpeaking) {
        peer.lastRemoteSpeaking = false;
        this.callbacks?.onPeerSpeaking?.(peer.peerUserId, false);
      }
    }
  }

  public setParticipantVolume(peerUserId: string, volumePercent: number): void {
    const clamped = Math.max(0, Math.min(200, Math.round(volumePercent)));
    this.peerVolumes.set(peerUserId, clamped);
    const peer = this.peers.get(peerUserId);
    if (peer) {
      peer.volumePercent = clamped;
      this.applyPeerVolume(peer);
    }
  }

  public async switchInputDevice(deviceId: string): Promise<void> {
    if (!this.isActive) return;
    const settings = getRuntimeStoreSettings();
    const constraints: MediaTrackConstraints = {
      echoCancellation: settings.echoCancellation,
      noiseSuppression: settings.noiseSuppression,
      autoGainControl: settings.autoGainControl,
    };
    if (deviceId && deviceId !== 'default') {
      constraints.deviceId = { exact: deviceId };
    }

    const newStream = await navigator.mediaDevices.getUserMedia({ audio: constraints, video: false });
    const newTrack = newStream.getAudioTracks()[0];
    if (!newTrack) return;

    newTrack.enabled = !this.isMuted;

    const oldStream = this.localAudioStream;
    this.localAudioStream = newStream;
    this.setupLocalVad(newStream);

    for (const peer of this.peers.values()) {
      if (peer.audioSender) {
        await peer.audioSender.replaceTrack(newTrack);
        await this.configureAudioSenderPriority(peer.audioSender);
      }
    }

    if (oldStream) {
      oldStream.getTracks().forEach((t) => t.stop());
    }
  }

  public async switchOutputDevice(deviceId: string): Promise<void> {
    for (const peer of this.peers.values()) {
      if (peer.remoteAudioEl && deviceId) {
        await audioDeviceService.setAudioSink(peer.remoteAudioEl, deviceId).catch(() => {});
      }
    }
  }

  public isNativeScreenShareActive(): boolean {
    return this.nativeScreenActive;
  }

  public async startNativeScreenShare(
    options: StartScreenShareOptions
  ): Promise<NativeCaptureStatus | null> {
    if (!this.isActive) return null;
    const request = ++this.nativeStartRequest;
    const room = this.roomGeneration;
    await this.stopScreenShare(false);
    if (request !== this.nativeStartRequest || room !== this.roomGeneration) return null;
    const generation = this.nativeScreenGeneration;
    const alive = () => this.isActive && request === this.nativeStartRequest && room === this.roomGeneration && generation === this.nativeScreenGeneration;

    const preset = options.preset ?? this.activeQuality ?? 'auto';
    this.activeQuality = preset;
    const cfg = VOICE_ROOM_QUALITY_PRESETS[preset] ?? VOICE_ROOM_QUALITY_PRESETS.auto;
    this.adaptiveBitrateBps = cfg.maxBitrate;
    this.lastAdaptiveUpdateMs = Date.now();
    this.prevTotalPacketsLost = 0;

    const iceServers =
      options.ice_servers ?? this.cachedIceServers ?? (await this.fetchIceServers());
    if (!alive()) return null;

    const unlisten = await screenCaptureService.subscribeNativeEvents({
      onIce: (ev) => {
        if (!alive() || !this.nativeScreenActive || this.departedPeers.has(ev.peer_id)) return;
        const candidate = tagScreenCandidate({ candidate: ev.candidate, sdpMid: ev.sdp_mid ?? undefined, sdpMLineIndex: ev.sdp_mline_index ?? undefined }, ev.sdp_session_id ?? null);
        if (!this.nativeScreenReadyPeers.has(ev.peer_id)) {
          const queue = this.nativeScreenPendingIce.get(ev.peer_id) ?? [];
          if (queue.length < MAX_CANDIDATE_QUEUE_SIZE) queue.push(candidate);
          this.nativeScreenPendingIce.set(ev.peer_id, queue);
          return;
        }
        const id = this.nativeScreenOfferIds.get(ev.peer_id);
        if (screenCandidateSessionId(candidate) && screenCandidateSessionId(candidate) !== id) return;
        this.callbacks?.onSendIceCandidate(ev.peer_id, tagScreenCandidate(candidate, id ?? null), 'screen');
      },
      onStats: (ev) => {
        if (!alive() || !this.nativeScreenActive) return;
        this.callbacks?.onNativeStats?.(ev);
      },
      onError: (ev) => {
        if (!alive()) return;
        this.callbacks?.onError?.(ev.message);
        if (!ev.recoverable && (this.nativeScreenActive || this.nativeScreenStarting)) {
          this.callbacks?.onNativeScreenEnded?.('capture_failed');
          void this.stopScreenShare();
        }
      },
      onEnded: (ev) => {
        if (!alive() || (!this.nativeScreenActive && !this.nativeScreenStarting)) return;
        if (this.nativeScreenStarting && !this.nativeScreenActive && ev.reason === 'user_stopped') return;
        this.callbacks?.onNativeScreenEnded?.(ev.reason);
        void this.stopScreenShare();
      },
    });

    if (!alive()) { unlisten(); return null; }
    this.nativeUnlisten = unlisten;

    try {
      this.nativeScreenStarting = true;
      const status = await screenCaptureService.startNativeShare({
        ...options,
        preset,
        ice_servers: iceServers,
      });
      if (!alive()) return null;
      this.nativeScreenStarting = false;
      this.nativeScreenActive = true;
      this.adaptiveBitrateBps = status.bitrate_bps || cfg.maxBitrate;
      this.callbacks?.onNativeStatusChange?.(status);
      this.callbacks?.onScreenSharingChange?.(true);

      for (const peerUserId of this.peers.keys()) {
        try { await this.addNativeScreenPeer(peerUserId, iceServers); }
        catch {
          if (alive()) this.callbacks?.onError?.('Não foi possível conectar a tela a um participante. Os outros espectadores continuam conectados.');
        }
        if (!alive()) return null;
      }
      return alive() ? status : null;
    } catch (err) {
      if (!alive()) return null;
      await this.stopScreenShare();
      throw err;
    }
  }

  public async startScreenShare(_preset: VoiceRoomQualityPreset = 'auto'): Promise<boolean> {
    this.callbacks?.onError?.(SCREEN_DEDICATED_REQUIRED);
    return false;
  }

  public async stopScreenShare(cancelPendingStart = true): Promise<void> {
    if (cancelPendingStart) this.nativeStartRequest++;
    this.nativeScreenGeneration++;
    if (this.nativeScreenActive || this.nativeScreenStarting || this.screenVideoTrack) this.callbacks?.onScreenSharingChange?.(false);
    if (this.nativeScreenActive || this.nativeScreenStarting) {
      this.teardownNativeScreenState();
      this.callbacks?.onNativeStatusChange?.(null);
      this.callbacks?.onNativeStats?.(null);
      await screenCaptureService.stopNativeShare().catch(() => {});
    }

    const track = this.screenVideoTrack;
    this.screenVideoTrack = null;

    for (const peer of this.peers.values()) {
      if (peer.videoSender) {
        try {
          peer.pc.removeTrack(peer.videoSender);
        } catch {
          // Ignore if already removed or closed
        }
        peer.videoSender = null;
      }
    }

    if (track) {
      try {
        track.onended = null;
        track.stop();
      } catch {
        // Ignore
      }
    }

    if (screenCaptureService.getState().isCapturing) {
      screenCaptureService.stopCapture();
    }
  }

  public async setScreenShareQuality(preset: VoiceRoomQualityPreset): Promise<void> {
    this.activeQuality = preset;
    const cfg = VOICE_ROOM_QUALITY_PRESETS[preset] ?? VOICE_ROOM_QUALITY_PRESETS.auto;
    this.adaptiveBitrateBps = cfg.maxBitrate;

    if (this.nativeScreenActive) {
      await screenCaptureService.setNativeScreenQuality(preset);
      return;
    }

    if (this.screenVideoTrack) {
      applyTrackContentHint(this.screenVideoTrack, cfg.contentHint);
    }

    for (const peer of this.peers.values()) {
      if (peer.videoSender) {
        await this.applyVideoSenderParameters(peer.videoSender, cfg);
      }
    }
  }

  public async handleRemoteOffer(
    peerUserId: string,
    sdp: string,
    streamKind?: StreamKind
  ): Promise<void> {
    if (!this.isActive || !this.selfUserId) return;
    if (this.sessionInitPromise) {
      await this.sessionInitPromise;
      if (!this.isActive || !this.selfUserId) return;
    }

    if (streamKind === 'screen') {
      return this.handleScreenReceiverOffer(peerUserId, sdp);
    }

    const peer = await this.ensurePeerConnection(peerUserId);

    return this.enqueuePeerSignaling(peer, async () => {
      const offerCollision = peer.makingOffer || peer.pc.signalingState !== 'stable';
      peer.ignoreOffer = !peer.polite && offerCollision;
      if (peer.ignoreOffer) {
        return;
      }

      assertVoiceOnlySdp(sdp);
      await peer.pc.setRemoteDescription({ type: 'offer', sdp });
      await this.flushPendingCandidates(peer);
      await peer.pc.setLocalDescription();

      if (peer.pc.localDescription?.sdp) {
        this.callbacks?.onSendAnswer(peerUserId, peer.pc.localDescription.sdp, 'voice');
      }
    });
  }

  public async handleRemoteAnswer(
    peerUserId: string,
    sdp: string,
    streamKind?: StreamKind
  ): Promise<void> {
    if (!this.isActive) return;

    if (streamKind === 'screen') {
      const answerSession = screenAnswerSessionId(sdp);
      if (answerSession && answerSession !== this.nativeScreenOfferIds.get(peerUserId)) return;
      if (this.nativeScreenActive) {
        await screenCaptureService.handleNativeScreenAnswer(peerUserId, sdp, this.nativeScreenOfferIds.get(peerUserId)).catch((err) => {
          console.warn('[ScreenP2P] answer_rejected'); this.callbacks?.onError?.(SCREEN_P2P_ERROR); void err;
        });
      }
      return;
    }

    const peer = this.peers.get(peerUserId);
    if (!peer) return;

    return this.enqueuePeerSignaling(peer, async () => {
      peer.isSettingRemoteAnswerPending = true;
      try {
        assertVoiceOnlySdp(sdp);
        await peer.pc.setRemoteDescription({ type: 'answer', sdp });
        await this.flushPendingCandidates(peer);
      } finally {
        peer.isSettingRemoteAnswerPending = false;
      }
    });
  }

  public async handleRemoteIceCandidate(
    peerUserId: string,
    candidate: RTCIceCandidateInit,
    streamKind?: StreamKind
  ): Promise<void> {
    if (!this.isActive || !this.selfUserId) return;
    if (this.sessionInitPromise) {
      await this.sessionInitPromise;
      if (!this.isActive || !this.selfUserId) return;
    }

    if (streamKind === 'screen') {
      await this.handleScreenStreamIceCandidate(peerUserId, candidate);
      return;
    }

    const peer = await this.ensurePeerConnection(peerUserId);

    return this.enqueuePeerSignaling(peer, async () => {
      try {
        if (!peer.pc.remoteDescription) {
          if (peer.pendingCandidates.length < MAX_CANDIDATE_QUEUE_SIZE) {
            peer.pendingCandidates.push(candidate);
          }
          return;
        }
        await peer.pc.addIceCandidate(candidate);
      } catch (err) {
        if (!peer.ignoreOffer) {
          console.warn(`[MeshRoomService] Erro ao aplicar ICE candidate de ${peerUserId}:`, err);
        }
      }
    });
  }

  public async collectMetricsSnapshot(): Promise<VoiceRoomMetricsSnapshot> {
    const now = Date.now();
    const peerMetrics: Record<string, VoiceRoomPeerMetrics> = {};
    let rttSum = 0;
    let rttCount = 0;
    let totalUploadKbps = 0;
    let totalDownloadKbps = 0;
    let totalPacketsLost = 0;

    for (const [peerUserId, peer] of this.peers.entries()) {
      const metrics = await this.collectPeerMetrics(peer, now);
      peerMetrics[peerUserId] = metrics;

      if (metrics.rttMs !== null) {
        rttSum += metrics.rttMs;
        rttCount += 1;
      }
      totalUploadKbps += metrics.uploadKbps;
      totalDownloadKbps += metrics.downloadKbps;
      totalPacketsLost += metrics.packetsLost;
    }

    const perfMem = (performance as any)?.memory;
    const jsHeapUsedMb =
      perfMem && typeof perfMem.usedJSHeapSize === 'number'
        ? Math.round((perfMem.usedJSHeapSize / (1024 * 1024)) * 10) / 10
        : null;

    return {
      timestampMs: now,
      peerCount: this.peers.size,
      avgRttMs: rttCount > 0 ? Math.round(rttSum / rttCount) : null,
      totalUploadKbps: Math.round(totalUploadKbps * 10) / 10,
      totalDownloadKbps: Math.round(totalDownloadKbps * 10) / 10,
      totalPacketsLost,
      jsHeapUsedMb,
      peers: peerMetrics,
    };
  }

  private async ensureLocalAudio(): Promise<MediaStream | null> {
    if (this.localAudioStream) return this.localAudioStream;
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      return null;
    }

    const settings = getRuntimeStoreSettings();
    const audioConstraints: MediaTrackConstraints = {
      echoCancellation: settings.echoCancellation,
      noiseSuppression: settings.noiseSuppression,
      autoGainControl: settings.autoGainControl,
    };
    if (settings.inputDevice && settings.inputDevice !== 'default') {
      audioConstraints.deviceId = { exact: settings.inputDevice };
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints,
        video: false,
      });
      stream.getAudioTracks().forEach((track) => {
        track.enabled = !this.isMuted;
      });
      this.localAudioStream = stream;
      this.setupLocalVad(stream);
      return stream;
    } catch (err) {
      console.warn('[MeshRoomService] Falha ao capturar microfone (fallback para default):', err);
      try {
        const fallbackStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
          video: false,
        });
        fallbackStream.getAudioTracks().forEach((track) => {
          track.enabled = !this.isMuted;
        });
        this.localAudioStream = fallbackStream;
        this.setupLocalVad(fallbackStream);
        return fallbackStream;
      } catch (fallbackErr: any) {
        this.callbacks?.onError?.(
          fallbackErr?.message || 'Não foi possível acessar o microfone.'
        );
        return null;
      }
    }
  }

  private teardownLocalAudio(): void {
    if (this.localAudioCtx) {
      this.localAudioCtx.close().catch(() => {});
      this.localAudioCtx = null;
    }
    this.localAnalyser = null;
    this.localVad = null;
    if (this.localAudioStream) {
      this.localAudioStream.getTracks().forEach((t) => t.stop());
      this.localAudioStream = null;
    }
  }

  private setupLocalVad(stream: MediaStream): void {
    try {
      if (this.localAudioCtx) {
        this.localAudioCtx.close().catch(() => {});
        this.localAudioCtx = null;
      }
      if (typeof window === 'undefined') return;
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioCtx) return;

      const settings = getRuntimeStoreSettings();
      this.localAudioCtx = new AudioCtx();
      const source = this.localAudioCtx.createMediaStreamSource(stream);
      this.localAnalyser = this.localAudioCtx.createAnalyser();
      this.localAnalyser.fftSize = 256;
      source.connect(this.localAnalyser);
      this.localVad = audioDeviceService.createVoiceDetector({
        sensitivity: settings.inputSensitivity,
        hangoverMs: settings.voiceHangoverMs,
      });
      this.localAudioCtx.resume().catch(() => {});
    } catch (err) {
      console.warn('[MeshRoomService] Falha ao iniciar VAD local:', err);
    }
  }

  private async ensurePeerConnection(peerUserId: string): Promise<PeerSession> {
    const existing = this.peers.get(peerUserId);
    if (existing) return existing;

    const iceServers = this.cachedIceServers ?? (await this.fetchIceServers());
    const pc = new RTCPeerConnection({
      iceServers,
      iceTransportPolicy: this.iceTransportPolicy,
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
      iceCandidatePoolSize: 2,
    });

    const settings = getRuntimeStoreSettings();
    const initialVol =
      this.peerVolumes.get(peerUserId) ??
      settings.participantVolumes[peerUserId] ??
      100;

    const polite = Boolean(this.selfUserId && this.selfUserId < peerUserId);

    const peer: PeerSession = {
      peerUserId,
      pc,
      polite,
      makingOffer: false,
      ignoreOffer: false,
      isSettingRemoteAnswerPending: false,
      pendingCandidates: [],
      signalingChain: Promise.resolve(),
      audioSender: null,
      videoSender: null,
      remoteAudioStream: null,
      remoteAudioEl: null,
      remoteAudioCtx: null,
      remoteAnalyser: null,
      remoteBoostGain: null,
      remoteVad: null,
      lastRemoteSpeaking: false,
      volumePercent: Math.max(0, Math.min(200, Math.round(initialVol))),
      status: 'new',
      iceDisconnectTimer: null,
      iceRestartAttempts: 0,
      statsPrev: null,
    };

    this.peers.set(peerUserId, peer);

    pc.onnegotiationneeded = async () => {
      if (!this.isActive || this.peers.get(peerUserId) !== peer) return;
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        if (pc.localDescription?.sdp) {
          this.callbacks?.onSendOffer(peerUserId, pc.localDescription.sdp);
        }
      } catch (err) {
        console.warn(`[MeshRoomService] Erro em negotiationneeded (${peerUserId}):`, err);
      } finally {
        peer.makingOffer = false;
      }
    };

    pc.onicecandidate = (event) => {
      if (!this.isActive || this.peers.get(peerUserId) !== peer) return;
      if (event.candidate) {
        const init =
          typeof event.candidate.toJSON === 'function'
            ? event.candidate.toJSON()
            : {
                candidate: event.candidate.candidate,
                sdpMid: event.candidate.sdpMid,
                sdpMLineIndex: event.candidate.sdpMLineIndex,
              };
        this.callbacks?.onSendIceCandidate(peerUserId, init);
      }
    };

    pc.oniceconnectionstatechange = () => {
      if (!this.isActive || this.peers.get(peerUserId) !== peer) return;
      const state = pc.iceConnectionState;

      if (state === 'connected' || state === 'completed') {
        this.clearPeerIceTimer(peer);
        peer.iceRestartAttempts = 0;
        this.updatePeerStatus(peer, 'connected');
      } else if (state === 'checking') {
        this.updatePeerStatus(peer, 'connecting');
      } else if (state === 'disconnected') {
        this.updatePeerStatus(peer, 'reconnecting');
        this.schedulePeerIceRestart(peer);
      } else if (state === 'failed') {
        this.clearPeerIceTimer(peer);
        this.updatePeerStatus(peer, 'failed');
        this.triggerPeerIceRestart(peer).catch(() => {});
      } else if (state === 'closed') {
        this.clearPeerIceTimer(peer);
        this.updatePeerStatus(peer, 'closed');
      }
    };

    pc.onconnectionstatechange = () => {
      if (!this.isActive || this.peers.get(peerUserId) !== peer) return;
      const state = pc.connectionState;
      if (state === 'connected') {
        this.updatePeerStatus(peer, 'connected');
      } else if (state === 'connecting') {
        this.updatePeerStatus(peer, 'connecting');
      } else if (state === 'disconnected') {
        this.updatePeerStatus(peer, 'reconnecting');
      } else if (state === 'failed') {
        this.updatePeerStatus(peer, 'failed');
      } else if (state === 'closed') {
        this.updatePeerStatus(peer, 'closed');
      }
    };

    pc.ontrack = (event) => {
      if (!this.isActive || this.peers.get(peerUserId) !== peer) return;
      const track = event.track;
      const stream = event.streams?.[0] || new MediaStream([track]);

      if (track.kind === 'audio') {
        peer.remoteAudioStream = stream;
        this.setupPeerRemoteAudio(peer, stream);
      } else if (track.kind === 'video') {
        this.remoteVideoStreams.set(peerUserId, stream);
        this.callbacks?.onRemoteVideoStreamsChange?.(new Map(this.remoteVideoStreams));

        track.onended = () => {
          if (this.remoteVideoStreams.get(peerUserId) === stream) {
            this.remoteVideoStreams.delete(peerUserId);
            this.callbacks?.onRemoteVideoStreamsChange?.(new Map(this.remoteVideoStreams));
          }
        };
      }
    };

    if (this.localAudioStream) {
      const audioTrack = this.localAudioStream.getAudioTracks()[0];
      if (audioTrack) {
        peer.audioSender = pc.addTrack(audioTrack, this.localAudioStream);
        await this.configureAudioSenderPriority(peer.audioSender);
      }
    }

    if (this.screenVideoTrack) {
      const cfg = VOICE_ROOM_QUALITY_PRESETS[this.activeQuality] ?? VOICE_ROOM_QUALITY_PRESETS.auto;
      const stream = new MediaStream([this.screenVideoTrack]);
      await this.attachVideoTrackToPeer(peer, this.screenVideoTrack, stream, cfg);
    }

    if (this.nativeScreenActive) {
      this.addNativeScreenPeer(peerUserId, iceServers).catch((err) => {
        console.warn(`[MeshRoomService] Falha ao adicionar peer nativo ${peerUserId}:`, err);
      });
    }

    return peer;
  }

  private updatePeerStatus(peer: PeerSession, status: VoiceRoomPeerStatus): void {
    if (peer.status === status) return;
    peer.status = status;
    this.callbacks?.onPeerStatusChange?.(peer.peerUserId, status);
  }

  private clearPeerIceTimer(peer: PeerSession): void {
    if (peer.iceDisconnectTimer) {
      clearTimeout(peer.iceDisconnectTimer);
      peer.iceDisconnectTimer = null;
    }
  }

  private schedulePeerIceRestart(peer: PeerSession): void {
    this.clearPeerIceTimer(peer);
    peer.iceDisconnectTimer = setTimeout(() => {
      if (!this.isActive || this.peers.get(peer.peerUserId) !== peer) return;
      const state = peer.pc.iceConnectionState;
      if (state === 'disconnected' || state === 'failed') {
        this.triggerPeerIceRestart(peer).catch(() => {});
      }
    }, this.iceDisconnectTimeoutMs);
  }

  private async triggerPeerIceRestart(peer: PeerSession): Promise<void> {
    if (!this.isActive || this.peers.get(peer.peerUserId) !== peer) return;
    if (peer.iceRestartAttempts >= MAX_ICE_RESTART_ATTEMPTS) {
      this.updatePeerStatus(peer, 'failed');
      return;
    }
    peer.iceRestartAttempts += 1;
    this.updatePeerStatus(peer, 'reconnecting');

    return this.enqueuePeerSignaling(peer, async () => {
      try {
        if (typeof peer.pc.restartIce === 'function') {
          peer.pc.restartIce();
        }
        peer.makingOffer = true;
        const offer = await peer.pc.createOffer({ iceRestart: true });
        await peer.pc.setLocalDescription(offer);
        if (peer.pc.localDescription?.sdp) {
          this.callbacks?.onSendOffer(peer.peerUserId, peer.pc.localDescription.sdp);
        }
      } catch (err) {
        console.warn(`[MeshRoomService] ICE Restart falhou para ${peer.peerUserId}:`, err);
      } finally {
        peer.makingOffer = false;
      }
    });
  }

  private enqueuePeerSignaling(peer: PeerSession, op: () => Promise<void>): Promise<void> {
    peer.signalingChain = peer.signalingChain.then(op, op);
    return peer.signalingChain;
  }

  private async flushPendingCandidates(peer: PeerSession): Promise<void> {
    while (peer.pendingCandidates.length > 0 && peer.pc.remoteDescription) {
      const cand = peer.pendingCandidates.shift();
      if (!cand) continue;
      try {
        await peer.pc.addIceCandidate(cand);
      } catch {
        // Ignore stale candidates
      }
    }
  }

  private async configureAudioSenderPriority(sender: RTCRtpSender): Promise<void> {
    try {
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) {
        params.encodings = [{}];
      }
      (params.encodings[0] as any).priority = 'high';
      (params.encodings[0] as any).networkPriority = 'high';
      await sender.setParameters(params);
    } catch {
      // Some WebViews do not expose priority/networkPriority
    }
  }

  private async attachVideoTrackToPeer(
    _peer: PeerSession, _track: MediaStreamTrack, _stream: MediaStream, _cfg: VideoEncodingPreset
  ): Promise<void> {
    throw new Error(SCREEN_DEDICATED_REQUIRED);
  }

  private async applyVideoSenderParameters(
    sender: RTCRtpSender,
    cfg: VideoEncodingPreset
  ): Promise<void> {
    try {
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) {
        params.encodings = [{}];
      }
      params.encodings[0].maxBitrate = cfg.maxBitrate;
      params.encodings[0].maxFramerate = cfg.maxFramerate;
      (params.encodings[0] as any).priority = 'medium';
      (params.encodings[0] as any).networkPriority = 'medium';
      await sender.setParameters(params);
    } catch {
      // Ignore unsupported sender parameter fields
    }
  }

  private setupPeerRemoteAudio(peer: PeerSession, stream: MediaStream): void {
    const settings = getRuntimeStoreSettings();

    if (!peer.remoteAudioEl && typeof Audio !== 'undefined') {
      peer.remoteAudioEl = new Audio();
      peer.remoteAudioEl.autoplay = true;
      peer.remoteAudioEl.style.display = 'none';
      if (typeof document !== 'undefined' && document.body) {
        document.body.appendChild(peer.remoteAudioEl);
      }
    }

    if (peer.remoteAudioEl) {
      peer.remoteAudioEl.srcObject = stream;
      if (settings.outputDevice && settings.outputDevice !== 'default') {
        audioDeviceService.setAudioSink(peer.remoteAudioEl, settings.outputDevice).catch(() => {});
      }
      const playRes = peer.remoteAudioEl.play?.();
      if (playRes && typeof playRes.catch === 'function') {
        playRes.catch(() => {});
      }
    }

    try {
      if (peer.remoteAudioCtx) {
        peer.remoteAudioCtx.close().catch(() => {});
        peer.remoteAudioCtx = null;
      }
      if (typeof window !== 'undefined') {
        const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
        if (AudioCtx) {
          peer.remoteAudioCtx = new AudioCtx();
          const source = peer.remoteAudioCtx.createMediaStreamSource(stream);
          peer.remoteAnalyser = peer.remoteAudioCtx.createAnalyser();
          peer.remoteAnalyser.fftSize = 256;
          source.connect(peer.remoteAnalyser);
          peer.remoteVad = audioDeviceService.createVoiceDetector({
            sensitivity: 72,
            hangoverMs: 300,
          });

          if (
            typeof peer.remoteAudioCtx.createGain === 'function' &&
            peer.remoteAudioCtx.destination
          ) {
            peer.remoteBoostGain = peer.remoteAudioCtx.createGain();
            peer.remoteBoostGain.gain.value = 0;
            source.connect(peer.remoteBoostGain);
            peer.remoteBoostGain.connect(peer.remoteAudioCtx.destination);
          }
          peer.remoteAudioCtx.resume().catch(() => {});
        }
      }
    } catch {
      // Ignore AudioContext errors in headless/restricted environments
    }

    this.applyPeerVolume(peer);
  }

  private applyPeerVolume(peer: PeerSession): void {
    const outputVolume = getRuntimeStoreSettings().outputVolume;
    const ratio = (outputVolume / 100) * (peer.volumePercent / 100);

    if (peer.remoteAudioEl) {
      peer.remoteAudioEl.muted = this.isDeafened || ratio <= 0;
      peer.remoteAudioEl.volume = this.isDeafened ? 0 : Math.max(0, Math.min(1, ratio));
    }

    if (peer.remoteBoostGain) {
      peer.remoteBoostGain.gain.value =
        this.isDeafened || ratio <= 1 ? 0 : Math.min(1, ratio - 1);
    }
  }

  private startVadLoop(): void {
    if (this.vadInterval) clearInterval(this.vadInterval);
    const localBuf = new Uint8Array(128);
    const remoteBuf = new Uint8Array(128);

    this.vadInterval = setInterval(() => {
      if (!this.isActive) return;

      const settings = getRuntimeStoreSettings();
      if (this.localAudioCtx?.state === 'suspended') {
        this.localAudioCtx.resume().catch(() => {});
      }

      if (this.localAnalyser && this.localVad && !this.isMuted) {
        this.localVad.setSensitivity(settings.inputSensitivity);
        this.localVad.setHangover(settings.voiceHangoverMs);
        const speaking = processAnalyserFrame(
          this.localVad,
          this.localAnalyser,
          localBuf,
          50
        ).isSpeaking;
        if (speaking !== this.lastLocalSpeaking) {
          this.lastLocalSpeaking = speaking;
          this.callbacks?.onLocalSpeaking?.(speaking);
        }
      } else if (this.lastLocalSpeaking) {
        this.lastLocalSpeaking = false;
        this.localVad?.reset();
        this.callbacks?.onLocalSpeaking?.(false);
      }

      for (const peer of this.peers.values()) {
        if (peer.remoteAudioCtx?.state === 'suspended') {
          peer.remoteAudioCtx.resume().catch(() => {});
        }
        if (peer.remoteAnalyser && peer.remoteVad && !this.isDeafened && peer.volumePercent > 0) {
          const speaking = processAnalyserFrame(
            peer.remoteVad,
            peer.remoteAnalyser,
            remoteBuf,
            50
          ).isSpeaking;
          if (speaking !== peer.lastRemoteSpeaking) {
            peer.lastRemoteSpeaking = speaking;
            this.callbacks?.onPeerSpeaking?.(peer.peerUserId, speaking);
          }
        } else if (peer.lastRemoteSpeaking) {
          peer.lastRemoteSpeaking = false;
          peer.remoteVad?.reset();
          this.callbacks?.onPeerSpeaking?.(peer.peerUserId, false);
        }
      }
    }, VAD_POLL_INTERVAL_MS);
  }

  private startStatsLoop(): void {
    if (this.statsInterval) clearInterval(this.statsInterval);
    this.statsInterval = setInterval(() => {
      if (!this.isActive || this.peers.size === 0) return;
      this.collectMetricsSnapshot()
        .then((snapshot) => {
          if (this.isActive) {
            this.callbacks?.onMetricsUpdate?.(snapshot);
            if (this.nativeScreenActive) {
              this.evaluateAdaptiveBitrate(snapshot);
            }
          }
        })
        .catch(() => {});
    }, STATS_POLL_INTERVAL_MS);
  }

  private async collectPeerMetrics(
    peer: PeerSession,
    nowMs: number
  ): Promise<VoiceRoomPeerMetrics> {
    let rttMs: number | null = null;
    let candidateType: string | null = null;
    let packetsLost = 0;
    let jitterMs: number | null = null;
    let bytesSent = 0;
    let bytesReceived = 0;

    try {
      if (typeof peer.pc.getStats === 'function') {
        const report = await peer.pc.getStats();
        let selectedLocalCandidateId: string | null = null;

        report.forEach((stat: any) => {
          if (stat.type === 'candidate-pair' && (stat.nominated || stat.state === 'succeeded')) {
            if (typeof stat.currentRoundTripTime === 'number') {
              rttMs = Math.round(stat.currentRoundTripTime * 1000);
            }
            if (stat.localCandidateId) {
              selectedLocalCandidateId = stat.localCandidateId;
            }
          } else if (stat.type === 'outbound-rtp' && !stat.isRemote) {
            bytesSent += Number(stat.bytesSent || 0);
          } else if (stat.type === 'inbound-rtp' && !stat.isRemote) {
            bytesReceived += Number(stat.bytesReceived || 0);
            packetsLost += Number(stat.packetsLost || 0);
            if (typeof stat.jitter === 'number') {
              jitterMs = Math.round(stat.jitter * 1000 * 10) / 10;
            }
          }
        });

        if (selectedLocalCandidateId) {
          const localCand = report.get(selectedLocalCandidateId) as any;
          if (localCand?.candidateType) {
            candidateType = localCand.candidateType;
          }
        }
      }
    } catch {
      // Ignore transient getStats failures
    }

    let uploadKbps = 0;
    let downloadKbps = 0;
    if (peer.statsPrev && nowMs > peer.statsPrev.timestampMs) {
      const dtSec = (nowMs - peer.statsPrev.timestampMs) / 1000;
      if (dtSec > 0) {
        uploadKbps = Math.max(0, ((bytesSent - peer.statsPrev.bytesSent) * 8) / 1000 / dtSec);
        downloadKbps = Math.max(
          0,
          ((bytesReceived - peer.statsPrev.bytesReceived) * 8) / 1000 / dtSec
        );
      }
    }
    peer.statsPrev = { timestampMs: nowMs, bytesSent, bytesReceived };

    return {
      peerUserId: peer.peerUserId,
      connectionState: peer.status,
      iceConnectionState: peer.pc.iceConnectionState,
      rttMs,
      uploadKbps: Math.round(uploadKbps * 10) / 10,
      downloadKbps: Math.round(downloadKbps * 10) / 10,
      candidateType,
      packetsLost,
      jitterMs,
    };
  }

  private cleanupPeer(peer: PeerSession): void {
    this.clearPeerIceTimer(peer);

    if (peer.remoteAudioCtx) {
      peer.remoteAudioCtx.close().catch(() => {});
      peer.remoteAudioCtx = null;
    }
    peer.remoteAnalyser = null;
    peer.remoteBoostGain = null;
    peer.remoteVad = null;

    if (peer.remoteAudioEl) {
      try {
        peer.remoteAudioEl.pause?.();
        peer.remoteAudioEl.srcObject = null;
        peer.remoteAudioEl.remove?.();
      } catch {
        // Ignore DOM cleanup errors
      }
      peer.remoteAudioEl = null;
    }

    try {
      peer.pc.onnegotiationneeded = null;
      peer.pc.onicecandidate = null;
      peer.pc.oniceconnectionstatechange = null;
      peer.pc.onconnectionstatechange = null;
      peer.pc.ontrack = null;
      peer.pc.close();
    } catch {
      // Ignore close errors
    }
  }

  private teardownNativeScreenState(): void {
    this.nativeScreenGeneration++;
    this.nativeScreenStarting = false;
    this.nativeScreenActive = false;
    this.nativeScreenReadyPeers.clear();
    this.nativeScreenPendingIce.clear();
    this.nativeScreenOfferIds.clear();
    this.nativeScreenRetryLimits.clear();
    this.nativeScreenPeerVersions.clear();
    if (this.nativeUnlisten) {
      try {
        this.nativeUnlisten();
      } catch {
        // Ignore
      }
      this.nativeUnlisten = null;
    }
  }

  private async addNativeScreenPeer(
    peerUserId: string,
    iceServers?: RTCIceServer[]
  ): Promise<void> {
    if (!this.isActive || !this.nativeScreenActive) return;
    const generation = this.nativeScreenGeneration;
    const peerVersion = (this.nativeScreenPeerVersions.get(peerUserId) ?? 0) + 1;
    this.nativeScreenPeerVersions.set(peerUserId, peerVersion);
    this.nativeScreenReadyPeers.delete(peerUserId);
    this.nativeScreenPendingIce.delete(peerUserId);
    const alive = () => this.isActive && this.nativeScreenActive && generation === this.nativeScreenGeneration &&
      peerVersion === this.nativeScreenPeerVersions.get(peerUserId) && !this.departedPeers.has(peerUserId);
    let offer;
    try { offer = await screenCaptureService.addNativeScreenPeer(peerUserId, iceServers); }
    catch (error) {
      if (!alive()) return;
      throw error;
    }
    if (alive() && offer?.sdp) {
      const id = screenSessionId(offer.sdp);
      if (id) this.nativeScreenOfferIds.set(peerUserId, id);
      this.callbacks?.onSendOffer(offer.peer_id || peerUserId, offer.sdp, 'screen');
      this.nativeScreenReadyPeers.add(peerUserId);
      for (const candidate of this.nativeScreenPendingIce.get(peerUserId) ?? []) {
        if (screenCandidateSessionId(candidate) && screenCandidateSessionId(candidate) !== id) continue;
        this.callbacks?.onSendIceCandidate(peerUserId, tagScreenCandidate(candidate, id), 'screen');
      }
      this.nativeScreenPendingIce.delete(peerUserId);
    }
  }

  // A retry asks the existing transmitter for one fresh dedicated PC, not a new capture.
  public retryRemoteScreen(peerUserId: string): boolean {
    const id = this.screenRetryOffers.get(peerUserId);
    if (!id || !this.isActive || this.departedPeers.has(peerUserId) || this.screenRetryPending.has(peerUserId)) return false;
    const limit = this.screenRetryLimits.get(peerUserId);
    if (limit && (Date.now() - limit.at < 10000 || limit.count >= 3)) return false;
    this.screenRetryLimits.set(peerUserId, { at: Date.now(), count: (limit?.count ?? 0) + 1 });
    this.callbacks?.onScreenReceiverState?.(peerUserId, 'connecting');
    const timer = setTimeout(() => {
      this.screenRetryPending.delete(peerUserId);
      if (this.isActive && this.screenRetryOffers.get(peerUserId) === id) {
        this.callbacks?.onScreenReceiverState?.(peerUserId, 'failed');
        this.callbacks?.onError?.('A nova tentativa não recebeu resposta. Peça ao transmissor para reiniciar a tela ou atualizar o NEXUS.');
      }
    }, 30000);
    this.screenRetryPending.set(peerUserId, timer);
    this.callbacks?.onSendIceCandidate(peerUserId,
      { candidate: '', nexusScreenSessionId: id, nexusScreenAction: 'retry' } as RTCIceCandidateInit, 'screen');
    return true;
  }

  private failRemoteScreen(peerUserId: string, message: string): void {
    const id = this.screenReceiverOfferIds.get(peerUserId);
    const limit = this.screenRetryLimits.get(peerUserId);
    this.closeRemoteScreen(peerUserId);
    if (id) this.screenRetryOffers.set(peerUserId, id);
    if (limit) this.screenRetryLimits.set(peerUserId, limit);
    this.callbacks?.onScreenReceiverState?.(peerUserId, 'failed');
    this.callbacks?.onError?.(message);
  }

  public closeRemoteScreen(peerUserId: string): void {
    clearTimeout(this.screenRetryPending.get(peerUserId)); this.screenRetryPending.delete(peerUserId);
    this.screenRetryOffers.delete(peerUserId); this.screenRetryLimits.delete(peerUserId);
    this.callbacks?.onScreenReceiverState?.(peerUserId, 'closed');
    this.screenReceiverVersions.set(peerUserId, (this.screenReceiverVersions.get(peerUserId) ?? 0) + 1);
    this.stoppedScreenPeers.add(peerUserId);
    this.earlyScreenCandidates.delete(peerUserId);
    this.screenReceiverCreations.delete(peerUserId);
    this.screenReceiverOfferIds.delete(peerUserId);
    const session = this.screenReceiverPeers.get(peerUserId);
    this.screenReceiverPeers.delete(peerUserId);
    if (session) this.cleanupScreenReceiver(session);
    // The fallback stream can share transceivers with voice; only detach its player.
    else detachScreenElements(this.remoteVideoStreams.get(peerUserId) ?? null);
    if (this.remoteVideoStreams.delete(peerUserId)) {
      this.callbacks?.onRemoteVideoStreamsChange?.(new Map(this.remoteVideoStreams));
    }
  }

  private async ensureScreenReceiverPeer(peerUserId: string): Promise<ScreenReceiverSession | null> {
    const existing = this.screenReceiverPeers.get(peerUserId);
    if (existing) return existing;
    const pending = this.screenReceiverCreations.get(peerUserId);
    if (pending) return pending;
    const version = this.screenReceiverVersions.get(peerUserId) ?? 0;
    const room = this.roomGeneration;
    const creation = (async () => {
    const iceServers = this.cachedIceServers ?? (await this.fetchIceServers());
    if (!this.isActive || this.departedPeers.has(peerUserId) || room !== this.roomGeneration ||
      version !== (this.screenReceiverVersions.get(peerUserId) ?? 0)) return null;
    const pc = new RTCPeerConnection({
      iceServers: screenIceServers(iceServers),
      iceTransportPolicy: 'all',
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
      iceCandidatePoolSize: 2,
    });

    const session: ScreenReceiverSession = {
      offerSessionId: null,
      diagnostics: { offersApplied: 0, answersSent: 0, iceQueued: 0, iceApplied: 0, iceRejected: 0, iceStale: 0 },
      stopDiagnostics: () => {},
      peerUserId,
      pc,
      stream: new MediaStream(),
      pendingCandidates: this.earlyScreenCandidates.get(peerUserId) ?? [],
      signalingChain: Promise.resolve(),
    };
    this.screenReceiverPeers.set(peerUserId, session);
    this.callbacks?.onScreenReceiverState?.(peerUserId, 'connecting');
    this.earlyScreenCandidates.delete(peerUserId);
    session.stopDiagnostics = startScreenReceiveDiagnostics(pc, session.stream, () => {
      if (this.screenReceiverPeers.get(peerUserId) === session) this.failRemoteScreen(peerUserId, 'A transmissão conectou, mas não recebeu vídeo. Tente conectar novamente a esta tela.');
    }, screenReceiverContext(peerUserId, this.selfUserId ?? '', this.screenReceiverOfferIds.get(peerUserId) ?? null,
      version, room), () => ({ ...session.diagnostics }));

    pc.onicecandidate = (event) => {
      if (!this.isActive || this.screenReceiverPeers.get(peerUserId) !== session) return;
      if (event.candidate) {
        const init =
          typeof event.candidate.toJSON === 'function'
            ? event.candidate.toJSON()
            : {
                candidate: event.candidate.candidate,
                sdpMid: event.candidate.sdpMid,
                sdpMLineIndex: event.candidate.sdpMLineIndex,
              };
        this.callbacks?.onSendIceCandidate(peerUserId, tagScreenCandidate(init, session.offerSessionId), 'screen');
      }
    };

    let p2pReady = false;
    const publish = () => {
      if (!p2pReady || !session.stream.getVideoTracks().length || this.screenReceiverPeers.get(peerUserId) !== session) return;
      this.remoteVideoStreams.set(peerUserId, session.stream);
      this.callbacks?.onRemoteVideoStreamsChange?.(new Map(this.remoteVideoStreams));
    };
    const stopDiagnostics = session.stopDiagnostics;
    const stopGuard = guardScreenP2P(pc, ready => {
      p2pReady = ready; session.stream.getTracks().forEach(track => { track.enabled = ready; });
      if (ready) { this.callbacks?.onScreenReceiverState?.(peerUserId, 'waiting_video'); publish(); }
    }, message => {
      if (this.screenReceiverPeers.get(peerUserId) === session) this.failRemoteScreen(peerUserId, message);
    });
    session.stopDiagnostics = () => { stopGuard(); stopDiagnostics(); };
    pc.ontrack = (event) => {
      if (!this.isActive || this.screenReceiverPeers.get(peerUserId) !== session) return;
      const track = event.track;
      track.enabled = p2pReady;
      if (!session.stream.getTracks().some((t) => t.id === track.id)) {
        session.stream.addTrack(track);
      }

      publish();

      if (track.kind === 'video') {
        track.onended = () => {
          if (this.screenReceiverPeers.get(peerUserId) === session) this.closeRemoteScreen(peerUserId);
        };
      }
    };

    pc.onconnectionstatechange = () => {
      if (!this.isActive || this.screenReceiverPeers.get(peerUserId) !== session) return;
      if (pc.connectionState === 'failed') this.failRemoteScreen(peerUserId, 'Não foi possível estabelecer a conexão direta para esta tela. Tente novamente.');
      else if (pc.connectionState === 'closed') this.closeRemoteScreen(peerUserId);
    };

    return session;
    })();
    this.screenReceiverCreations.set(peerUserId, creation);
    try { return await creation; }
    finally {
      if (this.screenReceiverCreations.get(peerUserId) === creation) this.screenReceiverCreations.delete(peerUserId);
    }
  }

  private enqueueScreenReceiverSignaling(
    session: ScreenReceiverSession,
    op: () => Promise<void>
  ): Promise<void> {
    session.signalingChain = session.signalingChain.then(op, op);
    return session.signalingChain;
  }

  private async handleScreenReceiverOffer(peerUserId: string, sdp: string): Promise<void> {
    try { assertScreenSdp(sdp); } catch {
      this.closeRemoteScreen(peerUserId); this.callbacks?.onError?.(SCREEN_P2P_ERROR); throw new Error(SCREEN_P2P_ERROR);
    }
    if (this.departedPeers.has(peerUserId)) return;
    clearTimeout(this.screenRetryPending.get(peerUserId)); this.screenRetryPending.delete(peerUserId);
    this.screenRetryOffers.delete(peerUserId);
    const id = screenSessionId(sdp);
    const previous = this.screenReceiverPeers.get(peerUserId);
    const previousId = previous?.offerSessionId ?? this.screenReceiverOfferIds.get(peerUserId);
    if (id && previousId && id !== previousId) this.closeRemoteScreen(peerUserId);
    if (id) this.screenReceiverOfferIds.set(peerUserId, id);
    this.stoppedScreenPeers.delete(peerUserId);
    const session = await this.ensureScreenReceiverPeer(peerUserId);
    if (!session || this.screenReceiverPeers.get(peerUserId) !== session) return;
    session.offerSessionId = id;
    return this.enqueueScreenReceiverSignaling(session, async () => {
      const alive = () => this.isActive && this.screenReceiverPeers.get(peerUserId) === session;
      if (!alive()) return;
      try {
      if (session.lastOfferSdp === sdp && session.answerSdp) {
        this.callbacks?.onSendAnswer(peerUserId, session.answerSdp, 'screen');
        return;
      }
      await session.pc.setRemoteDescription({ type: 'offer', sdp });
      session.diagnostics.offersApplied++;
      if (!alive()) return;
      while (session.pendingCandidates.length > 0) {
        const cand = session.pendingCandidates.shift();
        if (cand) {
          if (screenCandidateSessionId(cand) && screenCandidateSessionId(cand) !== session.offerSessionId) { session.diagnostics.iceStale++; continue; }
          assertScreenCandidate(cand);
          try { await session.pc.addIceCandidate(screenCandidateInit(cand)); session.diagnostics.iceApplied++; }
          catch { session.diagnostics.iceRejected++; console.warn('[ScreenReceiver] queued_ice_rejected'); }
          if (!alive()) return;
        }
      }
      await session.pc.setLocalDescription();
      if (!alive()) return;
      if (session.pc.localDescription?.sdp) {
        session.lastOfferSdp = sdp;
        session.answerSdp = tagScreenAnswer(session.pc.localDescription.sdp, session.offerSessionId);
        session.diagnostics.answersSent++;
        this.callbacks?.onSendAnswer(peerUserId, session.answerSdp, 'screen');
      }
      } catch (error) {
        if (!alive()) return;
        this.closeRemoteScreen(peerUserId);
        throw error;
      }
    });
  }

  private async handleScreenStreamIceCandidate(
    peerUserId: string,
    candidate: RTCIceCandidateInit
  ): Promise<void> {
    if (this.departedPeers.has(peerUserId)) return;
    const id = screenCandidateSessionId(candidate);
    if ((candidate as RTCIceCandidateInit & { nexusScreenAction?: unknown }).nexusScreenAction === 'retry') {
      if (candidate.candidate || !id || !this.nativeScreenActive || !this.peers.has(peerUserId) ||
        id !== this.nativeScreenOfferIds.get(peerUserId)) return;
      const limit = this.nativeScreenRetryLimits.get(peerUserId);
      if (limit && (Date.now() - limit.at < 10000 || limit.count >= 3)) return;
      this.nativeScreenRetryLimits.set(peerUserId, { at: Date.now(), count: (limit?.count ?? 0) + 1 });
      try { await this.addNativeScreenPeer(peerUserId, this.cachedIceServers ?? undefined); }
      catch { this.callbacks?.onError?.('Não foi possível reconectar a tela a um participante.'); }
      return;
    }
    const outgoing = this.nativeScreenActive && this.nativeScreenOfferIds.has(peerUserId);
    const incoming = this.screenReceiverOfferIds.get(peerUserId);
    // Never copy a candidate between dedicated PCs, even when both users share.
    // Legacy candidates are usable only when their destination is unambiguous.
    const toSender = id ? id === this.nativeScreenOfferIds.get(peerUserId) : outgoing && !incoming;
    const toReceiver = id ? id === incoming : !outgoing;
    if (!toSender && !toReceiver && (!id || incoming)) {
      console.warn('[ScreenReceiver] stale_or_ambiguous_ice_ignored'); return;
    }
    try { assertScreenCandidate(candidate); } catch {
      if (toSender) await screenCaptureService.removeNativeScreenPeer(peerUserId).catch(() => {});
      if (toReceiver) this.closeRemoteScreen(peerUserId);
      this.callbacks?.onError?.(SCREEN_P2P_ERROR); throw new Error(SCREEN_P2P_ERROR);
    }
    if (toSender) {
      if (candidate.candidate) await screenCaptureService.handleNativeScreenIce(peerUserId,
        candidate.candidate, candidate.sdpMid ?? null, candidate.sdpMLineIndex ?? null, this.nativeScreenOfferIds.get(peerUserId))
        .catch(() => { console.warn('[ScreenSender] remote_ice_apply_failed'); });
      return;
    }

    if (this.departedPeers.has(peerUserId) || this.stoppedScreenPeers.has(peerUserId)) return;
    const session = this.screenReceiverPeers.get(peerUserId);
    if (!session) {
      const queue = this.earlyScreenCandidates.get(peerUserId) ?? [];
      if (queue.length < MAX_CANDIDATE_QUEUE_SIZE && this.earlyScreenCandidates.size < DEFAULT_MAX_PARTICIPANTS) {
        queue.push(candidate);
        this.earlyScreenCandidates.set(peerUserId, queue);
      }
      return;
    }
    {
      await this.enqueueScreenReceiverSignaling(session, async () => {
        if (!this.isActive || this.screenReceiverPeers.get(peerUserId) !== session) return;
        if (!session.pc.remoteDescription) {
          if (session.pendingCandidates.length < MAX_CANDIDATE_QUEUE_SIZE) {
            session.pendingCandidates.push(candidate);
            session.diagnostics.iceQueued++;
          }
          return;
        }
        try { await session.pc.addIceCandidate(screenCandidateInit(candidate)); session.diagnostics.iceApplied++; }
        catch { session.diagnostics.iceRejected++; console.warn('[ScreenReceiver] remote_ice_apply_failed'); }
      });
    }
  }

  private cleanupScreenReceiver(session: ScreenReceiverSession): void {
    session.stopDiagnostics();
    session.pendingCandidates = [];
    try {
      session.pc.onicecandidate = null;
      session.pc.ontrack = null;
      session.pc.onconnectionstatechange = null;
      session.pc.close();
    } catch {
      // Ignore close errors
    }
    releaseScreenStream(session.stream);
  }

  private evaluateAdaptiveBitrate(snapshot: VoiceRoomMetricsSnapshot): void {
    const now = Date.now();
    if (now - this.lastAdaptiveUpdateMs < 4000) return;

    const cfg = VOICE_ROOM_QUALITY_PRESETS[this.activeQuality] ?? VOICE_ROOM_QUALITY_PRESETS.auto;
    const minBitrate = 400_000;
    let maxBitrate = cfg.maxBitrate;

    const peerList = Object.values(snapshot.peers);
    const hasRelay = peerList.some((p) => p.candidateType === 'relay');
    if (hasRelay) {
      maxBitrate = Math.min(maxBitrate, 1_800_000);
    }

    const lostDelta = Math.max(0, snapshot.totalPacketsLost - this.prevTotalPacketsLost);
    this.prevTotalPacketsLost = snapshot.totalPacketsLost;

    const rtt = snapshot.avgRttMs ?? 0;
    let nextBitrate = this.adaptiveBitrateBps;

    if (rtt > 250 || lostDelta > 3) {
      nextBitrate = Math.max(minBitrate, Math.round(this.adaptiveBitrateBps * 0.8));
    } else if (rtt > 0 && rtt < 120 && lostDelta === 0) {
      nextBitrate = Math.min(maxBitrate, Math.round(this.adaptiveBitrateBps * 1.1));
    } else if (this.adaptiveBitrateBps > maxBitrate) {
      nextBitrate = maxBitrate;
    }

    if (Math.abs(nextBitrate - this.adaptiveBitrateBps) / Math.max(1, this.adaptiveBitrateBps) >= 0.1) {
      this.adaptiveBitrateBps = nextBitrate;
      this.lastAdaptiveUpdateMs = now;
      screenCaptureService.setNativeAdaptiveBitrate(nextBitrate).catch(() => {});
    }
  }
}

export const meshRoomService = new MeshRoomService();
