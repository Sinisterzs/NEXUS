import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { MeshRoomService } from '../src/services/MeshRoomService.ts';
import { WebRtcService } from '../src/services/WebRtcService.ts';
import { screenCaptureService } from '../src/services/ScreenCaptureService.ts';
import { screenSessionId } from '../src/services/screenReceiverLifecycle.ts';

const original = { pc: globalThis.RTCPeerConnection, stream: globalThis.MediaStream,
  interval: globalThis.setInterval, clear: globalThis.clearInterval, document: globalThis.document, info: console.info };
const methods = ['subscribeNativeEvents', 'startNativeShare', 'stopNativeShare', 'addNativeScreenPeer'] as const;
const nativeMethods = Object.fromEntries(methods.map((key) => [key, screenCaptureService[key]]));
let timers: Map<number, () => void>;
let peers: FakePc[];
let nextTimer = 1;
let setRemoteGate: (() => Promise<void>) | null = null;
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const sdp = (id: number) => `v=0\r\no=- ${id} 0 IN IP4 0.0.0.0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n`;

class FakeTrack {
  id = 'screen'; kind = 'video'; readyState = 'live'; muted = false; stops = 0;
  onended: any = null; onmute: any = null; onunmute: any = null;
  stop() { this.stops++; this.readyState = 'ended'; }
}
class FakeStream {
  tracks: any[] = [];
  getTracks() { return [...this.tracks]; }
  getVideoTracks() { return this.tracks.filter((track) => track.kind === 'video'); }
  addTrack(track: any) { this.tracks.push(track); }
  removeTrack(track: any) { this.tracks = this.tracks.filter((item) => item !== track); }
}
class FakePc extends EventTarget {
  connectionState = 'connected'; iceConnectionState = 'connected'; signalingState = 'stable';
  remoteDescription: any = null; localDescription: any = null;
  onicecandidate: any = null; ontrack: any = null; onconnectionstatechange: any = null;
  closes = 0; answers = 0; candidates: any[] = [];
  configuration: any; pairLocal: string | undefined = 'host'; pairRemote: string | undefined = 'srflx';
  constructor(configuration?: any) { super(); this.configuration = configuration; peers.push(this); }
  async setRemoteDescription(description: any) { if (setRemoteGate) await setRemoteGate(); this.remoteDescription = description; }
  async createAnswer() { this.answers++; return { type: 'answer', sdp: 'answer' }; }
  async setLocalDescription(description?: any) { this.localDescription = description ?? { type: 'answer', sdp: 'answer' }; }
  async addIceCandidate(candidate: any) { this.candidates.push(candidate); }
  async getStats() { return new Map([['pair', {id:'pair',type:'candidate-pair',selected:true,localCandidateId:'local',remoteCandidateId:'remote'}],['local',{id:'local',type:'local-candidate',candidateType:this.pairLocal}],['remote',{id:'remote',type:'remote-candidate',candidateType:this.pairRemote}]]); }
  close() { this.closes++; this.connectionState = 'closed'; }
  state(value: string) { this.connectionState = value; this.dispatchEvent(new Event('connectionstatechange')); this.onconnectionstatechange?.(); }
}

beforeEach(() => {
  console.info = () => {};
  peers = []; timers = new Map(); setRemoteGate = null;
  (globalThis as any).RTCPeerConnection = FakePc;
  (globalThis as any).MediaStream = FakeStream;
  globalThis.setInterval = ((callback: () => void) => { const id = nextTimer++; timers.set(id, callback); return id; }) as any;
  globalThis.clearInterval = ((id: number) => { timers.delete(id); }) as any;
});
afterEach(() => {
  console.info = original.info;
  (globalThis as any).RTCPeerConnection = original.pc;
  (globalThis as any).MediaStream = original.stream;
  (globalThis as any).document = original.document;
  globalThis.setInterval = original.interval; globalThis.clearInterval = original.clear;
  for (const key of methods) (screenCaptureService as any)[key] = nativeMethods[key];
  assert.equal(timers.size, 0, 'screen diagnostic timers must be cancelled');
});

