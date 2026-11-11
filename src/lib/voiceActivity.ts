/**
 * NEXUS - Voice Activity Detector (Nightly 2 / Audio 2.0)
 * Pure, unit-testable module for real-time audio energy calculation,
 * Schmitt-trigger hysteresis, attack/release smoothing, and hangover timing.
 *
 * Architectural boundary:
 * 1. Captured Audio: Hardware input stream with browser DSP (unaltered).
 * 2. Transmitted Audio: RTP WebRTC stream; continuous by default (no aggressive gate).
 * 3. Visual Indicator: Smoothed voice activity state with hangover to prevent UI flicker.
 */

export interface VadOptions {
  /** Sensitivity level from 0 to 100. Higher sensitivity = easier activation (lower threshold). Default 70. */
  sensitivity?: number;
  /** Explicit activation threshold override (0 to 100). If omitted, derived from sensitivity. */
  manualThreshold?: number;
  /** Hysteresis offset in level points (0..100) between activation and deactivation. Default 5. */
  hysteresisOffset?: number;
  /** Hangover time in milliseconds to bridge inter-syllable pauses and avoid indicator flicker. Default 400ms. */
  hangoverMs?: number;
  /** Number of consecutive frames required above threshold to trigger speech start. Default 2 (at ~50ms cadence). */
  attackFramesRequired?: number;
  /** Smoothing coefficient (0..1) for the visual meter decay. Default 0.3. */
  meterSmoothing?: number;
  /**
   * Optional soft audio gate for transmitted audio. Default false (indicator-only).
   * When false, audio transmission is never chopped. When true, operates with long hangover.
   */
  softGateEnabled?: boolean;
}

export interface VadFrameResult {
  /** Instantaneous energy level (0..100) */
  rawLevel: number;
  /** Smoothed level suitable for real-time UI meter display (0..100) */
  meterLevel: number;
  /** Reliable voice activity indicator (hysteresis + hangover smoothed) */
  isSpeaking: boolean;
  /** Effective threshold to begin speaking (0..100) */
  activationThreshold: number;
  /** Effective threshold to stop speaking after hangover (0..100) */
  deactivationThreshold: number;
  /** Time remaining in hangover state in milliseconds */
  hangoverRemainingMs: number;
  /**
   * Whether soft gate should suppress transmitted audio.
   * Always false if softGateEnabled is false (default).
   */
  shouldGateAudio: boolean;
}

/**
 * Maps intuitive sensitivity (0..100) to an activation threshold (0..100).
 * - Sensitivity 0   -> Threshold 85 (only very loud speech triggers)
 * - Sensitivity 70  -> Threshold 36 (balanced normal speech)
 * - Sensitivity 100 -> Threshold 12 (whisper / high sensitivity)
 */
export function sensitivityToThreshold(sensitivity: number): number {
  const clamped = Math.max(0, Math.min(100, Math.round(sensitivity)));
  // Linear interpolation: 85 down to 12
  const minThreshold = 12;
  const maxThreshold = 85;
  const threshold = Math.round(maxThreshold - (clamped / 100) * (maxThreshold - minThreshold));
  return Math.max(minThreshold, Math.min(maxThreshold, threshold));
}

/**
 * Maps an activation threshold (0..100) back to intuitive sensitivity (0..100).
 */
export function thresholdToSensitivity(threshold: number): number {
  const minThreshold = 12;
  const maxThreshold = 85;
  const clamped = Math.max(minThreshold, Math.min(maxThreshold, Math.round(threshold)));
  const ratio = (maxThreshold - clamped) / (maxThreshold - minThreshold);
  return Math.max(0, Math.min(100, Math.round(ratio * 100)));
}

/**
 * Calculates normalized energy level (0..100) from Web Audio AnalyserNode frequency byte data.
 */
export function calculateByteFrequencyLevel(data: Uint8Array): number {
  if (!data || data.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    sum += data[i];
  }
  const avg = sum / data.length;
  // Analyser frequency bytes range 0..255. Normalize to 0..100 with dynamic response.
  return Math.min(100, Math.round((avg / 128) * 100));
}

