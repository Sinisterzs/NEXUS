import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  APP_VERSION,
  getInstalledVersionInfo,
  inferDefaultUpdateChannel,
  isNightlyVersion,
  isPrereleaseVersion,
} from '../src/version.ts';
import { resolveChannelVersionComparison } from '../src/services/UpdateService.ts';
import { PreloginUpdaterService } from '../src/services/PreloginUpdaterService.ts';
import type {
  PreloginCheckResult,
  PreloginProgressEvent,
  PreloginStartupState,
  PreloginUpdaterBackend,
} from '../src/services/PreloginUpdaterService.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const EXPECTED_NIGHTLY4_VERSION = '0.3.0-nightly.4';
const OFFICIAL_MINISIGN_PUBKEY = 'RWSd5/ox8A8dk+NW9lqVAMuCKxJvH9kzKpUxCk1SmABC7b4+8zd5cfHf';
const OFFICIAL_MINISIGN_KEY_ID = '931D0FF031FAE79D';

/**
 * Pure SemVer 2.0.0 comparator matching Rust's `semver::Version` precedence rules.
 * Returns > 0 if a > b, < 0 if a < b, 0 if equal.
 */
function compareSemver(a: string, b: string): number {
  const parse = (raw: string) => {
    const clean = raw.trim().replace(/^v/i, '').split('+')[0];
    const hyphenIdx = clean.indexOf('-');
    const core = hyphenIdx === -1 ? clean : clean.slice(0, hyphenIdx);
    const pre = hyphenIdx === -1 ? [] : clean.slice(hyphenIdx + 1).split('.');
    const parts = core.split('.').map((n) => Number(n));
    return {
      major: parts[0] || 0,
      minor: parts[1] || 0,
      patch: parts[2] || 0,
      pre,
    };
  };

  const va = parse(a);
  const vb = parse(b);

  if (va.major !== vb.major) return va.major > vb.major ? 1 : -1;
  if (va.minor !== vb.minor) return va.minor > vb.minor ? 1 : -1;
  if (va.patch !== vb.patch) return va.patch > vb.patch ? 1 : -1;

  if (va.pre.length === 0 && vb.pre.length === 0) return 0;
  if (va.pre.length === 0) return 1; // Release version has higher precedence than prerelease
  if (vb.pre.length === 0) return -1;

  const len = Math.max(va.pre.length, vb.pre.length);
  for (let i = 0; i < len; i++) {
    const ia = va.pre[i];
    const ib = vb.pre[i];
    if (ia === undefined) return -1;
    if (ib === undefined) return 1;

    const na = /^\d+$/.test(ia) ? Number(ia) : null;
    const nb = /^\d+$/.test(ib) ? Number(ib) : null;

    if (na !== null && nb !== null) {
      if (na !== nb) return na > nb ? 1 : -1;
    } else if (na !== null) {
      return -1; // Numeric identifiers have lower precedence than non-numeric
    } else if (nb !== null) {
      return 1;
    } else if (ia !== ib) {
      return ia > ib ? 1 : -1;
    }
  }

  return 0;
}

class MockPreloginBackend implements PreloginUpdaterBackend {
  public checkCalls = 0;
  public downloadedCalled = false;
  public restartCalled = false;
  private readonly checkResult: PreloginCheckResult;

  constructor(checkResult: PreloginCheckResult) {
    this.checkResult = checkResult;
  }

  async checkPrelogin(_channel: 'stable' | 'beta'): Promise<PreloginCheckResult> {
    this.checkCalls++;
    return this.checkResult;
  }

  async downloadAndInstall(
    _updateResult: PreloginCheckResult,
    onProgress: (evt: PreloginProgressEvent) => void
  ): Promise<void> {
    this.downloadedCalled = true;
    onProgress({
      downloadedBytes: 5_000_000,
      totalBytes: 10_000_000,
      percent: 50,
      stage: 'downloading',
    });
    onProgress({
      downloadedBytes: 10_000_000,
      totalBytes: 10_000_000,
      percent: 100,
      stage: 'installing',
    });
  }

  async restart(): Promise<void> {
    this.restartCalled = true;
  }
}

