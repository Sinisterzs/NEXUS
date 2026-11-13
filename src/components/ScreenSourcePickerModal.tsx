import React, { useEffect, useMemo, useState } from 'react';
import {
  Monitor,
  AppWindow,
  RefreshCw,
  X,
  Volume2,
  VolumeX,
  MousePointer,
  ShieldCheck,
  AlertTriangle,
  Loader2,
  Cpu,
  Radio,
} from 'lucide-react';
import { useAppStore } from '../stores/useAppStore';
import {
  CaptureSourceInfo,
  NativeCaptureStatus,
  NativeScreenStatsEvent,
  ScreenShareQualityPreset,
} from '../lib/types';
import { cn } from '../lib/utils';
import { LocalScreenPreview } from './LocalScreenPreview';
import { screenCaptureService } from '../services/ScreenCaptureService';

const FREE_QUALITY_PRESETS: Array<{
  value: ScreenShareQualityPreset;
  label: string;
  sublabel: string;
}> = [
  { value: 'auto', label: 'Auto', sublabel: 'Adaptativo' },
  { value: '720p30', label: '720p 30', sublabel: 'HD fluido' },
  { value: '720p60', label: '720p 60', sublabel: 'Jogos leve' },
  { value: '1080p30', label: '1080p 30', sublabel: 'Full HD texto' },
  { value: '1080p60', label: '1080p 60', sublabel: 'Full HD 60fps' },
];

function formatBackendLabel(backendUsed: string): string {
  switch (backendUsed) {
    case 'DxgiMonitor':
      return 'DXGI Monitor (sem borda)';
    case 'WgcMonitor':
      return 'WGC Monitor';
    case 'WgcWindow':
      return 'WGC Janela';
    default:
      return backendUsed || 'Nativo';
  }
}

export interface NativeScreenShareBannerProps {
  status: NativeCaptureStatus;
  stats: NativeScreenStatsEvent | null;
  onStop?: () => void;
  className?: string;
}

