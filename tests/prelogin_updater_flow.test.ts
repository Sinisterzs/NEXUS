import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PreloginUpdaterService,
} from '../src/services/PreloginUpdaterService.ts';
import type {
  PreloginUpdaterBackend,
  PreloginCheckResult,
  PreloginProgressEvent,
  PreloginStartupState,
} from '../src/services/PreloginUpdaterService.ts';

class MockPreloginBackend implements PreloginUpdaterBackend {
  public checkBehavior: (channel: 'stable' | 'beta') => Promise<PreloginCheckResult>;
  public downloadBehavior?: (
    updateResult: PreloginCheckResult,
    onProgress: (evt: PreloginProgressEvent) => void
  ) => Promise<void>;
  public restartCalled = false;
  public downloadedCalled = false;

  constructor(
    checkBehavior: (channel: 'stable' | 'beta') => Promise<PreloginCheckResult>,
    downloadBehavior?: (
      updateResult: PreloginCheckResult,
      onProgress: (evt: PreloginProgressEvent) => void
    ) => Promise<void>
  ) {
    this.checkBehavior = checkBehavior;
    this.downloadBehavior = downloadBehavior;
  }

  async checkPrelogin(channel: 'stable' | 'beta'): Promise<PreloginCheckResult> {
    return this.checkBehavior(channel);
  }

  async downloadAndInstall(
    updateResult: PreloginCheckResult,
    onProgress: (evt: PreloginProgressEvent) => void
  ): Promise<void> {
    this.downloadedCalled = true;
    if (this.downloadBehavior) {
      await this.downloadBehavior(updateResult, onProgress);
    } else {
      // Default simulated download progress
      onProgress({
        downloadedBytes: 10_000_000,
        totalBytes: 20_000_000,
        percent: 50,
        stage: 'downloading',
      });
      onProgress({
        downloadedBytes: 20_000_000,
        totalBytes: 20_000_000,
        percent: 100,
        stage: 'installing',
      });
    }
  }

  async restart(): Promise<void> {
    this.restartCalled = true;
  }
}

test('Prelogin Updater - Canal Stable com Atualização Disponível (Automático)', async () => {
  const history: PreloginStartupState[] = [];
  const backend = new MockPreloginBackend(
    async (channel) => ({
      updateAvailable: true,
      version: '0.2.1',
      currentVersion: '0.2.0',
      channel,
      body: 'Hotfix de segurança e estabilidade.',
      rid: 42,
    }),
    async (_res, onProgress) => {
      onProgress({ downloadedBytes: 5_000, totalBytes: 10_000, percent: 50, stage: 'downloading' });
      onProgress({ downloadedBytes: 10_000, totalBytes: 10_000, percent: 100, stage: 'installing' });
    }
  );

  const service = new PreloginUpdaterService(backend);
  service.addListener((st) => history.push(st.status));

  await service.runStartupSequence({ channelOverride: 'stable' });

  assert.ok(history.includes('checking'), 'Deveria passar pelo estado checking');
  assert.ok(history.includes('downloading'), 'Deveria passar pelo estado downloading');
  assert.ok(history.includes('installing'), 'Deveria passar pelo estado installing');
  assert.ok(history.includes('restarting'), 'Deveria finalizar no estado restarting');
  assert.equal(backend.restartCalled, true, 'Deveria ter chamado backend.restart');
});

test('Prelogin Updater - Canal Stable Sem Atualização (Up to Date)', async () => {
  const history: PreloginStartupState[] = [];
  let proceedTriggered = false;

  const backend = new MockPreloginBackend(async (channel) => ({
    updateAvailable: false,
    currentVersion: '0.2.0',
    channel,
  }));

  const service = new PreloginUpdaterService(backend);
  service.addListener((st) => history.push(st.status));

  await service.runStartupSequence({
    channelOverride: 'stable',
    onProceed: () => {
      proceedTriggered = true;
    },
  });

  assert.ok(history.includes('checking'), 'Deveria passar pelo estado checking');
  assert.equal(service.getState().status, 'up_to_date', 'Status final deve ser up_to_date');
  assert.equal(proceedTriggered, true, 'onProceed deve ser invocado imediatamente quando up-to-date');
  assert.equal(backend.downloadedCalled, false, 'Não deve baixar nada');
});

