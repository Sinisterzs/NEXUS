import { summarizeScreenNegotiation } from './ScreenTransportDiagnostics.ts';
// Observe only the dedicated screen PC. Never serialize a stats report or candidate.
let receiverSequence = 0;
const diagnosticRun = globalThis.crypto?.randomUUID?.().replaceAll('-', '') ?? '';
export async function screenReceiverContext(senderId: string, peerId: string, offerId: string | null,
  generation: number, roomGeneration: number): Promise<Record<string, string | number>> {
  const token = async (kind: string, value: string) => {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`nexus-screen:${kind}:${value}`));
    return [...new Uint8Array(bytes)].map(v => v.toString(16).padStart(2, '0')).join('');
  };
  return { diagnosticRun, senderToken: await token('user', senderId), peerToken: await token('user', peerId),
    transportToken: await token('transport', senderId + ':' + (offerId ?? 'unknown')),
    offerToken: await token('offer', offerId ?? ''),
    receiverGeneration: generation, roomGeneration };
}
export function summarizeScreenReceiver(
  pc: RTCPeerConnection,
  report: RTCStatsReport,
  stream: MediaStream
): Record<string, string | number | boolean | null> {
  const stats = new Map<string, any>();
  report.forEach((stat) => stats.set(stat.id, stat));
  const video = [...stats.values()].filter(
    (stat) => stat.type === 'inbound-rtp' && (stat.kind ?? stat.mediaType) === 'video'
  );
  const snapshot: Record<string, string | number | boolean | null> = {
    connectionState: pc.connectionState,
    iceConnectionState: pc.iceConnectionState,
    signalingState: pc.signalingState,
  };
  for (const key of ['packetsReceived', 'bytesReceived', 'framesReceived', 'framesDecoded',
    'keyFramesDecoded', 'framesDropped']) {
    const values = video.map((stat) => stat[key]).filter(Number.isFinite);
    const total = values.length ? values.reduce((sum, value) => sum + value, 0) : null;
    snapshot[key] = typeof total === 'number' && Number.isFinite(total) && total >= 0 ? total : null;
  }
  const transport = [...stats.values()].find((stat) => stat.type === 'transport' && stat.selectedCandidatePairId);
  const pair = (transport ? stats.get(transport.selectedCandidatePairId) : undefined) ??
    [...stats.values()].find((stat) => stat.type === 'candidate-pair' && stat.selected);
  const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  for (const key of ['requestsSent','requestsReceived','responsesSent','responsesReceived','consentRequestsSent','bytesSent','bytesReceived']) {
    snapshot[`pair${key[0].toUpperCase()}${key.slice(1)}`] = number(pair?.[key]);
  }
  const pairs = [...stats.values()].filter(stat => stat.type === 'candidate-pair');
  snapshot.icePairs = pairs.length;
  for (const [name, state] of [['Waiting','waiting'],['InProgress','in-progress'],['Succeeded','succeeded'],['Failed','failed']]) {
    snapshot[`icePairs${name}`] = pairs.filter(p => p.state === state).length;
  }
  for (const key of ['requestsSent','requestsReceived','responsesSent','responsesReceived','consentRequestsSent']) {
    const values = pairs.map(p => number(p[key])).filter((v): v is number => v !== null);
    snapshot[`ice${key[0].toUpperCase()}${key.slice(1)}Total`] = values.length ? values.reduce((a,b) => a+b,0) : null;
  }
  snapshot.pairNominated = typeof pair?.nominated === 'boolean' ? pair.nominated : null;
  snapshot.pairState = ['frozen','waiting','in-progress','failed','succeeded'].includes(pair?.state) ? pair.state : null;
  Object.assign(snapshot, summarizeScreenNegotiation(pc, stats, transport));
  snapshot.roundTripTime = number(pair?.currentRoundTripTime);
  snapshot.availableIncomingBitrate = number(pair?.availableIncomingBitrate);
  for (const key of ['packetsLost', 'jitter', 'nackCount', 'pliCount', 'firCount', 'qpSum', 'totalDecodeTime']) {
    const values = video.map((s) => number(s[key])).filter((v): v is number => v !== null);
    snapshot[key] = values.length ? values.reduce((a, b) => a + b, 0) : null;
  }
  const audio = [...stats.values()].filter((s) => s.type === 'inbound-rtp' && (s.kind ?? s.mediaType) === 'audio');
  for (const key of ['packetsReceived', 'bytesReceived', 'packetsLost', 'jitter', 'totalSamplesReceived', 'concealedSamples']) {
    const values = audio.map((s) => number(s[key])).filter((v): v is number => v !== null);
    snapshot[`audio${key[0].toUpperCase()}${key.slice(1)}`] = values.length ? values.reduce((a, b) => a + b, 0) : null;
  }
  const audioTrack = stream.getAudioTracks?.()[0];
  snapshot.audioTrackState = audioTrack?.readyState ?? null;
  snapshot.audioTrackMuted = audioTrack?.muted ?? null;
  snapshot.dtlsState = transport?.dtlsState ?? null;
  snapshot.localCandidateType = stats.get(pair?.localCandidateId)?.candidateType ?? null;
  snapshot.remoteCandidateType = stats.get(pair?.remoteCandidateId)?.candidateType ?? null;
  for (const side of ['local', 'remote']) {
    for (const type of ['host', 'srflx', 'relay']) {
      snapshot[`${side}_${type}`] = [...stats.values()].filter(
        (stat) => stat.type === `${side}-candidate` && stat.candidateType === type
      ).length;
    }
  }
  const track = stream.getVideoTracks()[0];
  snapshot.trackState = track?.readyState ?? null;
  snapshot.trackMuted = track?.muted ?? null;
  const element = typeof document === 'undefined' ? undefined :
    [...document.querySelectorAll('video')].find((el) => el.srcObject === stream);
  snapshot.playerBound = Boolean(element);
  snapshot.playerMuted = element?.muted ?? null;
  snapshot.playerVolume = number(element?.volume);
  snapshot.audioTrackCount = stream.getAudioTracks?.().length ?? 0;
  snapshot.playerReadyState = element?.readyState ?? null;
  snapshot.playerPaused = element?.paused ?? null;
  snapshot.playerWidth = element?.videoWidth ?? null;
  snapshot.playerHeight = element?.videoHeight ?? null;
  snapshot.playerCurrentTime = element && Number.isFinite(element.currentTime) && element.currentTime >= 0 ? element.currentTime : null;
  return snapshot;
}

