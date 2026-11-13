/** Private binary IPC thumbnail: session, sequence, width, height, then BGRA8. */
export class BinaryPreviewUnavailableError extends Error {
  constructor() { super('Binary preview unavailable'); }
}
export interface PreviewProfile { width: number; height: number; fps: number }
export const PREVIEW_VISIBLE_KEY = 'nexus.screenPreview.visible';
export function readPreviewVisible(storage: Pick<Storage, 'getItem'> | undefined): boolean {
  try { return storage?.getItem(PREVIEW_VISIBLE_KEY) !== 'false'; } catch { return true; }
}
export function savePreviewVisible(storage: Pick<Storage, 'setItem'> | undefined, visible: boolean): void {
  try { storage?.setItem(PREVIEW_VISIBLE_KEY, String(visible)); } catch { /* session preference still applies */ }
}
/** Budget is independent of presentation mode: ~62 MB/s raw at most. */
export function previewProfile(width: number, height: number, fps: number): PreviewProfile {
  fps = Math.min(60, Math.max(5, Math.round(fps || 30)));
  const scale = Math.min(1, 960 / Math.max(2, width), 540 / Math.max(2, height),
    Math.sqrt(15_552_000 / (Math.max(2, width) * Math.max(2, height) * fps)));
  return { width: Math.max(2, Math.floor(width * scale / 2) * 2), height: Math.max(2, Math.floor(height * scale / 2) * 2), fps };
}
export interface PreviewMetrics {
  frames: number; fps: number; requestMs: number; nativeWaitMs: number;
  deliveryMs: number; conversionMs: number; renderMs: number; scheduleMs: number;
  width: number; height: number;
}
export interface PreviewFrame {
  sequence: number;
  nativeWaitMs: number;
  emittedAt: number;
  width: number;
  height: number;
  rgba: Uint8ClampedArray<ArrayBuffer>;
}
export function decodePreviewFrame(data: ArrayBuffer, session: number): PreviewFrame | null {
  // Tauri may fall back to JSON arrays if its binary IPC origin is CSP-blocked.
  // Refuse that expensive path; the app CSP explicitly allows Tauri's internal IPC.
  if (!(data instanceof ArrayBuffer)) throw new BinaryPreviewUnavailableError();
  if (!data.byteLength) return null;
  if (data.byteLength < 32) throw new Error('Invalid preview');
  const header = new DataView(data);
  if (header.getUint32(0, true) !== session) return null;
  const sequence = header.getUint32(4, true);
  const width = header.getUint32(8, true);
  const height = header.getUint32(12, true);
  if (!sequence || !width || !height || width > 960 || height > 540 || data.byteLength !== 32 + width * height * 4)
    throw new Error('Invalid preview');
  const rgba = new Uint8ClampedArray(data, 32);
  for (let i = 0; i < rgba.length; i += 4) {
    const blue = rgba[i]; rgba[i] = rgba[i + 2]; rgba[i + 2] = blue; rgba[i + 3] = 255;
  }
  return { sequence, width, height, rgba, nativeWaitMs: header.getUint32(16, true) / 1000, emittedAt: Number(header.getBigUint64(24, true)) / 1000 };
}
export type PreviewPhase = 'loading' | 'ready' | 'unavailable';
export interface PreviewConsumer {
  frame: (frame: PreviewFrame) => void | Promise<void>;
  phase: (phase: PreviewPhase) => void;
  metrics?: (metrics: PreviewMetrics) => void;
}
/** One long-poll request in flight. Deadlines include IPC, decode and paint time. */
export function startPreviewPolling(session: number, take: (session: number, profile?: PreviewProfile) => Promise<ArrayBuffer>, consumer: PreviewConsumer,
  options: { interval?: number; staleAfter?: number; visible?: () => boolean; profile?: () => PreviewProfile } = {}): () => void {
  let active = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastFrame = performance.now();
  let lastSequence = 0;
  let nextDeadline = performance.now();
  let frames = 0;
  const paints: number[] = [];
  const staleAfter = options.staleAfter ?? 3000;
  consumer.phase('loading');
  const poll = async () => {
    if (!active) return;
    const profile = options.profile?.() ?? { width: 480, height: 270, fps: 15 };
    const interval = options.interval ?? 1000 / profile.fps;
    const started = performance.now();
    const scheduleMs = Math.max(0, started - nextDeadline);
    let retryDelay = 0;
    if (options.visible?.() !== false) {
      try {
        const data = await take(session, profile);
        const received = performance.now();
        if (!active) return;
        const deliveryMs = data.byteLength >= 32 ? Math.max(0, Date.now() - Number(new DataView(data).getBigUint64(24, true)) / 1000) : 0;
        const decodeStart = performance.now();
        const frame = decodePreviewFrame(data, session);
        const conversionMs = performance.now() - decodeStart;
        if (frame && frame.sequence !== lastSequence) {
          lastSequence = frame.sequence;
          const renderStart = performance.now();
          await consumer.frame(frame);
          if (!active) return;
          const painted = performance.now();
          lastFrame = painted; frames++;
          paints.push(painted);
          while (paints.length > 1 && paints[0] < painted - 2000) paints.shift();
          consumer.phase('ready');
          consumer.metrics?.({ frames, fps: paints.length > 1 ? (paints.length - 1) * 1000 / (painted - paints[0]) : 0,
            requestMs: received - started, nativeWaitMs: frame.nativeWaitMs,
            deliveryMs: frame.emittedAt > 0 ? deliveryMs : 0, conversionMs,
            renderMs: painted - renderStart, scheduleMs, width: frame.width, height: frame.height });
        } else {
          retryDelay = options.interval ?? 250;
          if (performance.now() - lastFrame >= staleAfter) consumer.phase('unavailable');
        }
      } catch (error) {
        if (active) consumer.phase('unavailable');
        retryDelay = options.interval ?? 500;
        if (error instanceof BinaryPreviewUnavailableError) active = false;
      }
    }
    // Never add a full interval after an already slow IPC/paint. Skip old deadlines.
    nextDeadline = Math.max(nextDeadline + interval, started + interval);
    if (active) timer = setTimeout(poll, options.visible?.() === false ? 250 : Math.max(retryDelay, nextDeadline - performance.now()));
  };
  void poll();
  return () => { active = false; clearTimeout(timer); };
}
