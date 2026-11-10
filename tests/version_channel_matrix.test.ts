import test from 'node:test';
import assert from 'node:assert/strict';
import { getInstalledVersionInfo } from '../src/version.ts';
import { resolveChannelVersionComparison } from '../src/services/UpdateService.ts';

test('Matriz Cenário 1: Stable 0.2.0 + canal Stable (remoto 0.2.0) -> up_to_date sem downgrade', () => {
  const installedInfo = getInstalledVersionInfo('0.2.0');
  assert.equal(installedInfo.isPrerelease, false);
  assert.equal(installedInfo.badgeLabel, 'VERSÃO ESTÁVEL');

  const resolution = resolveChannelVersionComparison({
    currentVersion: '0.2.0',
    latestRemoteVersion: '0.2.0',
    updateAvailable: false,
    isCurrentHigher: false,
    channel: 'stable',
  });

  assert.equal(resolution.status, 'up_to_date');
  assert.equal(resolution.isDowngradeNotice, false);
  assert.equal(resolution.downgradeNoticeMessage, null);
  assert.match(resolution.statusMessage || '', /já está atualizado.*Estável/i);
});

test('Matriz Cenário 2 (Bug Fix): Stable 0.2.0 + canal Beta (remoto 0.1.9-nightly.7) -> up_to_date sem falso aviso de versão experimental', () => {
  // A versão instalada DEVE permanecer classificada como estável
  const installedInfo = getInstalledVersionInfo('0.2.0');
  assert.equal(installedInfo.isPrerelease, false);
  assert.equal(installedInfo.badgeLabel, 'VERSÃO ESTÁVEL');

  // Consulta do updater: 0.2.0 > 0.1.9-nightly.7 (isCurrentHigher = true)
  const resolution = resolveChannelVersionComparison({
    currentVersion: '0.2.0',
    latestRemoteVersion: '0.1.9-nightly.7',
    updateAvailable: false,
    isCurrentHigher: true,
    channel: 'beta',
  });

  // NÃO deve emitir status downgrade_notice
  assert.equal(resolution.status, 'up_to_date');
  assert.equal(resolution.isDowngradeNotice, false);
  assert.equal(resolution.downgradeNoticeMessage, null);
  assert.equal(resolution.noticeTitle, null);

  // Mensagem explicativa amigável informando que a instalação é estável e aguarda novos builds Beta
  assert.ok(resolution.statusMessage);
  assert.match(resolution.statusMessage, /versão estável oficial/i);
  assert.match(resolution.statusMessage, /Canal Beta \/ Nightly está ativo/i);
  assert.doesNotMatch(resolution.statusMessage, /versão experimental em execução/i);
  assert.doesNotMatch(resolution.statusMessage, /versão estável mais recente é a v0\.1\.9-nightly/i);
});

test('Matriz Cenário 3: Stable 0.2.0 + canal Beta (remoto 0.2.1-nightly.1) -> update available', () => {
  const resolution = resolveChannelVersionComparison({
    currentVersion: '0.2.0',
    latestRemoteVersion: '0.2.1-nightly.1',
    updateAvailable: true,
    isCurrentHigher: false,
    channel: 'beta',
  });

  assert.equal(resolution.status, 'available');
  assert.equal(resolution.isDowngradeNotice, false);
  assert.equal(resolution.downgradeNoticeMessage, null);
});

test('Matriz Cenário 4: Nightly 0.1.9-nightly.7 + canal Beta (remoto 0.1.9-nightly.7) -> up_to_date', () => {
  const installedInfo = getInstalledVersionInfo('0.1.9-nightly.7');
  assert.equal(installedInfo.isPrerelease, true);
  assert.equal(installedInfo.badgeLabel, 'VERSÃO NIGHTLY/BETA');

  const resolution = resolveChannelVersionComparison({
    currentVersion: '0.1.9-nightly.7',
    latestRemoteVersion: '0.1.9-nightly.7',
    updateAvailable: false,
    isCurrentHigher: false,
    channel: 'beta',
  });

  assert.equal(resolution.status, 'up_to_date');
  assert.equal(resolution.isDowngradeNotice, false);
  assert.match(resolution.statusMessage || '', /já está atualizado.*Beta \/ Nightly/i);
});

test('Matriz Cenário 5: Nightly 0.1.9-nightly.7 + canal Stable (remoto 0.1.8) -> downgrade_notice legítimo', () => {
  const installedInfo = getInstalledVersionInfo('0.1.9-nightly.7');
  assert.equal(installedInfo.isPrerelease, true);

  const resolution = resolveChannelVersionComparison({
    currentVersion: '0.1.9-nightly.7',
    latestRemoteVersion: '0.1.8',
    updateAvailable: false,
    isCurrentHigher: true,
    channel: 'stable',
  });

  assert.equal(resolution.status, 'downgrade_notice');
  assert.equal(resolution.isDowngradeNotice, true);
  assert.equal(resolution.noticeTitle, 'Versão Experimental com Canal Estável Ativo');
  assert.ok(resolution.downgradeNoticeMessage);
  assert.match(resolution.downgradeNoticeMessage, /versão experimental \(v0\.1\.9-nightly\.7\)/i);
  assert.match(resolution.downgradeNoticeMessage, /Canal Estável ativo/i);
  assert.match(resolution.downgradeNoticeMessage, /Não haverá downgrade automático/i);
});

test('Matriz Cenário 6: Nightly 0.1.9-nightly.7 + canal Stable (remoto 0.2.0) -> update available para Stable oficial', () => {
  const resolution = resolveChannelVersionComparison({
    currentVersion: '0.1.9-nightly.7',
    latestRemoteVersion: '0.2.0',
    updateAvailable: true,
    isCurrentHigher: false,
    channel: 'stable',
  });

  assert.equal(resolution.status, 'available');
  assert.equal(resolution.isDowngradeNotice, false);
  assert.equal(resolution.downgradeNoticeMessage, null);
});

test('Matriz Cenário 7: Comportamento quando silent = true preserva idle em verificação de fundo', () => {
  const resolutionSilent = resolveChannelVersionComparison({
    currentVersion: '0.2.0',
    latestRemoteVersion: '0.1.9-nightly.7',
    updateAvailable: false,
    isCurrentHigher: true,
    channel: 'beta',
    silent: true,
  });

  assert.equal(resolutionSilent.status, 'idle');
  assert.equal(resolutionSilent.isDowngradeNotice, false);
});
