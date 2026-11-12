/**
 * NEXUS - WebRTC P2P Mesh Voice & Screen Room Engine (Phase B3.2)
 *
 * Independente do WebRtcService (1:1) e CallService (1:1).
 * Gerencia multiplas RTCPeerConnection por peerUserId (ate 4 participantes iniciais),
 * Perfect Negotiation (polite = selfUserId < peerUserId), ICE Restart individual,
 * STUN + TURN fallback, microfone compartilhado, audio remoto independente (0..200% + VAD),
 * multiplos streamers simultaneos e telemetria real via getStats().
 */

import { audioDeviceService } from './AudioDeviceService';
import { screenCaptureService, applyTrackContentHint } from './ScreenCaptureService';
import { processAnalyserFrame, type VoiceActivityDetector } from '../lib/voiceActivity';
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

export interface MeshRoomCallbacks {
  onSendOffer: (peerUserId: string, sdp: string, streamKind?: StreamKind) => void;
  onSendAnswer: (peerUserId: string, sdp: string, streamKind?: StreamKind) => void;
  onSendIceCandidate: (peerUserId: string, candidate: RTCIceCandidateInit, streamKind?: StreamKind) => void;
  onPeerStatusChange?: (peerUserId: string, status: VoiceRoomPeerStatus) => void;
  onLocalSpeaking?: (isSpeaking: boolean) => void;
  onPeerSpeaking?: (peerUserId: string, isSpeaking: boolean) => void;
  onRemoteVideoStreamsChange?: (streams: Map<string, MediaStream>) => void;
  onMetricsUpdate?: (snapshot: VoiceRoomMetricsSnapshot) => void;
  onNativeStatusChange?: (status: NativeCaptureStatus | null) => void;
  onNativeStats?: (stats: NativeScreenStatsEvent | null) => void;
  onNativeScreenEnded?: (reason: string) => void;
  onError?: (message: string) => void;
}

interface ScreenReceiverSession {
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
  private remoteVideoStreams = new Map<string, MediaStream>();
  private peerVolumes = new Map<string, number>();

  private localAudioStream: MediaStream | null = null;
  private localAudioCtx: AudioContext | null = null;
  private localAnalyser: AnalyserNode | null = null;
  private localVad: VoiceActivityDetector | null = null;
  private lastLocalSpeaking = false;

  private screenVideoTrack: MediaStreamTrack | null = null;
  private nativeScreenActive = false;
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
    await this.stopScreenShare();

    const preset = options.preset ?? this.activeQuality ?? 'auto';
    this.activeQuality = preset;
    const cfg = VOICE_ROOM_QUALITY_PRESETS[preset] ?? VOICE_ROOM_QUALITY_PRESETS.auto;
    this.adaptiveBitrateBps = cfg.maxBitrate;
    this.lastAdaptiveUpdateMs = Date.now();
    this.prevTotalPacketsLost = 0;

    const iceServers =
      options.ice_servers ?? this.cachedIceServers ?? (await this.fetchIceServers());

    this.nativeUnlisten = await screenCaptureService.subscribeNativeEvents({
      onIce: (ev) => {
        if (!this.isActive || !this.nativeScreenActive) return;
        this.callbacks?.onSendIceCandidate(
          ev.peer_id,
          {
            candidate: ev.candidate,
            sdpMid: ev.sdp_mid ?? undefined,
            sdpMLineIndex: ev.sdp_mline_index ?? undefined,
          },
          'screen'
        );
      },
      onStats: (ev) => {
        if (!this.isActive || !this.nativeScreenActive) return;
        this.callbacks?.onNativeStats?.(ev);
      },
      onError: (ev) => {
        if (!this.isActive) return;
        this.callbacks?.onError?.(ev.message);
        if (!ev.recoverable && this.nativeScreenActive) {
          void this.stopScreenShare();
        }
      },
      onEnded: (ev) => {
        if (!this.nativeScreenActive) return;
        this.teardownNativeScreenState();
        this.callbacks?.onNativeScreenEnded?.(ev.reason);
      },
    });