// =============================================================================
// 1. All 6 version metadata files on integration/nexus-v0.3.0-nightly.4
// =============================================================================
test('Nightly.4 Metadata — All 6 version metadata files are exactly 0.3.0-nightly.4', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  const pkgLock = JSON.parse(fs.readFileSync(path.join(rootDir, 'package-lock.json'), 'utf8'));
  const tauriConf = JSON.parse(
    fs.readFileSync(path.join(rootDir, 'src-tauri', 'tauri.conf.json'), 'utf8')
  );
  const versionTs = fs.readFileSync(path.join(rootDir, 'src', 'version.ts'), 'utf8');
  const cargoToml = fs.readFileSync(path.join(rootDir, 'src-tauri', 'Cargo.toml'), 'utf8');
  const cargoLock = fs.readFileSync(path.join(rootDir, 'src-tauri', 'Cargo.lock'), 'utf8');

  const versionTsMatch = versionTs.match(/export const APP_VERSION = '([^']+)';/);
  const cargoTomlMatch = cargoToml.match(/^\[package\][\s\S]*?^version = "([^"]+)"/m);
  const cargoLockMatch = cargoLock.match(/\[\[package\]\]\r?\nname = "nexus"\r?\nversion = "([^"]+)"/);

  assert.equal(pkg.version, EXPECTED_NIGHTLY4_VERSION, 'package.json version must be 0.3.0-nightly.4');
  assert.equal(pkgLock.version, EXPECTED_NIGHTLY4_VERSION, 'package-lock.json version must be 0.3.0-nightly.4');
  assert.equal(
    pkgLock.packages?.['']?.version,
    EXPECTED_NIGHTLY4_VERSION,
    'package-lock.json root package version must be 0.3.0-nightly.4'
  );
  assert.equal(
    tauriConf.version,
    EXPECTED_NIGHTLY4_VERSION,
    'src-tauri/tauri.conf.json version must be 0.3.0-nightly.4'
  );
  assert.equal(APP_VERSION, EXPECTED_NIGHTLY4_VERSION, 'Imported APP_VERSION must be 0.3.0-nightly.4');
  assert.equal(
    versionTsMatch?.[1],
    EXPECTED_NIGHTLY4_VERSION,
    'src/version.ts APP_VERSION literal must be 0.3.0-nightly.4'
  );
  assert.equal(
    cargoTomlMatch?.[1],
    EXPECTED_NIGHTLY4_VERSION,
    'src-tauri/Cargo.toml version must be 0.3.0-nightly.4'
  );
  assert.equal(
    cargoLockMatch?.[1],
    EXPECTED_NIGHTLY4_VERSION,
    'src-tauri/Cargo.lock nexus package version must be 0.3.0-nightly.4'
  );

  const info = getInstalledVersionInfo(APP_VERSION);
  assert.equal(isPrereleaseVersion(APP_VERSION), true);
  assert.equal(isNightlyVersion(APP_VERSION), true);
  assert.equal(inferDefaultUpdateChannel(APP_VERSION), 'beta');
  assert.equal(info.prereleaseTag, 'nightly.4');
  assert.equal(info.badgeLabel, 'VERSÃO NIGHTLY/BETA');
});

