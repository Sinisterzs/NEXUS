/**
 * Lightweight className combiner to avoid bloated external helper dependencies
 */
export function cn(...classes: (string | undefined | null | false)[]): string {
  return classes.filter(Boolean).join(' ');
}
