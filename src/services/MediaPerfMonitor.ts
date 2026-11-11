/**
 * NEXUS - Media Performance Monitor (MediaPerfMonitor)
 *
 * Instrumentação leve, segura e opt-in para diagnóstico de desempenho em streaming WebRTC.
 * Responsabilidades:
 * 1. Monitoramento de Long Tasks (PerformanceObserver 'longtask') para detecção de engasgos na UI.
 * 2. Extração de métricas de codificador WebRTC (encoderImplementation, powerEfficientEncoder,
 *    qualityLimitationReason, qualityLimitationDurations, tempo médio de codificação por quadro).
 * 3. Controle inteligente de cadência de polling (adaptive getStats cadence, proteção contra reentrância).
 * 4. Diagnóstico de gargalos de CPU/GPU sem impacto no thread principal e sem vazamentos de memória.
 */

export interface EncoderPerfMetrics {
  encoderImplementation: string | null;
  powerEfficientEncoder: boolean | null;
  qualityLimitationReason: 'none' | 'cpu' | 'bandwidth' | 'other' | null;
  qualityLimitationDurations: {
    cpu?: number;
    bandwidth?: number;
    other?: number;
    none?: number;
  } | null;
  framesEncoded: number;
  framesPerSecond: number | null;
  totalEncodeTimeSec: number;
  avgEncodeTimeMs: number | null;
  keyFramesEncoded: number;
  framesDropped: number;
  cpuBottleneckDetected: boolean;
}

export interface LongTaskMetrics {
  totalLongTasks: number;
  maxDurationMs: number;
  totalDurationMs: number;
  recentLongTasksCount: number;
  lastLongTaskMs: number | null;
}

export interface MediaPerfSnapshot {
  timestamp: number;
  isEnabled: boolean;
  encoder: EncoderPerfMetrics | null;
  longTasks: LongTaskMetrics;
  recommendedPollIntervalMs: number;
}

export interface MediaPerfOptions {
  enabled?: boolean;
  activePollIntervalMs?: number;
  idlePollIntervalMs?: number;
  highCpuThresholdMs?: number;
}

export type MediaPerfListener = (snapshot: MediaPerfSnapshot) => void;

export class MediaPerfMonitor {
  private isEnabled = false;
  private activePollIntervalMs = 2000;
  private idlePollIntervalMs = 5000;
  private highCpuThresholdMs = 22.0;

  private longTaskObserver: PerformanceObserver | null = null;
  private totalLongTasks = 0;
  private maxLongTaskDurationMs = 0;
  private totalLongTaskDurationMs = 0;
  private recentLongTaskTimestamps: number[] = [];
  private lastLongTaskMs: number | null = null;

  private lastEncoderMetrics: EncoderPerfMetrics | null = null;
  private prevEncodeSnapshot: {
    timestampMs: number;
    totalEncodeTimeSec: number;
    framesEncoded: number;
  } | null = null;

  private isPollingActive = false;
  private listeners: Set<MediaPerfListener> = new Set();

  constructor(options?: MediaPerfOptions) {
    if (options) {
      this.configure(options);
    }
  }

  public configure(options: MediaPerfOptions): void {
    if (typeof options.activePollIntervalMs === 'number' && options.activePollIntervalMs >= 500) {
      this.activePollIntervalMs = options.activePollIntervalMs;
    }
    if (typeof options.idlePollIntervalMs === 'number' && options.idlePollIntervalMs >= 1000) {
      this.idlePollIntervalMs = options.idlePollIntervalMs;
    }
    if (typeof options.highCpuThresholdMs === 'number' && options.highCpuThresholdMs > 0) {
      this.highCpuThresholdMs = options.highCpuThresholdMs;
    }
    if (options.enabled !== undefined) {
      if (options.enabled && !this.isEnabled) {
        this.start();
      } else if (!options.enabled && this.isEnabled) {
        this.stop();
      }
    }
  }

  /**
   * Inicia a instrumentação de desempenho (PerformanceObserver para longtask)
   */
  public start(): void {
    if (this.isEnabled) return;
    this.isEnabled = true;
    this.initLongTaskObserver();
    this.notify();
  }

  /**
   * Interrompe o monitoramento e desconecta observers
   */
  public stop(): void {
    if (!this.isEnabled) return;
    this.isEnabled = false;
    this.teardownLongTaskObserver();
    this.notify();
  }

  /**
   * Reinicia métricas acumuladas mantendo estado de ativação
   */
  public reset(): void {
    this.totalLongTasks = 0;
    this.maxLongTaskDurationMs = 0;
    this.totalLongTaskDurationMs = 0;
    this.recentLongTaskTimestamps = [];
    this.lastLongTaskMs = null;
    this.lastEncoderMetrics = null;
    this.prevEncodeSnapshot = null;
    this.isPollingActive = false;
    this.notify();
  }

