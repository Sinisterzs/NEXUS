# NEXUS Nightly 2 - Audio & Voice Activity Engineering Notes

## Problem 6: Microphone Sensitivity & Reliable Voice-Activity Indicator

### 1. Root Cause & Evidence Analysis

#### 1.1 Flickering Voice Activity Indicator (Chatter / Absence of Hysteresis)
- **Evidence**: In `WebRtcService.ts` (lines 1405-1416), the VAD loop runs on a 100ms interval with an instantaneous comparison:
  ```ts
  const localThreshold = Math.max(5, Math.round(46 - sensitivity * 0.36));
  const isSpeaking = avg > localThreshold;
  if (isSpeaking !== lastLocalSpeaking) {
    lastLocalSpeaking = isSpeaking;
    this.callbacks.onLocalSpeaking(isSpeaking);
  }
  ```
- **Cause**: Natural human speech contains frequent acoustic pauses between syllables (e.g. stop consonants like /p/, /t/, /k/, brief breaths, and unvoiced fricatives) where the energy drops for 50-250ms. Without an activation hangover (hold time) and Schmitt-trigger hysteresis (different opening vs closing thresholds), any dip below `localThreshold` immediately flips `isSpeaking` to `false`, followed by `true` 100ms later. This causes aggressive visual flickering in `CallsView` and `ActiveCallBar` (avatar green halo toggling several times per sentence).

#### 1.2 Unintuitive Sensitivity Control & Static / Ambiguous Meter in Settings
- **Evidence**: In `SettingsView.tsx` (lines 982-1024), the slider controlled `inputSensitivity` (0-100), but:
  - When not testing, the meter displayed a static fake bar (`settings.audioVideo.inputSensitivity * 0.7%`).
  - When testing, the meter displayed the instantaneous raw average (`micVolumeLevel`), but with **no threshold marker**.
  - Users could not determine where their voice would cross into the "Speaking" state relative to ambient room noise or keyboard clicks.
  - No background noise calibration tool existed to help users calibrate sensitivity in noisy environments.

#### 1.3 Audio Architecture Boundaries: Captured Audio vs. Transmitted Audio vs. Visual Indicator
- **Captured Audio**: Raw PCM audio captured from the hardware input device via `navigator.mediaDevices.getUserMedia` with browser DSP (echo cancellation, noise suppression, AGC).
- **Transmitted Audio**: RTP stream carried over WebRTC `RTCPeerConnection`. To prevent clipped syllables at the beginning and end of phrases ("gate swallowing"), **transmitted audio MUST NOT be aggressively gated**. By default, transmitted audio flows continuously while unmuted (`track.enabled = true`), leaving codec-level comfort noise generation and discontinuous transmission (OPUS DTX) to WebRTC standards.
- **Visual Indicator**: The UI representation of speech state (`isLocalSpeaking`, green glow, `ActiveCallBar` status). This layer employs a Voice Activity Detector with **attack time, hysteresis, and hangover time (default 400ms)** to ensure clean, human-perceptible indicators without visual chatter.

---

### 2. Implementation Plan & Fix Strategy

1. **`src/lib/voiceActivity.ts` (Pure Module)**:
   - Implement `VoiceActivityDetector` with:
     - Opening threshold vs. Closing threshold (hysteresis offset, default 5 points).
     - Hangover timer (default 400ms, configurable) to bridge inter-syllable gaps.
     - Attack frame verification to avoid single-sample impulse spikes triggering speech.
     - Level smoothing (exponential decay) for realistic visual metering.
     - Pure helper functions for RMS, frequency magnitude averaging, sensitivity-to-threshold mapping, and ambient noise calibration.
   - Fully unit-testable without DOM/WebRTC mocks.

2. **`tests/voice_activity_nightly2.test.ts`**:
   - Comprehensive test suite covering:
     - Hysteresis opening vs closing threshold transitions.
     - Hangover hold time preventing flicker during silent dips.
     - Attack delay filtering short transient clicks.
     - Sensitivity to threshold mapping and noise floor calibration.
     - Account preference validation & persistence schema.

3. **`src/services/AudioDeviceService.ts`**:
   - Add utility methods for VAD creation and noise calibration helpers.
   - Ensure clean device lifecycle and fallback compatibility.

4. **`src/repositories/SettingsRepository.ts` & `src/lib/types.ts`**:
   - Add audio preferences:
     - `voiceAutoSensitivity?: boolean` (default: `true`)
     - `voiceHangoverMs?: number` (default: `400`)
     - `voiceSoftGate?: boolean` (default: `false` - indicator-only by default, soft gate opt-in)
   - Add schema validation and persistence per account (`validateAndMerge`).

5. **`src/services/CallService.ts`**:
   - Connect `VoiceActivityDetector` with hangover smoothing to `onLocalSpeaking` and `onRemoteSpeaking` callbacks.
   - Ensure immediate deactivation on Mute or Deafen (bypassing hangover when explicitly muted).
   - Safeguard transmitted audio from aggressive gating.

6. **`src/features/settings/SettingsView.tsx`**:
   - Audio section enhancements:
     - Real-time interactive meter with visible threshold marker.
     - Clear distinction between speaking state and ambient level.
     - Room noise calibration button ("Calibrar Ruído Ambiente").
     - Intuitive sensitivity slider and hangover control.
     - Documented soft-gate setting (off by default).