function rtc() {
  let ended = 0;
  const service = new WebRtcService({ onIceCandidate() {}, onConnectionStateChange() {}, onLocalSpeaking() {},
    onRemoteSpeaking() {}, onError() {}, onRemoteVideoEnded() { ended++; } });
  (service as any).cachedIceServers = [];
  return { service, ended: () => ended };
}
function mesh() {
  const service = new MeshRoomService();
  const visible: Map<string, any>[] = [];
  const answers: string[] = [];
  service.setCallbacks({ onSendOffer() {}, onSendAnswer(_id, value) { answers.push(value); }, onSendIceCandidate() {},
    onRemoteVideoStreamsChange(value) { visible.push(value); } });
  Object.assign(service as any, { isActive: true, selfUserId: 'self', cachedIceServers: [] });
  return { service, visible, answers };
}
function video(pc: FakePc) {
  const track = new FakeTrack(); pc.ontrack({ track, streams: [] }); return track;
}

test('SDP session identity stays stable across renegotiation and rejects malformed origins', () => {
  assert.equal(screenSessionId(sdp(123)), '123');
  assert.equal(screenSessionId('o=- secret 0 IN IP4 address'), null);
});

test('1:1 explicit stop releases player, tracks, diagnostics and PC once, preserving voice', async () => {
  const { service, ended } = rtc();
  await service.handleRemoteScreenOffer(sdp(1));
  const track = video(peers[0]);
  const stream = (service as any).screenReceiverStream;
  const element = { srcObject: stream, pauses: 0, loads: 0, pause() { this.pauses++; }, load() { this.loads++; } };
  (globalThis as any).document = { querySelectorAll: () => [element] };
  const voice = { closes: 0, close() { this.closes++; } };
  (service as any).peerConnection = voice;
  service.closeScreenReceiver('1'); service.closeScreenReceiver('1');
  assert.equal(element.srcObject, null); assert.equal(element.pauses, 1);
  assert.equal(track.stops, 1); assert.equal(peers[0].closes, 1); assert.equal(ended(), 1);
  assert.equal(voice.closes, 0);
});

test('1:1 disconnected recovers in place; failed cleans up and next share replaces it', async () => {
  const { service } = rtc(); await service.handleRemoteScreenOffer(sdp(1));
  const track = video(peers[0]);
  peers[0].state('disconnected'); assert.equal(track.stops, 0); assert.equal(timers.size, 2);
  peers[0].state('connected'); assert.equal(peers[0].closes, 0);
  peers[0].state('failed'); assert.equal(track.stops, 1); assert.equal(timers.size, 0);
  await service.addScreenReceiverIceCandidate({ candidate: 'candidate:late 1 udp 1 192.0.2.1 9 typ host' });
  await service.handleRemoteScreenOffer(sdp(2)); assert.equal(peers.length, 2);
  service.closeScreenReceiver('1'); assert.equal(peers[1].closes, 0, 'late stop must not close newer share');
  service.closeScreenReceiver('2');
});

test('1:1 stop during pending offer cancels answer and queued work without resurrecting a PC', async () => {
  const { service } = rtc();
  let resolve!: () => void;
  setRemoteGate = () => new Promise<void>((done) => { resolve = done; });
  const pending = service.handleRemoteScreenOffer(sdp(1)); await flush();
  service.closeScreenReceiver('1'); resolve();
  assert.equal(await pending, null); assert.equal(peers[0].answers, 0);
  setRemoteGate = null; await service.handleRemoteScreenOffer(sdp(2)); service.closeScreenReceiver();
});

test('1:1 stop while fetching ICE prevents creation after the await', async () => {
  const { service } = rtc(); (service as any).cachedIceServers = null;
  let resolve!: (value: any[]) => void;
  service.fetchIceServers = () => new Promise((done) => { resolve = done; });
  const pending = service.handleRemoteScreenOffer(sdp(1)); await flush(); service.closeScreenReceiver('1');
  resolve([]); assert.equal(await pending, null); assert.equal(peers.length, 0);
});

