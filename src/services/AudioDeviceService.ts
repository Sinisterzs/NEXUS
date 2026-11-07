/**
 * NEXUS - Audio Device Manager
 * Gerencia enumeração de dispositivos reais de áudio (microfones e saídas de som)
 * e aplicação de setSinkId() no WebView2 / Chromium.
 */

export interface AudioDeviceInfo {
  deviceId: string;
  label: string;
  kind: 'audioinput' | 'audiooutput';
}

type DeviceChangeListener = (devices: {
  inputs: AudioDeviceInfo[];
  outputs: AudioDeviceInfo[];
}) => void;

export class AudioDeviceService {
  private listeners: Set<DeviceChangeListener> = new Set();
  private isListening = false;

  constructor() {
    if (typeof navigator !== 'undefined' && navigator.mediaDevices) {
      this.initEventListener();
    }
  }

  private initEventListener(): void {
    if (this.isListening) return;
    this.isListening = true;

    navigator.mediaDevices.addEventListener('devicechange', async () => {
      console.log('[AudioDeviceService] Mudança de dispositivos de áudio detectada.');
      const devices = await this.getAvailableDevices();
      this.listeners.forEach((listener) => {
        try {
          listener(devices);
        } catch (e) {
          console.warn('[AudioDeviceService] Erro ao notificar listener:', e);
        }
      });
    });
  }

  /**
   * Obtém a lista atualizada de microfones e fones/alto-falantes reais do sistema
   */
  async getAvailableDevices(): Promise<{
    inputs: AudioDeviceInfo[];
    outputs: AudioDeviceInfo[];
  }> {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) {
      return { inputs: [], outputs: [] };
    }

    try {
      const allDevices = await navigator.mediaDevices.enumerateDevices();

      const inputs: AudioDeviceInfo[] = [];
      const outputs: AudioDeviceInfo[] = [];

      let micIndex = 1;
      let speakerIndex = 1;

      for (const dev of allDevices) {
        if (dev.kind === 'audioinput') {
          inputs.push({
            deviceId: dev.deviceId,
            label: dev.label || `Microfone ${micIndex++}`,
            kind: 'audioinput',
          });
        } else if (dev.kind === 'audiooutput') {
          outputs.push({
            deviceId: dev.deviceId,
            label: dev.label || `Alto-falantes / Fones ${speakerIndex++}`,
            kind: 'audiooutput',
          });
        }
      }

      // Adiciona opções padrão caso a lista esteja vazia
      if (inputs.length === 0) {
        inputs.push({
          deviceId: 'default',
          label: 'Microfone Padrão do Sistema',
          kind: 'audioinput',
        });
      }

      if (outputs.length === 0) {
        outputs.push({
          deviceId: 'default',
          label: 'Alto-falantes / Fones Padrão',
          kind: 'audiooutput',
        });
      }

      return { inputs, outputs };
    } catch (err) {
      console.warn('[AudioDeviceService] Erro ao enumerar dispositivos:', err);
      return {
        inputs: [{ deviceId: 'default', label: 'Microfone Padrão do Sistema', kind: 'audioinput' }],
        outputs: [{ deviceId: 'default', label: 'Alto-falantes / Fones Padrão', kind: 'audiooutput' }],
      };
    }
  }

  /**
   * Solicita autorização prévia de microfone se necessário para revelar nomes reais dos dispositivos
   */
  async promptPermissionIfNeeded(): Promise<{
    inputs: AudioDeviceInfo[];
    outputs: AudioDeviceInfo[];
  }> {
    const devices = await this.getAvailableDevices();
    const hasUnlabeled = devices.inputs.some((d) => !d.label || d.label.startsWith('Microfone '));

    if (hasUnlabeled && typeof navigator !== 'undefined' && navigator.mediaDevices?.getUserMedia) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((t) => t.stop());
        return await this.getAvailableDevices();
      } catch (e) {
        console.warn('[AudioDeviceService] Permissão negada ou não disponível:', e);
      }
    }

    return devices;
  }

  /**
   * Define o dispositivo de saída (setSinkId) no elemento de áudio remoto
   */
  async setAudioSink(audioElement: HTMLAudioElement | null, deviceId: string): Promise<boolean> {
    if (!audioElement) return false;

    // setSinkId é suportado no Chromium / WebView2
    if (typeof (audioElement as any).setSinkId === 'function') {
      try {
        await (audioElement as any).setSinkId(deviceId === 'default' ? '' : deviceId);
        console.log(`[AudioDeviceService] Dispositivo de saída alterado para: ${deviceId}`);
        return true;
      } catch (err) {
        console.warn('[AudioDeviceService] Falha ao executar setSinkId:', err);
        return false;
      }
    } else {
      console.log('[AudioDeviceService] setSinkId não suportado neste navegador/ambiente.');
      return false;
    }
  }

  /**
   * Registra listener para conexão/desconexão de dispositivos
   */
  onDeviceChange(listener: DeviceChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export const audioDeviceService = new AudioDeviceService();