  /**
   * Destrói completamente o monitor liberando recursos e listeners
   */
  public destroy(): void {
    this.stop();
    this.reset();
    this.listeners.clear();
  }

  public isActive(): boolean {
    return this.isEnabled;
  }

  public addListener(listener: MediaPerfListener): () => void {
    this.listeners.add(listener);
    try {
      listener(this.getSnapshot());
    } catch (err) {
      console.warn('[MediaPerfMonitor] Erro ao notificar listener inicial:', err);
    }
    return () => {
      this.listeners.delete(listener);
    };
  }

  public removeListener(listener: MediaPerfListener): void {
    this.listeners.delete(listener);
  }

  /**
   * Executa uma chamada getStats() de forma protegida contra reentrância / requisições simultâneas
   */
  public async executeSafePoll<T>(pollFn: () => Promise<T>): Promise<T | null> {
    if (this.isPollingActive) {
      // Ignora polling concorrente para poupar ciclos de CPU
      return null;
    }

    this.isPollingActive = true;
    try {
      return await pollFn();
    } catch (err) {
      console.warn('[MediaPerfMonitor] Erro durante poll protegido:', err);
      return null;
    } finally {
      this.isPollingActive = false;
    }
  }

  /**
   * Calcula o intervalo ideal de polling com base no estado da interface e transmissão
   */
  public getRecommendedPollInterval(isPanelVisible: boolean, isStreaming: boolean): number {
    if (!isStreaming) {
      return this.idlePollIntervalMs;
    }
    if (!isPanelVisible) {
      // Se a tela de diagnóstico não está visível, reduz a frequência para poupar CPU
      return this.idlePollIntervalMs;
    }
    return this.activePollIntervalMs;
  }

  /**
   * Extrai e calcula métricas do codificador de vídeo a partir de um RTCStatsReport
   */
  public parseRtcStats(report: RTCStatsReport | Iterable<any> | Map<string, any> | null): EncoderPerfMetrics | null {
    if (!report) {
      return this.lastEncoderMetrics;
    }

    let outboundVideoStat: any = null;

    try {
      if (typeof (report as any).forEach === 'function') {
        (report as any).forEach((stat: any) => {
          if (
            stat?.type === 'outbound-rtp' &&
            (stat.kind === 'video' || stat.mediaType === 'video')
          ) {
            outboundVideoStat = stat;
          }
        });
      } else if (Symbol.iterator in Object(report)) {
        for (const stat of report as any) {
          const item = Array.isArray(stat) ? stat[1] : stat;
          if (
            item?.type === 'outbound-rtp' &&
            (item.kind === 'video' || item.mediaType === 'video')
          ) {
            outboundVideoStat = item;
            break;
          }
        }
      }
    } catch (err) {
      console.warn('[MediaPerfMonitor] Erro ao iterar RTCStatsReport:', err);
      return this.lastEncoderMetrics;
    }

    if (!outboundVideoStat) {
      return this.lastEncoderMetrics;
    }

    const encoderImplementation =
      typeof outboundVideoStat.encoderImplementation === 'string'
        ? outboundVideoStat.encoderImplementation
        : null;

    const powerEfficientEncoder =
      typeof outboundVideoStat.powerEfficientEncoder === 'boolean'
        ? outboundVideoStat.powerEfficientEncoder
        : null;

    const qualityLimitationReason =
      typeof outboundVideoStat.qualityLimitationReason === 'string'
        ? (outboundVideoStat.qualityLimitationReason as EncoderPerfMetrics['qualityLimitationReason'])
        : null;

    const qualityLimitationDurations =
      outboundVideoStat.qualityLimitationDurations && typeof outboundVideoStat.qualityLimitationDurations === 'object'
        ? {
            cpu: Number(outboundVideoStat.qualityLimitationDurations.cpu || 0),
            bandwidth: Number(outboundVideoStat.qualityLimitationDurations.bandwidth || 0),
            other: Number(outboundVideoStat.qualityLimitationDurations.other || 0),
            none: Number(outboundVideoStat.qualityLimitationDurations.none || 0),
          }
        : null;

    const framesEncoded = Number(outboundVideoStat.framesEncoded || 0);
    const totalEncodeTimeSec = Number(outboundVideoStat.totalEncodeTime || 0);
    const framesPerSecond =
      typeof outboundVideoStat.framesPerSecond === 'number' && outboundVideoStat.framesPerSecond > 0
        ? Math.round(outboundVideoStat.framesPerSecond)
        : null;
    const keyFramesEncoded = Number(outboundVideoStat.keyFramesEncoded || 0);
    const framesDropped = Number(outboundVideoStat.framesDropped || outboundVideoStat.droppedFrames || 0);

    const nowMs = Date.now();
    let avgEncodeTimeMs: number | null = null;

    if (this.prevEncodeSnapshot) {
      const deltaFrames = framesEncoded - this.prevEncodeSnapshot.framesEncoded;
      const deltaTime = totalEncodeTimeSec - this.prevEncodeSnapshot.totalEncodeTimeSec;

      if (deltaFrames > 0 && deltaTime >= 0) {
        avgEncodeTimeMs = Number(((deltaTime / deltaFrames) * 1000).toFixed(2));
      }
    }

    if (avgEncodeTimeMs === null && framesEncoded > 0 && totalEncodeTimeSec > 0) {
      avgEncodeTimeMs = Number(((totalEncodeTimeSec / framesEncoded) * 1000).toFixed(2));
    }

    this.prevEncodeSnapshot = {
      timestampMs: nowMs,
      totalEncodeTimeSec,
      framesEncoded,
    };

    const isCpuLimited = qualityLimitationReason === 'cpu';
    const isEncodeTimeHigh = avgEncodeTimeMs !== null && avgEncodeTimeMs >= this.highCpuThresholdMs;
    const cpuBottleneckDetected = isCpuLimited || isEncodeTimeHigh;

    const metrics: EncoderPerfMetrics = {
      encoderImplementation,
      powerEfficientEncoder,
      qualityLimitationReason,
      qualityLimitationDurations,
      framesEncoded,
      framesPerSecond,
      totalEncodeTimeSec,
      avgEncodeTimeMs,
      keyFramesEncoded,
      framesDropped,
      cpuBottleneckDetected,
    };

    this.lastEncoderMetrics = metrics;
    this.notify();
    return metrics;
  }

