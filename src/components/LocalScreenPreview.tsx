import { useEffect, useRef, useState } from 'react';
import { Maximize2, Minimize2, Loader2, Monitor, Eye, EyeOff } from 'lucide-react';
import { screenCaptureService } from '../services/ScreenCaptureService';
import { startPreviewPolling, previewProfile, readPreviewVisible, savePreviewVisible, type PreviewPhase, type PreviewProfile } from '../services/ScreenPreview';

export function LocalScreenPreview({ sessionId, sourceName, isWindow, targetFps, sourceWidth, sourceHeight }: {
  sessionId: number; sourceName: string; isWindow: boolean; targetFps: number; sourceWidth: number; sourceHeight: number;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const section = useRef<HTMLElement>(null);
  const expandButton = useRef<HTMLButtonElement>(null);
  const profile = useRef<PreviewProfile>({ width: 480, height: 270, fps: 15 });
  const [enabled, setEnabled] = useState(() => readPreviewVisible(window.localStorage));
  const [phase, setPhase] = useState<PreviewPhase>('loading');
  const [expanded, setExpanded] = useState(false);
  const ratio = sourceWidth > 0 && sourceHeight > 0 ? sourceWidth / sourceHeight : 16 / 9;
  const [fps, setFps] = useState(0);
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const update = () => {
      const rect = element.getBoundingClientRect();
      profile.current = previewProfile(Math.max(64, Math.ceil(rect.width)), Math.max(36, Math.ceil(rect.height)), targetFps);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [expanded, ratio, targetFps, enabled]);
  useEffect(() => {
    if (!enabled) {
      void screenCaptureService.setNativePreviewVisible(sessionId, false).catch(() => {});
      return;
    }
    const element = canvas.current;
    if (!element) return;
    const context = element.getContext('2d');
    if (!context) { setPhase('unavailable'); return; }
    let alive = true;
    let animation = 0;
    let finishPaint: (() => void) | undefined;
    let lastMetrics = 0;
    let stop = () => {};
    setPhase('loading'); setFps(0);
    void screenCaptureService.setNativePreviewVisible(sessionId, true).then(() => {
      if (!alive) return;
      stop = startPreviewPolling(sessionId, (id, config) => screenCaptureService.takeNativePreview(id, config), {
      frame(frame) {
        return new Promise<void>((resolve) => {
          finishPaint = resolve;
          animation = requestAnimationFrame(() => {
            if (alive) {
              // Resizing clears/reallocates canvas storage. Do it only on a size change.
              if (element.width !== frame.width || element.height !== frame.height) {
                element.width = frame.width; element.height = frame.height;
                // Source ratio stays stable across rounding/adaptive preview resolutions.
              }
              context.putImageData(new ImageData(frame.rgba, frame.width, frame.height), 0, 0);
            }
            finishPaint = undefined; resolve();
          });
        });
      },
      phase(next) {
        setPhase(next);
        if (next !== 'ready') context.clearRect(0, 0, element.width, element.height);
      },
      metrics(metrics) {
        // Scalar timings only. Never expose/store pixels through diagnostics.
        if (section.current) section.current.dataset.previewMetrics = JSON.stringify(metrics);
        if (performance.now() - lastMetrics > 500) { setFps(Math.round(metrics.fps)); lastMetrics = performance.now(); }
      },
    }, { visible: () => !document.hidden, profile: () => profile.current });
    }).catch(() => { if (alive) setPhase('unavailable'); });
    return () => {
      alive = false; stop(); cancelAnimationFrame(animation); finishPaint?.();
      element.width = 0; element.height = 0;
      void screenCaptureService.setNativePreviewVisible(sessionId, false).catch(() => {});
    };
  }, [sessionId, enabled]);
  useEffect(() => {
    if (!expanded) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setExpanded(false); expandButton.current?.focus(); }
    };
    document.addEventListener('keydown', escape);
    expandButton.current?.focus();
    return () => document.removeEventListener('keydown', escape);
  }, [expanded]);
  return (
    <section ref={section} aria-label="Prévia local do compartilhamento" data-local-screen-preview
      data-preview-enabled={enabled} data-preview-expanded={expanded} data-preview-kind={isWindow ? 'window' : 'monitor'}
      style={expanded ? undefined : { maxWidth: `min(100%, calc(48vh * ${ratio}), ${480 * ratio}px)` }}
      className={expanded
        ? 'fixed top-12 bottom-28 left-3 right-3 sm:left-6 sm:right-6 z-[90] rounded-xl border border-nexus-border bg-nexus-bg p-3 flex flex-col gap-2 shadow-2xl min-h-0'
        : 'w-full min-w-0 mx-auto rounded-xl border border-nexus-border bg-nexus-surface overflow-hidden'}>
      <div className="flex items-center gap-2 px-3 py-2.5 text-xs text-nexus-text min-w-0 shrink-0">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" />
        <span className="truncate flex-1" title={sourceName}>Sua tela · {sourceName}</span>
        <button type="button" aria-label={enabled ? 'Ocultar prévia local' : 'Mostrar prévia local'} aria-pressed={enabled}
          onClick={() => { const next = !enabled; savePreviewVisible(window.localStorage, next); setExpanded(false); setEnabled(next); }}
          title={enabled ? 'Ocultar prévia local' : 'Mostrar prévia local'}
          className="p-1.5 rounded hover:bg-nexus-panel text-nexus-muted hover:text-nexus-text cursor-pointer">
          {enabled ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
        </button>
        {enabled && phase === 'ready' && <span className="text-[10px] text-nexus-muted tabular-nums shrink-0">{fps} FPS</span>}
        {enabled && <button ref={expandButton} type="button" onClick={() => setExpanded((value) => !value)}
          aria-label={expanded ? 'Reduzir prévia' : 'Expandir prévia'}
          className="p-1.5 rounded hover:bg-nexus-panel text-nexus-muted hover:text-nexus-text cursor-pointer">
          {expanded ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
        </button>}
      </div>
      {!enabled && <p role="status" className="px-3 pb-3 text-xs text-nexus-muted">Prévia oculta. Seu compartilhamento continua ativo.</p>}
      {enabled && <div ref={viewport} className="relative min-h-0 flex items-center justify-center bg-black/60 overflow-hidden"
        style={expanded ? { flex: 1 } : { aspectRatio: ratio, width: '100%' }}>
        <canvas ref={canvas} aria-label={`Sua prévia: ${sourceName}`}
          className="absolute inset-0 block w-full h-full object-contain"
          style={{ visibility: phase === 'ready' ? 'visible' : 'hidden' }} />
        {phase !== 'ready' && <div role="status" className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-3 text-xs text-nexus-muted text-center">
          {phase === 'loading' ? <Loader2 className="w-5 h-5 animate-spin" /> : <Monitor className="w-5 h-5" />}
          <span>{phase === 'loading' ? 'Carregando prévia…' : 'Prévia indisponível. A transmissão continua.'}</span>
        </div>}
      </div>
      }
      {expanded && <p className="text-xs text-nexus-muted shrink-0">Sua prévia local · Esc para reduzir</p>}
    </section>
  );
}
