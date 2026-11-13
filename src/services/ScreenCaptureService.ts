import { screenIceServers, assertScreenCandidate, assertScreenSdp } from './ScreenP2PPolicy.ts';
/**
 * NEXUS - Screen Capture Service 2.0 (Calls & Streaming 2.0)
 *
 * Gerencia a captura de monitores ou janelas de aplicativos utilizando a API
 * navigator.mediaDevices.getDisplayMedia() com consentimento restrito via Tauri 2 IPC,
 * presets de qualidade (Auto, 720p30, 1080p30, 1080p60), fallback automático resiliente
 * e ciclo de vida estrito contra tracks órfãs.
 */

import type {
  CaptureSources,
  NativeCaptureStatus,
  NativeScreenEndedEvent,
  NativeScreenErrorEvent,
  NativeScreenIceEvent,
  NativeScreenOfferEvent,
  NativeScreenStatsEvent,
  ScreenShareQualityPreset,
  StartScreenShareOptions,
  VoiceRoomQualityPreset,
} from '../lib/types.ts';
import {
  canRetryDisplayCapture,
  getCaptureSourcePresentation,
  normalizeDisplaySurface,
} from '../lib/screenCapturePolicy.ts';

export interface ScreenEncodingTargets {
  maxBitrate: number;
  minBitrate: number;
  initialBitrate: number;
  maxFramerate: number;
  targetWidth: number;
  targetHeight: number;
  degradationPreference: 'maintain-resolution' | 'balanced' | 'maintain-framerate';
  steadyContentHint: 'detail' | 'motion';
  label: string;
}

export interface ScreenCaptureState {
  isCapturing: boolean;
  isStarting: boolean;
  stream: MediaStream | null;
  trackId: string | null;
  sourceLabel: string | null;
  qualityPreset: ScreenShareQualityPreset;
  requestedWidth: number;
  requestedHeight: number;
  requestedFrameRate: number;
  capturedWidth: number | null;
  capturedHeight: number | null;
  capturedFrameRate: number | null;
  effectiveWidth: number | null;
  effectiveHeight: number | null;
  effectiveFrameRate: number | null;
  displaySurface: string | null;
  captureNotice: string | null;
  qualityFallbackNotice: string | null;
  error: string | null;
}

export type ScreenCaptureListener = (state: ScreenCaptureState) => void;

export interface NativeScreenEventHandlers {
  onOffer?: (event: NativeScreenOfferEvent) => void;
  onIce?: (event: NativeScreenIceEvent) => void;
  onStats?: (event: NativeScreenStatsEvent) => void;
  onError?: (event: NativeScreenErrorEvent) => void;
  onEnded?: (event: NativeScreenEndedEvent) => void;
}

/**
 * Tauri 2 expõe os argumentos de comandos Rust em camelCase (peer_id -> peerId).
 * O payload aninhado de início de captura segue o mesmo padrão; o backend ainda
 * aceita os nomes snake_case antigos como alias de compatibilidade.
 */
export function toNativeStartOptionsPayload(options: StartScreenShareOptions): Record<string, unknown> {
  const payload: Record<string, unknown> = { sourceId: options.source_id };
  if (options.preset !== undefined) payload.preset = options.preset;
  if (options.cursor_enabled !== undefined) payload.cursorEnabled = options.cursor_enabled;
  if (options.include_app_audio !== undefined) payload.includeAppAudio = options.include_app_audio;
  if (options.force_software !== undefined) payload.forceSoftware = options.force_software;
  if (options.ice_servers !== undefined) payload.iceServers = options.ice_servers;
  return payload;
}
export function isTauriWindowsEnvironment(): boolean {
  if (typeof window === 'undefined') return false;
  const hasTauri = Boolean((window as any).__TAURI_INTERNALS__);
  if (!hasTauri) return false;
  const platform =
    (typeof navigator !== 'undefined' &&
      ((navigator as any).userAgentData?.platform || navigator.platform || navigator.userAgent)) ||
    '';
  return /win/i.test(String(platform));
}