export const NativeScreenShareBanner: React.FC<NativeScreenShareBannerProps> = ({
  status,
  stats,
  onStop,
  className,
}) => {
  const [experimentOpen, setExperimentOpen] = useState(false);
  const [experimentError, setExperimentError] = useState<string | null>(null);
  if (!status.active) return null;

  const backend = stats?.backend_used || status.backend_used;
  const encoderName = stats?.encoder_name || status.encoder_name;
  const isHardware = stats?.is_hardware ?? status.is_hardware;
  const appAudioActive = stats?.app_audio_active ?? status.app_audio_active;
  const width = stats?.dst_width || status.width;
  const height = stats?.dst_height || status.height;
  const fps = stats ? Math.round(stats.send_fps) : status.fps;
  const bitrateKbps = stats
    ? Math.round(stats.send_bitrate_kbps)
    : Math.round(status.bitrate_bps / 1000);

  return (
    <div
      className={cn(
        'px-3.5 py-2.5 rounded-xl bg-emerald-500/10 border border-emerald-500/30 flex flex-wrap items-center justify-between gap-2.5 text-xs',
        className
      )}
    >
      <div className="flex flex-wrap items-center gap-2 min-w-0">
        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 font-semibold text-[11px]">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
          <Radio className="w-3 h-3" />
          <span>Transmitindo ao vivo</span>
        </span>

        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-nexus-panel border border-nexus-border text-nexus-text font-mono text-[11px]">
          {backend === 'WgcWindow' ? (
            <AppWindow className="w-3 h-3 text-indigo-400" />
          ) : (
            <Monitor className="w-3 h-3 text-emerald-400" />
          )}
          <span>{formatBackendLabel(backend)}</span>
          <span title="Compartilhamento sem retransmissão TURN">· Somente P2P</span>
        </span>

        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-nexus-panel border border-nexus-border text-nexus-muted font-mono text-[11px]">
          <Cpu className="w-3 h-3 text-nexus-accent" />
          <span>
            {encoderName} ({isHardware ? 'HW' : 'SW'})
          </span>
        </span>

        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-nexus-panel border border-nexus-border text-nexus-text font-mono text-[11px] tabular-nums">
          <span>
            {width}x{height}
          </span>
          <span className="text-nexus-muted">•</span>
          <span>{fps} FPS</span>
          <span className="text-nexus-muted">•</span>
          <span>{bitrateKbps} kbps</span>
        </span>

        <span
          className={cn(
            'inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-[11px]',
            appAudioActive
              ? 'bg-indigo-500/15 border-indigo-500/30 text-indigo-300'
              : 'bg-nexus-panel border-nexus-border text-nexus-muted'
          )}
        >
          {appAudioActive ? (
            <>
              <Volume2 className="w-3 h-3" />
              <span>Áudio do app (WASAPI)</span>
            </>
          ) : (
            <>
              <VolumeX className="w-3 h-3" />
              <span>Sem áudio do app</span>
            </>
          )}
        </span>
      </div>

      <div className="flex flex-col items-end gap-1 text-[11px]">
        <button type="button" onClick={() => setExperimentOpen(!experimentOpen)} className="text-nexus-muted underline">Comparar bitrate local</button>
        {experimentOpen && <label>Perfil temporário (não altera presets)
          <select aria-label="Perfil temporário de bitrate" value={String(stats?.bitrate_experiment_bps || 0)}
            onChange={event => { const profiles: Record<string,string> = {'0':'official','3500000':'a35','4235000':'a4235','6000000':'b6','8000000':'c8','10000000':'d10'}; setExperimentError(null);
              void screenCaptureService.setNativeBitrateExperiment(profiles[event.target.value]).catch(error => setExperimentError(String(error))); }}
            className="ml-2 bg-nexus-panel border border-nexus-border rounded px-1 py-1">
            <option value="0">Oficial</option><option value="3500000">A · 3,5 Mbps fixos</option><option value="4235000">A2 · 4,235 Mbps fixos</option>
            <option value="6000000">B · 6 Mbps</option><option value="8000000">C · 8 Mbps</option><option value="10000000">D · 10 Mbps (exige margem)</option>
          </select></label>}
        {experimentOpen && <span className="text-nexus-muted">
          Solicitado: {((stats?.requested_bitrate_bps || stats?.target_bitrate_bps || status.bitrate_bps)/1e6).toFixed(2)} Mbps ·
          MFT: {stats?.encoder_readback_bitrate_bps == null ? 'não confirmado' : `${(stats.encoder_readback_bitrate_bps/1e6).toFixed(2)} Mbps`} ·
          Codificado: {stats?.encoded_payload_bitrate_kbps == null ? 'aguardando' : `${(stats.encoded_payload_bitrate_kbps/1000).toFixed(2)} Mbps`}
        </span>}
        {experimentError && <span role="alert" className="text-amber-300 max-w-md">{experimentError}</span>}
      </div>
      {onStop && (
        <button
          type="button"
          onClick={onStop}
          className="px-2.5 py-1 rounded-lg bg-rose-600/90 hover:bg-rose-500 text-white text-[11px] font-semibold transition-colors cursor-pointer shrink-0"
        >
          Parar transmissão
        </button>
      )}
    </div>
  );
};

/** Content panel, deliberately separate from the compact status banner. */
export const NativeLocalScreenPreview: React.FC<{ status: NativeCaptureStatus }> = ({ status }) => {
  const sources = useAppStore((s) => s.nativeCaptureSources);
  const stats = useAppStore((s) => s.nativeScreenStats);
  const targetFps = stats?.target_fps;
  const source = [...(sources?.monitors ?? []), ...(sources?.windows ?? [])].find((item) => item.id === status.source_id);
  if (!status.active || !status.preview_session_id) return null;
  return <LocalScreenPreview key={status.preview_session_id} sessionId={status.preview_session_id}
    sourceName={source?.title || source?.device_name || (status.backend_used === 'WgcWindow' ? 'Janela compartilhada' : 'Monitor compartilhado')}
    isWindow={status.backend_used === 'WgcWindow'} targetFps={targetFps || status.fps} sourceWidth={stats?.src_width || status.width} sourceHeight={stats?.src_height || status.height} />;
};