test('Mesh authoritative stop removes remote video without touching the voice peer', async () => {
  const { service, visible } = mesh();
  const voice = { closes: 0, close() { this.closes++; } };
  (service as any).peers.set('remote', { pc: voice });
  await service.handleRemoteOffer('remote', sdp(1), 'screen'); const track = video(peers[0]);
  service.closeRemoteScreen('remote'); service.closeRemoteScreen('remote');
  assert.equal(visible.at(-1)?.size, 0); assert.equal(track.stops, 1);
  assert.equal(peers[0].closes, 1); assert.equal(voice.closes, 0);
  assert.equal((service as any).screenReceiverPeers.size, 0);
});

test('Mesh fallback stop detaches video without stopping tracks owned by the voice connection', () => {
  const { service } = mesh(); const stream = new FakeStream();
  const video = new FakeTrack(); const audio = new FakeTrack(); audio.kind = 'audio';
  stream.addTrack(video); stream.addTrack(audio);
  (service as any).remoteVideoStreams.set('remote', stream);
  const element = { srcObject: stream, pause() {}, load() {} };
  (globalThis as any).document = { querySelectorAll: () => [element] };
  service.closeRemoteScreen('remote');
  assert.equal(element.srcObject, null); assert.equal(video.stops, 0); assert.equal(audio.stops, 0);
});

test('Mesh queues early ICE without creating a receiver and does not recreate it after stop', async () => {
  const { service } = mesh();
  await service.handleRemoteIceCandidate('remote', { candidate: 'candidate:early 1 udp 1 192.0.2.1 9 typ host' }, 'screen'); assert.equal(peers.length, 0);
  await service.handleRemoteOffer('remote', sdp(1), 'screen'); assert.equal(peers[0].candidates.length, 1);
  service.closeRemoteScreen('remote');
  await service.handleRemoteIceCandidate('remote', { candidate: 'candidate:late 1 udp 1 192.0.2.1 9 typ host' }, 'screen'); assert.equal(peers.length, 1);
  await service.handleRemoteOffer('remote', sdp(2), 'screen'); assert.equal(peers.length, 2);
  service.closeRemoteScreen('remote');
});

test('Mesh shares pending receiver creation and cancels it on stop', async () => {
  const { service, answers } = mesh(); (service as any).cachedIceServers = null;
  let resolve!: (value: any[]) => void;
  service.fetchIceServers = () => new Promise((done) => { resolve = done; });
  const first = service.handleRemoteOffer('remote', sdp(1), 'screen');
  const second = service.handleRemoteOffer('remote', sdp(1), 'screen');
  await flush(); service.closeRemoteScreen('remote'); resolve([]);
  await Promise.all([first, second]); assert.equal(peers.length, 0); assert.equal(answers.length, 0);
});

test('Mesh cancels pending SDP on participant departure and leaving room', async () => {
  const { service, answers } = mesh();
  let resolve!: () => void;
  setRemoteGate = () => new Promise<void>((done) => { resolve = done; });
  const pending = service.handleRemoteOffer('remote', sdp(1), 'screen'); await flush();
  service.removeParticipant('remote'); resolve(); await pending; assert.equal(answers.length, 0);
  setRemoteGate = null; await service.handleRemoteOffer('remote', sdp(2), 'screen'); assert.equal(peers.length, 1);
  await service.leaveRoom();
});

test('Mesh transient disconnect preserves video; failed closes the dedicated receiver', async () => {
  const { service } = mesh(); await service.handleRemoteOffer('remote', sdp(1), 'screen');
  const track = video(peers[0]); peers[0].state('disconnected'); assert.equal(track.stops, 0);
  peers[0].state('connected'); peers[0].state('failed'); assert.equal(track.stops, 1);
  assert.equal((service as any).screenReceiverPeers.size, 0);
});

