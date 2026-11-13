import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeScreenReceiver, startScreenReceiveDiagnostics } from '../src/services/ScreenReceiveDiagnostics.ts';

test('screen diagnostics read video counters and selected candidate types without copying sensitive stats', () => {
  const report = new Map([
    ['video', { id: 'video', type: 'inbound-rtp', kind: 'video', packetsReceived: 12, bytesReceived: 900, framesDecoded: 3 }],
    ['audio', { id: 'audio', type: 'inbound-rtp', kind: 'audio', packetsReceived: 999, bytesReceived: 9999 }],
    ['transport', { id: 'transport', type: 'transport', selectedCandidatePairId: 'pair', dtlsState: 'connected' }],
    ['pair', { id: 'pair', type: 'candidate-pair', localCandidateId: 'local', remoteCandidateId: 'remote' }],
    ['local', { id: 'local', type: 'local-candidate', candidateType: 'relay', address: 'PRIVATE_ADDRESS', username: 'PRIVATE_CREDENTIAL' }],
    ['remote', { id: 'remote', type: 'remote-candidate', candidateType: 'srflx' }],
  ]);
  const result = summarizeScreenReceiver({ connectionState: 'connected', iceConnectionState: 'connected', signalingState: 'stable' } as RTCPeerConnection,
    report as unknown as RTCStatsReport, { getVideoTracks: () => [{ readyState: 'live', muted: false }] } as unknown as MediaStream);
  assert.equal(result.packetsReceived, 12);
  assert.equal(result.bytesReceived, 900);
  assert.equal(result.framesDecoded, 3);
  assert.equal(result.framesReceived, null, 'missing browser counters must stay unknown');
  assert.equal(result.localCandidateType, 'relay');
  assert.equal(result.remoteCandidateType, 'srflx');
  assert.equal(result.local_relay, 1);
  assert.equal(result.playerBound, false);
  assert.ok(!JSON.stringify(result).includes('PRIVATE_'));
});

test('no-frame warning waits for 30 connected seconds, tolerates negotiation/disconnect, and fires only once', async () => {
  const original = { now: Date.now, interval: globalThis.setInterval, clear: globalThis.clearInterval, info: console.info };
  let now = 0; let tick!: () => void; let warnings = 0;
  Date.now = () => now; console.info = () => {};
  globalThis.setInterval = ((callback: () => void) => { tick = callback; return 123; }) as any;
  globalThis.clearInterval = (() => {}) as any;
  const pc = Object.assign(new EventTarget(), { connectionState: 'connecting', getStats: async () => new Map() });
  const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  const state = (value: string) => { pc.connectionState = value; pc.dispatchEvent(new Event('connectionstatechange')); };
  let stop: (() => void) | undefined;
  try {
    stop = startScreenReceiveDiagnostics(pc as unknown as RTCPeerConnection, { getVideoTracks: () => [] } as any, () => { warnings++; });
    await flush(); now = 90000; tick(); await flush(); assert.equal(warnings, 0, 'negotiation has no frame deadline');
    state('connected'); await flush(); now += 29000; tick(); await flush(); assert.equal(warnings, 0);
    state('disconnected'); await flush(); now += 90000; tick(); await flush(); assert.equal(warnings, 0);
    state('connected'); await flush(); now += 30000; tick(); await flush(); assert.equal(warnings, 1, 'no inbound RTP entry must also warn');
    now += 30000; tick(); await flush(); assert.equal(warnings, 1);
  } finally {
    stop?.(); Date.now = original.now; console.info = original.info;
    globalThis.setInterval = original.interval; globalThis.clearInterval = original.clear;
  }
});

