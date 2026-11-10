export const APP_VERSION = '0.2.1';

export type VersionType = 'stable' | 'prerelease';

export interface InstalledVersionInfo {
  version: string;
  isPrerelease: boolean;
  isNightly: boolean;
  prereleaseTag: string | null;
  badgeLabel: 'VERSÃO ESTÁVEL' | 'VERSÃO NIGHTLY/BETA';
}

/**
 * Detecta se a versão fornecida é experimental/prerelease pelo padrão SemVer 2.0.0.
 * Versões pré-lançamento contêm um hífen após a versão patch, seguido por identificadores (-nightly, -beta, -rc, etc.).
 */
export function isPrereleaseVersion(version: string = APP_VERSION): boolean {
  if (!version || typeof version !== 'string') return false;
  const trimmed = version.trim().replace(/^v/i, '');
  const beforeBuild = trimmed.split('+')[0];
  const match = beforeBuild.match(/^[0-9]+\.[0-9]+\.[0-9]+-(.+)$/);
  return Boolean(match && match[1]?.length > 0);
}

/**
 * Detecta se a versão fornecida é especificamente do tipo nightly.
 */
export function isNightlyVersion(version: string = APP_VERSION): boolean {
  if (!version || typeof version !== 'string') return false;
  return isPrereleaseVersion(version) && /nightly/i.test(version);
}

/**
 * Retorna os metadados da versão instalada e os dados do badge independente:
 * - Versão Stable -> "VERSÃO ESTÁVEL"
 * - Versão experimental -> "VERSÃO NIGHTLY/BETA"
 */
export function getInstalledVersionInfo(version: string = APP_VERSION): InstalledVersionInfo {
  const isPrerelease = isPrereleaseVersion(version);
  const isNightly = isNightlyVersion(version);
  let prereleaseTag: string | null = null;

  if (isPrerelease) {
    const trimmed = version.trim().replace(/^v/i, '');
    const beforeBuild = trimmed.split('+')[0];
    const hyphenIdx = beforeBuild.indexOf('-');
    if (hyphenIdx !== -1) {
      prereleaseTag = beforeBuild.substring(hyphenIdx + 1);
    }
  }

  return {
    version,
    isPrerelease,
    isNightly,
    prereleaseTag,
    badgeLabel: isPrerelease ? 'VERSÃO NIGHTLY/BETA' : 'VERSÃO ESTÁVEL',
  };
}