// =============================================================================
// 2. Release notes v0.3.0-nightly.4 completeness
// =============================================================================
test('Nightly.4 Release Notes — Exists and covers Password Recovery, Pre-Login Auto Updater 0.1, Google Login, and Calls & Streaming 2.1', () => {
  const releaseNotesPath = path.join(rootDir, 'scripts', 'release-notes-v0.3.0-nightly.4.md');
  assert.equal(fs.existsSync(releaseNotesPath), true, 'scripts/release-notes-v0.3.0-nightly.4.md must exist');

  const notes = fs.readFileSync(releaseNotesPath, 'utf8');
  assert.ok(notes.trim().length > 200, 'Release notes must have substantive content');

  assert.match(notes, /v?0\.3\.0-nightly\.4/, 'Must reference v0.3.0-nightly.4');
  assert.match(notes, /v?0\.3\.0-nightly\.3/, 'Must reference upgrade path from v0.3.0-nightly.3');
  assert.match(notes, /v?0\.2\.5/, 'Must reference Stable v0.2.5 alignment');
  assert.match(notes, /v?0\.2\.1/, 'Must reference current Stable v0.2.1');

  assert.match(
    notes,
    /Recuperação de Senha|Password Recovery/i,
    'Release notes must cover Password Recovery'
  );
  assert.match(
    notes,
    /Pre-Login Auto Updater 0\.1/i,
    'Release notes must cover Pre-Login Auto Updater 0.1'
  );
  assert.match(
    notes,
    /Google Login|Autenticação Google/i,
    'Release notes must cover Google Login'
  );
  assert.match(
    notes,
    /Chamadas e Transmissão 2\.1|Calls\s*&\s*Streaming 2\.1/i,
    'Release notes must cover Calls & Streaming 2.1'
  );
  assert.match(notes, /latest-nightly\.json/, 'Release notes must document latest-nightly.json isolation');
  assert.match(notes, /latest\.json/, 'Release notes must document latest.json isolation');
});

// =============================================================================
// 3. SemVer & Channel Compatibility Matrix (0.3.0-nightly.3, 0.3.0-nightly.4, 0.2.1, 0.2.5)
// =============================================================================
test('Channel Matrix — SemVer precedence across 0.2.1, 0.2.5, 0.3.0-nightly.3, and 0.3.0-nightly.4', () => {
  assert.ok(
    compareSemver('0.3.0-nightly.4', '0.3.0-nightly.3') > 0,
    "compareSemver('0.3.0-nightly.4', '0.3.0-nightly.3') must be > 0"
  );
  assert.ok(compareSemver('0.3.0-nightly.3', '0.3.0-nightly.4') < 0);

  assert.ok(
    compareSemver('0.2.5', '0.2.1') > 0,
    "compareSemver('0.2.5', '0.2.1') must be > 0"
  );
  assert.ok(compareSemver('0.2.1', '0.2.5') < 0);

  assert.ok(
    compareSemver('0.2.5', '0.3.0-nightly.4') < 0,
    "compareSemver('0.2.5', '0.3.0-nightly.4') must be < 0"
  );
  assert.ok(compareSemver('0.3.0-nightly.4', '0.2.5') > 0);
  assert.ok(compareSemver('0.3.0-nightly.3', '0.2.5') > 0);
  assert.ok(compareSemver('0.3.0', '0.3.0-nightly.4') > 0);
  assert.equal(compareSemver('0.3.0-nightly.4', '0.3.0-nightly.4'), 0);
});

test('Channel Matrix (1/4) — 0.3.0-nightly.3 on Beta channel detects 0.3.0-nightly.4 as an update', async () => {
  assert.ok(compareSemver('0.3.0-nightly.4', '0.3.0-nightly.3') > 0);

  const cmp = resolveChannelVersionComparison({
    currentVersion: '0.3.0-nightly.3',
    latestRemoteVersion: '0.3.0-nightly.4',
    updateAvailable: true,
    isCurrentHigher: false,
    channel: 'beta',
  });

  assert.equal(cmp.status, 'available');
  assert.equal(cmp.isDowngradeNotice, false);
  assert.equal(cmp.downgradeNoticeMessage, null);
  assert.equal(cmp.requiresConfirmation, true, 'Beta channel updates must prompt for confirmation');

  const history: PreloginStartupState[] = [];
  const backend = new MockPreloginBackend({
    updateAvailable: true,
    version: '0.3.0-nightly.4',
    currentVersion: '0.3.0-nightly.3',
    latestRemoteVersion: '0.3.0-nightly.4',
    isCurrentHigher: false,
    channel: 'beta',
    body: 'NEXUS v0.3.0-nightly.4 — Integração Completa (Recuperação de Senha, Google Login & Pre-Login Auto Updater 0.1)',
    rid: 304,
  });

  const service = new PreloginUpdaterService(backend);
  service.addListener((st) => history.push(st.status));
  await service.runStartupSequence({ channelOverride: 'beta' });

  assert.equal(service.getState().status, 'update_found');
  assert.equal(service.getState().updateInfo?.version, '0.3.0-nightly.4');
  assert.equal(backend.downloadedCalled, false, 'Beta update must wait for user confirmation');

  await service.confirmUpdate();
  assert.ok(history.includes('downloading'));
  assert.ok(history.includes('installing'));
  assert.ok(history.includes('restarting'));
  assert.equal(backend.downloadedCalled, true);
  assert.equal(backend.restartCalled, true);
});

