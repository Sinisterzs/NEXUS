/**
 * Pure layout calculation and configuration logic for CallsView and ActiveCallBar.
 * Provides deterministic layout presets, aspect-ratio calculators, and diagnostic formatters.
 */

export type CallLayoutMode = 'compact' | 'balanced' | 'cinema';

export interface LayoutPresetConfig {
  id: CallLayoutMode;
  label: string;
  shortLabel: string;
  ratio: number;
  description: string;
  participantCardStyle: 'full' | 'compact' | 'strip';
  controlsOverlay: boolean;
  maxContainerWidthClass: string;
}

export const CALL_LAYOUT_PRESETS: Record<CallLayoutMode, LayoutPresetConfig> = {
  compact: {
    id: 'compact',
    label: 'Compacto',
    shortLabel: 'Comp',
    ratio: 45,
    description: 'Vídeo menor, participantes totalmente visíveis',
    participantCardStyle: 'full',
    controlsOverlay: false,
    maxContainerWidthClass: 'max-w-5xl',
  },
  balanced: {
    id: 'balanced',
    label: 'Equilibrado',
    shortLabel: 'Equil',
    ratio: 68,
    description: 'Vídeo ampliado com participantes compactos',
    participantCardStyle: 'compact',
    controlsOverlay: false,
    maxContainerWidthClass: 'max-w-6xl',
  },
  cinema: {
    id: 'cinema',
    label: 'Cinema',
    shortLabel: 'Cinema',
    ratio: 92,
    description: 'Vídeo preenche a área máxima utilizável com controles discretos',
    participantCardStyle: 'strip',
    controlsOverlay: true,
    maxContainerWidthClass: 'max-w-full',
  },
};

/**
 * Resolves the layout mode given an explicit mode string or falls back to ratio inspection.
 */
export function resolveLayoutMode(
  explicitMode?: CallLayoutMode | null,
  splitRatio?: number
): CallLayoutMode {
  if (explicitMode && (explicitMode === 'compact' || explicitMode === 'balanced' || explicitMode === 'cinema')) {
    return explicitMode;
  }
  if (typeof splitRatio === 'number') {
    if (splitRatio <= 52) return 'compact';
    if (splitRatio >= 80) return 'cinema';
    return 'balanced';
  }
  return 'balanced';
}

/**
 * Clamps the stage split ratio within safe boundaries.
 */
export function clampSplitRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 68;
  return Math.max(30, Math.min(95, Math.round(ratio)));
}

/**
 * Calculates cinema stage dimensions ensuring native aspect ratio is never distorted.
 */
export interface CinemaDimensionsResult {
  usableWidth: number;
  usableHeight: number;
  renderWidth: number;
  renderHeight: number;
  letterboxType: 'pillarbox' | 'letterbox' | 'exact';
  aspectRatio: number;
}

export function calculateCinemaDimensions(
  viewportWidth: number,
  viewportHeight: number,
  sidebarWidth: number = 0,
  headerHeight: number = 48,
  videoAspectRatio: number = 16 / 9
): CinemaDimensionsResult {
  const safeVpW = Math.max(320, viewportWidth);
  const safeVpH = Math.max(240, viewportHeight);
  const usableWidth = Math.max(200, safeVpW - Math.max(0, sidebarWidth));
  const usableHeight = Math.max(160, safeVpH - Math.max(0, headerHeight));
  const targetAspect = videoAspectRatio > 0 ? videoAspectRatio : 16 / 9;

  const areaAspect = usableWidth / usableHeight;
  let renderWidth: number;
  let renderHeight: number;
  let letterboxType: 'pillarbox' | 'letterbox' | 'exact' = 'exact';

  if (Math.abs(areaAspect - targetAspect) < 0.01) {
    renderWidth = usableWidth;
    renderHeight = usableHeight;
    letterboxType = 'exact';
  } else if (areaAspect > targetAspect) {
    // Area is wider than video: pillarbox (black bars on left/right)
    renderHeight = usableHeight;
    renderWidth = Math.round(usableHeight * targetAspect);
    letterboxType = 'pillarbox';
  } else {
    // Area is taller than video: letterbox (black bars on top/bottom)
    renderWidth = usableWidth;
    renderHeight = Math.round(usableWidth / targetAspect);
    letterboxType = 'letterbox';
  }

  return {
    usableWidth,
    usableHeight,
    renderWidth,
    renderHeight,
    letterboxType,
    aspectRatio: targetAspect,
  };
}

/**
 * Determines whether the sidebar should be auto-collapsed when entering cinema mode.
 */
export function shouldSuggestSidebarCollapse(mode: CallLayoutMode, isSidebarCollapsed: boolean): boolean {
  return mode === 'cinema' && !isSidebarCollapsed;
}

/**
 * Returns the CSS classes for the stage container based on layout mode and fullscreen state.
 */
export function getStageContainerClasses(
  mode: CallLayoutMode,
  isFullscreen: boolean,
  hasAnyScreenStage: boolean
): string {
  if (isFullscreen) {
    return 'fixed inset-0 z-50 bg-black flex flex-col animate-fadeIn';
  }

  if (!hasAnyScreenStage) {
    return 'w-full max-w-4xl mx-auto flex flex-col items-center justify-center';
  }

  switch (mode) {
    case 'cinema':
      return 'w-full h-full flex-1 min-h-0 bg-black/95 rounded-xl border border-white/10 overflow-hidden shadow-2xl flex flex-col';
    case 'balanced':
      return 'w-full max-w-6xl bg-nexus-surface/95 border border-nexus-border rounded-2xl overflow-hidden shadow-2xl flex flex-col shrink-0';
    case 'compact':
    default:
      return 'w-full max-w-5xl bg-nexus-surface/95 border border-nexus-border rounded-2xl overflow-hidden shadow-2xl flex flex-col shrink-0';
  }
}

/**
 * Multi-stage FPS diagnostic details formatter.
 * Handles requested, captured, sent, received, rendered FPS.
 */
export interface DetailedFpsStats {
  requested?: number | null;
  captured?: number | null;
  sent?: number | null;
  received?: number | null;
  rendered?: number | null;
  effective?: number | null;
}

export function formatDetailedFps(stats?: DetailedFpsStats | null): {
  primaryLabel: string;
  secondaryDetails: string;
  hasBreakdown: boolean;
} {
  if (!stats) {
    return {
      primaryLabel: '—',
      secondaryDetails: '',
      hasBreakdown: false,
    };
  }

  const effective = stats.effective ?? stats.rendered ?? stats.received ?? stats.sent ?? stats.captured ?? null;
  const primaryLabel = effective !== null && Number.isFinite(effective) ? `${Math.round(effective)} FPS` : '—';

  const parts: string[] = [];
  if (stats.captured !== undefined && stats.captured !== null) {
    parts.push(`Cap: ${Math.round(stats.captured)}`);
  }
  if (stats.sent !== undefined && stats.sent !== null) {
    parts.push(`Env: ${Math.round(stats.sent)}`);
  }
  if (stats.received !== undefined && stats.received !== null) {
    parts.push(`Rec: ${Math.round(stats.received)}`);
  }
  if (stats.rendered !== undefined && stats.rendered !== null) {
    parts.push(`Rend: ${Math.round(stats.rendered)}`);
  }
  if (stats.requested !== undefined && stats.requested !== null) {
    parts.push(`Ped: ${Math.round(stats.requested)}`);
  }

  return {
    primaryLabel,
    secondaryDetails: parts.join(' | '),
    hasBreakdown: parts.length > 1,
  };
}