export function startScreenReceiveDiagnostics(
  pc: RTCPeerConnection, stream: MediaStream, onNoFrames?: () => void,
  context?: Promise<Record<string, string | number>>, counters?: () => Record<string, number>
): () => void {
  const receiverId = ++receiverSequence;
  const safeContext = context?.catch(() => ({ diagnosticRun }));
  let stopped = false;
  let busy = false;
  let connectedSince: number | null = null;
  let warned = false;
  let iceConnectedSince: number | null = null;
  let dtlsConnectingSince: number | null = null;
  const sample = async () => {
    if (stopped || busy || typeof pc.getStats !== 'function') return;
    busy = true;
    try {
      const report = await pc.getStats();
      if (stopped) return;
      const snapshot = summarizeScreenReceiver(pc, report, stream);
      Object.assign(snapshot, safeContext ? await safeContext : { diagnosticRun }, counters?.());
      if (stopped) return;
      snapshot.receiverId = receiverId;
      if (['connected','completed'].includes(pc.iceConnectionState)) iceConnectedSince ??= Date.now(); else iceConnectedSince = null;
      if (snapshot.dtlsState === 'connecting') dtlsConnectingSince ??= Date.now(); else dtlsConnectingSince = null;
      snapshot.iceConnectedObservedMs = iceConnectedSince === null ? null : Math.max(0, Date.now() - iceConnectedSince);
      snapshot.dtlsConnectingObservedMs = dtlsConnectingSince === null ? null : Math.max(0, Date.now() - dtlsConnectingSince);
      if (pc.connectionState === 'connected') {
        connectedSince ??= Date.now();
        const frames = snapshot.framesDecoded ?? snapshot.framesReceived;
        const noRtp = (snapshot.packetsReceived === null || snapshot.packetsReceived === 0) &&
          (snapshot.bytesReceived === null || snapshot.bytesReceived === 0);
        if (!warned && (frames === 0 || (frames === null && noRtp)) && Date.now() - connectedSince >= 30000) {
          warned = true;
          console.warn('[ScreenReceiver] connected_without_video_frames');
          onNoFrames?.();
        }
      } else {
        connectedSince = null;
      }
      console.info('[ScreenReceiver]', snapshot);
      if (typeof window !== 'undefined' && (window as any).__TAURI_INTERNALS__) {
        const { invoke } = await import('@tauri-apps/api/core');
        if (!stopped) await invoke('native_log_screen_receiver', { snapshot });
      }
    } catch {
      // No raw browser errors: they can contain SDP or candidate addresses.
      if (!stopped) console.warn('[ScreenReceiver] diagnostics_unavailable');
    } finally {
      busy = false;
      if (pc.connectionState === 'closed') stop();
    }
  };
  const timer = setInterval(() => { void sample(); }, 5000);
  const onState = () => {
    if (pc.connectionState !== 'connected') connectedSince = null;
    void sample();
  };
  pc.addEventListener?.('connectionstatechange', onState);
  const stop = () => {
    stopped = true;
    clearInterval(timer);
    pc.removeEventListener?.('connectionstatechange', onState);
  };
  void sample();
  return stop;
}
