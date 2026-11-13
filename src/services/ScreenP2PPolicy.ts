export const SCREEN_P2P_ERROR = 'Não foi possível estabelecer compartilhamento P2P direto. O uso de relay/TURN está bloqueado para proteger o consumo de tráfego.';
export const SCREEN_DEDICATED_REQUIRED = 'O compartilhamento P2P-only exige o capturador nativo e um transporte dedicado. O envio de tela pelo peer de voz está bloqueado.';
const directTypes = new Set(['host', 'srflx', 'prflx']);
export const isDirectCandidateType = (type: unknown): boolean => typeof type === 'string' && directTypes.has(type);

// Derive a fresh list; cached voice configuration must never be mutated.
export function screenIceServers(servers: RTCIceServer[]): RTCIceServer[] {
  return servers.flatMap(server => {
    const urls = (Array.isArray(server.urls) ? server.urls : [server.urls])
      .filter(url => typeof url === 'string' && /^stuns?:/i.test(url.trim())).map(url => url.trim());
    return urls.length ? [{ urls }] : [];
  });
}
export function assertScreenCandidate(candidate: RTCIceCandidateInit | string): void {
  const value = typeof candidate === 'string' ? candidate : candidate.candidate ?? '';
  if (!value.trim()) return; // end-of-candidates
  const tokens = value.trim().replace(/^a=/i, '').split(/\s+/);
  if (/[\r\n]/.test(value) || !/^candidate:/i.test(tokens[0]) || tokens[6]?.toLowerCase() !== 'typ' || !isDirectCandidateType(tokens[7]?.toLowerCase())) {
    throw new Error(SCREEN_P2P_ERROR);
  }
}
export function assertScreenSdp(sdp: string): void {
  for (const line of sdp.split(/\r?\n/)) {
    if (/^a=candidate:/i.test(line.trim())) assertScreenCandidate(line.trim().slice(2));
    if (/^a=remote-candidates:/i.test(line.trim())) throw new Error(SCREEN_P2P_ERROR);
  }
}

// A connected state alone is insufficient. Unknown types fail closed.
export function screenSelectedTypes(report: RTCStatsReport): { local: unknown; remote: unknown } {
  const stats = new Map<string, any>(); report.forEach(s => stats.set(s.id, s));
  const transport = [...stats.values()].find(s => s.type === 'transport' && s.selectedCandidatePairId);
  const pair = transport ? stats.get(transport.selectedCandidatePairId) : [...stats.values()].find(s => s.type === 'candidate-pair' && s.selected);
  return { local: stats.get(pair?.localCandidateId)?.candidateType, remote: stats.get(pair?.remoteCandidateId)?.candidateType };
}

export function guardScreenP2P(pc: RTCPeerConnection, onReady: (ready: boolean) => void, onFailure: (message: string) => void): () => void {
  let stopped = false, busy = false, ready = false;
  let pendingSince = Date.now();
  let revision = 0;
  let statsStarted = 0;
  const publish = (value: boolean) => { if (ready !== value) { ready = value; onReady(value); } };
  const fail = () => { if (!stopped) { stop(); publish(false); onFailure(SCREEN_P2P_ERROR); } };
  const check = async () => {
    if (stopped) return;
    if (!ready && Date.now() - pendingSince >= 30000) { fail(); return; }
    if (busy) { if (Date.now() - statsStarted >= 2000) fail(); return; }
    if (pc.connectionState === 'closed') { stop(); return; }
    if (pc.connectionState === 'failed' || pc.iceConnectionState === 'failed') { fail(); return; }
    const connected = pc.connectionState === 'connected' && ['connected', 'completed'].includes(pc.iceConnectionState);
    if (!connected) { publish(false); if (Date.now() - pendingSince >= 30000) fail(); return; }
    busy = true; statsStarted = Date.now(); const generation = revision;
    try {
      const types = screenSelectedTypes(await pc.getStats());
      if (stopped || generation !== revision) return;
      if (types.local === 'relay' || types.remote === 'relay') { fail(); return; }
      if (isDirectCandidateType(types.local) && isDirectCandidateType(types.remote)) {
        if (!ready) console.info('[ScreenP2P] selected', { local: types.local, remote: types.remote });
        pendingSince = Date.now(); publish(true);
      } else { publish(false); if (Date.now() - pendingSince >= 30000) fail(); }
    } catch { publish(false); if (Date.now() - pendingSince >= 30000) fail(); }
    finally { busy = false; }
  };
  const state = () => { revision++; if (!['connected', 'completed'].includes(pc.iceConnectionState) || pc.connectionState !== 'connected') {
    if (ready) pendingSince = Date.now(); publish(false);
  } void check(); };
  const timer = setInterval(() => { void check(); }, 500);
  const stop = () => { stopped = true; revision++; clearInterval(timer); pc.removeEventListener?.('connectionstatechange', state); pc.removeEventListener?.('iceconnectionstatechange', state); };
  pc.addEventListener?.('connectionstatechange', state); pc.addEventListener?.('iceconnectionstatechange', state);
  void check(); return stop;
}

export function assertVoiceOnlySdp(sdp: string): void {
  if (sdp.split(/\r?\n/).some(line => /^m=video\s+(?!0(?:\s|$))/.test(line.trim()))) throw new Error(SCREEN_DEDICATED_REQUIRED);
}
