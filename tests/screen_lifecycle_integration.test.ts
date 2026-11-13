// Bundled with esbuild before running under node:test, to resolve the app's Vite imports.
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { CallService } from '../src/services/CallService';
import { gatewayClient } from '../src/services/GatewayClient';
import { useAppStore } from '../src/stores/useAppStore';
import { meshRoomService } from '../src/services/MeshRoomService';
import { screenCaptureService } from '../src/services/ScreenCaptureService';

const methods = ['subscribeNativeEvents', 'startNativeShare', 'stopNativeShare', 'addNativeScreenPeer'] as const;
const originals = Object.fromEntries(methods.map((key) => [key, screenCaptureService[key]]));
const originalConnect = gatewayClient.connect;
const originalSend = (gatewayClient as any).sendJson;
let messages: any[];
let state: any;
let listeners: any[];
let captureListeners: any;
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
const offer = { peer_id: 'peer', sdp: 'v=0\r\no=- 12345 0 IN IP4 0.0.0.0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n' };
const event = (type: string, payload: any) => (gatewayClient as any).handleGatewayEvent({ type, payload });

beforeEach(() => {
  messages = []; state = useAppStore.getState();
  listeners = [...(gatewayClient as any).listeners];
  captureListeners = new Set((screenCaptureService as any).listeners);
  (gatewayClient as any).sendJson = (data: any) => { messages.push(data); };
  gatewayClient.connect = async () => {};
  screenCaptureService.stopNativeShare = async () => {};
  screenCaptureService.startNativeShare = async () => ({ bitrate_bps: 1000 } as any);
  screenCaptureService.subscribeNativeEvents = async () => () => {};
  screenCaptureService.addNativeScreenPeer = async () => offer;
  useAppStore.setState({ activeCallId: 'call', activeCallPeer: { id: 'peer' } as any, voiceCallState: 'connected' });
});
afterEach(() => {
  for (const key of methods) (screenCaptureService as any)[key] = originals[key];
  gatewayClient.connect = originalConnect; (gatewayClient as any).sendJson = originalSend;
  (gatewayClient as any).listeners = listeners;
  (screenCaptureService as any).listeners = captureListeners;
  useAppStore.setState(state, true);
});

test('Gateway encodes and delivers screen stop with session identity, rejecting malformed identity', () => {
  const received: any[] = [];
  const unsubscribe = gatewayClient.addListener({ onCallScreenStopped(value) { received.push(value); } });
  gatewayClient.sendCallScreenStopped('call', 'peer', '12345');
  assert.deepEqual(messages[0], { op: 'call.screen_stopped', call_id: 'call', target_user_id: 'peer', share_id: '12345' });
  event('call.screen_stopped', { call_id: 'call', sender_id: 'peer', share_id: '12345' });
  event('call.screen_stopped', { call_id: 'call', sender_id: 'peer', share_id: 'invalid' });
  assert.deepEqual(received, [{ callId: 'call', senderId: 'peer', shareId: '12345' }]); unsubscribe();
});

test('1:1 coordinator validates call and sender before forwarding screen stop', () => {
  const service = new CallService(); service.init();
  const stopped: string[] = [];
  (service as any).webRtc = { closeScreenReceiver(id: string) { stopped.push(id); } };
  event('call.screen_stopped', { call_id: 'other', sender_id: 'peer', share_id: '12345' });
  event('call.screen_stopped', { call_id: 'call', sender_id: 'other', share_id: '12345' });
  event('call.screen_stopped', { call_id: 'call', sender_id: 'peer', share_id: '12345' });
  assert.deepEqual(stopped, ['12345']); assert.equal(useAppStore.getState().voiceCallState, 'connected');
});

