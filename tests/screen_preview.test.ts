import test from 'node:test';
import assert from 'node:assert/strict';
import { decodePreviewFrame, startPreviewPolling, previewProfile, readPreviewVisible, savePreviewVisible } from '../src/services/ScreenPreview.ts';
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function packet(session = 3, sequence = 1, width = 2, height = 2) {
  const data = new ArrayBuffer(32 + width * height * 4);
  [session, sequence, width, height].forEach((v, i) => new DataView(data).setUint32(i * 4, v, true));
  new Uint8Array(data, 32).set([10, 20, 30, 0]);
  return data;
}
test('decodes bounded binary frame, swaps BGRA and makes alpha opaque', () => {
  const frame = decodePreviewFrame(packet(), 3)!;
  assert.equal(frame.width, 2); assert.equal(frame.height, 2);
  assert.deepEqual([...frame.rgba.slice(0, 4)], [30, 20, 10, 255]);
});
test('empty frame and old session are ignored; malformed/oversized payloads rejected', () => {
  assert.equal(decodePreviewFrame(new ArrayBuffer(0), 3), null);
  assert.throws(() => decodePreviewFrame([] as unknown as ArrayBuffer, 3), /Binary preview unavailable/);
  assert.equal(decodePreviewFrame(packet(2), 3), null);
  assert.throws(() => decodePreviewFrame(new ArrayBuffer(1), 3));
  assert.throws(() => decodePreviewFrame(packet(3, 1, 962, 2), 3));
  assert.throws(() => decodePreviewFrame(packet().slice(0, 17), 3));
});
test('only one request in flight and cleanup ignores pending response without rescheduling', async () => {
  let calls = 0, frames = 0;
  let resolve!: (value: ArrayBuffer) => void;
  const stop = startPreviewPolling(3, async () => { calls++; return new Promise<ArrayBuffer>((done) => { resolve = done; }); },
    { frame() { frames++; }, phase() {} }, { interval: 1 });
  await delay(10); assert.equal(calls, 1);
  stop(); stop(); resolve(packet()); await delay(10);
  assert.equal(frames, 0); assert.equal(calls, 1);
});
test('reports loading then ready and does not render duplicate sequences', async () => {
  const phases: string[] = []; let frames = 0;
  const stop = startPreviewPolling(3, async () => packet(), { frame() { frames++; }, phase(v) { phases.push(v); } }, { interval: 1 });
  await delay(15); stop();
  assert.equal(frames, 1); assert.deepEqual(phases, ['loading', 'ready']);
});
test('preview failure is isolated and recovers when a later frame arrives', async () => {
  let calls = 0; const phases: string[] = [];
  const stop = startPreviewPolling(3, async () => { if (++calls === 1) throw new Error('GPU unavailable'); return packet(); },
    { frame() {}, phase(v) { phases.push(v); } }, { interval: 1 });
  await delay(20); stop(); assert.deepEqual(phases, ['loading', 'unavailable', 'ready']);
});
test('empty frames time out to unavailable without ending transmission', async () => {
  const phases: string[] = [];
  const stop = startPreviewPolling(3, async () => new ArrayBuffer(0), { frame() {}, phase(v) { phases.push(v); } }, { interval: 1, staleAfter: 5 });
  await delay(20); stop(); assert.ok(phases.includes('unavailable'));
});
test('rapid restart/source change never paints an old in-flight session', async () => {
  const painted: number[] = [];
  let old!: (value: ArrayBuffer) => void;
  const stopOld = startPreviewPolling(3, () => new Promise((done) => { old = done; }), { frame() { painted.push(3); }, phase() {} });
  stopOld();
  const stopNew = startPreviewPolling(4, async () => packet(4), { frame() { painted.push(4); }, phase() {} });
  old(packet(3)); await delay(10); stopNew(); assert.deepEqual(painted, [4]);
});
test('hidden UI does not request or retain new frames', async () => {
  let calls = 0;
  const stop = startPreviewPolling(3, async () => { calls++; return packet(); }, { frame() {}, phase() {} }, { interval: 1, visible: () => false });
  await delay(10); stop(); assert.equal(calls, 0);
});

test('nonbinary IPC fallback stops polling immediately instead of repeatedly transporting JSON images', async () => {
  let calls = 0; const phases: string[] = [];
  const stop = startPreviewPolling(3, async () => { calls++; return [] as unknown as ArrayBuffer; },
    { frame() { assert.fail('No binary frame'); }, phase(v) { phases.push(v); } }, { interval: 1 });
  await delay(15); stop(); assert.equal(calls, 1); assert.deepEqual(phases, ['loading', 'unavailable']);
});

test('visibility preference persists, defaults enabled and tolerates storage errors', () => {
  const values = new Map<string,string>();
  const storage = {getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);}};
  assert.equal(readPreviewVisible(storage),true);
  savePreviewVisible(storage,false); assert.equal(readPreviewVisible(storage),false);
  savePreviewVisible(storage,true); assert.equal(readPreviewVisible(storage),true);
  assert.equal(readPreviewVisible({getItem(){throw new Error('blocked')}}),true);
});
test('both presentation sizes target stream cadence, with a bounded raw-pixel budget', () => {
  for(const fps of [30,60]) for(const [w,h] of [[480,270],[1920,1080]]) {
    const config=previewProfile(w,h,fps);
    assert.equal(config.fps,fps);
    assert.ok(config.width*config.height*config.fps<=15_552_000);
    assert.ok(config.width<=960 && config.height<=540);
  }
});