test('unknown frame counters with incoming RTP do not imply zero decoded frames', async () => {
  const original = { now: Date.now, interval: globalThis.setInterval, clear: globalThis.clearInterval, info: console.info };
  let now = 0; let tick!: () => void; let warnings = 0;
  Date.now = () => now; console.info = () => {};
  globalThis.setInterval = ((callback: () => void) => { tick = callback; return 123; }) as any;
  globalThis.clearInterval = (() => {}) as any;
  const stat: any = { id: 'v', type: 'inbound-rtp', kind: 'video', packetsReceived: 10, bytesReceived: 1000 };
  const pc = { connectionState: 'connected', getStats: async () => new Map([['v', stat]]) };
  const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  let stop: (() => void) | undefined;
  try {
    stop = startScreenReceiveDiagnostics(pc as unknown as RTCPeerConnection, { getVideoTracks: () => [] } as any, () => { warnings++; });
    await flush(); now += 31000; tick(); await flush(); assert.equal(warnings, 0);
    stat.framesDecoded = 0; tick(); await flush(); assert.equal(warnings, 1, 'explicit decoder zero is actionable');
  } finally {
    stop?.(); Date.now = original.now; console.info = original.info;
    globalThis.setInterval = original.interval; globalThis.clearInterval = original.clear;
  }
});

test('screen polling does not overlap and cancels its interval and pending output on cleanup', async () => {
  const originalSet = globalThis.setInterval;
  const originalClear = globalThis.clearInterval;
  let tick: (() => void) | undefined;
  let cleared = false;
  let calls = 0;
  let resolveReport!: (report: RTCStatsReport) => void;
  globalThis.setInterval = ((callback: () => void) => { tick = callback; return 123; }) as any;
  globalThis.clearInterval = ((id: any) => { assert.equal(id, 123); cleared = true; }) as any;
  try {
    const stop = startScreenReceiveDiagnostics({ getStats: () => {
      calls += 1;
      return new Promise<RTCStatsReport>((resolve) => { resolveReport = resolve; });
    } } as RTCPeerConnection, {} as MediaStream);
    tick!(); tick!();
    assert.equal(calls, 1);
    stop();
    resolveReport(new Map() as unknown as RTCStatsReport);
    await Promise.resolve();
    tick!();
    assert.equal(calls, 1);
    assert.equal(cleared, true);
  } finally {
    globalThis.setInterval = originalSet;
    globalThis.clearInterval = originalClear;
  }
});


test('screen diagnostics trace audio RTP, playback mute, loss and RTT without addresses', () => {
  const pc = { connectionState: 'connected', iceConnectionState: 'connected', signalingState: 'stable' } as RTCPeerConnection;
  const values = [
    { id: 'a', type: 'inbound-rtp', kind: 'audio', packetsReceived: 25, bytesReceived: 5000, packetsLost: 2, jitter: .003 },
    { id: 'v', type: 'inbound-rtp', kind: 'video', packetsReceived: 100, framesDecoded: 60, packetsLost: 3, nackCount: 4, qpSum: 1100 },
    { id: 'p', type: 'candidate-pair', selected: true, currentRoundTripTime: .04, availableIncomingBitrate: 4000000, address: 'PRIVATE' },
  ];
  const report = new Map(values.map(v => [v.id, v])) as unknown as RTCStatsReport;
  const stream = { getVideoTracks: () => [], getAudioTracks: () => [{ readyState: 'live', muted: false }] } as unknown as MediaStream;
  const safe = summarizeScreenReceiver(pc, report, stream);
  assert.equal(safe.audioPacketsReceived, 25);
  assert.equal(safe.audioBytesReceived, 5000);
  assert.equal(safe.audioTrackState, 'live');
  assert.equal(safe.audioTrackCount, 1);
  assert.equal(safe.roundTripTime, .04);
  assert.equal(safe.packetsLost, 3);
  assert.equal(safe.nackCount, 4);
  assert.equal(JSON.stringify(safe).includes('PRIVATE'), false);
});


test('receiver correlation hashes identities and distinguishes transport generations without private data', async () => {
  const {screenReceiverContext}=await import('../src/services/ScreenReceiveDiagnostics.ts');
  const a=await screenReceiverContext('PRIVATE_SENDER','PRIVATE_PEER','100',1,2);
  const b=await screenReceiverContext('PRIVATE_SENDER','PRIVATE_PEER','101',2,2);
  assert.match(a.senderToken as string,/^[a-f0-9]{64}$/);
  assert.match(a.diagnosticRun as string,/^[a-f0-9]{32}$/);
  assert.equal(a.senderToken,b.senderToken); assert.notEqual(a.transportToken,b.transportToken);
  assert.equal(JSON.stringify(a).includes('PRIVATE'),false); assert.equal(a.receiverGeneration,1);
});