test('1:1 publishes stop and clears local screen before native cleanup completes, without ending voice', async () => {
  const service = new CallService();
  Object.assign(service as any, { nativeScreenActive: true, nativeScreenShareId: '12345', webRtc: { detachScreenTrack: async () => null } });
  let finish!: () => void;
  screenCaptureService.stopNativeShare = () => new Promise((resolve) => { finish = resolve; });
  useAppStore.setState({ isScreenSharing: true });
  const pending = service.stopScreenShare();
  assert.equal(messages[0].op, 'call.screen_stopped'); assert.equal(useAppStore.getState().isScreenSharing, false);
  await service.stopScreenShare(); assert.equal(messages.length, 1); finish(); await pending;
  assert.equal(useAppStore.getState().voiceCallState, 'connected');
});

test('1:1 native offer precedes trickle, and source-ended reuses the full stop path', async () => {
  const service = new CallService(); let handler: any;
  (service as any).webRtc = { detachScreenTrack: async () => null };
  screenCaptureService.subscribeNativeEvents = async (value) => { handler = value; return () => {}; };
  screenCaptureService.addNativeScreenPeer = async () => {
    handler.onIce({ peer_id: 'peer', candidate: 'early' }); return offer;
  };
  assert.ok(await service.startNativeScreenShare({ source_id: 'mock', ice_servers: [] }));
  assert.deepEqual(messages.map((message) => message.op), ['call.webrtc.offer', 'call.webrtc.ice_candidate']);
  handler.onEnded({ reason: 'target_closed' }); await flush();
  assert.equal(messages.at(-1).op, 'call.screen_stopped'); assert.equal(messages.at(-1).share_id, '12345');
  assert.equal((service as any).nativeScreenActive, false); assert.equal(useAppStore.getState().voiceCallState, 'connected');
});

test('1:1 stop while adding native peer prevents late offer and stale success', async () => {
  const service = new CallService(); (service as any).webRtc = { detachScreenTrack: async () => null };
  let finish!: (value: any) => void;
  screenCaptureService.addNativeScreenPeer = () => new Promise((resolve) => { finish = resolve; });
  const pending = service.startNativeScreenShare({ source_id: 'mock', ice_servers: [] }); await flush();
  await service.stopScreenShare(); finish(offer);
  assert.equal(await pending, null); assert.equal(messages.length, 0);
});

test('cancelled native subscription cannot overwrite the current subscription', async () => {
  const service = new CallService(); (service as any).webRtc = { detachScreenTrack: async () => null };
  const subscriptions: ((unlisten: () => void) => void)[] = [];
  let oldStops = 0; let newStops = 0;
  screenCaptureService.subscribeNativeEvents = () => new Promise((resolve) => { subscriptions.push(resolve); });
  const first = service.startNativeScreenShare({ source_id: 'old', ice_servers: [] }); await flush();
  const second = service.startNativeScreenShare({ source_id: 'new', ice_servers: [] }); await flush();
  subscriptions[1](() => { newStops++; }); await second;
  subscriptions[0](() => { oldStops++; }); assert.equal(await first, null);
  assert.equal(oldStops, 1); assert.equal(newStops, 0); await service.stopScreenShare(); assert.equal(newStops, 1);
});

test('room participant false event closes its receiver even when previous DTO was false', async () => {
  const service: any = meshRoomService;
  const oldClose = service.closeRemoteScreen;
  const closed: string[] = [];
  service.closeRemoteScreen = (id: string) => { closed.push(id); };
  try {
    useAppStore.setState({ activeVoiceCommunityId: 'community', activeVoiceChannelId: 'room',
      voiceRoomParticipants: [{ user_id: 'peer', is_screen_sharing: false } as any] });
    useAppStore.getState().initWebSocket();
    event('room_participant_updated', { community_id: 'other', channel_id: 'room', participant: { user_id: 'peer', is_screen_sharing: false } });
    event('room_participant_updated', { community_id: 'community', channel_id: 'room', participant: { user_id: 'peer', is_screen_sharing: false } });
    assert.deepEqual(closed, ['peer']);
  } finally { service.closeRemoteScreen = oldClose; }
});