export const SCREEN_QUALITY_CONFIGS: Record<ScreenShareQualityPreset, ScreenEncodingTargets> = {
  auto: {
    maxBitrate: 3_000_000,
    minBitrate: 1_200_000,
    initialBitrate: 2_000_000,
    maxFramerate: 30,
    targetWidth: 1920,
    targetHeight: 1080,
    degradationPreference: 'maintain-resolution',
    steadyContentHint: 'detail',
    label: 'Automático (Adaptativo)',
  },
  '720p30': {
    maxBitrate: 2_200_000,
    minBitrate: 900_000,
    initialBitrate: 1_500_000,
    maxFramerate: 30,
    targetWidth: 1280,
    targetHeight: 720,
    degradationPreference: 'maintain-resolution',
    steadyContentHint: 'detail',
    label: '720p • 30 FPS',
  },
  '720p60': {
    maxBitrate: 3_200_000,
    minBitrate: 1_400_000,
    initialBitrate: 2_200_000,
    maxFramerate: 60,
    targetWidth: 1280,
    targetHeight: 720,
    degradationPreference: 'balanced',
    steadyContentHint: 'motion',
    label: '720p • 60 FPS',
  },
  '1080p30': {
    maxBitrate: 3_500_000,
    minBitrate: 1_500_000,
    initialBitrate: 2_400_000,
    maxFramerate: 30,
    targetWidth: 1920,
    targetHeight: 1080,
    degradationPreference: 'maintain-resolution',
    steadyContentHint: 'detail',
    label: '1080p • 30 FPS',
  },
  '1080p60': {
    maxBitrate: 5_000_000,
    minBitrate: 2_200_000,
    initialBitrate: 3_250_000,
    maxFramerate: 60,
    targetWidth: 1920,
    targetHeight: 1080,
    degradationPreference: 'balanced',
    steadyContentHint: 'motion',
    label: '1080p • 60 FPS',
  },
};

export function applyTrackContentHint(
  track: MediaStreamTrack | null,
  hint: 'detail' | 'motion'
): void {
  if (!track) return;
  try {
    if ('contentHint' in track) {
      (track as any).contentHint = hint;
    } else {
      Object.defineProperty(track, 'contentHint', {
        value: hint,
        writable: true,
        configurable: true,
      });
    }
  } catch {}
}

export function buildDisplayVideoConstraints(preset: ScreenShareQualityPreset): MediaTrackConstraints {
  const cfg = SCREEN_QUALITY_CONFIGS[preset] || SCREEN_QUALITY_CONFIGS.auto;
  if (preset === 'auto') {
    return {
      cursor: 'always',
      width: { ideal: cfg.targetWidth, max: 1920 },
      height: { ideal: cfg.targetHeight, max: 1080 },
      frameRate: { ideal: cfg.maxFramerate, max: 30 },
    } as MediaTrackConstraints;
  }

  return {
    cursor: 'always',
    width: { ideal: cfg.targetWidth, max: cfg.targetWidth },
    height: { ideal: cfg.targetHeight, max: cfg.targetHeight },
    frameRate: { ideal: cfg.maxFramerate, max: cfg.maxFramerate },
  } as MediaTrackConstraints;
}

/** A supported picker preference, never an exact constraint or a privacy-indicator override. */
export function buildDisplayMediaVideoConstraints(
  preset: ScreenShareQualityPreset,
  fallback = false
): MediaTrackConstraints {
  return {
    ...(fallback
      ? { cursor: 'always', frameRate: { max: 30 } }
      : buildDisplayVideoConstraints(preset)),
    displaySurface: 'window',
  } as MediaTrackConstraints;
}

export class ScreenCaptureService {
  private nativeCaptureChain: Promise<void> = Promise.resolve();