/**
 * Calculates normalized energy level (0..100) from PCM float samples (-1.0 .. 1.0).
 */
export function calculateRmsLevel(samples: Float32Array): number {
  if (!samples || samples.length === 0) return 0;
  let sumSquares = 0;
  for (let i = 0; i < samples.length; i++) {
    const val = samples[i];
    sumSquares += val * val;
  }
  const rms = Math.sqrt(sumSquares / samples.length);
  // RMS 0.0 to ~0.4 typical speech range. Scale to 0..100.
  const level = Math.min(100, Math.round((rms / 0.35) * 100));
  return level;
}

/**
 * Calibrates the ambient noise floor from an array of measured quiet levels.
 * Returns recommended sensitivity (0..100) with safety headroom.
 */
export function calibrateSensitivityFromNoise(noiseLevels: number[]): {
  averageNoise: number;
  peakNoise: number;
  recommendedThreshold: number;
  recommendedSensitivity: number;
} {
  if (!noiseLevels || noiseLevels.length === 0) {
    return {
      averageNoise: 15,
      peakNoise: 20,
      recommendedThreshold: 32,
      recommendedSensitivity: thresholdToSensitivity(32),
    };
  }

  const sum = noiseLevels.reduce((acc, v) => acc + v, 0);
  const avg = sum / noiseLevels.length;
  const peak = Math.max(...noiseLevels);

  // Recommended threshold is above peak noise with a 10-point headroom
  const recommendedThreshold = Math.max(18, Math.min(80, Math.round(peak + 10)));
  const recommendedSensitivity = thresholdToSensitivity(recommendedThreshold);

  return {
    averageNoise: Math.round(avg),
    peakNoise: Math.round(peak),
    recommendedThreshold,
    recommendedSensitivity,
  };
}

/**
 * Reliable Voice Activity Detector with Hysteresis & Hangover Smoothing
 */
export class VoiceActivityDetector {
  private sensitivity: number;
  private manualThreshold?: number;
  private hysteresisOffset: number;
  private hangoverMs: number;
  private attackFramesRequired: number;
  private meterSmoothing: number;
  private softGateEnabled: boolean;

  // Internal state
  private isSpeaking = false;
  private smoothedMeterLevel = 0;
  private consecutiveAboveThreshold = 0;
  private hangoverTimerMs = 0;

  constructor(options: VadOptions = {}) {
    this.sensitivity = options.sensitivity ?? 70;
    this.manualThreshold = options.manualThreshold;
    this.hysteresisOffset = options.hysteresisOffset ?? 5;
    this.hangoverMs = options.hangoverMs ?? 400;
    this.attackFramesRequired = options.attackFramesRequired ?? 2;
    this.meterSmoothing = options.meterSmoothing ?? 0.3;
    this.softGateEnabled = options.softGateEnabled ?? false;
  }

  public getEffectiveActivationThreshold(): number {
    if (typeof this.manualThreshold === 'number') {
      return Math.max(5, Math.min(95, Math.round(this.manualThreshold)));
    }
    return sensitivityToThreshold(this.sensitivity);
  }

  public getEffectiveDeactivationThreshold(): number {
    const activation = this.getEffectiveActivationThreshold();
    return Math.max(2, activation - this.hysteresisOffset);
  }

  public setSensitivity(sensitivity: number): void {
    this.sensitivity = Math.max(0, Math.min(100, Math.round(sensitivity)));
    this.manualThreshold = undefined;
  }

  public getSensitivity(): number {
    return this.sensitivity;
  }

  public setManualThreshold(threshold?: number): void {
    if (typeof threshold === 'number') {
      this.manualThreshold = Math.max(5, Math.min(95, Math.round(threshold)));
    } else {
      this.manualThreshold = undefined;
    }
  }

  public setHangover(hangoverMs: number): void {
    this.hangoverMs = Math.max(50, Math.min(3000, Math.round(hangoverMs)));
  }

  public getHangover(): number {
    return this.hangoverMs;
  }

