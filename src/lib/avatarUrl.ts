/** Resolve a persisted backend avatar path without depending on native services. */
export function resolveAvatarUrl(
  avatarUrl: string | null | undefined,
  apiBaseUrl = 'https://nexus-api.dynv6.net',
): string | undefined {
  if (!avatarUrl) return undefined;
  const trimmed = avatarUrl.trim();
  if (!trimmed || trimmed.startsWith('data:')) return undefined;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  const base = apiBaseUrl.trim().replace(/\/+$/, '');
  return `${base}${trimmed.startsWith('/') ? trimmed : `/${trimmed}`}`;
}