function nativeStubs(onAdd: (handler: any) => Promise<any>) {
  let handler: any;
  screenCaptureService.subscribeNativeEvents = async (value) => { handler = value; return () => {}; };
  screenCaptureService.startNativeShare = async () => ({ bitrate_bps: 1000 } as any);
  screenCaptureService.stopNativeShare = async () => {};
  screenCaptureService.addNativeScreenPeer = async () => onAdd(handler);
}

test('Mesh publishes active state before offer, buffers local trickle until offer, and stops once', async () => {
  const { service } = mesh(); const events: string[] = [];
  (service as any).peers.set('remote', { videoSender: null });
  service.setCallbacks({ onScreenSharingChange(value) { events.push(`state:${value}`); },
    onSendOffer() { events.push('offer'); }, onSendAnswer() {}, onSendIceCandidate() { events.push('ice'); } });
  nativeStubs(async (handler) => {
    handler.onIce({ peer_id: 'remote', candidate: 'candidate:early 1 udp 1 192.0.2.1 9 typ host' }); return { peer_id: 'remote', sdp: sdp(1) };
  });
  assert.ok(await service.startNativeScreenShare({ source_id: 'mock' }));
  assert.deepEqual(events, ['state:true', 'offer', 'ice']);
  await service.stopScreenShare(); await service.stopScreenShare();
  assert.deepEqual(events, ['state:true', 'offer', 'ice', 'state:false']);
});

test('Mesh stop during peer creation never sends the late offer or returns a stale success', async () => {
  const { service } = mesh(); const events: string[] = [];
  (service as any).peers.set('remote', { videoSender: null });
  let resolve!: (value: any) => void;
  nativeStubs(() => new Promise((done) => { resolve = done; }));
  service.setCallbacks({ onSendOffer() { events.push('offer'); }, onSendAnswer() {}, onSendIceCandidate() {} });
  const pending = service.startNativeScreenShare({ source_id: 'mock' }); await flush();
  await service.stopScreenShare(); resolve({ peer_id: 'remote', sdp: sdp(1) });
  assert.equal(await pending, null); assert.equal(events.length, 0);
});

test('Mesh source closes during startup and cannot publish a successful dead capture', async () => {
  const { service } = mesh(); const events: boolean[] = []; let handler: any;
  let ready!: (value: any) => void;
  screenCaptureService.subscribeNativeEvents = async (value) => { handler = value; return () => {}; };
  screenCaptureService.startNativeShare = () => new Promise((resolve) => { ready = resolve; });
  screenCaptureService.stopNativeShare = async () => {};
  service.setCallbacks({ onSendOffer() {}, onSendAnswer() {}, onSendIceCandidate() {}, onScreenSharingChange(value) { events.push(value); } });
  const pending = service.startNativeScreenShare({ source_id: 'mock' }); await flush();
  handler.onEnded({ reason: 'target_closed' }); ready({ bitrate_bps: 1000 });
  assert.equal(await pending, null); assert.ok(!events.includes(true));
});

test('Mesh peer departure during native add never sends an offer to the departed participant', async () => {
  const { service } = mesh(); const events: string[] = [];
  (service as any).peers.set('remote', { videoSender: null });
  let ready!: (value: any) => void;
  nativeStubs(() => new Promise((resolve) => { ready = resolve; }));
  service.setCallbacks({ onSendOffer() { events.push('offer'); }, onSendAnswer() {}, onSendIceCandidate() {} });
  const pending = service.startNativeScreenShare({ source_id: 'mock' }); await flush();
  // Isolate the native-add race from unrelated voice resource disposal.
  (service as any).peers.clear();
  const originalRemove = screenCaptureService.removeNativeScreenPeer;
  screenCaptureService.removeNativeScreenPeer = async () => {};
  try {
    service.removeParticipant('remote'); ready({ peer_id: 'remote', sdp: sdp(1) });
    await pending; assert.equal(events.length, 0); await service.stopScreenShare();
  } finally { screenCaptureService.removeNativeScreenPeer = originalRemove; }
});