export const ScreenSourcePickerModal: React.FC = () => {
  const screenPickerTarget = useAppStore((s) => s.screenPickerTarget);
  const nativeCaptureSources = useAppStore((s) => s.nativeCaptureSources);
  const isLoadingNativeSources = useAppStore((s) => s.isLoadingNativeSources);
  const voiceRoomQuality = useAppStore((s) => s.voiceRoomQuality);
  const screenShareQuality = useAppStore((s) => s.screenShareQuality);
  const voiceRoomError = useAppStore((s) => s.voiceRoomError);
  const screenShareError = useAppStore((s) => s.screenShareError);

  const closeScreenSourcePicker = useAppStore((s) => s.closeScreenSourcePicker);
  const refreshNativeCaptureSources = useAppStore((s) => s.refreshNativeCaptureSources);
  const startNativeVoiceRoomScreenShare = useAppStore((s) => s.startNativeVoiceRoomScreenShare);
  const startNativeCallScreenShare = useAppStore((s) => s.startNativeCallScreenShare);

  const [activeTab, setActiveTab] = useState<'monitors' | 'windows'>('monitors');
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const [preset, setPreset] = useState<ScreenShareQualityPreset>('auto');
  const [cursorEnabled, setCursorEnabled] = useState(true);
  const [includeAppAudio, setIncludeAppAudio] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const monitors = nativeCaptureSources?.monitors ?? [];
  const windows = nativeCaptureSources?.windows ?? [];

  useEffect(() => {
    if (!screenPickerTarget) return;
    setPreset(screenPickerTarget === 'room' ? voiceRoomQuality : screenShareQuality);
    setIsSubmitting(false);
  }, [screenPickerTarget, voiceRoomQuality, screenShareQuality]);

  useEffect(() => {
    if (!screenPickerTarget) return;
    const allSources = [...monitors, ...windows];
    if (selectedSourceId && allSources.some((src) => src.id === selectedSourceId)) {
      return;
    }
    const primaryMonitor = monitors.find((m) => m.is_primary) || monitors[0];
    if (primaryMonitor) {
      setSelectedSourceId(primaryMonitor.id);
      setActiveTab('monitors');
    } else if (windows[0]) {
      setSelectedSourceId(windows[0].id);
      setActiveTab('windows');
    } else {
      setSelectedSourceId(null);
    }
  }, [screenPickerTarget, monitors, windows, selectedSourceId]);

  useEffect(() => {
    if (!screenPickerTarget) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isSubmitting) {
        closeScreenSourcePicker();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [screenPickerTarget, isSubmitting, closeScreenSourcePicker]);

  const selectedSource: CaptureSourceInfo | null = useMemo(() => {
    return [...monitors, ...windows].find((s) => s.id === selectedSourceId) ?? null;
  }, [monitors, windows, selectedSourceId]);

  if (!screenPickerTarget) return null;

  const activeError = screenPickerTarget === 'room' ? voiceRoomError : screenShareError;
  const displayedSources = activeTab === 'monitors' ? monitors : windows;

  const handleConfirm = async () => {
    if (!selectedSourceId || isSubmitting) return;
    setIsSubmitting(true);
    try {
      const options = {
        source_id: selectedSourceId,
        preset,
        cursor_enabled: cursorEnabled,
        include_app_audio: includeAppAudio,
      };
      if (screenPickerTarget === 'room') {
        await startNativeVoiceRoomScreenShare(options);
      } else {
        await startNativeCallScreenShare(options);
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={() => {
        if (!isSubmitting) closeScreenSourcePicker();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="screen-picker-title"
    >
      <div
        className="w-full max-w-2xl rounded-2xl bg-nexus-surface border border-nexus-border shadow-2xl overflow-hidden flex flex-col max-h-[88vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 py-4 border-b border-nexus-border flex items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-nexus-accent/15 border border-nexus-accent/30 flex items-center justify-center text-nexus-accent">
              <Monitor className="w-4 h-4" />
            </div>
            <div>
              <h2 id="screen-picker-title" className="text-sm font-bold text-nexus-text">
                Compartilhar tela
              </h2>
              <p className="text-[11px] text-nexus-muted">
                Escolha um monitor ou janela para transmitir no NEXUS
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void refreshNativeCaptureSources()}
              disabled={isLoadingNativeSources || isSubmitting}
              className="px-2.5 py-1.5 rounded-lg bg-nexus-panel hover:bg-nexus-bg border border-nexus-border text-xs text-nexus-text flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-50"
              title="Atualizar lista de monitores e janelas"
            >
              <RefreshCw
                className={cn('w-3.5 h-3.5', isLoadingNativeSources && 'animate-spin')}
              />
              <span>Atualizar</span>
            </button>
            <button
              type="button"
              onClick={closeScreenSourcePicker}
              disabled={isSubmitting}
              className="p-1.5 rounded-lg text-nexus-muted hover:text-nexus-text hover:bg-nexus-panel transition-colors cursor-pointer disabled:opacity-50"
              aria-label="Fechar seletor"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="px-5 pt-3 border-b border-nexus-border flex items-center gap-2 shrink-0 bg-nexus-bg/40">
          <button
            type="button"
            onClick={() => setActiveTab('monitors')}
            className={cn(
              'px-3.5 py-2 text-xs font-semibold border-b-2 transition-colors flex items-center gap-1.5 cursor-pointer',
              activeTab === 'monitors'
                ? 'border-nexus-accent text-nexus-text'
                : 'border-transparent text-nexus-muted hover:text-nexus-text'
            )}
          >
            <Monitor className="w-3.5 h-3.5" />
            <span>Monitores ({monitors.length})</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('windows')}
            className={cn(
              'px-3.5 py-2 text-xs font-semibold border-b-2 transition-colors flex items-center gap-1.5 cursor-pointer',
              activeTab === 'windows'
                ? 'border-nexus-accent text-nexus-text'
                : 'border-transparent text-nexus-muted hover:text-nexus-text'
            )}
          >
            <AppWindow className="w-3.5 h-3.5" />
            <span>Janelas ({windows.length})</span>
          </button>
        </div>

        {/* Source List */}
        <div className="flex-1 overflow-y-auto p-5 space-y-2.5 min-h-[220px]">
          {isLoadingNativeSources && displayedSources.length === 0 ? (
            <div className="h-44 flex flex-col items-center justify-center gap-2 text-xs text-nexus-muted">
              <Loader2 className="w-5 h-5 animate-spin text-nexus-accent" />
              <span>Carregando fontes de captura...</span>
            </div>
          ) : displayedSources.length === 0 ? (
            <div className="h-44 flex flex-col items-center justify-center gap-2 text-xs text-nexus-muted border border-dashed border-nexus-border rounded-xl">
              <span>
                {activeTab === 'monitors'
                  ? 'Nenhum monitor disponível para captura.'
                  : 'Nenhuma janela disponível para captura.'}
              </span>
              <button
                type="button"
                onClick={() => void refreshNativeCaptureSources()}
                className="text-nexus-accent hover:underline cursor-pointer"
              >
                Atualizar fontes
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              {displayedSources.map((src) => {
                const isSelected = src.id === selectedSourceId;
                const isDxgi = src.kind === 'DxgiMonitor';

                return (
                  <button
                    key={src.id}
                    type="button"
                    onClick={() => setSelectedSourceId(src.id)}
                    className={cn(
                      'text-left p-3.5 rounded-xl border transition-all cursor-pointer flex flex-col gap-2',
                      isSelected
                        ? 'bg-nexus-accent/15 border-nexus-accent shadow-sm'
                        : 'bg-nexus-panel/70 border-nexus-border hover:border-nexus-muted/60 hover:bg-nexus-panel'
                    )}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        {src.kind === 'WgcWindow' ? (
                          <AppWindow className="w-4 h-4 text-indigo-400 shrink-0" />
                        ) : (
                          <Monitor className="w-4 h-4 text-emerald-400 shrink-0" />
                        )}
                        <span className="text-xs font-semibold text-nexus-text truncate">
                          {src.title || src.device_name || 'Fonte sem título'}
                        </span>
                      </div>
                      {src.is_primary && (
                        <span className="px-1.5 py-0.5 rounded bg-emerald-500/20 border border-emerald-500/35 text-emerald-300 text-[10px] font-semibold shrink-0">
                          Primário
                        </span>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
                      {src.width > 0 && src.height > 0 && (
                        <span className="px-1.5 py-0.5 rounded bg-nexus-bg border border-nexus-border text-nexus-muted font-mono">
                          {src.width}x{src.height}
                        </span>
                      )}

                      {src.kind !== 'WgcWindow' && (
                        <span
                          className={cn(
                            'px-1.5 py-0.5 rounded border inline-flex items-center gap-1 font-medium',
                            isDxgi
                              ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                              : 'bg-nexus-bg border-nexus-border text-nexus-muted'
                          )}
                        >
                          {isDxgi && <ShieldCheck className="w-2.5 h-2.5" />}
                          <span>{isDxgi ? 'DXGI • Sem borda amarela' : 'WGC Monitor'}</span>
                        </span>
                      )}

                      {src.is_hdr && (
                        <span className="px-1.5 py-0.5 rounded bg-amber-500/15 border border-amber-500/30 text-amber-300 font-semibold">
                          HDR
                        </span>
                      )}

                      {src.kind === 'WgcWindow' && (
                        <>
                          {src.process_name && (
                            <span className="px-1.5 py-0.5 rounded bg-nexus-bg border border-nexus-border text-nexus-muted truncate max-w-[140px]">
                              {src.process_name}
                            </span>
                          )}
                          <span className="px-1.5 py-0.5 rounded bg-nexus-bg border border-nexus-border text-nexus-muted font-mono">
                            PID {src.pid}
                          </span>
                          {src.is_minimized && (
                            <span className="px-1.5 py-0.5 rounded bg-amber-500/10 border border-amber-500/30 text-amber-300 inline-flex items-center gap-1">
                              <AlertTriangle className="w-2.5 h-2.5" />
                              <span>Minimizada</span>
                            </span>
                          )}
                        </>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Options & Quality */}
        <div className="px-5 py-4 border-t border-nexus-border bg-nexus-bg/40 space-y-3.5 shrink-0">
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[11px] font-semibold text-nexus-muted uppercase tracking-wider">
                Qualidade da transmissão
              </span>
              <span className="text-[10px] text-emerald-400 font-medium">
                Todos os perfis liberados
              </span>
            </div>
            <div className="grid grid-cols-5 gap-1.5">
              {FREE_QUALITY_PRESETS.map((opt) => {
                const active = preset === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setPreset(opt.value)}
                    className={cn(
                      'px-2 py-1.5 rounded-lg border text-center transition-colors cursor-pointer',
                      active
                        ? 'bg-nexus-accent/20 border-nexus-accent text-nexus-text'
                        : 'bg-nexus-panel border-nexus-border text-nexus-muted hover:text-nexus-text'
                    )}
                  >
                    <div className="text-[11px] font-bold">{opt.label}</div>
                    <div className="text-[9px] opacity-80 truncate">{opt.sublabel}</div>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <label className="inline-flex items-center gap-2 text-xs text-nexus-text cursor-pointer select-none">
              <input
                type="checkbox"
                checked={cursorEnabled}
                onChange={(e) => setCursorEnabled(e.target.checked)}
                className="rounded border-nexus-border bg-nexus-panel text-nexus-accent focus:ring-nexus-accent cursor-pointer"
              />
              <MousePointer className="w-3.5 h-3.5 text-nexus-muted" />
              <span>Mostrar cursor</span>
            </label>

            <label className="inline-flex items-center gap-2 text-xs text-nexus-text cursor-pointer select-none">
              <input
                type="checkbox"
                checked={includeAppAudio}
                onChange={(e) => setIncludeAppAudio(e.target.checked)}
                className="rounded border-nexus-border bg-nexus-panel text-nexus-accent focus:ring-nexus-accent cursor-pointer"
              />
              <Volume2 className="w-3.5 h-3.5 text-nexus-muted" />
              <span>Capturar áudio do aplicativo (WASAPI)</span>
            </label>
          </div>

          {activeError && (
            <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-xs text-rose-300 flex items-start gap-2.5">
              <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-rose-200">Falha ao iniciar transmissão</p>
                <p className="font-mono text-[11px] text-rose-300/90 break-words select-text mt-0.5">
                  {activeError}
                </p>
              </div>
            </div>
          )}

          {/* Footer Actions */}
          <div className="flex items-center justify-between gap-3 pt-1">
            <span className="text-[11px] text-nexus-muted truncate">
              {selectedSource
                ? `Selecionado: ${selectedSource.title || selectedSource.device_name}`
                : 'Selecione uma fonte para iniciar'}
            </span>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={closeScreenSourcePicker}
                disabled={isSubmitting}
                className="px-3.5 py-2 rounded-lg bg-nexus-panel hover:bg-nexus-bg border border-nexus-border text-xs font-medium text-nexus-text transition-colors cursor-pointer disabled:opacity-50"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={() => void handleConfirm()}
                disabled={!selectedSourceId || isSubmitting}
                className="px-4 py-2 rounded-lg bg-nexus-accent hover:bg-nexus-accent/90 text-white text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isSubmitting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                <span>Iniciar transmissão</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