test('Channel Matrix (2/4) — 0.2.1 on Stable channel detects 0.2.5 as an update', async () => {
  assert.ok(compareSemver('0.2.5', '0.2.1') > 0);

  const cmp = resolveChannelVersionComparison({
    currentVersion: '0.2.1',
    latestRemoteVersion: '0.2.5',
    updateAvailable: true,
    isCurrentHigher: false,
    channel: 'stable',
  });

  assert.equal(cmp.status, 'available');
  assert.equal(cmp.isDowngradeNotice, false);
  assert.equal(cmp.downgradeNoticeMessage, null);
  assert.equal(cmp.requiresConfirmation, false, 'Stable channel applies verified updates automatically');

  const history: PreloginStartupState[] = [];
  const backend = new MockPreloginBackend({
    updateAvailable: true,
    version: '0.2.5',
    currentVersion: '0.2.1',
    latestRemoteVersion: '0.2.5',
    isCurrentHigher: false,
    channel: 'stable',
    body: 'NEXUS v0.2.5 Stable — Recuperação de Senha, Login Google e Pre-Login Auto Updater 0.1.',
    rid: 205,
  });

  const service = new PreloginUpdaterService(backend);
  service.addListener((st) => history.push(st.status));
  await service.runStartupSequence({ channelOverride: 'stable' });

  assert.equal(history.includes('update_found'), false, 'Stable channel must not pause at update_found');
  assert.ok(history.includes('downloading'));
  assert.ok(history.includes('installing'));
  assert.ok(history.includes('restarting'));
  assert.equal(backend.downloadedCalled, true);
  assert.equal(backend.restartCalled, true);
});

test('Channel Matrix (3/4) — 0.2.5 on Stable channel never accepts 0.3.0-nightly.4 (prerelease blocked)', async () => {
  assert.equal(isPrereleaseVersion('0.3.0-nightly.4'), true);
  assert.equal(isPrereleaseVersion('0.2.5'), false);

  const cmp = resolveChannelVersionComparison({
    currentVersion: '0.2.5',
    latestRemoteVersion: '0.3.0-nightly.4',
    updateAvailable: true,
    isCurrentHigher: false,
    channel: 'stable',
  });

  assert.equal(cmp.status, 'error');
  assert.notEqual(cmp.status, 'available');
  assert.equal(cmp.requiresConfirmation, false);
  assert.equal(cmp.noticeTitle, 'Canal Estável Incompatível');
  assert.match(cmp.statusMessage || '', /rejeitou.*0\.3\.0-nightly\.4/i);

  const cmpSilent = resolveChannelVersionComparison({
    currentVersion: '0.2.5',
    latestRemoteVersion: '0.3.0-nightly.4',
    updateAvailable: true,
    isCurrentHigher: false,
    channel: 'stable',
    silent: true,
  });
  assert.equal(cmpSilent.status, 'idle');
  assert.notEqual(cmpSilent.status, 'available');

  let proceeded = false;
  const backend = new MockPreloginBackend({
    updateAvailable: true,
    version: '0.3.0-nightly.4',
    currentVersion: '0.2.5',
    latestRemoteVersion: '0.3.0-nightly.4',
    isCurrentHigher: false,
    channel: 'stable',
  });

  const service = new PreloginUpdaterService(backend);
  await service.runStartupSequence({
    channelOverride: 'stable',
    onProceed: () => {
      proceeded = true;
    },
  });

  assert.equal(service.getState().status, 'up_to_date');
  assert.equal(proceeded, true, 'Must proceed cleanly without installing prerelease on Stable');
  assert.equal(backend.downloadedCalled, false, 'Stable channel must never download 0.3.0-nightly.4');
  assert.equal(backend.restartCalled, false, 'Stable channel must never restart for 0.3.0-nightly.4');

  const updaterRs = fs.readFileSync(path.join(rootDir, 'src-tauri', 'src', 'updater.rs'), 'utf8');
  assert.match(updaterRs, /if norm_channel == "stable"/);
  assert.match(updaterRs, /!ver\.pre\.is_empty\(\)/);
  assert.match(updaterRs, /Canal Estável não instala versões experimentais\/pré-lançamento/);
});

