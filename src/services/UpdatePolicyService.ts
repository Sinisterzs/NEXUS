export type UpdateChannel = 'stable' | 'beta';

export interface BackendCompatibilityContract {
  min_client_version_stable?: string | null;
  min_client_version_nightly?: string | null;
}

const DISMISSED_NIGHTLY_KEY = 'nexus_dismissed_nightly_version';

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prereleaseNum: number | null;
}

export function parseVersion(raw: string): ParsedVersion | null {
  const cleaned = raw.trim().replace(/^v/i, '');
  const match = cleaned.match(/^(\d+)\.(\d+)\.(\d+)(?:-(?:nightly|beta|alpha)\.?(\d+))?/i);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prereleaseNum: match[4] !== undefined ? Number(match[4]) : null,
  };
}

export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return a.localeCompare(b);

  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  if (pa.patch !== pb.patch) return pa.patch - pb.patch;

  // Stable (prereleaseNum === null) is newer than prerelease of same major.minor.patch
  if (pa.prereleaseNum === null && pb.prereleaseNum === null) return 0;
  if (pa.prereleaseNum === null) return 1;
  if (pb.prereleaseNum === null) return -1;
  return pa.prereleaseNum - pb.prereleaseNum;
}

export function isPrerelease(version: string): boolean {
  const parsed = parseVersion(version);
  return parsed ? parsed.prereleaseNum !== null : /-/.test(version);
}

export function isVersionCompatible(
  currentVersion: string,
  channel: UpdateChannel,
  contract?: BackendCompatibilityContract | null,
): boolean {
  if (!contract) return true;
  const minVersion =
    channel === 'stable'
      ? contract.min_client_version_stable
      : contract.min_client_version_nightly;
  if (!minVersion || !minVersion.trim()) return true;
  return compareVersions(currentVersion, minVersion) >= 0;
}

export function isUpdateAllowedForChannel(
  currentVersion: string,
  candidateVersion: string,
  channel: UpdateChannel,
): boolean {
  if (channel === 'stable' && isPrerelease(candidateVersion)) {
    return false;
  }
  return compareVersions(candidateVersion, currentVersion) > 0;
}

export class UpdatePolicyService {
  getDismissedNightlyVersion(): string | null {
    try {
      return globalThis.localStorage?.getItem(DISMISSED_NIGHTLY_KEY) || null;
    } catch {
      return null;
    }
  }

  dismissNightlyVersion(version: string): void {
    try {
      globalThis.localStorage?.setItem(DISMISSED_NIGHTLY_KEY, version.trim());
    } catch {
      // Ignore storage errors
    }
  }

  clearDismissedNightlyVersion(): void {
    try {
      globalThis.localStorage?.removeItem(DISMISSED_NIGHTLY_KEY);
    } catch {
      // Ignore storage errors
    }
  }

  shouldShowNightlyNotification(
    currentVersion: string,
    availableVersion: string,
    mandatory: boolean,
  ): boolean {
    if (!isUpdateAllowedForChannel(currentVersion, availableVersion, 'beta')) {
      return false;
    }
    if (mandatory) {
      return true;
    }
    const dismissed = this.getDismissedNightlyVersion();
    if (!dismissed) return true;
    return compareVersions(availableVersion, dismissed) > 0;
  }
}

export const updatePolicyService = new UpdatePolicyService();

export async function fetchBackendCompatibility(): Promise<BackendCompatibilityContract | null> {
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      return await invoke<BackendCompatibilityContract>('updater_get_compatibility');
    } catch {
      return null;
    }
  }
  return null;
}