test('Mesh different offer during pending fetch cancels old creation and answers only the new offer', async () => {
  const { service, answers } = mesh(); (service as any).cachedIceServers = null;
  const completions: ((value: any[]) => void)[] = [];
  service.fetchIceServers = () => new Promise((resolve) => { completions.push(resolve); });
  const first = service.handleRemoteOffer('remote', sdp(1), 'screen'); await flush();
  const second = service.handleRemoteOffer('remote', sdp(2), 'screen'); await flush();
  completions[0]([]); completions[1]([]); await Promise.all([first, second]);
  assert.equal(peers.length, 1); assert.equal(answers.length, 1); assert.equal(peers[0].remoteDescription.sdp, sdp(2));
  service.closeRemoteScreen('remote');
});

test('Mesh native add rejected after peer departure does not stop the shared capture', async () => {
  const { service } = mesh();
  (service as any).peers.set('remote', { videoSender: null });
  let reject!: (error: Error) => void;
  nativeStubs(() => new Promise((_resolve, fail) => { reject = fail; }));
  const pending = service.startNativeScreenShare({ source_id: 'mock' }); await flush();
  (service as any).peers.clear();
  const originalRemove = screenCaptureService.removeNativeScreenPeer;
  screenCaptureService.removeNativeScreenPeer = async () => {};
  try {
    service.removeParticipant('remote'); reject(new Error('Native screen share stopped while adding peer'));
    assert.ok(await pending); assert.equal((service as any).nativeScreenActive, true);
    await service.stopScreenShare();
  } finally { screenCaptureService.removeNativeScreenPeer = originalRemove; }
});


test('1:1 and Mesh receivers filter backend TURN without mutating the voice cache', async () => {
  for (const mode of ['call','room']) {
    const original = [{urls:['stun:example.invalid','turn:example.invalid'],username:'private',credential:'private'}];
    const copy = structuredClone(original);
    const service:any = mode === 'call' ? rtc().service : mesh().service;
    service.cachedIceServers = original;
    if (mode === 'call') await service.handleRemoteScreenOffer(sdp(99));
    else await service.handleRemoteOffer('remote', sdp(99), 'screen');
    const pc = peers.at(-1)!;
    assert.deepEqual(pc.configuration.iceServers, [{urls:['stun:example.invalid']}]);
    assert.equal(pc.configuration.iceTransportPolicy, 'all');
    assert.deepEqual(original, copy);
    if (mode === 'call') service.closeScreenReceiver(); else service.closeRemoteScreen('remote');
  }
});
test('both receiver routes reject relay before SDP installation and close on relay trickle', async () => {
  const relay = 'candidate:1 1 udp 1 192.0.2.1 9 typ relay';
  for (const mode of ['call','room']) {
    const service:any = mode === 'call' ? rtc().service : mesh().service;
    const offer = sdp(101) + 'a=' + relay + '\r\n'; const before = peers.length;
    if (mode === 'call') await assert.rejects(service.handleRemoteScreenOffer(offer), /relay\/TURN/i);
    else await assert.rejects(service.handleRemoteOffer('remote', offer, 'screen'), /relay\/TURN/i);
    assert.equal(peers.length, before, 'unsafe SDP never reaches a new PC');
    if (mode === 'call') await service.handleRemoteScreenOffer(sdp(102));
    else await service.handleRemoteOffer('remote', sdp(102), 'screen');
    const pc = peers.at(-1)!;
    if (mode === 'call') await assert.rejects(service.addScreenReceiverIceCandidate({candidate:relay}));
    else await assert.rejects(service.handleRemoteIceCandidate('remote',{candidate:relay},'screen'));
    assert.equal(pc.closes,1); assert.equal(pc.candidates.length,0);
  }
});
test('receiver source replacement reinstalls the guard; relay-selected pair is never published', async () => {
  const { service } = rtc(); let published = 0; let errors = 0;
  (service as any).callbacks.onRemoteVideoTrack = () => published++;
  (service as any).callbacks.onError = () => errors++;
  await service.handleRemoteScreenOffer(sdp(201));
  const first = peers.at(-1)!; video(first); assert.equal(published,1);
  await service.handleRemoteScreenOffer(sdp(202)); assert.equal(first.closes,1);
  const second = peers.at(-1)!; second.pairRemote='relay';
  for (const tick of [...timers.values()]) tick(); await flush();
  assert.equal(second.closes,1); assert.equal(errors,1); assert.equal(published,1);
  service.closeScreenReceiver();
});