  public setHysteresisOffset(offset: number): void {
    this.hysteresisOffset = Math.max(1, Math.min(25, Math.round(offset)));
  }

  public setSoftGateEnabled(enabled: boolean): void {
    this.softGateEnabled = Boolean(enabled);
  }

  public isSoftGateEnabled(): boolean {
    return this.softGateEnabled;
  }

  public reset(): void {
    this.isSpeaking = false;
    this.smoothedMeterLevel = 0;
    this.consecutiveAboveThreshold = 0;
    this.hangoverTimerMs = 0;
  }

  /**
   * Evaluates an instantaneous audio level (0..100) against the hysteresis/hangover model.
   * @param rawLevel Current level (0..100)
   * @param deltaMs Elapsed time in milliseconds since the previous evaluation
   */
  public processFrame(rawLevel: number, deltaMs = 50): VadFrameResult {
    const safeRaw = Math.max(0, Math.min(100, Math.round(rawLevel)));
    const safeDelta = Math.max(1, deltaMs);

    // 1. Smooth meter level for display (fast attack, smooth release)
    if (safeRaw >= this.smoothedMeterLevel) {
      this.smoothedMeterLevel = safeRaw;
    } else {
      this.smoothedMeterLevel = Math.round(
        this.smoothedMeterLevel * (1 - this.meterSmoothing) + safeRaw * this.meterSmoothing
      );
    }

    const activationThreshold = this.getEffectiveActivationThreshold();
    const deactivationThreshold = this.getEffectiveDeactivationThreshold();

    // 2. Evaluate speech onset / attack
    if (safeRaw >= activationThreshold) {
      this.consecutiveAboveThreshold++;
      if (this.consecutiveAboveThreshold >= this.attackFramesRequired) {
        this.isSpeaking = true;
        this.hangoverTimerMs = this.hangoverMs;
      }
    } else {
      this.consecutiveAboveThreshold = 0;
    }

    // 3. Evaluate hangover / release
    if (this.isSpeaking) {
      if (safeRaw >= deactivationThreshold) {
        // Sustaining speech above the cutoff threshold resets the hangover timer
        this.hangoverTimerMs = this.hangoverMs;
      } else {
        // Falling below the cutoff threshold depletes hangover time
        this.hangoverTimerMs = Math.max(0, this.hangoverTimerMs - safeDelta);
        if (this.hangoverTimerMs === 0) {
          this.isSpeaking = false;
        }
      }
    }

    // 4. Soft gate audio determination:
    // If soft gate is disabled (default), audio transmission is never gated (always false).
    // If enabled, audio is gated only when NOT in speaking/hangover state.
    const shouldGateAudio = this.softGateEnabled ? !this.isSpeaking : false;

    return {
      rawLevel: safeRaw,
      meterLevel: this.smoothedMeterLevel,
      isSpeaking: this.isSpeaking,
      activationThreshold,
      deactivationThreshold,
      hangoverRemainingMs: this.hangoverTimerMs,
      shouldGateAudio,
    };
  }

  /**
   * Helper to process frequency data from AnalyserNode
   */
  public processByteFrequency(data: Uint8Array, deltaMs = 50): VadFrameResult {
    const rawLevel = calculateByteFrequencyLevel(data);
    return this.processFrame(rawLevel, deltaMs);
  }

  /**
   * Helper to process PCM float samples
   */
  public processFloatSamples(samples: Float32Array, deltaMs = 50): VadFrameResult {
    const rawLevel = calculateRmsLevel(samples);
    return this.processFrame(rawLevel, deltaMs);
  }
}

/** Reads deterministic analyser data through the shared local VAD pipeline. */
export function processAnalyserFrame(
  vad: VoiceActivityDetector,
  analyser: Pick<AnalyserNode, 'getByteFrequencyData'>,
  data: Uint8Array<ArrayBuffer>,
  deltaMs = 50
): VadFrameResult {
  analyser.getByteFrequencyData(data);
  return vad.processByteFrequency(data, deltaMs);
}
