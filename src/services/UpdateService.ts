/**
 * NEXUS - Serviço de Atualizações Automáticas via GitHub Releases (Tauri 2 Updater)
 * Permite que o app verifique, baixe e instale atualizações assinadas sem intervenção manual do usuário,
 * com suporte a canais dinâmicos (Stable e Beta / Nightly).
 */

export type UpdateChannel = 'stable' | 'beta';

export interface UpdateInfo {
  version: string;
  currentVersion: string;
  body?: string;
  date?: string;
  channel?: UpdateChannel;
  isDowngradeNotice?: boolean;
  latestRemoteVersion?: string;
  endpointUsed?: string;
}

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'installing'
  | 'up_to_date'
  | 'downgrade_notice'
  | 'error';

type UpdateListener = (state: UpdateState) => void;

export interface UpdateState {
  status: UpdateStatus;
  channel: UpdateChannel;
  updateInfo: UpdateInfo | null;
  downloadProgress: number; // 0 - 100
  downloadedBytes: number;
  totalBytes: number;
  errorMessage: string | null;
  downgradeNoticeMessage: string | null;
}

class UpdateService {
  private activeUpdate: any = null;
  private listeners: UpdateListener[] = [];
  private state: UpdateState = {
    status: 'idle',
    channel: 'stable',
    updateInfo: null,
    downloadProgress: 0,
    downloadedBytes: 0,
    totalBytes: 0,
    errorMessage: null,
    downgradeNoticeMessage: null,
  };

  getState(): UpdateState {
    return this.state;
  }

  setChannel(channel: UpdateChannel) {
    this.setState({ channel });
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
   * Verifica se há atualizações disponíveis no GitHub Releases para o canal especificado
   * @param silent Se true, não exibe erro nem status 'up_to_date' para o usuário (usado no arranque)
   * @param requestedChannel Canal a verificar ('stable' | 'beta')
   */
  async checkForUpdates(silent = false, requestedChannel?: UpdateChannel): Promise<UpdateInfo | null> {
    if (this.state.status === 'downloading' || this.state.status === 'installing') {
      return this.state.updateInfo;
    }

    const channel = requestedChannel || this.state.channel || 'stable';

    this.setState({
      status: 'checking',
      channel,
      errorMessage: null,
      downgradeNoticeMessage: null,
      downloadProgress: 0,
    });

    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const res = await invoke<any>('updater_check_channel', { channel });

      if (res && res.updateAvailable && res.rid != null) {
        const { Update } = await import('@tauri-apps/plugin-updater');
        const update = new Update(res);
        this.activeUpdate = update;

        const info: UpdateInfo = {
          version: res.version,
          currentVersion: res.currentVersion,
          body: res.body || 'Atualizações e melhorias de estabilidade.',
          date: res.date,
          channel,
          endpointUsed: res.endpointUsed,
          isDowngradeNotice: false,
        };

        console.log(
          `[UpdateService] Nova versão encontrada (${channel}): v${res.version} (Atual: v${res.currentVersion})`
        );
        this.setState({
          status: 'available',
          updateInfo: info,
          errorMessage: null,
          downgradeNoticeMessage: null,
        });
        return info;
      } else if (res && res.isCurrentHigher) {
        // Usuário está em uma versão Nightly/Beta, mas selecionou o canal Stable (sem downgrade automático)
        const remoteVer = res.latestRemoteVersion || 'estável';
        const msg = `Você está usando uma versão experimental (v${res.currentVersion}). A versão estável mais recente é a v${remoteVer}. Não haverá downgrade automático; novas atualizações estáveis serão oferecidas quando uma versão superior for lançada.`;
        console.log(`[UpdateService] Notificação de versão superior (${channel}): ${msg}`);
        this.activeUpdate = null;
        this.setState({
          status: 'downgrade_notice',
          updateInfo: {
            version: remoteVer,
            currentVersion: res.currentVersion,
            channel,
            isDowngradeNotice: true,
            latestRemoteVersion: remoteVer,
            endpointUsed: res.endpointUsed,
          },
          errorMessage: null,
          downgradeNoticeMessage: msg,
        });
        return null;
      } else {
        console.log(`[UpdateService] NEXUS já está na versão mais recente no canal ${channel}.`);
        this.activeUpdate = null;
        this.setState({
          status: silent ? 'idle' : 'up_to_date',
          updateInfo: null,
          errorMessage: null,
          downgradeNoticeMessage: null,
        });
        return null;
      }
    } catch (err: any) {
      console.warn(`[UpdateService] Falha ao verificar atualizações no canal ${channel}:`, err);
      this.activeUpdate = null;
      this.setState({
        status: silent ? 'idle' : 'error',
        errorMessage:
          err?.message ||
          (typeof err === 'string' ? err : 'Não foi possível consultar os servidores do GitHub Releases.'),
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
      const msg =
        typeof err === 'string'
          ? err
          : err?.message || (err ? JSON.stringify(err) : 'Falha ao baixar os pacotes da nova versão.');
      this.setState({
        status: 'error',
        errorMessage: msg,
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
