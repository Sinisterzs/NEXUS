import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  VoiceActivityDetector,
  sensitivityToThreshold,
  thresholdToSensitivity,
  calculateByteFrequencyLevel,
  calculateRmsLevel,
  calibrateSensitivityFromNoise,
} from '../src/lib/voiceActivity.ts';
import { audioDeviceService } from '../src/services/AudioDeviceService.ts';

describe('VoiceActivityDetector - Pure Logic & Hysteresis Unit Tests', () => {
  it('sensitivityToThreshold: monotonic mapping with safe clamping', () => {
    // 0 sensitivity -> highest threshold (85)
    assert.strictEqual(sensitivityToThreshold(0), 85);
    // 100 sensitivity -> lowest threshold (12)
    assert.strictEqual(sensitivityToThreshold(100), 12);
    // Intermediate sensitivity values are monotonic
    const t30 = sensitivityToThreshold(30);
    const t50 = sensitivityToThreshold(50);
    const t70 = sensitivityToThreshold(70);
    assert.ok(t30 > t50, 'Higher sensitivity must yield lower threshold');
    assert.ok(t50 > t70, 'Higher sensitivity must yield lower threshold');

    // Clamping on out-of-range inputs
    assert.strictEqual(sensitivityToThreshold(-10), 85);
    assert.strictEqual(sensitivityToThreshold(150), 12);

    // Inverse mapping round-trip
    const sens = 65;
    const thresh = sensitivityToThreshold(sens);
    const recoveredSens = thresholdToSensitivity(thresh);
    assert.ok(Math.abs(recoveredSens - sens) <= 2, 'Round-trip sensitivity error should be <= 2');
  });

  it('calculateByteFrequencyLevel & calculateRmsLevel: energy computation', () => {
    // Silent frequency buffer
    const silentFreq = new Uint8Array(128).fill(0);
    assert.strictEqual(calculateByteFrequencyLevel(silentFreq), 0);

    // Loud frequency buffer
    const loudFreq = new Uint8Array(128).fill(128);
    assert.strictEqual(calculateByteFrequencyLevel(loudFreq), 100);

    // Moderate frequency buffer
    const modFreq = new Uint8Array(128).fill(64);
    assert.strictEqual(calculateByteFrequencyLevel(modFreq), 50);

    // Silent RMS buffer
    const silentPcm = new Float32Array(256).fill(0);
    assert.strictEqual(calculateRmsLevel(silentPcm), 0);

    // DC signal PCM buffer
    const loudPcm = new Float32Array(256).fill(0.35);
    assert.strictEqual(calculateRmsLevel(loudPcm), 100);
  });

  it('calibrateSensitivityFromNoise: calculates safe threshold above background noise', () => {
    // Ambient room noise varying between 10 and 18
    const roomNoise = [10, 12, 14, 18, 12, 11, 15];
    const cal = calibrateSensitivityFromNoise(roomNoise);

    assert.ok(cal.averageNoise >= 12 && cal.averageNoise <= 14);
    assert.strictEqual(cal.peakNoise, 18);
    // Recommended threshold must be peakNoise (18) + 10 = 28
    assert.strictEqual(cal.recommendedThreshold, 28);
    assert.ok(cal.recommendedSensitivity > 0 && cal.recommendedSensitivity <= 100);
  });

  it('attack frames requirement: single impulse spike does NOT trigger speaking', () => {
    const vad = new VoiceActivityDetector({
      sensitivity: 70, // threshold = 36
      attackFramesRequired: 2,
    });

    // Baseline silence
    let res = vad.processFrame(10, 50);
    assert.strictEqual(res.isSpeaking, false);

    // Single isolated spike above threshold (e.g. keyboard click or mouse click)
    res = vad.processFrame(55, 50);
    assert.strictEqual(res.isSpeaking, false, 'Single impulse spike must not trigger speech indicator');

    // Followed immediately by silence again
    res = vad.processFrame(10, 50);
    assert.strictEqual(res.isSpeaking, false);

    // Two consecutive frames above threshold -> triggers speech
    vad.processFrame(55, 50);
    res = vad.processFrame(55, 50);
    assert.strictEqual(res.isSpeaking, true, 'Consecutive frames above threshold must trigger speech indicator');
  });

  it('Schmitt-trigger hysteresis: speech sustained between activation and deactivation thresholds', () => {
    const vad = new VoiceActivityDetector({
      manualThreshold: 40,
      hysteresisOffset: 6, // activation = 40, deactivation = 34
      attackFramesRequired: 1,
      hangoverMs: 400,
    });

    assert.strictEqual(vad.getEffectiveActivationThreshold(), 40);
    assert.strictEqual(vad.getEffectiveDeactivationThreshold(), 34);

    // Start speaking above activation threshold (45 >= 40)
    let res = vad.processFrame(45, 50);
    assert.strictEqual(res.isSpeaking, true);

    // Drops to 37 (between 34 and 40)
    // In a single-threshold system this would flick off; with hysteresis it must stay speaking!
    res = vad.processFrame(37, 50);
    assert.strictEqual(res.isSpeaking, true, 'Speech must stay active above deactivation threshold');
    assert.strictEqual(res.hangoverRemainingMs, 400, 'Hangover timer must remain full when above deactivation threshold');
  });

  it('hangover timer: prevents indicator flicker during pauses between syllables', () => {
    const vad = new VoiceActivityDetector({
      manualThreshold: 40,
      hysteresisOffset: 5, // deactivation = 35
      attackFramesRequired: 1,
      hangoverMs: 200,
    });

    // User speaks
    let res = vad.processFrame(50, 50);
    assert.strictEqual(res.isSpeaking, true);

    // User pauses between words: energy drops below cutoff (level 20 < 35) for 50ms
    res = vad.processFrame(20, 50);
    assert.strictEqual(res.isSpeaking, true, 'Indicator must stay active during hangover');
    assert.strictEqual(res.hangoverRemainingMs, 150);

    // Another 50ms of silence
    res = vad.processFrame(20, 50);
    assert.strictEqual(res.isSpeaking, true, 'Indicator must stay active during hangover');
    assert.strictEqual(res.hangoverRemainingMs, 100);

    // Syllable resumes before hangover expires!
    res = vad.processFrame(45, 50);
    assert.strictEqual(res.isSpeaking, true);
    assert.strictEqual(res.hangoverRemainingMs, 200, 'Hangover must reset back to full on new speech');

    // Silence for full hangover duration (200ms)
    vad.processFrame(15, 100);
    res = vad.processFrame(15, 100);
    assert.strictEqual(res.isSpeaking, false, 'Speech indicator must turn off after hangover expires');
  });

  it('meter smoothing: fast attack and smooth visual decay', () => {
    const vad = new VoiceActivityDetector({ meterSmoothing: 0.3 });

    // Attack: instant jump to peak
    let res = vad.processFrame(80, 50);
    assert.strictEqual(res.meterLevel, 80);

    // Release: smooth decay towards 0
    res = vad.processFrame(0, 50);
    assert.ok(res.meterLevel < 80 && res.meterLevel > 0, 'Meter level must smoothly decay');
    const firstDecay = res.meterLevel;

    res = vad.processFrame(0, 50);
    assert.ok(res.meterLevel < firstDecay, 'Meter level must continue decaying');
  });

  it('architectural boundary: soft gate off by default ensures transmitted audio is never cut', () => {
    // Default detector (indicator-only)
    const vad = new VoiceActivityDetector();
    assert.strictEqual(vad.isSoftGateEnabled(), false);

    // While silent, shouldGateAudio MUST be false
    let res = vad.processFrame(5, 50);
    assert.strictEqual(res.shouldGateAudio, false, 'Default VAD must never gate audio');

    // When soft gate is explicitly enabled (opt-in)
    vad.setSoftGateEnabled(true);
    assert.strictEqual(vad.isSoftGateEnabled(), true);

    // While silent, soft gate activates
    res = vad.processFrame(5, 50);
    assert.strictEqual(res.shouldGateAudio, true);

    // While speaking, soft gate opens (shouldGateAudio = false)
    vad.processFrame(60, 50);
    res = vad.processFrame(60, 50);
    assert.strictEqual(res.isSpeaking, true);
    assert.strictEqual(res.shouldGateAudio, false);
  });

  it('AudioDeviceService integration helpers work seamlessly', () => {
    const vad = audioDeviceService.createVoiceDetector({ sensitivity: 80 });
    assert.ok(vad instanceof VoiceActivityDetector);
    assert.strictEqual(vad.getSensitivity(), 80);

    const thresh = audioDeviceService.sensitivityToThreshold(80);
    const recovered = audioDeviceService.thresholdToSensitivity(thresh);
    assert.ok(Math.abs(recovered - 80) <= 2);

    const freqLevel = audioDeviceService.calculateFrequencyLevel(new Uint8Array(64).fill(128));
    assert.strictEqual(freqLevel, 100);

    const pcmLevel = audioDeviceService.calculateRmsLevel(new Float32Array(128).fill(0));
    assert.strictEqual(pcmLevel, 0);

    const cal = audioDeviceService.calibrateSensitivity([5, 8, 12, 10]);
    assert.ok(cal.recommendedThreshold >= 18);
  });

  it('Settings validation schema: audio preferences clamping and defaults', () => {
    // Clamping rule for hangoverMs: min 100, max 2000
    const clampHangover = (ms: any) =>
      typeof ms === 'number' && Number.isFinite(ms)
        ? Math.max(100, Math.min(2000, Math.round(ms)))
        : 400;

    assert.strictEqual(clampHangover(50), 100);
    assert.strictEqual(clampHangover(400), 400);
    assert.strictEqual(clampHangover(2500), 2000);
    assert.strictEqual(clampHangover('invalid'), 400);
    assert.strictEqual(clampHangover(null), 400);

    // Boolean coercion rule for softGate (default false)
    const validateSoftGate = (v: any) => (typeof v === 'boolean' ? v : false);
    assert.strictEqual(validateSoftGate(true), true);
    assert.strictEqual(validateSoftGate(false), false);
    assert.strictEqual(validateSoftGate(undefined), false);

    // Boolean coercion rule for autoSensitivity (default true)
    const validateAutoSensitivity = (v: any) => (typeof v === 'boolean' ? v : true);
    assert.strictEqual(validateAutoSensitivity(true), true);
    assert.strictEqual(validateAutoSensitivity(false), false);
    assert.strictEqual(validateAutoSensitivity(undefined), true);
  });
});