test('Channel Matrix (4/4) — 0.3.0-nightly.4 never suffers forced downgrade to 0.2.5', async () => {
  assert.ok(
    compareSemver('0.2.5', '0.3.0-nightly.4') < 0,
    "compareSemver('0.2.5', '0.3.0-nightly.4') must be < 0"
  );

  // Case A: Beta channel remains up_to_date even if a remote returns 0.2.5 (isCurrentHigher = true)
  const betaVs025 = resolveChannelVersionComparison({
    currentVersion: '0.3.0-nightly.4',
    latestRemoteVersion: '0.2.5',
    updateAvailable: false,
    isCurrentHigher: true,
    channel: 'beta',
  });
  assert.equal(betaVs025.status, 'up_to_date');
  assert.equal(betaVs025.isDowngradeNotice, false);
  assert.notEqual(betaVs025.status, 'available');

  // Case B: User on 0.3.0-nightly.4 switches channel to Stable -> sees downgrade_notice, never forced downgrade
  for (const silent of [false, true]) {
    const stableVs025 = resolveChannelVersionComparison({
      currentVersion: '0.3.0-nightly.4',
      latestRemoteVersion: '0.2.5',
      updateAvailable: false,
      isCurrentHigher: true,
      channel: 'stable',
      silent,
    });
    assert.equal(stableVs025.status, 'downgrade_notice');
    assert.equal(stableVs025.isDowngradeNotice, true);
    assert.equal(stableVs025.requiresConfirmation, false);
    assert.equal(stableVs025.noticeTitle, 'Versão Experimental com Canal Estável Ativo');
    assert.match(stableVs025.downgradeNoticeMessage || '', /v0\.3\.0-nightly\.4/);
    assert.match(stableVs025.downgradeNoticeMessage || '', /v0\.2\.5/);
    assert.match(stableVs025.downgradeNoticeMessage || '', /Não haverá downgrade automático/i);
  }

  // Case C: PreloginUpdaterService on Stable channel while running 0.3.0-nightly.4 never downloads 0.2.5
  let proceeded = false;
  const backend = new MockPreloginBackend({
    updateAvailable: false,
    version: '0.2.5',
    currentVersion: '0.3.0-nightly.4',
    latestRemoteVersion: '0.2.5',
    isCurrentHigher: true,
    channel: 'stable',
  });

  const service = new PreloginUpdaterService(backend);
  await service.runStartupSequence({
    channelOverride: 'stable',
    onProceed: () => {
      proceeded = true;
    },
  });

  assert.equal(service.getState().status, 'up_to_date');
  assert.equal(proceeded, true);
  assert.equal(backend.downloadedCalled, false, 'Must never download 0.2.5 over 0.3.0-nightly.4');
  assert.equal(backend.restartCalled, false, 'Must never restart to downgrade 0.3.0-nightly.4');

  // Case D: Rust backend is_downgrade guard exists
  const updaterRs = fs.readFileSync(path.join(rootDir, 'src-tauri', 'src', 'updater.rs'), 'utf8');
  assert.match(updaterRs, /pub fn is_downgrade\(current: &str, remote: &str\)/);
  assert.match(updaterRs, /Ok\(curr >= rem\)/);
});

