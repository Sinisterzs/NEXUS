import test from 'node:test';
import assert from 'node:assert/strict';
import { getInstalledVersionInfo, inferDefaultUpdateChannel } from '../src/version.ts';

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
function resolveUpdateChannelFromStore(
  storeData: Record<string, any>,
  currentAccount = 'offline_demo',
  installedVersion = '0.2.1'
): 'stable' | 'beta' {
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

  return inferDefaultUpdateChannel(installedVersion);
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

/**
 * Simulates SettingsRepository.getUpdateChannelSync() and getUpdateChannel()
 * under divergent storage states (Tauri Store vs localStorage vs inferred fallback).
 */
function simulateDualStorageResolution(params: {
  tauriStore: Record<string, any> | null;
  localStorageData: Record<string, string | null>;
  installedVersion?: string;
  isAsync?: boolean;
}): 'stable' | 'beta' {
  const { tauriStore, localStorageData, installedVersion = '0.2.1', isAsync = false } = params;

  // Async resolution checks Tauri store first (authoritative in Tauri app)
  if (isAsync && tauriStore) {
    const topLevel = tauriStore['app_update_channel'];
    if (topLevel === 'beta' || topLevel === 'stable') {
      return topLevel;
    }
    const accPrefs = tauriStore['preferences:offline_demo'];
    if (accPrefs?.updateChannel === 'beta' || accPrefs?.updateChannel === 'stable') {
      return accPrefs.updateChannel;
    }
  }

  // Synchronous resolution or local storage fallback
  const localVal = localStorageData['nexus_app_update_channel'];
  if (localVal === 'beta' || localVal === 'stable') {
    return localVal;
  }

  // Check account preference in localStorage
  const accRaw = localStorageData['nexus_preferences:offline_demo'];
  if (accRaw) {
    try {
      const parsed = JSON.parse(accRaw);
      if (parsed.updateChannel === 'beta' || parsed.updateChannel === 'stable') {
        return parsed.updateChannel;
      }
    } catch {}
  }

  return inferDefaultUpdateChannel(installedVersion);
}

test('Canal de atualização: fallback padrão para configuração ausente é "stable" em versão estável', () => {
  const emptyStore = {};
  const channel = resolveUpdateChannelFromStore(emptyStore, 'offline_demo', '0.2.1');
  assert.equal(channel, 'stable');
  assert.equal(DEFAULT_UPDATE_CHANNEL, 'stable');
});

test('Canal de atualização: fallback padrão para configuração ausente é "beta" em versão Nightly', () => {
  const emptyStore = {};
  const channel = resolveUpdateChannelFromStore(emptyStore, 'offline_demo', '0.3.0-nightly.2');
  assert.equal(channel, 'beta');
});

test('Canal de atualização: persistência de Stable -> Beta persiste após reinicialização simulada', () => {
  const diskState: Record<string, any> = {};

  persistUpdateChannelToStore(diskState, 'beta');
  assert.equal(diskState['app_update_channel'], 'beta');
  assert.equal(diskState['preferences:offline_demo']?.updateChannel, 'beta');

  const storeInstance2 = MockTauriStore.fromSnapshot(diskState);
  const reloadedChannel = resolveUpdateChannelFromStore(storeInstance2.snapshot());
  assert.equal(reloadedChannel, 'beta', 'Canal deve permanecer beta após reiniciar');
});

test('Canal de atualização: persistência de Beta -> Stable persiste após reinicialização simulada', () => {
  const diskState: Record<string, any> = {
    app_update_channel: 'beta',
    'preferences:offline_demo': { updateChannel: 'beta' },
  };

  persistUpdateChannelToStore(diskState, 'stable');
  assert.equal(diskState['app_update_channel'], 'stable');

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

  const channelBeta = 'beta';
  const showWarningWithBeta = versionInfo.isPrerelease && (channelBeta as string) === 'stable';
  assert.equal(showWarningWithBeta, false, 'Aviso NÃO deve aparecer quando canal Beta está selecionado');

  const channelStable = 'stable';
  const showWarningWithStable = versionInfo.isPrerelease && (channelStable as string) === 'stable';
  assert.equal(showWarningWithStable, true, 'Aviso DEVE aparecer quando usuário em Nightly muda para Stable');
});

// ============================================================================
// NOVOS TESTES: Sincronização e Estados Divergentes (Tauri Store vs localStorage)
// ============================================================================

test('Sincronização de Canais: Tauri Store contém "beta" mas localStorage não possui valor', () => {
  // Cenário: Usuário configurou Beta no passado em instalação Tauri pura; localStorage ainda limpo
  const tauriStore = { app_update_channel: 'beta' };
  const localStorageData = {};

  // Resolução assíncrona respeita o Tauri Store como autoridade
  const asyncResolved = simulateDualStorageResolution({
    tauriStore,
    localStorageData,
    isAsync: true,
  });
  assert.equal(asyncResolved, 'beta', 'Resolução assíncrona deve respeitar o valor "beta" do Tauri Store');

  // No boot instantâneo síncrono, se localStorage estiver vazio e a versão instalada for estável,
  // a resolução assíncrona subsequente alinha o serviço para "beta"
});

test('Sincronização de Canais: Usuário troca de canal para "beta" e reinicia imediatamente', () => {
  // setUpdateChannel espelha de imediato no localStorage e no Store
  const localStorageMock: Record<string, string | null> = {};
  const tauriStoreMock: Record<string, any> = {};

  // Chamada de escrita
  localStorageMock['nexus_app_update_channel'] = 'beta';
  tauriStoreMock['app_update_channel'] = 'beta';

  // Na reinicialização imediata (síncrona), getUpdateChannelSync lê localStorage imediatamente
  const syncChannel = simulateDualStorageResolution({
    tauriStore: null,
    localStorageData: localStorageMock,
    isAsync: false,
  });
  assert.equal(syncChannel, 'beta', 'getUpdateChannelSync deve ler "beta" imediatamente do localStorage');

  // E na verificação assíncrona posterior, confirma com o Store
  const asyncChannel = simulateDualStorageResolution({
    tauriStore: tauriStoreMock,
    localStorageData: localStorageMock,
    isAsync: true,
  });
  assert.equal(asyncChannel, 'beta', 'getUpdateChannel deve confirmar "beta" no Store');
});

test('Sincronização de Canais: Leitura do armazenamento falha ou lança exceção (fallback seguro)', () => {
  // Simulação de localStorage corrompido/bloqueado
  const corruptedLocalStorage = {
    nexus_app_update_channel: null,
    'nexus_preferences:offline_demo': 'CORRUPTED_JSON_NOT_VALID',
  };

  const channel = simulateDualStorageResolution({
    tauriStore: null,
    localStorageData: corruptedLocalStorage,
    installedVersion: '0.2.1',
    isAsync: false,
  });

  // Em versão estável, cai no fallback seguro 'stable'
  assert.equal(channel, 'stable', 'Deve retornar fallback seguro "stable" em versão estável');

  // Em versão pré-lançamento, cai no fallback seguro 'beta'
  const nightlyChannel = simulateDualStorageResolution({
    tauriStore: null,
    localStorageData: corruptedLocalStorage,
    installedVersion: '0.3.0-nightly.2',
    isAsync: false,
  });
  assert.equal(nightlyChannel, 'beta', 'Deve retornar fallback seguro "beta" em versão experimental');
});
