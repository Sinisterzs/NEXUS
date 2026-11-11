import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { audioDeviceService } from '../src/services/AudioDeviceService.ts';
import { processAnalyserFrame } from '../src/lib/voiceActivity.ts';
import { WebRtcService } from '../src/services/WebRtcService.ts';

describe('microphone monitoring integration', () => {
  it('uses the same normalized threshold in settings and call monitoring and applies sensitivity live', () => {
    const settingsVad = audioDeviceService.createVoiceDetector({ sensitivity: 70, attackFramesRequired: 1 });
    const callVad = audioDeviceService.createVoiceDetector({ sensitivity: 70, attackFramesRequired: 1 });
    assert.equal(settingsVad.getEffectiveActivationThreshold(), callVad.getEffectiveActivationThreshold());

    let signal = 40;
    let reads = 0;
    const analyser = {
      getByteFrequencyData(target: Uint8Array) {
        reads++;
        target.fill(signal);
      },
    };
    const data = new Uint8Array(128);
    const settingsFirst = processAnalyserFrame(settingsVad, analyser, data);
    const callFirst = processAnalyserFrame(callVad, analyser, data);
    assert.equal(settingsFirst.rawLevel, 31);
    assert.equal(settingsFirst.isSpeaking, false);
    assert.equal(callFirst.isSpeaking, settingsFirst.isSpeaking);

    // A slider update mutates the live detector: no stream or analyser replacement is involved.
    const existingAnalyser = analyser;
    settingsVad.setSensitivity(100);
    callVad.setSensitivity(100);
    const settingsNext = processAnalyserFrame(settingsVad, analyser, data);
    const callNext = processAnalyserFrame(callVad, analyser, data);
    assert.equal(settingsNext.activationThreshold, 12);
    assert.equal(settingsNext.isSpeaking, true);
    assert.equal(callNext.isSpeaking, settingsNext.isSpeaking);
    assert.equal(analyser, existingAnalyser);
    assert.equal(reads, 4);
    assert.equal(settingsNext.shouldGateAudio, false);
  });

  it('emits stable local call activity and applies slider changes without replacing analyser', () => {
    const previousWindow = (globalThis as any).window;
    const previousStore = (globalThis as any).__NEXUS_STORE__;
    const previousSetInterval = globalThis.setInterval;
    const previousClearInterval = globalThis.clearInterval;
    let sensitivity = 0;
    let intervalCallback: (() => void) | null = null;
    let sourceCount = 0;
    let level = 60;
    const speakingEvents: boolean[] = [];

    class FakeAudioContext {
      state = 'running';
      createMediaStreamSource() {
        sourceCount++;
        return { connect: () => {} };
      }
      createAnalyser() {
        return {
          fftSize: 0,
          frequencyBinCount: 128,
          getByteFrequencyData(data: Uint8Array) { data.fill(level); },
        };
      }
      resume() { return Promise.resolve(); }
      close() { return Promise.resolve(); }
    }

    (globalThis as any).window = { AudioContext: FakeAudioContext };
    (globalThis as any).__NEXUS_STORE__ = {
      getState: () => ({
        settings: { audioVideo: { inputSensitivity: sensitivity, voiceHangoverMs: 400 } },
        activeCallPeer: null,
      }),
    };
    globalThis.setInterval = ((callback: () => void, delay: number) => {
      assert.equal(delay, 50, 'call and mic test must use the same 50ms VAD cadence');
      intervalCallback = callback;
      return 1 as any;
    }) as typeof setInterval;
    globalThis.clearInterval = (() => {}) as typeof clearInterval;

    const service = new WebRtcService({
      onIceCandidate: () => {},
      onConnectionStateChange: () => {},
      onLocalSpeaking: (isSpeaking) => speakingEvents.push(isSpeaking),
      onRemoteSpeaking: () => {},
      onError: () => {},
    });

    try {
      (service as any).setupLocalVad({} as MediaStream);
      assert.equal(sourceCount, 1);
      assert.ok(intervalCallback);

      // Same deterministic signal is below the initial threshold, then above the live slider threshold.
      intervalCallback!();
      assert.deepEqual(speakingEvents, []);
      sensitivity = 100;
      intervalCallback!();
      assert.deepEqual(speakingEvents, []);
      intervalCallback!();
      assert.deepEqual(speakingEvents, [true]);
      assert.equal(sourceCount, 1, 'slider update must retain the captured stream and analyser');

      // Eight 50ms ticks exhaust a 400ms hangover, matching Settings.
      level = 0;
      for (let i = 0; i < 7; i++) intervalCallback!();
      assert.deepEqual(speakingEvents, [true]);
      intervalCallback!();
      assert.deepEqual(speakingEvents, [true, false]);
      level = 60;
      intervalCallback!(); intervalCallback!();
      assert.deepEqual(speakingEvents, [true, false, true]);

      // Muting clears VAD state so the previous hangover cannot reappear on unmute.
      service.setMuted(true);
      assert.deepEqual(speakingEvents, [true, false, true, false]);
      const eventsBeforeUnmute = speakingEvents.length;
      service.setMuted(false);
      level = 0;
      for (let i = 0; i < 10; i++) intervalCallback!();
      assert.equal(speakingEvents.includes(true, eventsBeforeUnmute), false, 'old hangover must not reactivate after unmute');
    } finally {
      (globalThis as any).window = previousWindow;
      (globalThis as any).__NEXUS_STORE__ = previousStore;
      globalThis.setInterval = previousSetInterval;
      globalThis.clearInterval = previousClearInterval;
    }
  });
});