  public getSnapshot(): MediaPerfSnapshot {
    const now = Date.now();
    const windowStart = now - 10000;
    this.recentLongTaskTimestamps = this.recentLongTaskTimestamps.filter((ts) => ts >= windowStart);

    return {
      timestamp: now,
      isEnabled: this.isEnabled,
      encoder: this.lastEncoderMetrics,
      longTasks: {
        totalLongTasks: this.totalLongTasks,
        maxDurationMs: this.maxLongTaskDurationMs,
        totalDurationMs: this.totalLongTaskDurationMs,
        recentLongTasksCount: this.recentLongTaskTimestamps.length,
        lastLongTaskMs: this.lastLongTaskMs,
      },
      recommendedPollIntervalMs: this.activePollIntervalMs,
    };
  }

  private initLongTaskObserver(): void {
    if (typeof PerformanceObserver === 'undefined') return;

    try {
      const supported = (PerformanceObserver as any).supportedEntryTypes;
      if (Array.isArray(supported) && !supported.includes('longtask')) {
        return;
      }

      this.longTaskObserver = new PerformanceObserver((entryList) => {
        const entries = entryList.getEntries();
        for (const entry of entries) {
          this.recordLongTask(entry.duration);
        }
      });

      this.longTaskObserver.observe({ entryTypes: ['longtask'] });
    } catch {
      // Degradação graciosa em ambientes sem suporte a 'longtask'
      this.longTaskObserver = null;
    }
  }

  private teardownLongTaskObserver(): void {
    if (this.longTaskObserver) {
      try {
        this.longTaskObserver.disconnect();
      } catch {}
      this.longTaskObserver = null;
    }
  }

  public recordLongTask(durationMs: number): void {
    if (!this.isEnabled) return;
    const cleanDuration = Math.max(0, durationMs);
    this.totalLongTasks++;
    this.totalLongTaskDurationMs += cleanDuration;
    if (cleanDuration > this.maxLongTaskDurationMs) {
      this.maxLongTaskDurationMs = cleanDuration;
    }
    const now = Date.now();
    this.lastLongTaskMs = cleanDuration;
    this.recentLongTaskTimestamps.push(now);

    // Mantém buffer de timestamps limitado a no máximo 100 entradas
    if (this.recentLongTaskTimestamps.length > 100) {
      this.recentLongTaskTimestamps.shift();
    }
    this.notify();
  }

  private notify(): void {
    if (this.listeners.size === 0) return;
    const snap = this.getSnapshot();
    for (const listener of this.listeners) {
      try {
        listener(snap);
      } catch (err) {
        console.warn('[MediaPerfMonitor] Erro em listener:', err);
      }
    }
  }
}

// Instância singleton para uso no NEXUS
export const mediaPerfMonitor = new MediaPerfMonitor();
