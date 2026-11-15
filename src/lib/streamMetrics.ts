const INVALID_METRIC_TOKEN_RE =
  /(?:^|[^a-zA-Z0-9]|\dx)(?:NaN|-?Infinity|undefined|null)(?=$|[^a-zA-Z0-9]|p(?=$|[^a-zA-Z])|x|fps|kbps|mbps|ms)/i;

function normalizeNegativeZero(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}

/**
 * Checks whether a value is a finite number respecting zero semantics.
 */
export function isValidMetricNumber(
  value: unknown,
  options?: { allowZero?: boolean }
): value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return false;
  }
  return options?.allowZero === false ? value > 0 : value >= 0;
}

/**
 * Returns a finite non-negative number (normalizing -0 to 0), or null otherwise.
 */
export function sanitizeNonNegativeMetric(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return normalizeNegativeZero(value);
}

/**
 * Returns a finite strictly positive number, or null otherwise.
 */
export function sanitizePositiveMetric(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return value;
}

/**
 * Returns the first candidate satisfying metric validity, preserving legitimate 0.
 */
export function pickFirstValidMetric(
  candidates: unknown[],
  options?: { allowZero?: boolean }
): number | null {
  for (const candidate of candidates) {
    if (isValidMetricNumber(candidate, options)) {
      return normalizeNegativeZero(candidate);
    }
  }
  return null;
}

/**
 * Formats an FPS metric (`>= 0`), preserving `0 FPS` and falling back on invalid values.
 */
export function formatFpsMetric(
  value: unknown,
  unit = 'FPS',
  fallback = '—'
): string {
  const sanitized = sanitizeNonNegativeMetric(value);
  if (sanitized === null) {
    return fallback;
  }
  const rounded = normalizeNegativeZero(Math.round(sanitized));
  const trimmedUnit = unit.trim();
  return trimmedUnit ? `${rounded} ${trimmedUnit}` : String(rounded);
}

/**
 * Formats a bitrate in kbps (`>= 0`), preserving `0 kbps` and falling back on invalid values.
 */
export function formatBitrateKbpsMetric(
  value: unknown,
  fallback = '—'
): string {
  const sanitized = sanitizeNonNegativeMetric(value);
  if (sanitized === null) {
    return fallback;
  }
  return `${normalizeNegativeZero(Math.round(sanitized))} kbps`;
}

/**
 * Formats a bitrate in Mbps from bits per second (`>= 0`).
 */
export function formatBitrateMbpsFromBps(
  bps: unknown,
  fallback = '—'
): string {
  const sanitized = sanitizeNonNegativeMetric(bps);
  if (sanitized === null) {
    return fallback;
  }
  return `${(sanitized / 1_000_000).toFixed(2)} Mbps`;
}

/**
 * Formats a bitrate in Mbps from kilobits per second (`>= 0`).
 */
export function formatBitrateMbpsFromKbps(
  kbps: unknown,
  fallback = '—'
): string {
  const sanitized = sanitizeNonNegativeMetric(kbps);
  if (sanitized === null) {
    return fallback;
  }
  return `${(sanitized / 1_000).toFixed(2)} Mbps`;
}

/**
 * Formats width x height resolution requiring both dimensions to be strictly positive.
 */
export function formatResolutionMetric(
  width: unknown,
  height: unknown,
  separator = 'x',
  fallback = '—'
): string {
  const w = sanitizePositiveMetric(width);
  const h = sanitizePositiveMetric(height);
  if (w === null || h === null) {
    return fallback;
  }
  const roundedW = Math.round(w);
  const roundedH = Math.round(h);
  if (roundedW <= 0 || roundedH <= 0) {
    return fallback;
  }
  return `${roundedW}${separator}${roundedH}`;
}

/**
 * Formats a resolution height label like `1080p`, or returns fallback if height is invalid.
 */
export function formatResolutionHeightLabel(
  height: unknown,
  fallback: string | null = null
): string | null {
  const h = sanitizePositiveMetric(height);
  if (h === null) {
    return fallback;
  }
  const roundedH = Math.round(h);
  if (roundedH <= 0) {
    return fallback;
  }
  return `${roundedH}p`;
}

/**
 * Formats latency in milliseconds (`>= 0`), preserving `0 ms`.
 */
export function formatLatencyMsMetric(ms: unknown, fallback = '—'): string {
  const sanitized = sanitizeNonNegativeMetric(ms);
  if (sanitized === null) {
    return fallback;
  }
  return `${normalizeNegativeZero(Math.round(sanitized))} ms`;
}

/**
 * Formats a percentage metric (`>= 0`), preserving `0%`.
 */
export function formatPercentMetric(
  percent: unknown,
  fallback = '—'
): string {
  const sanitized = sanitizeNonNegativeMetric(percent);
  if (sanitized === null) {
    return fallback;
  }
  return `${normalizeNegativeZero(Math.round(sanitized))}%`;
}

/**
 * Formats a non-negative integer count with an optional unit suffix, preserving `0`.
 */
export function formatCountMetric(
  count: unknown,
  suffix?: string,
  fallback = '—'
): string {
  const sanitized = sanitizeNonNegativeMetric(count);
  if (sanitized === null) {
    return fallback;
  }
  const rounded = normalizeNegativeZero(Math.round(sanitized));
  const trimmedSuffix = suffix?.trim();
  return trimmedSuffix ? `${rounded} ${trimmedSuffix}` : String(rounded);
}

/**
 * Safely formats a duration in seconds as `MM:SS`, clamping invalid values to `00:00`.
 */
export function formatSafeDurationSecs(totalSeconds: unknown): string {
  const safeSecs = Math.floor(sanitizeNonNegativeMetric(totalSeconds) ?? 0);
  const mins = Math.floor(safeSecs / 60);
  const secs = safeSecs % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

/**
 * Sanitizes a pre-formatted metric label string, rejecting empty or NaN/Infinity tokens.
 */
export function sanitizeMetricLabel(label: unknown): string | null {
  if (typeof label !== 'string') {
    return null;
  }
  const trimmed = label.trim();
  if (!trimmed || INVALID_METRIC_TOKEN_RE.test(trimmed)) {
    return null;
  }
  return trimmed;
}