test('screen ICE for an incoming stream must not be copied into this user native outgoing peer', async () => {
  const {service}=mesh();
  await service.handleRemoteOffer('remote',sdp(301),'screen');
  const receiver=peers.at(-1)!;
  (service as any).nativeScreenActive=true;
  (service as any).nativeScreenOfferIds.set('remote','302');
  const saved=screenCaptureService.handleNativeScreenIce;
  let nativeCalls=0;screenCaptureService.handleNativeScreenIce=async()=>{nativeCalls++;};
  try {
    await service.handleRemoteIceCandidate('remote',{candidate:'candidate:1 1 udp 1 192.0.2.1 9 typ host',nexusScreenSessionId:'301'} as any,'screen');
    assert.equal(receiver.candidates.length,1);
    assert.equal(nativeCalls,0,'one candidate must have only one dedicated destination');
  } finally {screenCaptureService.handleNativeScreenIce=saved;service.closeRemoteScreen('remote');}
});


test('Mesh routes sender ICE once, drops stale and ambiguous ICE, preserves independent receiver', async () => {
  const {service}=mesh(); await service.handleRemoteOffer('remote',sdp(401),'screen');
  const receiver=peers.at(-1)!; (service as any).nativeScreenActive=true;
  (service as any).nativeScreenOfferIds.set('remote','402');
  const saved=screenCaptureService.handleNativeScreenIce; let sent=0;
  screenCaptureService.handleNativeScreenIce=async()=>{sent++;};
  const candidate='candidate:1 1 udp 1 192.0.2.1 9 typ host';
  try {
    for (const id of ['402','old',undefined]) await service.handleRemoteIceCandidate('remote',
      {candidate,...(id ? {nexusScreenSessionId:id} : {})} as any,'screen');
    assert.equal(sent,1); assert.equal(receiver.candidates.length,0); assert.equal(receiver.closes,0);
    await service.handleRemoteIceCandidate('remote',{candidate,nexusScreenSessionId:'401'} as any,'screen');
    assert.equal(receiver.candidates.length,1); assert.ok(!('nexusScreenSessionId' in receiver.candidates[0]));
  } finally {screenCaptureService.handleNativeScreenIce=saved;service.closeRemoteScreen('remote');}
});

test('Mesh ignores old Answer and applies only the current native negotiation', async () => {
  const {service}=mesh(); (service as any).nativeScreenActive=true;
  (service as any).nativeScreenOfferIds.set('remote','502');
  const saved=screenCaptureService.handleNativeScreenAnswer; const applied:string[]=[];
  screenCaptureService.handleNativeScreenAnswer=async(_id,_sdp,id)=>{applied.push(id!);};
  try {
    await service.handleRemoteAnswer('remote','v=0\r\na=x-nexus-screen-session:501\r\n','screen');
    await service.handleRemoteAnswer('remote','v=0\r\na=x-nexus-screen-session:502\r\n','screen');
    assert.deepEqual(applied,['502']);
  } finally {screenCaptureService.handleNativeScreenAnswer=saved;}
});

test('Mesh duplicate offer resends cached Answer without resetting its PC or ICE', async () => {
  const {service,answers}=mesh(); await service.handleRemoteOffer('remote',sdp(601),'screen');
  const pc=peers.at(-1)!; await service.handleRemoteOffer('remote',sdp(601),'screen');
  assert.equal(peers.length,1); assert.equal(pc.closes,0); assert.equal(answers.length,2);
  assert.equal(answers[0],answers[1]); assert.match(answers[0],/x-nexus-screen-session:601/);
  service.closeRemoteScreen('remote');
});

