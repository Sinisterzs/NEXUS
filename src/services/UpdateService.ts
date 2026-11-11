/**
 * NEXUS - Serviço de Atualizações Automáticas via GitHub Releases (Tauri 2 Updater)
 * Permite que o app verifique, baixe e instale atualizações assinadas sem intervenção manual do usuário,
 * com suporte a canais dinâmicos (Stable e Beta / Nightly).
 */

import { isPrereleaseVersion } from '../version.ts';

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
  noticeTitle?: string;
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
  noticeTitle: string | null;
  statusMessage: string | null;
}

export interface ChannelVersionResolution {
  status: UpdateStatus;
  isDowngradeNotice: boolean;
  downgradeNoticeMessage: string | null;
  noticeTitle: string | null;
  statusMessage: string | null;
  requiresConfirmation?: boolean;
}

/**
 * Avalia de forma pura a relação entre a versão instalada, a versão remota do canal
 * e as regras de atualização do NEXUS, evitando avisos falsos de downgrade ou de versão experimental,
 * e garantindo que o canal Stable nunca baixe Nightlies e que Nightlies nunca migrem silenciosamente.
 */
export function resolveChannelVersionComparison(params: {
  currentVersion: string;
  latestRemoteVersion?: string | null;
  updateAvailable: boolean;
  isCurrentHigher: boolean;
  channel: UpdateChannel;
  silent?: boolean;
}): ChannelVersionResolution {
  const {
    currentVersion,
    latestRemoteVersion,
    updateAvailable,
    isCurrentHigher,
    channel,
    silent = false,
  } = params;

  const isCurrentPrerelease = isPrereleaseVersion(currentVersion);
  const remoteVer = latestRemoteVersion || '';
  const isRemotePrerelease = isPrereleaseVersion(remoteVer);

  // Regra Estrita 1: Canal Stable NUNCA baixa versões Nightly/pré-lançamento
  if (channel === 'stable' && isRemotePrerelease) {
    return {
      status: silent ? 'idle' : 'error',
      isDowngradeNotice: false,
      downgradeNoticeMessage: null,
      noticeTitle: 'Canal Estável Incompatível',
      statusMessage: `O canal Estável rejeitou a compilação experimental v${remoteVer}. O canal Estável aceita apenas versões oficiais homologadas.`,
      requiresConfirmation: false,
    };
  }

  // Regra Estrita 2: Proteção SemVer contra downgrades acidentais
  if (isCurrentHigher) {
    // Cenário A: Versão instalada é experimental e o canal ativo é Stable -> Downgrade Notice legítimo
    if (isCurrentPrerelease && channel === 'stable') {
      const msg = `Você está usando uma versão experimental (v${currentVersion}) com o Canal Estável ativo. A versão disponível no canal Estável é a v${remoteVer || 'estável'}. Não haverá downgrade automático; novas atualizações estáveis serão oferecidas quando uma versão estável superior à sua for publicada.`;
      return {
        status: 'downgrade_notice',
        isDowngradeNotice: true,
        downgradeNoticeMessage: msg,
        noticeTitle: 'Versão Experimental com Canal Estável Ativo',
        statusMessage: null,
        requiresConfirmation: false,
      };
    }

    // Cenário B: Versão instalada é Stable oficial e o canal ativo é Beta / Nightly
    // O usuário está à frente da compilação remota do canal beta (ex: 0.2.0 > 0.1.9-nightly.7).
    // NÃO é versão experimental, NÃO é downgrade.
    if (!isCurrentPrerelease && channel === 'beta') {
      const msg = `Você está utilizando a versão estável oficial (v${currentVersion}). O Canal Beta / Nightly está ativo e novas compilações experimentais serão oferecidas automaticamente assim que uma versão superior for publicada (ex: v0.2.1-nightly.x).`;
      return {
        status: silent ? 'idle' : 'up_to_date',
        isDowngradeNotice: false,
        downgradeNoticeMessage: null,
        noticeTitle: null,
        statusMessage: msg,
        requiresConfirmation: false,
      };
    }

    // Cenário C: Versão instalada é Stable e superior ao manifesto Stable (ex: build interno ou hotfix)
    if (!isCurrentPrerelease && channel === 'stable') {
      const msg = `O NEXUS (v${currentVersion}) já está em uma versão superior à homologada no canal Estável (v${remoteVer || 'estável'}).`;
      return {
        status: silent ? 'idle' : 'up_to_date',
        isDowngradeNotice: false,
        downgradeNoticeMessage: null,
        noticeTitle: null,
        statusMessage: msg,
        requiresConfirmation: false,
      };
    }

    // Cenário D: Versão instalada é experimental e superior à compilação remota do canal Beta
    if (isCurrentPrerelease && channel === 'beta') {
      const msg = `O NEXUS (v${currentVersion}) já está em uma compilação mais recente que a disponível no canal Beta (v${remoteVer}).`;
      return {
        status: silent ? 'idle' : 'up_to_date',
        isDowngradeNotice: false,
        downgradeNoticeMessage: null,
        noticeTitle: null,
        statusMessage: msg,
        requiresConfirmation: false,
      };
    }
  }

  // Regra Estrita 3: Nightly NUNCA migra silenciosamente para Stable
  // Se houver atualização disponível, Nightly ou Beta exige confirmação explícita
  if (updateAvailable) {
    const requiresConfirmation = channel === 'beta' || isCurrentPrerelease;
    return {
      status: 'available',
      isDowngradeNotice: false,
      downgradeNoticeMessage: null,
      noticeTitle: null,
      statusMessage: null,
      requiresConfirmation,
    };
  }

  // Versão instalada é idêntica à remota ou não há atualização
  const channelName = channel === 'beta' ? 'Beta / Nightly' : 'Estável';
  return {
    status: silent ? 'idle' : 'up_to_date',
    isDowngradeNotice: false,
    downgradeNoticeMessage: null,
    noticeTitle: null,
    statusMessage: `O NEXUS já está atualizado na versão mais recente disponível no canal ${channelName}!`,
    requiresConfirmation: false,
  };
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
    noticeTitle: null,
    statusMessage: null,
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
      noticeTitle: null,
      statusMessage: null,
      downloadProgress: 0,
    });

    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const res = await invoke<any>('updater_check_channel', { channel });

      const currentVer = res?.currentVersion || '0.2.0';
      const remoteVer = res?.latestRemoteVersion || res?.version || null;
      const isAvailable = Boolean(res && res.updateAvailable && res.rid != null);
      const isHigher = Boolean(res && res.isCurrentHigher);

      const resolution = resolveChannelVersionComparison({
        currentVersion: currentVer,
        latestRemoteVersion: remoteVer,
        updateAvailable: isAvailable,
        isCurrentHigher: isHigher,
        channel,
        silent,
      });

      if (resolution.status === 'available') {
        const { Update } = await import('@tauri-apps/plugin-updater');
        const update = new Update(res);
        this.activeUpdate = update;

        const info: UpdateInfo = {
          version: res.version,
          currentVersion: currentVer,
          body: res.body || 'Atualizações e melhorias de estabilidade.',
          date: res.date,
          channel,
          endpointUsed: res.endpointUsed,
          isDowngradeNotice: false,
          latestRemoteVersion: remoteVer || undefined,
        };

        console.log(
          `[UpdateService] Nova versão encontrada (${channel}): v${res.version} (Atual: v${currentVer})`
        );
        this.setState({
          status: 'available',
          updateInfo: info,
          errorMessage: null,
          downgradeNoticeMessage: null,
          noticeTitle: null,
          statusMessage: null,
        });
        return info;
      } else if (resolution.status === 'downgrade_notice') {
        const targetVer = remoteVer || 'estável';
        console.log(`[UpdateService] Notificação de downgrade/mismatch (${channel}): ${resolution.downgradeNoticeMessage}`);
        this.activeUpdate = null;
        this.setState({
          status: 'downgrade_notice',
          updateInfo: {
            version: targetVer,
            currentVersion: currentVer,
            channel,
            isDowngradeNotice: true,
            latestRemoteVersion: targetVer,
            endpointUsed: res?.endpointUsed,
            noticeTitle: resolution.noticeTitle || undefined,
          },
          errorMessage: null,
          downgradeNoticeMessage: resolution.downgradeNoticeMessage,
          noticeTitle: resolution.noticeTitle,
          statusMessage: null,
        });
        return null;
      } else {
        console.log(`[UpdateService] Status (${channel}): ${resolution.statusMessage}`);
        this.activeUpdate = null;
        this.setState({
          status: resolution.status,
          updateInfo: null,
          errorMessage: null,
          downgradeNoticeMessage: null,
          noticeTitle: null,
          statusMessage: resolution.statusMessage,
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
        downgradeNoticeMessage: null,
        noticeTitle: null,
        statusMessage: null,
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