  private enqueueNativeCapture<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.nativeCaptureChain.then(operation, operation);
    this.nativeCaptureChain = result.then(() => undefined, () => undefined);
    return result;
  }
  private stream: MediaStream | null = null;
  private isStarting = false;
  private isCapturing = false;
  private sourceLabel: string | null = null;
  private qualityPreset: ScreenShareQualityPreset = 'auto';
  private effectiveWidth: number | null = null;
  private effectiveHeight: number | null = null;
  private effectiveFrameRate: number | null = null;
  private displaySurface: string | null = null;
  private qualityFallbackNotice: string | null = null;
  private error: string | null = null;
  private sessionToken = 0;
  private listeners: Set<ScreenCaptureListener> = new Set();
  private boundTrackEndedHandler: (() => void) | null = null;
  private boundTrackWithListener: MediaStreamTrack | null = null;
  private windowUnloadHandler: (() => void) | null = null;

  constructor() {
    this.setupWindowListeners();
  }

  private setupWindowListeners(): void {
    if (typeof window !== 'undefined' && !this.windowUnloadHandler) {
      this.windowUnloadHandler = () => {
        this.stopCapture();
      };
      window.addEventListener('beforeunload', this.windowUnloadHandler);
    }
  }

  public getEncodingTargets(preset?: ScreenShareQualityPreset): ScreenEncodingTargets {
    const key = preset || this.qualityPreset || 'auto';
    return SCREEN_QUALITY_CONFIGS[key] || SCREEN_QUALITY_CONFIGS.auto;
  }

  public getQualityPreset(): ScreenShareQualityPreset {
    return this.qualityPreset;
  }

  private extractTrackSettings(track: MediaStreamTrack | null): void {
    if (!track || typeof track.getSettings !== 'function') {
      this.effectiveWidth = null;
      this.effectiveHeight = null;
      this.effectiveFrameRate = null;
      this.displaySurface = null;
      return;
    }

    try {
      const settings = track.getSettings() as MediaTrackSettings & { displaySurface?: string };
      this.effectiveWidth = typeof settings.width === 'number' && settings.width > 0 ? settings.width : null;
      this.effectiveHeight = typeof settings.height === 'number' && settings.height > 0 ? settings.height : null;
      this.effectiveFrameRate =
        typeof settings.frameRate === 'number' && settings.frameRate > 0
          ? Math.round(settings.frameRate)
          : null;
      this.displaySurface = normalizeDisplaySurface(settings.displaySurface);
    } catch {
      this.effectiveWidth = null;
      this.effectiveHeight = null;
      this.effectiveFrameRate = null;
      this.displaySurface = null;
    }
  }

  /**
   * Retorna o estado atual da captura de tela
   */
  public getState(): ScreenCaptureState {
    const track = this.stream?.getVideoTracks()[0] || null;
    if (track && this.isCapturing) {
      this.extractTrackSettings(track);
    }
    const targets = this.getEncodingTargets(this.qualityPreset);
    const source = getCaptureSourcePresentation(normalizeDisplaySurface(this.displaySurface));
    return {
      isCapturing: this.isCapturing,
      isStarting: this.isStarting,
      stream: this.stream,
      trackId: track ? track.id : null,
      sourceLabel: this.isCapturing ? source.label : null,
      qualityPreset: this.qualityPreset,
      requestedWidth: targets.targetWidth,
      requestedHeight: targets.targetHeight,
      requestedFrameRate: targets.maxFramerate,
      capturedWidth: this.effectiveWidth,
      capturedHeight: this.effectiveHeight,
      capturedFrameRate: this.effectiveFrameRate,
      effectiveWidth: this.effectiveWidth,
      effectiveHeight: this.effectiveHeight,
      effectiveFrameRate: this.effectiveFrameRate,
      displaySurface: this.displaySurface,
      captureNotice: this.isCapturing ? source.notice : null,
      qualityFallbackNotice: this.qualityFallbackNotice,
      error: this.error,
    };
  }

  /**
   * Registra um listener para mudanças de estado na captura
   */
  public addListener(listener: ScreenCaptureListener): () => void {
    this.listeners.add(listener);
    try {
      listener(this.getState());
    } catch (err) {
      console.error('[ScreenCaptureService] Erro ao notificar novo listener:', err);
    }
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Remove um listener registrado
   */
  public removeListener(listener: ScreenCaptureListener): void {
    this.listeners.delete(listener);
  }

  private notify(): void {
    const state = this.getState();
    for (const listener of this.listeners) {
      try {
        listener(state);
      } catch (err) {
        console.error('[ScreenCaptureService] Erro ao executar listener:', err);
      }
    }
  }

  /**
   * Altera a preferência de qualidade de captura. Se uma transmissão já estiver ativa,
   * aplica as novas restrições em tempo real com fallback automático caso o hardware rejeite.
   */
  public async setQualityPreset(
    preset: ScreenShareQualityPreset
  ): Promise<{ applied: boolean; didFallback: boolean; activePreset: ScreenShareQualityPreset }> {
    const validPreset: ScreenShareQualityPreset = SCREEN_QUALITY_CONFIGS[preset] ? preset : 'auto';
    this.qualityPreset = validPreset;
    this.qualityFallbackNotice = null;

    if (!this.isCapturing || !this.stream) {
      this.notify();
      return { applied: true, didFallback: false, activePreset: validPreset };
    }

    const track = this.stream.getVideoTracks()[0];
    if (!track || typeof track.applyConstraints !== 'function') {
      this.notify();
      return { applied: false, didFallback: false, activePreset: validPreset };
    }

    try {
      const targets = SCREEN_QUALITY_CONFIGS[validPreset];
      const constraints = buildDisplayVideoConstraints(validPreset);
      await track.applyConstraints(constraints);
      applyTrackContentHint(track, targets.steadyContentHint);
      this.extractTrackSettings(track);
      if (
        this.effectiveFrameRate !== null &&
        this.effectiveFrameRate < targets.maxFramerate - 5
      ) {
        this.qualityFallbackNotice = `A fonte capturada está operando a ${this.effectiveFrameRate} FPS (solicitado: ${targets.maxFramerate} FPS).`;
      }
      console.log(
        `[ScreenCaptureService] Qualidade de transmissão ajustada para ${validPreset} (efetivo: ${this.effectiveWidth || '?'}x${this.effectiveHeight || '?'} @ ${this.effectiveFrameRate || '?'}fps, contentHint=${targets.steadyContentHint})`
      );
      this.notify();
      return { applied: true, didFallback: false, activePreset: validPreset };
    } catch (err) {
      console.warn(
        `[ScreenCaptureService] Fonte não suportou restrições de ${validPreset}, aplicando fallback 720p30:`,
        err
      );
      try {
        await track.applyConstraints(buildDisplayVideoConstraints('720p30'));
        this.qualityPreset = '720p30';
        applyTrackContentHint(track, SCREEN_QUALITY_CONFIGS['720p30'].steadyContentHint);
        this.qualityFallbackNotice = `O perfil ${SCREEN_QUALITY_CONFIGS[validPreset].label} não foi suportado pela fonte; ajustado automaticamente para 720p • 30 FPS.`;
        this.extractTrackSettings(track);
        this.notify();
        return { applied: true, didFallback: true, activePreset: '720p30' };
      } catch {
        this.qualityFallbackNotice =
          'A fonte capturada mantém sua resolução nativa do sistema operacional.';
        this.extractTrackSettings(track);
        this.notify();
        return { applied: false, didFallback: true, activePreset: this.qualityPreset };
      }
    }
  }

  /**
   * Solicita e inicia a captura de tela ou janela.
   * Deve ser invocado exclusivamente após ação explícita do usuário (ex: clique de botão).
   */
  public async startCapture(requestedPreset?: ScreenShareQualityPreset): Promise<MediaStream | null> {
    if (requestedPreset && SCREEN_QUALITY_CONFIGS[requestedPreset]) {
      this.qualityPreset = requestedPreset;
    }

    // 1. Previne múltiplas tentativas simultâneas de captura
    if (this.isCapturing) {
      console.warn('[ScreenCaptureService] Captura já está em andamento.');
      return this.stream;
    }

    if (this.isStarting) {
      console.warn('[ScreenCaptureService] Uma solicitação de captura já está sendo processada.');
      return null;
    }

    // 2. Incrementa token de sessão para invalidar solicitações assíncronas concorrentes ou antigas
    this.sessionToken++;
    const currentToken = this.sessionToken;

    // 3. Verifica disponibilidade da API
    if (
      typeof navigator === 'undefined' ||
      !navigator.mediaDevices ||
      typeof navigator.mediaDevices.getDisplayMedia !== 'function'
    ) {
      const errorMsg = 'Captura de tela (getDisplayMedia) não suportada neste ambiente.';
      console.error(`[ScreenCaptureService] ${errorMsg}`);
      this.error = errorMsg;
      this.notify();
      return null;
    }

    this.isStarting = true;
    this.error = null;
    this.qualityFallbackNotice = null;
    this.notify();

    // 4. Sinaliza consentimento temporário na camada nativa Tauri 2 (DisplayCapture)
    await this.setNativeConsent(true);

    if (currentToken !== this.sessionToken) {
      await this.setNativeConsent(false);
      return null;
    }

    let acquiredStream: MediaStream | null = null;
    let usedFallback = false;

    try {
      // 5. Invoca o seletor nativo do Windows / WebView2 com as preferências de qualidade
      const videoConstraints = buildDisplayMediaVideoConstraints(this.qualityPreset);
      try {
        acquiredStream = await navigator.mediaDevices.getDisplayMedia({
          video: videoConstraints,
          audio: false,
        });
      } catch (firstErr: any) {
        // Não reabre após cancelamento, erro de acesso ou stop durante o seletor.
        if (currentToken !== this.sessionToken || !canRetryDisplayCapture(firstErr)) {
          throw firstErr;
        }
        // Se falhou por OverconstrainedError ou limitação do driver, tenta fallback 720p30 conservador
        console.warn('[ScreenCaptureService] Fallback de restrições em getDisplayMedia:', firstErr);
        usedFallback = true;
        acquiredStream = await navigator.mediaDevices.getDisplayMedia({
          video: buildDisplayMediaVideoConstraints(this.qualityPreset, true),
          audio: false,
        });
      }
    } catch (err: any) {
      if (currentToken !== this.sessionToken) {
        return null;
      }

      this.isStarting = false;
      const errorName = err?.name || '';
      const errorMessage = err?.message || '';

      if (errorName === 'NotAllowedError') {
        if (
          errorMessage.toLowerCase().includes('cancel') ||
          errorMessage.toLowerCase().includes('user denied')
        ) {
          this.error = 'Seleção de tela cancelada pelo usuário.';
        } else {
          this.error = 'Permissão de captura de tela negada.';
        }
      } else if (errorName === 'NotFoundError' || errorName === 'DevicesNotFoundError') {
        this.error = 'Nenhuma fonte de tela ou janela foi encontrada.';
      } else if (errorName === 'AbortError') {
        this.error = 'Operação de captura de tela foi abortada.';
      } else {
        this.error = errorMessage || 'Falha ao iniciar compartilhamento de tela.';
      }

      console.warn('[ScreenCaptureService] Falha ou cancelamento na captura:', this.error);
      this.notify();
      return null;
    } finally {
      // 6. Revoga imediatamente a autorização temporária nativa logo após a resolução do seletor
      await this.setNativeConsent(false);
    }

    // 7. Validação pós-resolução: se o estado mudou ou foi cancelado enquanto o diálogo estava aberto
    if (currentToken !== this.sessionToken || !acquiredStream) {
      console.log('[ScreenCaptureService] Captura cancelada durante a seleção.');
      if (acquiredStream) {
        this.stopAllTracks(acquiredStream);
      }
      this.isStarting = false;
      this.notify();
      return null;
    }

    const videoTracks = acquiredStream.getVideoTracks();
    if (videoTracks.length === 0) {
      console.error('[ScreenCaptureService] Nenhum track de vídeo recebido do seletor.');
      this.stopAllTracks(acquiredStream);
      this.isStarting = false;
      this.error = 'Nenhuma faixa de vídeo foi fornecida pela fonte selecionada.';
      this.notify();
      return null;
    }

    const videoTrack = videoTracks[0];
    applyTrackContentHint(
      videoTrack,
      SCREEN_QUALITY_CONFIGS[this.qualityPreset]?.steadyContentHint || 'detail'
    );

    // 8. Remove qualquer listener anterior e registra listener único para encerramento nativo
    this.detachTrackEndedListener();
    this.boundTrackEndedHandler = () => {
      console.log('[ScreenCaptureService] Faixa de vídeo encerrada pelo sistema/usuário nativo.');
      if (currentToken === this.sessionToken) {
        this.stopCapture();
      }
    };
    this.boundTrackWithListener = videoTrack;
    videoTrack.addEventListener('ended', this.boundTrackEndedHandler);

    // 9. Atualiza estado ativo e lê resolução/FPS efetivos
    this.stream = acquiredStream;
    this.isCapturing = true;
    this.isStarting = false;
    this.error = null;
    if (usedFallback) {
      this.qualityFallbackNotice =
        'Restrições ajustadas automaticamente para compatibilidade com a fonte selecionada.';
    }
    this.extractTrackSettings(videoTrack);
    this.sourceLabel = getCaptureSourcePresentation(normalizeDisplaySurface(this.displaySurface)).label;

    console.log(
      `[ScreenCaptureService] Captura ativa: "${this.sourceLabel}" (id: ${videoTrack.id}, preset: ${this.qualityPreset}, efetivo: ${this.effectiveWidth || '?'}x${this.effectiveHeight || '?'} @ ${this.effectiveFrameRate || '?'}fps)`
    );
    this.notify();
    return this.stream;
  }

  private detachTrackEndedListener(): void {
    if (this.boundTrackWithListener && this.boundTrackEndedHandler) {
      try {
        this.boundTrackWithListener.removeEventListener('ended', this.boundTrackEndedHandler);
      } catch {}
    }
    this.boundTrackWithListener = null;
    this.boundTrackEndedHandler = null;
  }

  /**
   * Encerra imediatamente a captura de tela ativa e libera todos os recursos
   */
  public stopCapture(): void {
    this.sessionToken++;
    this.isStarting = false;
    this.detachTrackEndedListener();

    if (this.stream) {
      const tracks = this.stream.getTracks();
      for (const track of tracks) {
        try {
          track.stop();
        } catch (err) {
          console.warn('[ScreenCaptureService] Erro ao parar faixa:', err);
        }
      }
      this.stream = null;
    }

    const wasCapturing = this.isCapturing;
    this.isCapturing = false;
    this.sourceLabel = null;
    this.effectiveWidth = null;
    this.effectiveHeight = null;
    this.effectiveFrameRate = null;
    this.displaySurface = null;
    this.qualityFallbackNotice = null;

    // Garante que o consentimento nativo fique revogado
    this.setNativeConsent(false).catch(() => {});

    if (wasCapturing || this.error) {
      console.log('[ScreenCaptureService] Captura de tela finalizada e faixas liberadas.');
      this.notify();
    }
  }

  /**
   * Limpa mensagem de erro manualmente
   */
  public clearError(): void {
    if (this.error || this.qualityFallbackNotice) {
      this.error = null;
      this.qualityFallbackNotice = null;
      this.notify();
    }
  }

  /**
   * Destrói o serviço, encerrando capturas ativas e removendo listeners
   */
  public destroy(): void {
    this.stopCapture();
    if (this.windowUnloadHandler && typeof window !== 'undefined') {
      window.removeEventListener('beforeunload', this.windowUnloadHandler);
      this.windowUnloadHandler = null;
    }
    this.listeners.clear();
  }

  private stopAllTracks(stream: MediaStream): void {
    try {
      const tracks = stream.getTracks();
      for (const track of tracks) {
        track.stop();
      }
    } catch {}
  }

  private async setNativeConsent(granted: boolean): Promise<void> {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('screen_set_capture_consent', { granted });
    } catch {
      // Ignora erro quando executado fora do runtime nativo Tauri (ex: testes de unidade / ambiente web)
    }
  }

  public isNativeCaptureSupported(): boolean {
    return isTauriWindowsEnvironment();
  }

  private previewVisibilityChain: Promise<unknown> = Promise.resolve();
  private previewGenerations = new Map<number, number>();
  public setNativePreviewVisible(sessionId: number, enabled: boolean): Promise<number> {
    const change = this.previewVisibilityChain.catch(() => {}).then(async () => {
      const { invoke } = await import('@tauri-apps/api/core');
      const generation = await invoke<number>('native_set_screen_preview_visibility', { sessionId, enabled });
      if (enabled) this.previewGenerations.set(sessionId, generation);
      else this.previewGenerations.delete(sessionId);
      return generation;
    });
    this.previewVisibilityChain = change;
    return change;
  }
  public async takeNativePreview(sessionId: number, profile = { width: 480, height: 270, fps: 15 }): Promise<ArrayBuffer> {
    const generation = this.previewGenerations.get(sessionId);
    if (!generation) return new ArrayBuffer(0);
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<ArrayBuffer>('native_take_screen_preview', { sessionId, generation, ...profile });
  }

  public async listNativeSources(): Promise<CaptureSources> {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<CaptureSources>('native_list_capture_sources');
  }

  public async startNativeShare(options: StartScreenShareOptions): Promise<NativeCaptureStatus> {
    return this.enqueueNativeCapture(async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<NativeCaptureStatus>('native_start_screen_share', { options: toNativeStartOptionsPayload(options) });
    });
  }

  public async stopNativeShare(): Promise<void> {
    return this.enqueueNativeCapture(async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('native_stop_screen_share');
    });
  }

  public async setNativeScreenQuality(preset: VoiceRoomQualityPreset): Promise<void> {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('native_set_screen_quality', { preset });
  }

  public async setNativeAdaptiveBitrate(bitrateBps: number): Promise<void> {
    const { invoke } = await import('@tauri-apps/api/core');
    const val = Math.max(200_000, Math.round(bitrateBps));
    await invoke('native_set_adaptive_bitrate', { bitrateBps: val });
  }

  public async setNativeBitrateExperiment(profile: string): Promise<number> {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<number>('native_set_screen_bitrate_experiment', {profile});
  }

  public async addNativeScreenPeer(
    peerId: string,
    iceServers?: RTCIceServer[]
  ): Promise<NativeScreenOfferEvent> {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<NativeScreenOfferEvent>('native_add_screen_peer', {
      peerId,
      ...(iceServers ? { iceServers: screenIceServers(iceServers) } : {}),
    });
  }

  public async removeNativeScreenPeer(peerId: string): Promise<void> {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('native_remove_screen_peer', { peerId });
  }

  public async handleNativeScreenAnswer(peerId: string, sdp: string, screenSessionId?: string): Promise<void> {
    try { assertScreenSdp(sdp); } catch (error) { await this.removeNativeScreenPeer(peerId).catch(() => {}); throw error; }
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('native_handle_screen_answer', { peerId, sdp, ...(screenSessionId ? { screenSessionId } : {}) });
  }

  public async handleNativeScreenIce(
    peerId: string,
    candidate: string,
    sdpMid?: string | null,
    sdpMlineIndex?: number | null,
    screenSessionId?: string
  ): Promise<void> {
    try { assertScreenCandidate(candidate); } catch (error) { await this.removeNativeScreenPeer(peerId).catch(() => {}); throw error; }
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('native_handle_screen_ice', {
      peerId,
      candidate,
      sdpMid: sdpMid ?? null,
      sdpMlineIndex: sdpMlineIndex ?? null,
      ...(screenSessionId ? { screenSessionId } : {}),
    });
  }

  public async subscribeNativeEvents(handlers: NativeScreenEventHandlers): Promise<() => void> {
    const { listen } = await import('@tauri-apps/api/event');
    const unlisteners: Array<() => void> = [];

    if (handlers.onOffer) {
      unlisteners.push(
        await listen<NativeScreenOfferEvent>('native-screen-offer', (ev) => handlers.onOffer?.(ev.payload))
      );
    }
    if (handlers.onIce) {
      unlisteners.push(
        await listen<NativeScreenIceEvent>('native-screen-ice', (ev) => handlers.onIce?.(ev.payload))
      );
    }
    if (handlers.onStats) {
      unlisteners.push(
        await listen<NativeScreenStatsEvent>('native-screen-stats', (ev) => handlers.onStats?.(ev.payload))
      );
    }
    if (handlers.onError) {
      unlisteners.push(
        await listen<NativeScreenErrorEvent>('native-screen-error', (ev) => handlers.onError?.(ev.payload))
      );
    }
    if (handlers.onEnded) {
      unlisteners.push(
        await listen<NativeScreenEndedEvent>('native-screen-ended', (ev) => handlers.onEnded?.(ev.payload))
      );
    }

    return () => {
      for (const unlisten of unlisteners) {
        try {
          unlisten();
        } catch {}
      }
    };
  }
}

// Instância singleton para uso em todo o aplicativo NEXUS
export const screenCaptureService = new ScreenCaptureService();