test('Prelogin Updater - Canal Nightly/Beta com Atualização (Confirmação com Changelog)', async () => {
  const history: PreloginStartupState[] = [];
  const backend = new MockPreloginBackend(async (channel) => ({
    updateAvailable: true,
    version: '0.3.0-nightly.3',
    currentVersion: '0.3.0-nightly.2',
    channel,
    body: '- Novo sistema de chamadas P2P\n- Melhorias no pipeline WebRTC',
    rid: 99,
  }));

  const service = new PreloginUpdaterService(backend);
  service.addListener((st) => history.push(st.status));

  await service.runStartupSequence({ channelOverride: 'beta' });

  // No canal Beta/Nightly, NÃO deve iniciar o download automaticamente: deve pausar em 'update_found'
  assert.equal(service.getState().status, 'update_found');
  assert.equal(service.getState().updateInfo?.version, '0.3.0-nightly.3');
  assert.ok(service.getState().updateInfo?.changelog?.includes('WebRTC'));
  assert.equal(backend.downloadedCalled, false, 'Download não deve iniciar sem confirmação');

  // Agora usuário clica em "Atualizar Agora"
  await service.confirmUpdate();
  assert.ok(history.includes('downloading'));
  assert.ok(history.includes('installing'));
  assert.ok(history.includes('restarting'));
  assert.equal(backend.restartCalled, true);
});

test('Prelogin Updater - Canal Nightly/Beta (Usuário clica Lembrar Mais Tarde)', async () => {
  let proceedCalled = false;
  const backend = new MockPreloginBackend(async (channel) => ({
    updateAvailable: true,
    version: '0.3.0-nightly.3',
    currentVersion: '0.3.0-nightly.2',
    channel,
    body: 'Notas de versão experimentais',
  }));

  const service = new PreloginUpdaterService(backend);
  await service.runStartupSequence({ channelOverride: 'beta' });

  assert.equal(service.getState().status, 'update_found');

  // Usuário opta por pular
  service.skipUpdate(() => {
    proceedCalled = true;
  });

  assert.equal(proceedCalled, true, 'onProceed deve ser chamado para avançar para AuthView');
  assert.equal(backend.downloadedCalled, false, 'Download não deve ter ocorrido');
});

test('Prelogin Updater - Modo Offline / Erro de Conexão (Não-bloqueante)', async () => {
  let proceedCalled = false;
  const backend = new MockPreloginBackend(async () => {
    throw new Error('Falha de conexão com a rede: DNS lookup failure');
  });

  const service = new PreloginUpdaterService(backend);
  await service.runStartupSequence({ channelOverride: 'stable' });

  assert.equal(service.getState().status, 'connection_error');
  assert.ok(service.getState().errorMessage?.includes('DNS lookup failure'));

  // Não bloqueia o usuário: permite avançar para a versão instalada
  service.skipUpdate(() => {
    proceedCalled = true;
  });

  assert.equal(proceedCalled, true, 'Deve permitir avançar mesmo com erro de rede');
});

test('Prelogin Updater - Falha de Instalação e Retry com Sucesso', async () => {
  let attempts = 0;
  const backend = new MockPreloginBackend(
    async (channel) => ({
      updateAvailable: true,
      version: '0.2.1',
      currentVersion: '0.2.0',
      channel,
      rid: 10,
    }),
    async (_res, onProgress) => {
      attempts++;
      if (attempts === 1) {
        throw new Error('Falha de escrita no diretório temporário');
      }
      onProgress({ downloadedBytes: 100, totalBytes: 100, percent: 100, stage: 'installing' });
    }
  );

  const service = new PreloginUpdaterService(backend);
  await service.runStartupSequence({ channelOverride: 'stable' });

  assert.equal(service.getState().status, 'install_error');
  assert.ok(service.getState().errorMessage?.includes('Falha de escrita'));
  assert.equal(backend.restartCalled, false);

  // Executa retry
  await service.retry();
  assert.equal(service.getState().status, 'restarting');
  assert.equal(backend.restartCalled, true);
  assert.equal(attempts, 2, 'Deveria ter tentado novamente com sucesso');
});

test('Prelogin Updater - Proteção contra concorrência (isBusy flag)', async () => {
  let checkCalls = 0;
  const backend = new MockPreloginBackend(async (channel) => {
    checkCalls++;
    await new Promise((r) => setTimeout(r, 20));
    return {
      updateAvailable: false,
      currentVersion: '0.2.0',
      channel,
    };
  });

  const service = new PreloginUpdaterService(backend);
  // Dispara múltiplas chamadas simultâneas
  const p1 = service.runStartupSequence({ channelOverride: 'stable' });
  const p2 = service.runStartupSequence({ channelOverride: 'stable' });
  const p3 = service.runStartupSequence({ channelOverride: 'stable' });

  await Promise.all([p1, p2, p3]);
  assert.equal(checkCalls, 1, 'Apenas 1 checagem deve ser executada');
});
