import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebRtcService } from '../src/services/WebRtcService.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

test('native screen signaling sends exactly one Offer per peer in 1:1, Mesh, and Rust', () => {
  const webrtcSenderRs = fs.readFileSync(
    path.join(rootDir, 'src-tauri/src/capture/webrtc_sender.rs'),
    'utf8'
  );
  assert.equal(
    webrtcSenderRs.includes('emit("native-screen-offer"'),
    false,
    'Rust add_peer must not emit native-screen-offer when returning NativeScreenOfferEvent'
  );

  const callServiceTs = fs.readFileSync(
    path.join(rootDir, 'src/services/CallService.ts'),
    'utf8'
  );
  const callSubStart = callServiceTs.indexOf('subscribeNativeEvents({');
  const callSubEnd = callServiceTs.indexOf('});', callSubStart);
  assert.ok(callSubStart !== -1 && callSubEnd !== -1);
  const callSubBlock = callServiceTs.slice(callSubStart, callSubEnd);
  assert.equal(
    callSubBlock.includes('onOffer:'),
    false,
    'CallService must not register onOffer alongside addNativeScreenPeer return value'
  );

  const meshServiceTs = fs.readFileSync(
    path.join(rootDir, 'src/services/MeshRoomService.ts'),
    'utf8'
  );
  const meshSubStart = meshServiceTs.indexOf('subscribeNativeEvents({');
  const meshSubEnd = meshServiceTs.indexOf('});', meshSubStart);
  assert.ok(meshSubStart !== -1 && meshSubEnd !== -1);
  const meshSubBlock = meshServiceTs.slice(meshSubStart, meshSubEnd);
  assert.equal(
    meshSubBlock.includes('onOffer:'),
    false,
    'MeshRoomService must not register onOffer alongside addNativeScreenPeer return value'
  );
});

test('WebRtcService serializes concurrent screen offers and ICE candidates without recreating RTCPeerConnection', async () => {
  const prevRtc = (globalThis as any).RTCPeerConnection;
  const prevMediaStream = (globalThis as any).MediaStream;

  let pcConstructCount = 0;
  let activeOps = 0;
  let maxConcurrentOps = 0;
  const opLog: string[] = [];

  class MockMediaStream {
    private tracks: any[] = [];
    getTracks() {
      return this.tracks;
    }
    addTrack(t: any) {
      this.tracks.push(t);
    }
  }

  class MockRTCPeerConnection {
    remoteDescription: any = null;
    localDescription: any = null;
    connectionState = 'new';
    onicecandidate: any = null;
    ontrack: any = null;
    onconnectionstatechange: any = null;

    constructor() {
      pcConstructCount += 1;
    }

    async setRemoteDescription(desc: any) {
      activeOps += 1;
      maxConcurrentOps = Math.max(maxConcurrentOps, activeOps);
      opLog.push(`setRemote:${desc.sdp}`);
      await new Promise((r) => setTimeout(r, 10));
      this.remoteDescription = desc;
      activeOps -= 1;
    }

    async createAnswer() {
      activeOps += 1;
      maxConcurrentOps = Math.max(maxConcurrentOps, activeOps);
      opLog.push('createAnswer');
      await new Promise((r) => setTimeout(r, 5));
      activeOps -= 1;
      return { type: 'answer', sdp: `ans-${opLog.length}` };
    }

    async setLocalDescription(desc: any) {
      activeOps += 1;
      maxConcurrentOps = Math.max(maxConcurrentOps, activeOps);
      opLog.push(`setLocal:${desc.sdp}`);
      await new Promise((r) => setTimeout(r, 5));
      this.localDescription = desc;
      activeOps -= 1;
    }

    async addIceCandidate(cand: any) {
      opLog.push(`addIce:${cand.candidate}`);
    }

    close() {
      this.connectionState = 'closed';
    }
  }

  (globalThis as any).RTCPeerConnection = MockRTCPeerConnection;
  (globalThis as any).MediaStream = MockMediaStream;

  try {
    const svc = new WebRtcService({
      onIceCandidate: () => {},
      onConnectionStateChange: () => {},
      onLocalSpeaking: () => {},
      onRemoteSpeaking: () => {},
      onError: () => {},
    });

    // Queue an ICE candidate before the first offer finishes fetchIceServers()
    const pOffer1 = svc.handleRemoteScreenOffer('offer-1');
    const pIceEarly = svc.addScreenReceiverIceCandidate({ candidate: 'cand-early' });
    const pOffer2 = svc.handleRemoteScreenOffer('offer-2');

    const [ans1, , ans2] = await Promise.all([pOffer1, pIceEarly, pOffer2]);

    assert.equal(pcConstructCount, 1, 'must reuse single screenReceiverPc');
    assert.equal(maxConcurrentOps, 1, 'SDP operations must never overlap');
    assert.ok(ans1 && ans2);
    assert.deepEqual(opLog, [
      'setRemote:offer-1',
      'createAnswer',
      'setLocal:ans-2',
      'addIce:cand-early',
      'setRemote:offer-2',
      'createAnswer',
      'setLocal:ans-6',
    ]);

    svc.closeScreenReceiver();
    svc.destroy();
  } finally {
    (globalThis as any).RTCPeerConnection = prevRtc;
    (globalThis as any).MediaStream = prevMediaStream;
  }
});
