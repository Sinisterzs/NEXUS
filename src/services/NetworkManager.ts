import { NetworkStatus } from '../lib/types';

export const DEFAULT_NETWORK_STATUS: NetworkStatus = {
  tailscale_installed: false,
  tailscale_service_running: false,
  tailscale_authenticated: false,
  tailscale_state: 'stopped',
  tailscale_ips: [],
  tailscale_self_name: null,
  tailscale_auth_url: null,
  server_reachability: 'connecting',
  server_url: 'http://nexus-server:3001',
  server_latency_ms: null,
  is_magic_dns: true,
  detected_peers: [],
  error_message: null,
};

type NetworkChangeListener = (status: NetworkStatus) => void;

class NetworkManager {
  private lastStatus: NetworkStatus = DEFAULT_NETWORK_STATUS;
  private listeners: NetworkChangeListener[] = [];
  private pollTimer: any = null;
  private backoffDelayMs = 2000;
  private maxBackoffDelayMs = 30000;
  private isChecking = false;

  constructor() {
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => {
        console.log('[NetworkManager] Evento de rede ONLINE disparado pelo sistema operacional.');
        this.resetBackoff();
        this.checkNetwork();
      });

      window.addEventListener('offline', () => {
        console.log('[NetworkManager] Evento de rede OFFLINE disparado pelo sistema operacional.');
        this.updateStatus({
          ...this.lastStatus,
          server_reachability: 'network_disconnected',
          server_latency_ms: null,
        });
      });
    }
  }

  addListener(listener: NetworkChangeListener): () => void {
    this.listeners.push(listener);
    listener(this.lastStatus);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  private updateStatus(newStatus: NetworkStatus) {
    this.lastStatus = newStatus;
    this.listeners.forEach((listener) => {
      try {
        listener(newStatus);
      } catch (err) {
        console.warn('[NetworkManager] Erro no listener de rede:', err);
      }
    });
  }

  async checkNetwork(): Promise<NetworkStatus> {
    if (this.isChecking) {
      return this.lastStatus;
    }
    this.isChecking = true;

    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const status = await invoke<NetworkStatus>('network_get_status');
      this.updateStatus(status);

      if (status.server_reachability === 'connected') {
        this.resetBackoff();
        this.scheduleNextCheck(30000); // Check every 30s when healthy
      } else {
        // Exponential backoff when disconnected or unreachable
        this.scheduleNextCheck(this.backoffDelayMs);
        this.backoffDelayMs = Math.min(this.backoffDelayMs * 2, this.maxBackoffDelayMs);
      }
      return status;
    } catch (err: any) {
      console.warn('[NetworkManager] Falha ao consultar status de rede via Tauri:', err);
      // Fallback for browser mode
      const fallback: NetworkStatus = {
        ...this.lastStatus,
        server_reachability: 'server_unreachable',
        error_message: String(err?.message || err),
      };
      this.updateStatus(fallback);
      this.scheduleNextCheck(this.backoffDelayMs);
      this.backoffDelayMs = Math.min(this.backoffDelayMs * 2, this.maxBackoffDelayMs);
      return fallback;
    } finally {
      this.isChecking = false;
    }
  }

  private scheduleNextCheck(delayMs: number) {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
    }
    this.pollTimer = setTimeout(() => {
      this.checkNetwork();
    }, delayMs);
  }

  resetBackoff() {
    this.backoffDelayMs = 2000;
  }

  async openTailscale(): Promise<void> {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('network_open_tailscale');
    } catch (err) {
      console.warn('[NetworkManager] Erro ao acionar abertura do Tailscale:', err);
    }
  }

  async setServerAddress(url: string): Promise<string> {
    const { invoke } = await import('@tauri-apps/api/core');
    const oldServer = this.lastStatus.server_url;
    const updated = await invoke<string>('network_set_server_address', { url });
    this.resetBackoff();
    await this.checkNetwork();
    if (typeof window !== 'undefined' && oldServer && oldServer !== updated) {
      window.location.reload();
    }
    return updated;
  }

  async getServerAddress(): Promise<string> {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      return await invoke<string>('network_get_server_address');
    } catch {
      return this.lastStatus.server_url;
    }
  }

  async probeServer(url?: string): Promise<{ status: string; latency_ms?: number; error?: string }> {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      return await invoke<{ status: string; latency_ms?: number; error?: string }>('network_check_server', {
        url: url || null,
      });
    } catch (err: any) {
      return { status: 'unreachable', error: String(err?.message || err) };
    }
  }

  getLastStatus(): NetworkStatus {
    return this.lastStatus;
  }
}

export const networkManager = new NetworkManager();
