/**
 * NEXUS - Pre-login Auto Updater Service
 * Gerencia a verificação, download e instalação de atualizações ANTES do fluxo de autenticação e sessão.
 * Suporta canais 'stable' (automático com progresso) e 'beta' (com changelog e confirmação),
 * sem bloquear a inicialização offline do app.
 */

import { APP_VERSION, isPrereleaseVersion } from '../version.ts';

export type PreloginStartupState =
  | 'starting'
  | 'checking'
  | 'update_found'
  | 'downloading'
  | 'installing'
  | 'restarting'
  | 'up_to_date'
  | 'connection_error'
  | 'install_error';

export interface PreloginUpdateInfo {
  version: string;
  currentVersion: string;
  changelog?: string;
  date?: string;
  channel: 'stable' | 'beta';
  rid?: number;
  rawJson?: any;
}

export interface PreloginCheckResult {
  updateAvailable: boolean;
  version?: string;
  currentVersion: string;
  date?: string;
  body?: string;
  rawJson?: any;
  channel: 'stable' | 'beta';
  latestRemoteVersion?: string;
  isCurrentHigher?: boolean;
  rid?: number;
  errorMessage?: string;
}

export interface PreloginProgressEvent {
  downloadedBytes: number;
  totalBytes: number;
  percent: number;
  stage: 'downloading' | 'installing' | 'finished';
}

export interface PreloginUpdaterState {
  status: PreloginStartupState;
  channel: 'stable' | 'beta';
  currentVersion: string;
  updateInfo: PreloginUpdateInfo | null;
  downloadProgress: number; // 0 - 100
  downloadedBytes: number;
  totalBytes: number;
  errorMessage: string | null;
}

export type PreloginStateListener = (state: PreloginUpdaterState) => void;

export interface PreloginUpdaterBackend {
  checkPrelogin(channel: 'stable' | 'beta'): Promise<PreloginCheckResult>;
  downloadAndInstall(
    updateResult: PreloginCheckResult,
    onProgress: (evt: PreloginProgressEvent) => void
  ): Promise<void>;
  restart(): Promise<void>;
}

export interface PreloginProgressPayload {
  status?: 'started' | 'progress' | 'finished';
  chunkLength?: number;
  downloaded?: number;
  total?: number;
  downloadedBytes?: number;
  totalBytes?: number;
  percent?: number;
  stage?: 'downloading' | 'installing' | 'finished';
}

/**
 * Backend padrão baseado em Tauri IPC e @tauri-apps/plugin-updater
 */
export class TauriPreloginUpdaterBackend implements PreloginUpdaterBackend {
  private activeUpdateInstance: any = null;

