/**
 * NEXUS - Audio Device Manager (Calls & Streaming 2.0)
 * Gerencia enumeração de dispositivos reais de áudio (microfones e saídas de som),
 * verificação de capacidades do WebView2/Chromium (setSinkId, constraints DSP),
 * detecção de desconexão de periféricos e fallback seguro para dispositivo padrão.
 */

import {
  VoiceActivityDetector,
  sensitivityToThreshold,
  thresholdToSensitivity,
  calculateByteFrequencyLevel,
  calculateRmsLevel,
  calibrateSensitivityFromNoise,
} from '../lib/voiceActivity.ts';
import type { VadOptions } from '../lib/voiceActivity.ts';

export interface AudioDeviceInfo {
  deviceId: string;
  label: string;
  kind: 'audioinput' | 'audiooutput';
}

export interface SupportedAudioCapabilities {
  outputSinkSelection: boolean;
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
}

type DeviceChangeListener = (devices: {
  inputs: AudioDeviceInfo[];
  outputs: AudioDeviceInfo[];
}) => void;

export class AudioDeviceService {
  private listeners: Set<DeviceChangeListener> = new Set();
  private isListening = false;
  private boundDeviceChangeHandler: (() => void) | null = null;
  private lastKnownInputs: AudioDeviceInfo[] = [];
  private lastKnownOutputs: AudioDeviceInfo[] = [];

  constructor() {
    if (typeof navigator !== 'undefined' && navigator.mediaDevices) {
      this.initEventListener();
    }
  }

  public initEventListener(): void {
    if (this.isListening) return;
    if (
      typeof navigator === 'undefined' ||
      !navigator.mediaDevices ||
      typeof navigator.mediaDevices.addEventListener !== 'function'
    ) {
      return;
    }

    this.isListening = true;
    this.boundDeviceChangeHandler = async () => {
      console.log('[AudioDeviceService] Mudança de dispositivos de áudio detectada.');
      await this.refreshDevices();
    };

    navigator.mediaDevices.addEventListener('devicechange', this.boundDeviceChangeHandler);
  }

  /**
   * Verifica as capacidades reais suportadas pelo runtime WebView2 / Chromium atual
   */
  public getCapabilities(): SupportedAudioCapabilities {
    let outputSinkSelection = false;
    try {
      if (typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype) {
        outputSinkSelection = true;
      } else if (typeof Audio !== 'undefined') {
        const probe = new Audio();
        outputSinkSelection = typeof (probe as any).setSinkId === 'function';
      }
    } catch {
      outputSinkSelection = false;
    }

    let echoCancellation = true;
    let noiseSuppression = true;
    let autoGainControl = true;

    try {
      if (
        typeof navigator !== 'undefined' &&
        navigator.mediaDevices &&
        typeof navigator.mediaDevices.getSupportedConstraints === 'function'
      ) {
        const supported = navigator.mediaDevices.getSupportedConstraints();
        echoCancellation = Boolean(supported.echoCancellation ?? true);
        noiseSuppression = Boolean(supported.noiseSuppression ?? true);
        autoGainControl = Boolean(supported.autoGainControl ?? true);
      }
    } catch {}

    return {
      outputSinkSelection,
      echoCancellation,
      noiseSuppression,
      autoGainControl,
    };
  }

  /**
   * Valida se o deviceId selecionado continua presente na lista atual de dispositivos.
   * Caso tenha sido desconectado ou removido, realiza fallback seguro para 'default'.
   */
  public resolveValidDeviceId(
    requestedDeviceId: string | undefined | null,
    availableDevices: AudioDeviceInfo[]
  ): { deviceId: string; didFallback: boolean } {
    if (!requestedDeviceId || requestedDeviceId === 'default') {
      return { deviceId: 'default', didFallback: false };
    }

    const exists = availableDevices.some((d) => d.deviceId === requestedDeviceId);
    if (exists) {
      return { deviceId: requestedDeviceId, didFallback: false };
    }

    return { deviceId: 'default', didFallback: true };
  }

  /**
   * Atualiza a lista de dispositivos e notifica todos os listeners registrados
   */
  public async refreshDevices(): Promise<{
    inputs: AudioDeviceInfo[];
    outputs: AudioDeviceInfo[];
  }> {
    const devices = await this.getAvailableDevices();
    this.listeners.forEach((listener) => {
      try {
        listener(devices);
      } catch (e) {
        console.warn('[AudioDeviceService] Erro ao notificar listener:', e);
      }
    });
    return devices;
  }

  /**
   * Obtém a lista atualizada de microfones e fones/alto-falantes reais do sistema
   */
  async getAvailableDevices(): Promise<{
    inputs: AudioDeviceInfo[];
    outputs: AudioDeviceInfo[];
  }> {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) {
      const fallback = {
        inputs: [{ deviceId: 'default', label: 'Microfone Padrão do Sistema', kind: 'audioinput' as const }],
        outputs: [{ deviceId: 'default', label: 'Alto-falantes / Fones Padrão', kind: 'audiooutput' as const }],
      };
      this.lastKnownInputs = fallback.inputs;
      this.lastKnownOutputs = fallback.outputs;
      return fallback;
    }

