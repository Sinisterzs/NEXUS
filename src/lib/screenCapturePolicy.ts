export type CapturedDisplaySurface = 'monitor' | 'window' | 'browser';

export const SCREEN_CAPTURE_SELECTION_NOTICE =
  'Prefira compartilhar uma janela. Compartilhar um monitor pode incluir notificações e a barra de compartilhamento. Os indicadores de privacidade permanecem ativos.';

/** Only getSettings() describes the selected source; the picker hint is not a restriction. */
export function normalizeDisplaySurface(value: unknown): CapturedDisplaySurface | null {
  return value === 'monitor' || value === 'window' || value === 'browser' ? value : null;
}

export function getCaptureSourcePresentation(surface: CapturedDisplaySurface | null): {
  label: string;
  notice: string | null;
} {
  switch (surface) {
    case 'window':
      return { label: 'Janela', notice: null };
    case 'browser':
      return { label: 'Superfície do navegador', notice: null };
    case 'monitor':
      return {
        label: 'Monitor inteiro',
        notice: 'Monitor inteiro compartilhado: notificações e a barra de compartilhamento podem aparecer na transmissão. Para reduzir essa exposição, pare e selecione uma janela.',
      };
    default:
      return {
        label: 'Fonte não identificada',
        notice: 'O sistema não informou se a fonte é uma janela ou monitor. Confira a prévia; a barra de compartilhamento e outros conteúdos podem aparecer na transmissão.',
      };
  }
}

/** Retry only a rejected constraint shape/quality; never retry a denied or aborted selection. */
export function canRetryDisplayCapture(error: unknown): boolean {
  const name = typeof error === 'object' && error !== null && 'name' in error ? error.name : null;
  return name === 'OverconstrainedError' || name === 'TypeError';
}
