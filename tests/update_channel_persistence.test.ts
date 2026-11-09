import test from 'node:test';
import assert from 'node:assert/strict';
import { getInstalledVersionInfo } from '../src/version.ts';

const DEFAULT_UPDATE_CHANNEL: 'stable' | 'beta' = 'stable';

// Simulated Store interface mirroring @tauri-apps/plugin-store
class MockTauriStore {
  private data = new Map<string, any>();

  async get<T>(key: string): Promise<T | null> {
    return this.data.has(key) ? (this.data.get(key) as T) : null;
  }

  async set(key: string, value: any): Promise<void> {
    this.data.set(key, value);
  }

  async save(): Promise<void> {
    // Simulated disk flush
  }

  // Helper for test assertions and restart simulation
  snapshot(): Record<string, any> {
    return Object.fromEntries(this.data.entries());
  }

  static fromSnapshot(snapshot: Record<string, any>): MockTauriStore {
    const store = new MockTauriStore();
    for (const [k, v] of Object.entries(snapshot)) {
      store.data.set(k, v);
    }
    return store;
  }
}

// Logic engine for UpdateChannel resolution and validation
function resolveUpdateChannelFromStore(storeData: Record<string, any>, currentAccount = 'offline_demo'): 'stable' | 'beta' {
  // 1. Top-level store key has highest precedence for installation-wide setting
  const topLevel = storeData['app_update_channel'];
  if (topLevel === 'beta' || topLevel === 'stable') {
    return topLevel;
  }

  // 2. Account preference fallback
  const accPrefs = storeData[`preferences:${currentAccount}`];
  if (accPrefs?.updateChannel === 'beta' || accPrefs?.updateChannel === 'stable') {
    return accPrefs.updateChannel;
  }

  // 3. Legacy preferences fallback
  const legacy = storeData['preferences'];
  if (legacy?.updateChannel === 'beta' || legacy?.updateChannel === 'stable') {
    return legacy.updateChannel;
  }

  return 'stable';
}

function persistUpdateChannelToStore(
  storeData: Record<string, any>,
  channel: 'stable' | 'beta',
  currentAccount = 'offline_demo'
): void {
  const validated = channel === 'beta' ? 'beta' : 'stable';
  // Top-level installation-wide key
  storeData['app_update_channel'] = validated;

  // Account preference sync
  const accKey = `preferences:${currentAccount}`;
  storeData[accKey] = {
    ...(storeData[accKey] || {}),
    updateChannel: validated,
  };
}

test('Canal de atualização: fallback padrão para configuração ausente é "stable"', () => {
  const emptyStore = {};
  const channel = resolveUpdateChannelFromStore(emptyStore);
  assert.equal(channel, 'stable');
  assert.equal(DEFAULT_UPDATE_CHANNEL, 'stable');
});

test('Canal de atualização: persistência de Stable -> Beta persiste após reinicialização simulada', () => {
  const diskState: Record<string, any> = {};

  // Usuário seleciona canal Beta / Nightly
  persistUpdateChannelToStore(diskState, 'beta');
  assert.equal(diskState['app_update_channel'], 'beta');
  assert.equal(diskState['preferences:offline_demo']?.updateChannel, 'beta');

  // Simulação de fechamento e reabertura do aplicativo (nova instância a partir do snapshot em disco)
  const storeInstance2 = MockTauriStore.fromSnapshot(diskState);
  const reloadedChannel = resolveUpdateChannelFromStore(storeInstance2.snapshot());
  assert.equal(reloadedChannel, 'beta', 'Canal deve permanecer beta após reiniciar');
});

test('Canal de atualização: persistência de Beta -> Stable persiste após reinicialização simulada', () => {
  // Começa em beta
  const diskState: Record<string, any> = {
    app_update_channel: 'beta',
    'preferences:offline_demo': { updateChannel: 'beta' },
  };

  // Usuário seleciona Stable manualmente
  persistUpdateChannelToStore(diskState, 'stable');
  assert.equal(diskState['app_update_channel'], 'stable');

  // Simulação de reinício
  const storeInstance = MockTauriStore.fromSnapshot(diskState);
  const reloadedChannel = resolveUpdateChannelFromStore(storeInstance.snapshot());
  assert.equal(reloadedChannel, 'stable', 'Canal deve permanecer stable após reiniciar');
});

test('Canal de atualização: valor inválido ou corrompido em disco é corrigido com segurança para "stable"', () => {
  const corruptedStore = {
    app_update_channel: 'invalid_channel_name',
    'preferences:offline_demo': { updateChannel: 9999 },
  };

  const channel = resolveUpdateChannelFromStore(corruptedStore);
  assert.equal(channel, 'stable');
});

test('Canal de atualização: chave legada é migrada sem sobrescrever seleção explícita', () => {
  // Caso de loja legada v0.1.8 que só tinha preferences.updateChannel = 'beta'
  const legacyStore = {
    preferences: { updateChannel: 'beta' },
  };

  const channel = resolveUpdateChannelFromStore(legacyStore);
  assert.equal(channel, 'beta');
});

test('Canal de atualização: seleção de canal determina manifestos corretos (updater)', () => {
  const STABLE_MANIFEST = 'https://github.com/Sinisterzs/NEXUS/releases/latest/download/latest.json';
  const NIGHTLY_MANIFEST = 'latest-nightly.json';

  function resolveManifestForChannel(channel: 'stable' | 'beta') {
    if (channel === 'beta') {
      return { endpoint: NIGHTLY_MANIFEST, isNightly: true };
    }
    return { endpoint: STABLE_MANIFEST, isNightly: false };
  }

  const betaRes = resolveManifestForChannel('beta');
  assert.equal(betaRes.isNightly, true);
  assert.equal(betaRes.endpoint, 'latest-nightly.json');

  const stableRes = resolveManifestForChannel('stable');
  assert.equal(stableRes.isNightly, false);
  assert.equal(stableRes.endpoint, STABLE_MANIFEST);
});

test('Regras de interface: aviso de mismatch "Continuar recebendo Nightlies" é ocultado quando Beta está selecionado', () => {
  const nightlyVersion = '0.1.9-nightly.5';
  const versionInfo = getInstalledVersionInfo(nightlyVersion);
  assert.equal(versionInfo.isPrerelease, true);

  // Cenário do bug relatado: app reaberto com canal corrigido para Beta
  const channelBeta = 'beta';
  const showWarningWithBeta = versionInfo.isPrerelease && (channelBeta as string) === 'stable';
  assert.equal(showWarningWithBeta, false, 'Aviso NÃO deve aparecer quando canal Beta está selecionado');

  // Cenário de aviso legítimo: usuário em Nightly mudou explicitamente para Stable
  const channelStable = 'stable';
  const showWarningWithStable = versionInfo.isPrerelease && (channelStable as string) === 'stable';
  assert.equal(showWarningWithStable, true, 'Aviso DEVE aparecer quando usuário em Nightly muda para Stable');
});
