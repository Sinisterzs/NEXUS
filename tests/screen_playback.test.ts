import test from 'node:test';
import assert from 'node:assert/strict';
import { bindScreenPlayback, updateScreenPlaybackAudio } from '../src/services/ScreenPlayback.ts';

function fixture() {
  let plays = 0; let pauses = 0;
  const stream = new EventTarget() as unknown as MediaStream;
  const element = { srcObject: null, muted: true, volume: 0,
    play: async () => { plays++; }, pause: () => { pauses++; } } as unknown as HTMLVideoElement;
  return { stream, element, plays: () => plays, pauses: () => pauses };
}

test('screen audio is playable; late audio retries and cleanup detaches without touching voice', async () => {
  const f = fixture();
  const stop = bindScreenPlayback(f.element, f.stream);
  assert.equal(f.element.muted, false);
  assert.equal(f.element.volume, 1);
  assert.equal(f.plays(), 1);
  f.stream.dispatchEvent(new Event('addtrack'));
  assert.equal(f.plays(), 2);
  stop();
  f.stream.dispatchEvent(new Event('addtrack'));
  assert.equal(f.plays(), 2);
  assert.equal(f.pauses(), 1);
  assert.equal(f.element.srcObject, null);
});

test('deafen and volume update in place, preserving video playback and stream', () => {
  const f = fixture(); const stop = bindScreenPlayback(f.element, f.stream);
  updateScreenPlaybackAudio(f.element, true, 0.4);
  assert.equal(f.element.muted, true);
  assert.equal(f.element.volume, 0.4);
  updateScreenPlaybackAudio(f.element, false, 0.7);
  assert.equal(f.element.muted, false);
  assert.equal(f.element.srcObject, f.stream);
  assert.equal(f.pauses(), 0);
  assert.equal(f.plays(), 1);
  stop();
});

test('a rejected play promise does not notify an unmounted player', async () => {
  const f = fixture(); let reject!: () => void; let blocked = 0;
  f.element.play = () => new Promise<void>((_, fail) => { reject = () => fail(new Error('blocked')); });
  const stop = bindScreenPlayback(f.element, f.stream, false, 1, () => blocked++);
  stop(); reject(); await Promise.resolve(); await Promise.resolve();
  assert.equal(blocked, 0);
});
