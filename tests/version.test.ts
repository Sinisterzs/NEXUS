import test from 'node:test';
import assert from 'node:assert/strict';
import {
  APP_VERSION,
  isPrereleaseVersion,
  isNightlyVersion,
  getInstalledVersionInfo,
} from '../src/version.ts';

test('SemVer: versões estáveis produzem VERSÃO ESTÁVEL', () => {
  const stableCases = ['0.1.8', '1.0.0', 'v0.1.8', '0.1.8+20261109', '2.5.10'];

  for (const ver of stableCases) {
    assert.equal(isPrereleaseVersion(ver), false, `Falha em isPrereleaseVersion para ${ver}`);
    assert.equal(isNightlyVersion(ver), false, `Falha em isNightlyVersion para ${ver}`);

    const info = getInstalledVersionInfo(ver);
    assert.equal(info.isPrerelease, false);
    assert.equal(info.isNightly, false);
    assert.equal(info.prereleaseTag, null);
    assert.equal(info.badgeLabel, 'VERSÃO ESTÁVEL');
  }
});

test('SemVer: versões experimentais produzem VERSÃO NIGHTLY/BETA', () => {
  const experimentalCases = [
    { ver: '0.1.9-nightly.3', isNightly: true, tag: 'nightly.3' },
    { ver: 'v0.1.9-nightly.1', isNightly: true, tag: 'nightly.1' },
    { ver: '0.1.9-beta.1', isNightly: false, tag: 'beta.1' },
    { ver: '0.1.9-rc.2', isNightly: false, tag: 'rc.2' },
    { ver: '0.1.9-alpha', isNightly: false, tag: 'alpha' },
    { ver: '0.1.9-nightly.2+build.99', isNightly: true, tag: 'nightly.2' },
  ];

  for (const { ver, isNightly, tag } of experimentalCases) {
    assert.equal(isPrereleaseVersion(ver), true, `Falha em isPrereleaseVersion para ${ver}`);
    assert.equal(isNightlyVersion(ver), isNightly, `Falha em isNightlyVersion para ${ver}`);

    const info = getInstalledVersionInfo(ver);
    assert.equal(info.isPrerelease, true);
    assert.equal(info.isNightly, isNightly);
    assert.equal(info.prereleaseTag, tag);
    assert.equal(info.badgeLabel, 'VERSÃO NIGHTLY/BETA');
  }
});

test('SemVer: APP_VERSION atual é detectada corretamente', () => {
  assert.ok(APP_VERSION);
  const info = getInstalledVersionInfo();
  assert.equal(info.version, APP_VERSION);
  assert.equal(info.isPrerelease, isPrereleaseVersion(APP_VERSION));
  assert.equal(info.isNightly, isNightlyVersion(APP_VERSION));
  assert.equal(info.badgeLabel, isPrereleaseVersion(APP_VERSION) ? 'VERSÃO NIGHTLY/BETA' : 'VERSÃO ESTÁVEL');
});

test('Regra de exibição de mismatch: Nightly instalada com canal Stable selecionado', () => {
  const installedInfo = getInstalledVersionInfo('0.1.9-nightly.3');

  // Caso 1: Nightly instalada + Canal Stable selecionado -> AVISO DEVE SER EXIBIDO
  const shouldShowWarning1 = installedInfo.isPrerelease && ('stable' as string) === 'stable';
  assert.equal(shouldShowWarning1, true);

  // Caso 2: Nightly instalada + Canal Beta selecionado -> AVISO NÃO DEVE SER EXIBIDO
  const shouldShowWarning2 = installedInfo.isPrerelease && ('beta' as string) === 'stable';
  assert.equal(shouldShowWarning2, false);

  // Caso 3: Versão Stable instalada + Canal Stable selecionado -> AVISO NÃO DEVE SER EXIBIDO
  const stableInfo = getInstalledVersionInfo('0.1.8');
  const shouldShowWarning3 = stableInfo.isPrerelease && ('stable' as string) === 'stable';
  assert.equal(shouldShowWarning3, false);
});