// =============================================================================
// 4. Zero tracked disposable lab/private files & release hygiene
// =============================================================================
test('Repository Hygiene — Zero tracked disposable lab/private files in git ls-files', () => {
  const gitOut = spawnSync('git', ['ls-files'], {
    cwd: rootDir,
    encoding: 'utf8',
    windowsHide: true,
  });

  assert.equal(gitOut.status, 0, `git ls-files failed: ${gitOut.stderr}`);
  const trackedFiles = gitOut.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  assert.ok(trackedFiles.length > 0, 'git ls-files must return tracked repository files');

  const forbiddenExactPaths = new Set([
    '.lab_keys',
    '.nexus-lab',
    'lab_dist',
    'nexus-lab.wsb',
    'run_logs',
    '.git_backup_safety',
    'test_homologation_profile',
    'test_updater_stage',
    'backup_registry_and_config',
    'scripts/build-lab-artifacts.cjs',
    'scripts/dispatch-homologation.mjs',
    'scripts/lab-prepare-artifacts.cjs',
    'homologation-report.json',
    'homologation-summary.txt',
    'latest.json',
    'latest-nightly.json',
    'nexus_settings.json',
  ]);

  const forbiddenPathPatterns: RegExp[] = [
    /(^|\/)\.lab_keys(\/|$)/i,
    /(^|\/)\.nexus-lab(\/|$)/i,
    /(^|\/)lab_dist(\/|$)/i,
    /(^|\/)run_logs(\/|$)/i,
    /(^|\/)\.git_backup_safety(\/|$)/i,
    /(^|\/)test_homologation_profile(\/|$)/i,
    /(^|\/)test_updater_stage(\/|$)/i,
    /(^|\/)backup_registry_and_config(\/|$)/i,
    /(^|\/)\.tauri(\/|$)/i,
    /-agent-models\.json$/i,
    /(^|\/)nexus_.*\.json$/i,
    /\.(key|pem|pfx|p12|crt|cert|db|db-shm|db-wal|sqlite|sqlite3|log|dump)$/i,
  ];

  const violations: string[] = [];
  for (const file of trackedFiles) {
    const normalized = file.replace(/\\/g, '/');
    const base = path.posix.basename(normalized);

    if (forbiddenExactPaths.has(normalized)) {
      violations.push(normalized);
      continue;
    }

    // Disallow real .env files while allowing *.env.example templates
    if (
      (base === '.env' || base.startsWith('.env.') || base.endsWith('.env')) &&
      !base.endsWith('.example')
    ) {
      violations.push(normalized);
      continue;
    }

    if (forbiddenPathPatterns.some((pattern) => pattern.test(normalized))) {
      violations.push(normalized);
    }
  }

  assert.deepEqual(
    violations,
    [],
    `Tracked lab/private files detected in git ls-files: ${violations.join(', ')}`
  );

  // Confirm test-lab remains strictly debug-only and never shipped in release builds
  const labRs = fs.readFileSync(path.join(rootDir, 'src-tauri', 'src', 'lab.rs'), 'utf8');
  assert.match(labRs, /#\[cfg\(all\(feature = "test-lab", not\(debug_assertions\)\)\)\]/);
  assert.match(labRs, /compile_error!\("test-lab is restricted to Debug builds"\)/);

  // Confirm Nightly workflow never passes --features test-lab
  const nightlyYml = fs.readFileSync(path.join(rootDir, '.github', 'workflows', 'nightly.yml'), 'utf8');
  assert.equal(nightlyYml.includes('--features test-lab'), false);

  // Confirm official production Minisign pubkey & HTTPS API endpoint
  const tauriConf = JSON.parse(
    fs.readFileSync(path.join(rootDir, 'src-tauri', 'tauri.conf.json'), 'utf8')
  );
  const decodedPubkey = Buffer.from(tauriConf.plugins.updater.pubkey, 'base64').toString('utf8');
  assert.ok(
    decodedPubkey.includes(OFFICIAL_MINISIGN_PUBKEY) && decodedPubkey.includes(OFFICIAL_MINISIGN_KEY_ID),
    'tauri.conf.json must keep the official production Minisign pubkey'
  );

  const nexusConfig = JSON.parse(fs.readFileSync(path.join(rootDir, 'nexus.config.json'), 'utf8'));
  assert.match(nexusConfig.apiUrl, /^https:\/\//);
  assert.equal(/localhost|127\.0\.0\.1/i.test(nexusConfig.apiUrl), false);
});
