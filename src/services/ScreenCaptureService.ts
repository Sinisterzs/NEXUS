/**
 * NEXUS - Phase 3.0: Screen Capture Service (Local Preview Only)
 *
 * Gerencia a captura local de monitores ou janelas de aplicativos utilizando a API
 * navigator.mediaDevices.getDisplayMedia() com consentimento restrito via Tauri 2 IPC.
 *
 * Princípios de Segurança e Escopo:
 * 1. Somente captura local para prévia: Nenhum frame ou pacote de vídeo é transmitido pela rede.
 * 2. Consentimento temporário: A permissão DisplayCapture no WebView2 é autorizada apenas
 *    durante a abertura do seletor nativo e revogada imediatamente ao concluir ou cancelar.
 * 3. Ciclo de vida estrito: Interrupção automática ao encerrar faixa (onended), ao fechar janela,
 *    ao efetuar logout ou ao encerrar chamada.
 * 4. Isolamento de áudio: Não afeta ou interrompe as faixas de microfone do WebRtcService.
 * 5. Sem persistência: Nenhuma imagem ou frame é salvo em disco ou banco de dados.
 */

export interface ScreenCaptureState {
  isCapturing: boolean;
  isStarting: boolean;
  stream: MediaStream | null;
  trackId: string | null;
  sourceLabel: string | null;
  error: string | null;
}

export type ScreenCaptureListener = (state: ScreenCaptureState) => void;

export class ScreenCaptureService {
  private stream: MediaStream | null = null;
  private isStarting = false;
  private isCapturing = false;
  private sourceLabel: string | null = null;
  private error: string | null = null;
  private sessionToken = 0;
  private listeners: Set<ScreenCaptureListener> = new Set();
  private boundTrackEndedHandler: (() => void) | null = null;
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

  /**
   * Retorna o estado atual da captura de tela
   */
  public getState(): ScreenCaptureState {
    const track = this.stream?.getVideoTracks()[0] || null;
    return {
      isCapturing: this.isCapturing,
      isStarting: this.isStarting,
      stream: this.stream,
      trackId: track ? track.id : null,
      sourceLabel: this.sourceLabel,
      error: this.error,
    };
  }

  /**
   * Registra um listener para mudanças de estado na captura
   */
  public addListener(listener: ScreenCaptureListener): () => void {
    this.listeners.add(listener);
    // Notifica imediatamente com o estado atual
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
   * Solicita e inicia a captura de tela ou janela.
   * Deve ser invocado exclusivamente após ação explícita do usuário (ex: clique de botão).
   */
  public async startCapture(): Promise<MediaStream | null> {
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
    this.notify();

    // 4. Sinaliza consentimento temporário na camada nativa Tauri 2 (DisplayCapture)
    await this.setNativeConsent(true);

    // Se o usuário cancelou durante a preparação assíncrona
    if (currentToken !== this.sessionToken) {
      await this.setNativeConsent(false);
      return null;
    }

    let acquiredStream: MediaStream | null = null;

    try {
      // 5. Invoca o seletor nativo do Windows / WebView2
      // Vídeo estrito a 30fps máximo, cursor visível, sem captura de áudio (Phase 3.0)
      acquiredStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          cursor: 'always',
          frameRate: { max: 30 },
        } as MediaTrackConstraints,
        audio: false,
      });
    } catch (err: any) {
      // Trata cancelamento pelo usuário vs permissão negada
      if (currentToken !== this.sessionToken) {
        // Solicitação obsoleta
        return null;
      }

      this.isStarting = false;
      const errorName = err?.name || '';
      const errorMessage = err?.message || '';

      if (errorName === 'NotAllowedError') {
        if (errorMessage.toLowerCase().includes('cancel') || errorMessage.toLowerCase().includes('user denied')) {
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

    // 8. Registra listener para encerramento nativo pelo sistema operacional ou pelo botão nativo do Windows
    this.boundTrackEndedHandler = () => {
      console.log('[ScreenCaptureService] Faixa de vídeo encerrada pelo sistema/usuário nativo.');
      if (currentToken === this.sessionToken) {
        this.stopCapture();
      }
    };
    videoTrack.addEventListener('ended', this.boundTrackEndedHandler);

    // 9. Atualiza estado ativo
    this.stream = acquiredStream;
    this.sourceLabel = videoTrack.label || 'Tela / Janela';
    this.isCapturing = true;
    this.isStarting = false;
    this.error = null;

    console.log(`[ScreenCaptureService] Captura de tela ativa: "${this.sourceLabel}" (id: ${videoTrack.id})`);
    this.notify();
    return this.stream;
  }

  /**
   * Encerra imediatamente a captura de tela ativa e libera todos os recursos
   */
  public stopCapture(): void {
    this.sessionToken++;
    this.isStarting = false;

    if (this.stream) {
      const tracks = this.stream.getTracks();
      for (const track of tracks) {
        if (this.boundTrackEndedHandler) {
          track.removeEventListener('ended', this.boundTrackEndedHandler);
        }
        try {
          track.stop();
        } catch (err) {
          console.warn('[ScreenCaptureService] Erro ao parar faixa:', err);
        }
      }
      this.stream = null;
    }

    this.boundTrackEndedHandler = null;
    const wasCapturing = this.isCapturing;
    this.isCapturing = false;
    this.sourceLabel = null;

    // Garante que o consentimento nativo fique revogado
    this.setNativeConsent(false).catch(() => {});

    if (wasCapturing || this.error) {
      console.log('[ScreenCaptureService] Captura de tela finalizada e faixas liberadas.');
      this.notify();
    }
  }

  /**
   * Limpa mensagem de erro manualmente (ex: dismiss de toast ou fechamento de alerta)
   */
  public clearError(): void {
    if (this.error) {
      this.error = null;
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