    try {
      const status = await screenCaptureService.startNativeShare({
        ...options,
        preset,
        ice_servers: iceServers,
      });
      this.nativeScreenActive = true;
      this.adaptiveBitrateBps = status.bitrate_bps || cfg.maxBitrate;
      this.callbacks?.onNativeStatusChange?.(status);

      for (const peerUserId of this.peers.keys()) {
        await this.addNativeScreenPeer(peerUserId, iceServers);
      }
      return status;
    } catch (err) {
      this.teardownNativeScreenState();
      throw err;
    }
  }

  public async startScreenShare(preset: VoiceRoomQualityPreset = 'auto'): Promise<boolean> {
    if (!this.isActive) return false;
    await this.stopScreenShare();
    this.activeQuality = preset;
    const cfg = VOICE_ROOM_QUALITY_PRESETS[preset] ?? VOICE_ROOM_QUALITY_PRESETS.auto;

    const stream = await screenCaptureService.startCapture(cfg.capturePreset);
    if (!stream) return false;

    const videoTrack = stream.getVideoTracks()[0];
    if (!videoTrack) return false;

    this.screenVideoTrack = videoTrack;
    applyTrackContentHint(videoTrack, cfg.contentHint);

    videoTrack.onended = () => {
      this.stopScreenShare().catch(() => {});
    };

    for (const peer of this.peers.values()) {
      await this.attachVideoTrackToPeer(peer, videoTrack, stream, cfg);
    }

    return true;
  }

  public async stopScreenShare(): Promise<void> {
    if (this.nativeScreenActive) {
      this.teardownNativeScreenState();
      await screenCaptureService.stopNativeShare().catch(() => {});
      this.callbacks?.onNativeStatusChange?.(null);
      this.callbacks?.onNativeStats?.(null);
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
      if (this.nativeScreenActive) {
        await screenCaptureService.handleNativeScreenAnswer(peerUserId, sdp).catch((err) => {
          console.warn(`[MeshRoomService] Erro ao encaminhar screen answer de ${peerUserId}:`, err);
        });
      }
      return;
    }

    const peer = this.peers.get(peerUserId);
    if (!peer) return;

    return this.enqueuePeerSignaling(peer, async () => {
      peer.isSettingRemoteAnswerPending = true;
      try {
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
    peer: PeerSession,
    track: MediaStreamTrack,
    stream: MediaStream,
    cfg: VideoEncodingPreset
  ): Promise<void> {
    if (peer.videoSender) {
      await peer.videoSender.replaceTrack(track);
    } else {
      peer.videoSender = peer.pc.addTrack(track, stream);
    }
    await this.applyVideoSenderParameters(peer.videoSender, cfg);
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
    this.nativeScreenActive = false;
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
    const offer = await screenCaptureService.addNativeScreenPeer(peerUserId, iceServers);
    if (this.isActive && this.nativeScreenActive && offer?.sdp) {
      this.callbacks?.onSendOffer(offer.peer_id || peerUserId, offer.sdp, 'screen');
    }
  }

  private async ensureScreenReceiverPeer(peerUserId: string): Promise<ScreenReceiverSession> {
    const existing = this.screenReceiverPeers.get(peerUserId);
    if (existing) return existing;

    const iceServers = this.cachedIceServers ?? (await this.fetchIceServers());
    const pc = new RTCPeerConnection({
      iceServers,
      iceTransportPolicy: this.iceTransportPolicy,
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
      iceCandidatePoolSize: 2,
    });

    const session: ScreenReceiverSession = {
      peerUserId,
      pc,
      stream: new MediaStream(),
      pendingCandidates: [],
      signalingChain: Promise.resolve(),
    };
    this.screenReceiverPeers.set(peerUserId, session);

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
        this.callbacks?.onSendIceCandidate(peerUserId, init, 'screen');
      }
    };

    pc.ontrack = (event) => {
      if (!this.isActive || this.screenReceiverPeers.get(peerUserId) !== session) return;
      const track = event.track;
      if (!session.stream.getTracks().some((t) => t.id === track.id)) {
        session.stream.addTrack(track);
      }

      if (track.kind === 'video' || session.stream.getVideoTracks().length > 0) {
        this.remoteVideoStreams.set(peerUserId, session.stream);
        this.callbacks?.onRemoteVideoStreamsChange?.(new Map(this.remoteVideoStreams));
      }

      if (track.kind === 'video') {
        track.onended = () => {
          if (this.remoteVideoStreams.get(peerUserId) === session.stream) {
            this.remoteVideoStreams.delete(peerUserId);
            this.callbacks?.onRemoteVideoStreamsChange?.(new Map(this.remoteVideoStreams));
          }
        };
      }
    };

    pc.onconnectionstatechange = () => {
      if (!this.isActive || this.screenReceiverPeers.get(peerUserId) !== session) return;
      if (pc.connectionState === 'closed' || pc.connectionState === 'failed') {
        if (this.remoteVideoStreams.get(peerUserId) === session.stream) {
          this.remoteVideoStreams.delete(peerUserId);
          this.callbacks?.onRemoteVideoStreamsChange?.(new Map(this.remoteVideoStreams));
        }
      }
    };

    return session;
  }

  private enqueueScreenReceiverSignaling(
    session: ScreenReceiverSession,
    op: () => Promise<void>
  ): Promise<void> {
    session.signalingChain = session.signalingChain.then(op, op);
    return session.signalingChain;
  }

  private async handleScreenReceiverOffer(peerUserId: string, sdp: string): Promise<void> {
    const session = await this.ensureScreenReceiverPeer(peerUserId);
    return this.enqueueScreenReceiverSignaling(session, async () => {
      await session.pc.setRemoteDescription({ type: 'offer', sdp });
      while (session.pendingCandidates.length > 0) {
        const cand = session.pendingCandidates.shift();
        if (cand) {
          await session.pc.addIceCandidate(cand).catch(() => {});
        }
      }
      await session.pc.setLocalDescription();
      if (session.pc.localDescription?.sdp) {
        this.callbacks?.onSendAnswer(peerUserId, session.pc.localDescription.sdp, 'screen');
      }
    });
  }

  private async handleScreenStreamIceCandidate(
    peerUserId: string,
    candidate: RTCIceCandidateInit
  ): Promise<void> {
    if (this.nativeScreenActive && candidate.candidate) {
      screenCaptureService
        .handleNativeScreenIce(
          peerUserId,
          candidate.candidate,
          candidate.sdpMid ?? null,
          candidate.sdpMLineIndex ?? null
        )
        .catch(() => {});
    }

    if (this.screenReceiverPeers.has(peerUserId) || !this.nativeScreenActive) {
      const session = await this.ensureScreenReceiverPeer(peerUserId);
      await this.enqueueScreenReceiverSignaling(session, async () => {
        if (!session.pc.remoteDescription) {
          if (session.pendingCandidates.length < MAX_CANDIDATE_QUEUE_SIZE) {
            session.pendingCandidates.push(candidate);
          }
          return;
        }
        await session.pc.addIceCandidate(candidate).catch(() => {});
      });
    }
  }

  private cleanupScreenReceiver(session: ScreenReceiverSession): void {
    try {
      session.pc.onicecandidate = null;
      session.pc.ontrack = null;
      session.pc.onconnectionstatechange = null;
      session.pc.close();
    } catch {
      // Ignore close errors
    }
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