test('Mesh one viewer setup failure does not stop capture or skip another viewer', async () => {
  const {service}=mesh(); const added:string[]=[];
  for (const id of ['first','broken','third']) (service as any).peers.set(id,{videoSender:null});
  nativeStubs(async()=>({})); let stops=0;
  screenCaptureService.stopNativeShare=async()=>{stops++;};
  screenCaptureService.addNativeScreenPeer=async(id)=>{
    added.push(id); if(id==='broken') throw new Error('viewer setup failed');
    return {peer_id:id,sdp:sdp(id==='first'?701:703)} as any;
  };
  assert.ok(await service.startNativeScreenShare({source_id:'mock'}));
  assert.deepEqual(added,['first','broken','third']); assert.equal(stops,0);
  assert.equal(service.isNativeScreenShareActive(),true);
  assert.equal((service as any).nativeScreenOfferIds.get('first'),'701');
  await service.stopScreenShare(); assert.equal(stops,1);
});

test('Mesh failed receiver retry is bounded, requests only its session and cancels on stop', async () => {
  const {service}=mesh(); const requests:any[]=[];
  service.setCallbacks({onSendOffer(){},onSendAnswer(){},onSendIceCandidate(id,candidate){requests.push({id,candidate});}});
  await service.handleRemoteOffer('first',sdp(801),'screen'); const first=peers.at(-1)!;
  await service.handleRemoteOffer('second',sdp(802),'screen'); const second=peers.at(-1)!;
  first.state('failed'); assert.equal(second.closes,0);
  assert.equal(service.retryRemoteScreen('first'),true);
  assert.equal(service.retryRemoteScreen('first'),false);
  assert.equal(requests.length,1); assert.equal(requests[0].id,'first');
  assert.equal(requests[0].candidate.nexusScreenSessionId,'801');
  assert.equal(requests[0].candidate.nexusScreenAction,'retry');
  service.closeRemoteScreen('first'); assert.equal(service.retryRemoteScreen('first'),false);
  assert.equal(second.closes,0); service.closeRemoteScreen('second');
});

test('Mesh retry control recreates just the requested native viewer and ignores duplicate requests', async () => {
  const {service}=mesh(); (service as any).nativeScreenActive=true;
  (service as any).nativeScreenOfferIds.set('first','901');
  (service as any).nativeScreenOfferIds.set('second','902');
  (service as any).peers.set('first',{videoSender:null});
  const added:string[]=[]; screenCaptureService.addNativeScreenPeer=async(id)=>{added.push(id);return {peer_id:id,sdp:sdp(903)} as any;};
  const request={candidate:'',nexusScreenSessionId:'901',nexusScreenAction:'retry'} as any;
  await service.handleRemoteIceCandidate('first',request,'screen');
  await service.handleRemoteIceCandidate('first',request,'screen');
  assert.deepEqual(added,['first']); assert.equal((service as any).nativeScreenOfferIds.get('second'),'902');
  assert.equal(service.isNativeScreenShareActive(),true);
});

test('Mesh old early candidates are filtered when the matching Offer arrives', async () => {
  const {service}=mesh(); const candidate='candidate:1 1 udp 1 192.0.2.1 9 typ host';
  for(const id of ['1000','1001']) await service.handleRemoteIceCandidate('remote',{candidate,nexusScreenSessionId:id} as any,'screen');
  await service.handleRemoteOffer('remote',sdp(1001),'screen'); const pc=peers.at(-1)!;
  assert.equal(pc.candidates.length,1); service.closeRemoteScreen('remote');
});


