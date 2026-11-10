/**
 * NEXUS - Screen Capture Service 2.0 (Calls & Streaming 2.0)
 *
 * Gerencia a captura de monitores ou janelas de aplicativos utilizando a API
 * navigator.mediaDevices.getDisplayMedia() com consentimento restrito via Tauri 2 IPC,
 * presets de qualidade (Auto, 720p30, 1080p30, 1080p60), fallback automático resiliente
 * e ciclo de vida estrito contra tracks órfãs.
 */

import type { ScreenShareQualityPreset } from '../lib/types';

export interface ScreenEncodingTargets {
  maxBitrate: number;
  maxFramerate: number;
  targetWidth: number;
  targetHeight: number;
  label: string;
}

export interface ScreenCaptureState {
  isCapturing: boolean;
  isStarting: boolean;
  stream: MediaStream | null;
  trackId: string | null;
  sourceLabel: string | null;
  qualityPreset: ScreenShareQualityPreset;
  effectiveWidth: number | null;
  effectiveHeight: number | null;
  effectiveFrameRate: number | null;
  displaySurface: string | null;
  qualityFallbackNotice: string | null;
  error: string | null;
}

export type ScreenCaptureListener = (state: ScreenCaptureState) => void;

export const SCREEN_QUALITY_CONFIGS: Record<ScreenShareQualityPreset, ScreenEncodingTargets> = {
  auto: {
    maxBitrate: 3_000_000,
    maxFramerate: 30,
    targetWidth: 1920,
    targetHeight: 1080,
    label: 'Automático (Adaptativo)',
  },
  '720p30': {
    maxBitrate: 2_200_000,
    maxFramerate: 30,
    targetWidth: 1280,
    targetHeight: 720,
    label: '720p • 30 FPS',
  },
  '1080p30': {
    maxBitrate: 3_500_000,
    maxFramerate: 30,
    targetWidth: 1920,
    targetHeight: 1080,
    label: '1080p • 30 FPS',
  },
  '1080p60': {
    maxBitrate: 5_000_000,
    maxFramerate: 60,
    targetWidth: 1920,
    targetHeight: 1080,
    label: '1080p • 60 FPS',
  },
};

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

export class ScreenCaptureService {
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
      this.displaySurface = typeof settings.displaySurface === 'string' ? settings.displaySurface : null;
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
    return {
      isCapturing: this.isCapturing,
      isStarting: this.isStarting,
      stream: this.stream,
      trackId: track ? track.id : null,
      sourceLabel: this.sourceLabel,
      qualityPreset: this.qualityPreset,
      effectiveWidth: this.effectiveWidth,
      effectiveHeight: this.effectiveHeight,
      effectiveFrameRate: this.effectiveFrameRate,
      displaySurface: this.displaySurface,
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
      const constraints = buildDisplayVideoConstraints(validPreset);
      await track.applyConstraints(constraints);
      this.extractTrackSettings(track);
      console.log(
        `[ScreenCaptureService] Qualidade de transmissão ajustada para ${validPreset} (efetivo: ${this.effectiveWidth || '?'}x${this.effectiveHeight || '?'} @ ${this.effectiveFrameRate || '?'}fps)`
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
      const videoConstraints = buildDisplayVideoConstraints(this.qualityPreset);
      try {
        acquiredStream = await navigator.mediaDevices.getDisplayMedia({
          video: videoConstraints,
          audio: false,
        });
      } catch (firstErr: any) {
        const errName = firstErr?.name || '';
        // Se foi recusa/cancelamento do usuário, não tenta reabrir o seletor!
        if (errName === 'NotAllowedError' || errName === 'AbortError' || errName === 'NotFoundError') {
          throw firstErr;
        }
        // Se falhou por OverconstrainedError ou limitação do driver, tenta fallback 720p30 conservador
        console.warn('[ScreenCaptureService] Fallback de restrições em getDisplayMedia:', firstErr);
        usedFallback = true;
        acquiredStream = await navigator.mediaDevices.getDisplayMedia({
          video: {
            cursor: 'always',
            frameRate: { max: 30 },
          } as MediaTrackConstraints,
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
    try {
      if ('contentHint' in videoTrack) {
        (videoTrack as any).contentHint = this.qualityPreset === '1080p60' ? 'motion' : 'detail';
      }
    } catch {}

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
    this.sourceLabel = videoTrack.label || 'Tela / Janela';
    this.isCapturing = true;
    this.isStarting = false;
    this.error = null;
    if (usedFallback) {
      this.qualityFallbackNotice =
        'Restrições ajustadas automaticamente para compatibilidade com a fonte selecionada.';
    }
    this.extractTrackSettings(videoTrack);

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
}

// Instância singleton para uso em todo o aplicativo NEXUS
export const screenCaptureService = new ScreenCaptureService();