    try {
      const allDevices = await navigator.mediaDevices.enumerateDevices();

      const inputs: AudioDeviceInfo[] = [];
      const outputs: AudioDeviceInfo[] = [];
      const seenInputIds = new Set<string>();
      const seenOutputIds = new Set<string>();

      let micIndex = 1;
      let speakerIndex = 1;

      for (const dev of allDevices) {
        if (!dev || !dev.deviceId) continue;
        if (dev.kind === 'audioinput') {
          if (seenInputIds.has(dev.deviceId)) continue;
          seenInputIds.add(dev.deviceId);
          inputs.push({
            deviceId: dev.deviceId,
            label:
              dev.deviceId === 'default'
                ? dev.label || 'Microfone Padrão do Sistema'
                : dev.label || `Microfone ${micIndex++}`,
            kind: 'audioinput',
          });
        } else if (dev.kind === 'audiooutput') {
          if (seenOutputIds.has(dev.deviceId)) continue;
          seenOutputIds.add(dev.deviceId);
          outputs.push({
            deviceId: dev.deviceId,
            label:
              dev.deviceId === 'default'
                ? dev.label || 'Alto-falantes / Fones Padrão'
                : dev.label || `Alto-falantes / Fones ${speakerIndex++}`,
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

      this.lastKnownInputs = inputs;
      this.lastKnownOutputs = outputs;

      return { inputs, outputs };
    } catch (err) {
      console.warn('[AudioDeviceService] Erro ao enumerar dispositivos:', err);
      const fallback = {
        inputs: [{ deviceId: 'default', label: 'Microfone Padrão do Sistema', kind: 'audioinput' as const }],
        outputs: [{ deviceId: 'default', label: 'Alto-falantes / Fones Padrão', kind: 'audiooutput' as const }],
      };
      this.lastKnownInputs = fallback.inputs;
      this.lastKnownOutputs = fallback.outputs;
      return fallback;
    }
  }

  public getLastKnownDevices(): { inputs: AudioDeviceInfo[]; outputs: AudioDeviceInfo[] } {
    return {
      inputs: this.lastKnownInputs,
      outputs: this.lastKnownOutputs,
    };
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
   * Define o dispositivo de saída (setSinkId) no elemento de áudio remoto com fallback para padrão
   */
  async setAudioSink(
    audioElement: HTMLAudioElement | null,
    deviceId: string
  ): Promise<{ applied: boolean; didFallback: boolean; activeSinkId: string }> {
    if (!audioElement) {
      return { applied: false, didFallback: false, activeSinkId: 'default' };
    }

    const sinkTarget = !deviceId || deviceId === 'default' ? '' : deviceId;

    // setSinkId é suportado no Chromium / WebView2
    if (typeof (audioElement as any).setSinkId === 'function') {
      try {
        await (audioElement as any).setSinkId(sinkTarget);
        console.log(`[AudioDeviceService] Dispositivo de saída alterado para: ${deviceId || 'default'}`);
        return {
          applied: true,
          didFallback: false,
          activeSinkId: sinkTarget ? deviceId : 'default',
        };
      } catch (err) {
        console.warn('[AudioDeviceService] Falha ao executar setSinkId para dispositivo específico, tentando fallback padrão:', err);
        if (sinkTarget !== '') {
          try {
            await (audioElement as any).setSinkId('');
            return {
              applied: true,
              didFallback: true,
              activeSinkId: 'default',
            };
          } catch {}
        }
        return { applied: false, didFallback: true, activeSinkId: 'default' };
      }
    } else {
      console.log('[AudioDeviceService] setSinkId não suportado neste navegador/ambiente.');
      return { applied: false, didFallback: false, activeSinkId: 'default' };
    }
  }

  /**
   * Registra listener para conexão/desconexão de dispositivos
   */
  onDeviceChange(listener: DeviceChangeListener): () => void {
    this.initEventListener();
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Cria instância do detector de atividade de voz com histerese e hangover
   */
  public createVoiceDetector(options?: VadOptions): VoiceActivityDetector {
    return new VoiceActivityDetector(options);
  }

  /**
   * Converte sensibilidade (0..100) em limiar de ativação (0..100)
   */
  public sensitivityToThreshold(sensitivity: number): number {
    return sensitivityToThreshold(sensitivity);
  }

  /**
   * Converte limiar de ativação (0..100) em sensibilidade (0..100)
   */
  public thresholdToSensitivity(threshold: number): number {
    return thresholdToSensitivity(threshold);
  }

  /**
   * Calcula energia sonora normalizada (0..100) a partir de bytes de frequência
   */
  public calculateFrequencyLevel(data: Uint8Array): number {
    return calculateByteFrequencyLevel(data);
  }

  /**
   * Calcula energia sonora normalizada (0..100) a partir de amostras PCM Float32
   */
  public calculateRmsLevel(samples: Float32Array): number {
    return calculateRmsLevel(samples);
  }

  /**
   * Recomenda limiar e sensibilidade ideais com base em amostras de ruído ambiente
   */
  public calibrateSensitivity(noiseLevels: number[]) {
    return calibrateSensitivityFromNoise(noiseLevels);
  }
}

export const audioDeviceService = new AudioDeviceService();