test('Mesh transient retry setup failure preserves the request identity for another bounded attempt', async () => {
  const {service}=mesh(); const inner=service as any;
  inner.nativeScreenActive=true; inner.nativeScreenOfferIds.set('remote','1101');
  inner.peers.set('remote',{videoSender:null}); let attempts=0;
  screenCaptureService.addNativeScreenPeer=async(id)=>{
    if(++attempts===1) throw new Error('transient'); return {peer_id:id,sdp:sdp(1102)} as any;
  };
  const request={candidate:'',nexusScreenSessionId:'1101',nexusScreenAction:'retry'} as any;
  await service.handleRemoteIceCandidate('remote',request,'screen');
  assert.equal(inner.nativeScreenOfferIds.get('remote'),'1101');
  inner.nativeScreenRetryLimits.get('remote').at-=10001;
  await service.handleRemoteIceCandidate('remote',request,'screen');
  assert.equal(attempts,2); assert.equal(inner.nativeScreenOfferIds.get('remote'),'1102');
});


test('Mesh connected without frames exposes retry for only that receiver', async () => {
  const {service}=mesh(); let sampled!:()=>void;
  const states:string[]=[]; (service as any).callbacks.onScreenReceiverState=(_id:string,state:string)=>states.push(state);
  const initial=new Promise<void>(resolve=>{sampled=resolve;});
  console.info=(kind)=>{if(kind==='[ScreenReceiver]') sampled();};
  await service.handleRemoteOffer('remote',sdp(1201),'screen');
  const pc=peers.at(-1)!; video(pc); await initial;
  assert.equal((service as any).remoteVideoStreams.has('remote'),true,'stream was already published');
  const saved=Date.now; const now=saved();
  try {
    Date.now=()=>now+31000;
    const next=new Promise<void>(resolve=>{sampled=resolve;});
    for(const tick of [...timers.values()]) tick();
    await next;
    assert.equal(pc.closes,1);
    assert.equal((service as any).remoteVideoStreams.has('remote'),false,'published stream must be removed to expose retry');
    assert.equal(states.at(-1),'failed');
    assert.equal(service.retryRemoteScreen('remote'),true);
  } finally {Date.now=saved;service.closeRemoteScreen('remote');}
});


test('Mesh registers two outgoing and two incoming screen negotiations and routes every direction independently', async () => {
  const {service}=mesh(); const inner=service as any;
  for(const id of ['one','two']) inner.peers.set(id,{videoSender:null});
  await service.handleRemoteOffer('one',sdp(1301),'screen'); const incomingOne=peers.at(-1)!;
  await service.handleRemoteOffer('two',sdp(1302),'screen'); const incomingTwo=peers.at(-1)!;
  nativeStubs(async()=>({}));
  screenCaptureService.addNativeScreenPeer=async id=>({peer_id:id,sdp:sdp(id==='one'?1401:1402)} as any);
  const saved=screenCaptureService.handleNativeScreenIce; const native:string[]=[];
  screenCaptureService.handleNativeScreenIce=async(id,_candidate,_mid,_index,session)=>{native.push(id+':'+session);};
  try {
    assert.ok(await service.startNativeScreenShare({source_id:'mock'}));
    assert.equal(inner.nativeScreenOfferIds.size,2); assert.equal(inner.screenReceiverPeers.size,2);
    const candidate='candidate:1 1 udp 1 192.0.2.1 9 typ host';
    for(const [peer,id] of [['one','1301'],['two','1302'],['one','1401'],['two','1402']]) {
      await service.handleRemoteIceCandidate(peer,{candidate,nexusScreenSessionId:id} as any,'screen');
    }
    assert.deepEqual(native,['one:1401','two:1402']);
    assert.equal(incomingOne.candidates.length,1); assert.equal(incomingTwo.candidates.length,1);
    incomingOne.state('failed'); assert.equal(incomingTwo.closes,0);
    assert.equal(service.isNativeScreenShareActive(),true); assert.equal(inner.nativeScreenOfferIds.size,2);
  } finally {
    screenCaptureService.handleNativeScreenIce=saved;
    service.closeRemoteScreen('one'); service.closeRemoteScreen('two'); await service.stopScreenShare();
  }
});