  async checkPrelogin(channel: 'stable' | 'beta'): Promise<PreloginCheckResult> {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      let result: any = null;

      try {
        result = await invoke('updater_check_prelogin', { channel });
      } catch (err: any) {
        const msg = String(err?.message || err);
        // Fallback para updater_check_channel caso updater_check_prelogin não esteja registrado
        if (msg.includes('not found') || msg.includes('desconhecido') || msg.includes('unknown')) {
          result = await invoke('updater_check_channel', { channel });
        } else {
          throw err;
        }
      }

      if (result && result.updateAvailable && result.rid != null) {
        try {
          const { Update } = await import('@tauri-apps/plugin-updater');
          this.activeUpdateInstance = new Update(result);
        } catch {
          // Em ambientes sem plugin nativo, mantém referência mútua
        }
      }

      return {
        updateAvailable: Boolean(result?.updateAvailable),
        version: result?.version || result?.latestRemoteVersion,
        currentVersion: result?.currentVersion || APP_VERSION,
        date: result?.date,
        body: result?.body,
        rawJson: result?.rawJson,
        channel: (result?.channel as 'stable' | 'beta') || channel,
        latestRemoteVersion: result?.latestRemoteVersion,
        isCurrentHigher: Boolean(result?.isCurrentHigher),
        rid: result?.rid,
      };
    } catch (err: any) {
      console.warn('[TauriPreloginUpdaterBackend] Falha na checagem:', err);
      throw err;
    }
  }

  async downloadAndInstall(
    updateResult: PreloginCheckResult,
    onProgress: (evt: PreloginProgressEvent) => void
  ): Promise<void> {
    const { invoke } = await import('@tauri-apps/api/core');

    // 1. Tenta comando IPC dedicado updater_download_and_install_prelogin implementado pelo backend
    try {
      const unlisteners: (() => void)[] = [];
      try {
        const { listen } = await import('@tauri-apps/api/event');
        const handleEvent = (event: { payload: PreloginProgressPayload }) => {
          const p = event.payload || {};
          const total = p.totalBytes ?? p.total ?? 0;
          const downloaded = p.downloadedBytes ?? p.downloaded ?? 0;
          let percent = p.percent;
          if (percent == null && total > 0) {
            percent = Math.min(100, Math.round((downloaded / total) * 100));
          }

          const stage =
            p.status === 'finished' || p.stage === 'finished' || p.stage === 'installing'
              ? 'installing'
              : 'downloading';

          onProgress({
            downloadedBytes: downloaded,
            totalBytes: total,
            percent: percent ?? 0,
            stage,
          });
        };

        const u1 = await listen<PreloginProgressPayload>('updater-progress', handleEvent);
        const u2 = await listen<PreloginProgressPayload>('updater://progress', handleEvent);
        unlisteners.push(u1, u2);
      } catch {}

      let success = false;
      try {
        await invoke('updater_download_and_install_prelogin', {
          channel: updateResult.channel,
        });
        success = true;
      } catch (err: any) {
        const msg = String(err?.message || err);
        if (!msg.includes('not found') && !msg.includes('desconhecido')) {
          unlisteners.forEach((u) => u());
          throw err;
        }
      }

      unlisteners.forEach((u) => u());
      if (success) {
        return;
      }
    } catch (err: any) {
      const msg = String(err?.message || err);
      if (!msg.includes('not found') && !msg.includes('desconhecido')) {
        throw err;
      }
    }

    // 2. Fallback para Update.downloadAndInstall do @tauri-apps/plugin-updater
    if (this.activeUpdateInstance) {
      let downloaded = 0;
      let total = 0;

      await this.activeUpdateInstance.downloadAndInstall((event: any) => {
        if (event.event === 'Started') {
          total = event.data?.contentLength || 0;
          onProgress({
            downloadedBytes: 0,
            totalBytes: total,
            percent: 0,
            stage: 'downloading',
          });
        } else if (event.event === 'Progress') {
          downloaded += event.data?.chunkLength || 0;
          const percent = total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : 0;
          onProgress({
            downloadedBytes: downloaded,
            totalBytes: total,
            percent,
            stage: 'downloading',
          });
        } else if (event.event === 'Finished') {
          onProgress({
            downloadedBytes: total || downloaded,
            totalBytes: total || downloaded,
            percent: 100,
            stage: 'installing',
          });
        }
      });
      return;
    }

    throw new Error('Nenhuma instância de atualização disponível para instalação.');
  }

  async restart(): Promise<void> {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('updater_restart');
    } catch (err) {
      console.log('[TauriPreloginUpdaterBackend] Reinicialização via IPC:', err);
    }
  }
}

export class PreloginUpdaterService {
  private backend: PreloginUpdaterBackend;
  private listeners: PreloginStateListener[] = [];
  private activeCheckResult: PreloginCheckResult | null = null;
  private isBusy = false;

  private state: PreloginUpdaterState = {
    status: 'starting',
    channel: isPrereleaseVersion(APP_VERSION) ? 'beta' : 'stable',
    currentVersion: APP_VERSION,
    updateInfo: null,
    downloadProgress: 0,
    downloadedBytes: 0,
    totalBytes: 0,
    errorMessage: null,
  };

  constructor(backend?: PreloginUpdaterBackend) {
    this.backend = backend || new TauriPreloginUpdaterBackend();
  }

  setBackend(backend: PreloginUpdaterBackend) {
    this.backend = backend;
  }

  getState(): PreloginUpdaterState {
    return { ...this.state };
  }

