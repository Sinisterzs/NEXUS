/**
 * NEXUS - Serviço de Atualizações Automáticas via GitHub Releases (Tauri 2 Updater)
 * Permite que o app verifique, baixe e instale atualizações assinadas sem intervenção manual do usuário.
 */

export interface UpdateInfo {
  version: string;
  currentVersion: string;
  body?: string;
  date?: string;
}

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'installing'
  | 'up_to_date'
  | 'error';

type UpdateListener = (state: UpdateState) => void;

export interface UpdateState {
  status: UpdateStatus;
  updateInfo: UpdateInfo | null;
  downloadProgress: number; // 0 - 100
  downloadedBytes: number;
  totalBytes: number;
  errorMessage: string | null;
}

class UpdateService {
  private activeUpdate: any = null;
  private listeners: UpdateListener[] = [];
  private state: UpdateState = {
    status: 'idle',
    updateInfo: null,
    downloadProgress: 0,
    downloadedBytes: 0,
    totalBytes: 0,
    errorMessage: null,
  };

  getState(): UpdateState {
    return this.state;
  }

  addListener(listener: UpdateListener): () => void {
    this.listeners.push(listener);
    listener(this.state);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  private setState(partial: Partial<UpdateState>) {
    this.state = { ...this.state, ...partial };
    this.listeners.forEach((listener) => {
      try {
        listener(this.state);
      } catch (err) {
        console.warn('[UpdateService] Erro no listener:', err);
      }
    });
  }

  /**
   * Verifica se há atualizações disponíveis no GitHub Releases
   * @param silent Se true, não exibe erro nem status 'up_to_date' para o usuário (usado no arranque)
   */
  async checkForUpdates(silent = false): Promise<UpdateInfo | null> {
    if (this.state.status === 'downloading' || this.state.status === 'installing') {
      return this.state.updateInfo;
    }

    this.setState({
      status: 'checking',
      errorMessage: null,
      downloadProgress: 0,
    });

    try {
      // Dynamic import to support development in browser without crashing
      const { check } = await import('@tauri-apps/plugin-updater');
      const update = await check();

      if (update) {
        this.activeUpdate = update;
        const info: UpdateInfo = {
          version: update.version,
          currentVersion: update.currentVersion,
          body: update.body || 'Atualizações e melhorias de estabilidade.',
          date: update.date,
        };

        console.log(`[UpdateService] Nova versão encontrada: v${update.version} (Atual: v${update.currentVersion})`);
        this.setState({
          status: 'available',
          updateInfo: info,
          errorMessage: null,
        });
        return info;
      } else {
        console.log('[UpdateService] NEXUS já está na versão mais recente.');
        this.activeUpdate = null;
        this.setState({
          status: silent ? 'idle' : 'up_to_date',
          updateInfo: null,
          errorMessage: null,
        });
        return null;
      }
    } catch (err: any) {
      console.warn('[UpdateService] Falha ao verificar atualizações no GitHub:', err);
      this.activeUpdate = null;
      this.setState({
        status: silent ? 'idle' : 'error',
        errorMessage: err?.message || 'Não foi possível consultar os servidores do GitHub Releases.',
      });
      return null;
    }
  }

  /**
   * Baixa a atualização em segundo plano e instala.
   * No Windows, reinicia o aplicativo automaticamente após a substituição.
   */
  async downloadAndInstall(): Promise<void> {
    if (!this.activeUpdate) {
      const info = await this.checkForUpdates(false);
      if (!info || !this.activeUpdate) {
        throw new Error('Nenhuma atualização disponível no momento.');
      }
    }

    this.setState({
      status: 'downloading',
      downloadProgress: 0,
      downloadedBytes: 0,
      totalBytes: 0,
      errorMessage: null,
    });

    try {
      let downloaded = 0;
      let total = 0;

      await this.activeUpdate.downloadAndInstall((event: any) => {
        if (event.event === 'Started') {
          total = event.data?.contentLength || 0;
          this.setState({
            totalBytes: total,
            downloadProgress: 0,
          });
          console.log(`[UpdateService] Download iniciado. Tamanho total: ${total} bytes`);
        } else if (event.event === 'Progress') {
          downloaded += event.data?.chunkLength || 0;
          const percent = total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : 0;
          this.setState({
            downloadedBytes: downloaded,
            downloadProgress: percent,
          });
        } else if (event.event === 'Finished') {
          console.log('[UpdateService] Download concluído com sucesso. Aplicando instalador...');
          this.setState({
            status: 'installing',
            downloadProgress: 100,
          });
        }
      });

      // No Windows, downloadAndInstall fecha e reinicia o aplicativo após executar o instalador
      console.log('[UpdateService] Atualização aplicada. Reiniciando aplicativo...');
    } catch (err: any) {
      console.error('[UpdateService] Falha ao baixar ou aplicar atualização:', err);
      this.setState({
        status: 'error',
        errorMessage: err?.message || 'Falha ao baixar os pacotes da nova versão.',
      });
      throw err;
    }
  }

  /**
   * Dispensa a notificação atual
   */
  dismissUpdate(): void {
    this.setState({
      status: 'idle',
      errorMessage: null,
    });
  }
}

export const updateService = new UpdateService();