test('ICE and DTLS diagnostics retain counters and negotiation booleans without credentials or fingerprints', () => {
  const sdp=(role:string)=>'v=0\r\na=setup:'+role+'\r\na=ice-ufrag:PRIVATE_UFRAG\r\na=ice-pwd:PRIVATE_PASSWORD\r\na=fingerprint:sha-256 AA:BB\r\n';
  const pc={connectionState:'connecting',iceConnectionState:'connected',signalingState:'stable',
    localDescription:{type:'answer',sdp:sdp('active')}, remoteDescription:{type:'offer',sdp:sdp('actpass')}} as RTCPeerConnection;
  const report=new Map([
    ['t',{id:'t',type:'transport',selectedCandidatePairId:'p',dtlsState:'connecting',localCertificateId:'lc',remoteCertificateId:'rc'}],
    ['p',{id:'p',type:'candidate-pair',nominated:true,state:'succeeded',requestsSent:9,responsesReceived:7,requestsReceived:8,responsesSent:8,bytesReceived:123}],
    ['lc',{id:'lc',type:'certificate',fingerprintAlgorithm:'sha-256',fingerprint:'AA:BB'}],
    ['rc',{id:'rc',type:'certificate',fingerprintAlgorithm:'sha-256',fingerprint:'AA:CC'}],
  ]) as unknown as RTCStatsReport;
  const stream={getVideoTracks:()=>[],getAudioTracks:()=>[]} as unknown as MediaStream;
  const safe=summarizeScreenReceiver(pc,report,stream);
  assert.equal(safe.pairRequestsSent,9); assert.equal(safe.pairResponsesReceived,7);
  assert.equal(safe.pairBytesReceived,123); assert.equal(safe.bytesReceived,null,'pair bytes do not count as received media');
  assert.equal(safe.dtlsState,'connecting'); assert.equal(safe.setupCompatible,true);
  assert.equal(safe.localIceCredentialsPresent,true); assert.equal(safe.localFingerprintMatchesCertificate,true);
  assert.equal(safe.remoteFingerprintMatchesCertificate,false);
  assert.equal(JSON.stringify(safe).includes('PRIVATE'),false); assert.equal(JSON.stringify(safe).includes('AA:BB'),false);
});

test('invalid or incompatible DTLS roles are observable without returning arbitrary SDP values', async () => {
  const {summarizeScreenNegotiation}=await import('../src/services/ScreenTransportDiagnostics.ts');
  const pc={localDescription:{type:'offer',sdp:'a=setup:active\r\n'},remoteDescription:{type:'answer',sdp:'a=setup:active\r\n'}} as RTCPeerConnection;
  assert.equal(summarizeScreenNegotiation(pc,new Map(),null).setupCompatible,false);
  (pc.remoteDescription as any).sdp='a=setup:PRIVATE_ROLE\r\n';
  const safe=summarizeScreenNegotiation(pc,new Map(),null);
  assert.equal(safe.remoteSetup,null); assert.equal(safe.setupCompatible,null);
  assert.equal(JSON.stringify(safe).includes('PRIVATE'),false);
});


test('checking receivers report checks for all pairs even before any selected pair exists', () => {
  const pc={connectionState:'connecting',iceConnectionState:'checking',signalingState:'stable'} as RTCPeerConnection;
  const report=new Map([
    ['p1',{id:'p1',type:'candidate-pair',state:'in-progress',requestsSent:5,responsesReceived:0,address:'PRIVATE'}],
    ['p2',{id:'p2',type:'candidate-pair',state:'failed',requestsSent:3,responsesReceived:1}],
  ]) as unknown as RTCStatsReport;
  const safe=summarizeScreenReceiver(pc,report,{getVideoTracks:()=>[]} as unknown as MediaStream);
  assert.equal(safe.pairRequestsSent,null); assert.equal(safe.iceRequestsSentTotal,8);
  assert.equal(safe.iceResponsesReceivedTotal,1); assert.equal(safe.icePairsInProgress,1); assert.equal(safe.icePairsFailed,1);
  assert.equal(JSON.stringify(safe).includes('PRIVATE'),false);
});