  addListener(listener: PreloginStateListener): () => void {
    this.listeners.push(listener);
    listener(this.getState());
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  private setState(partial: Partial<PreloginUpdaterState>) {
    this.state = { ...this.state, ...partial };
    const current = this.getState();
    this.listeners.forEach((fn) => {
      try {
        fn(current);
      } catch (err) {
        console.warn('[PreloginUpdaterService] Listener error:', err);
      }
    });
  }

  /**
   * Executa a sequência pré-login de checagem.
   * Passo 1: Carrega canal de preferência.
   * Passo 2: Consulta servidor de updates (GitHub Releases / manifesto do canal).
   * Passo 3: Se Stable e update disponível -> inicia download automaticamente.
   *          Se Nightly/Beta e update disponível -> exibe 'update_found' com changelog para confirmação.
   *          Se sem update -> 'up_to_date'.
   *          Se offline/erro de rede -> 'connection_error' não-bloqueante.
   */
  async runStartupSequence(options?: {
    channelOverride?: 'stable' | 'beta';
    onProceed?: () => void;
  }): Promise<void> {
    if (this.isBusy) {
      return;
    }
    this.isBusy = true;

    try {
      this.setState({
        status: 'starting',
        errorMessage: null,
        downloadProgress: 0,
      });

      // Identifica canal configurado
      let channel: 'stable' | 'beta' = options?.channelOverride || this.state.channel;
      if (!options?.channelOverride) {
        try {
          const { settingsRepository } = await import('../repositories/SettingsRepository.ts');
          const persisted = await settingsRepository.getUpdateChannel();
          if (persisted === 'beta' || persisted === 'stable') {
            channel = persisted;
          }
        } catch {
          if (typeof window !== 'undefined' && window.localStorage) {
            const local = window.localStorage.getItem('nexus_app_update_channel');
            if (local === 'beta' || local === 'stable') {
              channel = local;
            }
          }
        }
      }

      this.setState({
        status: 'checking',
        channel,
      });

      let checkResult: PreloginCheckResult;
      try {
        checkResult = await this.backend.checkPrelogin(channel);
      } catch (networkErr: any) {
        console.warn('[PreloginUpdaterService] Checagem offline ou indisponível:', networkErr);
        this.setState({
          status: 'connection_error',
          errorMessage:
            networkErr?.message ||
            (typeof networkErr === 'string' ? networkErr : 'Não foi possível verificar atualizações.'),
        });
        this.isBusy = false;
        return;
      }

      this.activeCheckResult = checkResult;

      if (!checkResult.updateAvailable || !checkResult.version) {
        this.setState({
          status: 'up_to_date',
          errorMessage: null,
        });
        this.isBusy = false;
        if (options?.onProceed) {
          options.onProceed();
        }
        return;
      }

      const updateInfo: PreloginUpdateInfo = {
        version: checkResult.version,
        currentVersion: checkResult.currentVersion || APP_VERSION,
        changelog: checkResult.body || 'Melhorias de desempenho, estabilidade e correções de segurança.',
        date: checkResult.date,
        channel,
        rid: checkResult.rid,
        rawJson: checkResult.rawJson,
      };

      if (channel === 'stable') {
        // Passo 2: No canal Stable baixa automaticamente com progresso e reinicia
        this.setState({
          status: 'downloading',
          updateInfo,
          downloadProgress: 0,
        });
        this.isBusy = false;
        await this.startDownloadAndInstall(checkResult, options?.onProceed);
      } else {
        // Passo 3: No canal Nightly/Beta exibe confirmação com changelog
        this.setState({
          status: 'update_found',
          updateInfo,
        });
        this.isBusy = false;
      }
    } catch (err: any) {
      this.setState({
        status: 'connection_error',
        errorMessage: err?.message || 'Falha na inicialização do atualizador.',
      });
      this.isBusy = false;
    }
  }

  /**
   * Confirma a atualização no canal Beta/Nightly ou retenta instalação
   */
  async confirmUpdate(onProceed?: () => void): Promise<void> {
    if (!this.activeCheckResult || !this.activeCheckResult.updateAvailable) {
      return;
    }
    await this.startDownloadAndInstall(this.activeCheckResult, onProceed);
  }

  /**
   * Baixa os arquivos com progresso em tempo real e aplica a instalação
   */
  private async startDownloadAndInstall(
    checkResult: PreloginCheckResult,
    _onProceed?: () => void
  ): Promise<void> {
    this.setState({
      status: 'downloading',
      downloadProgress: 0,
      downloadedBytes: 0,
      totalBytes: 0,
      errorMessage: null,
    });

    try {
      await this.backend.downloadAndInstall(checkResult, (progress) => {
        if (progress.stage === 'downloading') {
          this.setState({
            status: 'downloading',
            downloadProgress: progress.percent,
            downloadedBytes: progress.downloadedBytes,
            totalBytes: progress.totalBytes,
          });
        } else if (progress.stage === 'installing' || progress.stage === 'finished') {
          this.setState({
            status: 'installing',
            downloadProgress: 100,
          });
        }
      });

      this.setState({
        status: 'restarting',
        downloadProgress: 100,
      });

      // Aciona reinício seguro
      await this.backend.restart();
    } catch (installErr: any) {
      console.error('[PreloginUpdaterService] Erro ao instalar atualização:', installErr);
      this.setState({
        status: 'install_error',
        errorMessage:
          installErr?.message ||
          (typeof installErr === 'string' ? installErr : 'Falha ao baixar ou aplicar os arquivos da atualização.'),
      });
    }
  }

  /**
   * Permite ao usuário pular a atualização (Nightly "Lembrar mais tarde" ou offline)
   */
  skipUpdate(onProceed?: () => void): void {
    if (onProceed) {
      onProceed();
    }
  }

  /**
   * Tenta novamente a checagem ou instalação
   */
  async retry(onProceed?: () => void): Promise<void> {
    if (this.state.status === 'install_error' && this.activeCheckResult?.updateAvailable) {
      await this.startDownloadAndInstall(this.activeCheckResult, onProceed);
    } else {
      await this.runStartupSequence({ onProceed });
    }
  }
}

export const preloginUpdaterService = new PreloginUpdaterService();
