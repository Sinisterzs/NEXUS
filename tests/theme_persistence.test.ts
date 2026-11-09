import test from 'node:test';
import assert from 'node:assert/strict';

type ThemeId = 'nexus-dark' | 'midnight-black' | 'cyber-slate';
const VALID_THEMES: ThemeId[] = ['nexus-dark', 'midnight-black', 'cyber-slate'];
const DEFAULT_THEME: ThemeId = 'nexus-dark';

// Simulated Store interface mirroring @tauri-apps/plugin-store
class MockTauriStore {
  private data = new Map<string, any>();

  async get<T>(key: string): Promise<T | null> {
    return this.data.has(key) ? (this.data.get(key) as T) : null;
  }

  async set(key: string, value: any): Promise<void> {
    this.data.set(key, value);
  }

  async save(): Promise<void> {}

  async keys(): Promise<string[]> {
    return Array.from(this.data.keys());
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

// Logic engine mirroring SettingsRepository for Theme resolution
function resolveThemeFromStore(
  storeData: Record<string, any>,
  currentAccount = 'offline_demo',
  localStorageMock?: Record<string, string>
): ThemeId {
  // 1. Top-level store key has highest precedence for installation-wide theme
  const topLevel = storeData['app_theme'];
  if (topLevel && VALID_THEMES.includes(topLevel as ThemeId)) {
    return topLevel as ThemeId;
  }

  // 2. Account preference fallback
  const accPrefs = storeData[`preferences:${currentAccount}`];
  if (accPrefs?.theme && VALID_THEMES.includes(accPrefs.theme as ThemeId)) {
    return accPrefs.theme as ThemeId;
  }

  // 3. Legacy preferences fallback
  const legacy = storeData['preferences'];
  if (legacy?.theme && VALID_THEMES.includes(legacy.theme as ThemeId)) {
    return legacy.theme as ThemeId;
  }

  // 4. Any account preference fallback
  for (const [k, v] of Object.entries(storeData)) {
    if (k.startsWith('preferences:') && v?.theme && VALID_THEMES.includes(v.theme as ThemeId)) {
      return v.theme as ThemeId;
    }
  }

  // 5. LocalStorage fallback
  if (localStorageMock) {
    const localTop = localStorageMock['nexus_theme'];
    if (localTop && VALID_THEMES.includes(localTop as ThemeId)) {
      return localTop as ThemeId;
    }
    const localAcc = localStorageMock[`nexus_preferences:${currentAccount}`];
    if (localAcc) {
      try {
        const parsed = JSON.parse(localAcc);
        if (parsed.theme && VALID_THEMES.includes(parsed.theme as ThemeId)) {
          return parsed.theme as ThemeId;
        }
      } catch {}
    }
  }

  return DEFAULT_THEME;
}

function persistThemeToStore(
  storeData: Record<string, any>,
  theme: string,
  currentAccount = 'offline_demo',
  localStorageMock?: Record<string, string>
): void {
  const validated: ThemeId = VALID_THEMES.includes(theme as ThemeId) ? (theme as ThemeId) : DEFAULT_THEME;

  // 1. Top-level installation-wide key
  storeData['app_theme'] = validated;

  // 2. LocalStorage synchronous update (for zero-flash startup)
  if (localStorageMock) {
    localStorageMock['nexus_theme'] = validated;
  }

  // 3. Account preference sync
  const accKey = `preferences:${currentAccount}`;
  storeData[accKey] = {
    ...(storeData[accKey] || {}),
    theme: validated,
  };
}

test('Tema: fallback padrão para configuração ausente é "nexus-dark"', () => {
  const emptyStore = {};
  const theme = resolveThemeFromStore(emptyStore);
  assert.equal(theme, 'nexus-dark');
  assert.equal(DEFAULT_THEME, 'nexus-dark');
});

test('Tema: persistência de Midnight Black persiste após reinicialização simulada', () => {
  const diskState: Record<string, any> = {};
  const localStore: Record<string, string> = {};

  // Usuário seleciona Midnight Black
  persistThemeToStore(diskState, 'midnight-black', 'user_123', localStore);
  assert.equal(diskState['app_theme'], 'midnight-black');
  assert.equal(localStore['nexus_theme'], 'midnight-black');
  assert.equal(diskState['preferences:user_123']?.theme, 'midnight-black');

  // Simula cold-restart (reabertura do aplicativo)
  const storeInstance2 = MockTauriStore.fromSnapshot(diskState);
  const reloadedTheme = resolveThemeFromStore(storeInstance2.snapshot(), 'user_123', localStore);
  assert.equal(reloadedTheme, 'midnight-black', 'Tema deve permanecer midnight-black após reiniciar');
});

test('Tema: persistência de Cyber Slate persiste após reinicialização simulada', () => {
  const diskState: Record<string, any> = {};
  const localStore: Record<string, string> = {};

  // Usuário seleciona Cyber Slate
  persistThemeToStore(diskState, 'cyber-slate', 'offline_demo', localStore);
  assert.equal(diskState['app_theme'], 'cyber-slate');
  assert.equal(localStore['nexus_theme'], 'cyber-slate');

  // Simula cold-restart
  const storeInstance2 = MockTauriStore.fromSnapshot(diskState);
  const reloadedTheme = resolveThemeFromStore(storeInstance2.snapshot(), 'offline_demo', localStore);
  assert.equal(reloadedTheme, 'cyber-slate', 'Tema deve permanecer cyber-slate após reiniciar');
});

test('Tema: retorno para NEXUS Dark persiste após reinicialização simulada', () => {
  const diskState: Record<string, any> = {
    app_theme: 'midnight-black',
  };
  const localStore: Record<string, string> = {
    nexus_theme: 'midnight-black',
  };

  // Usuário retorna para NEXUS Dark
  persistThemeToStore(diskState, 'nexus-dark', 'user_456', localStore);
  assert.equal(diskState['app_theme'], 'nexus-dark');
  assert.equal(localStore['nexus_theme'], 'nexus-dark');

  // Simula cold-restart
  const storeInstance2 = MockTauriStore.fromSnapshot(diskState);
  const reloadedTheme = resolveThemeFromStore(storeInstance2.snapshot(), 'user_456', localStore);
  assert.equal(reloadedTheme, 'nexus-dark');
});

test('Tema: valor inválido ou corrompido em disco é corrigido com segurança para "nexus-dark"', () => {
  const corruptedStore = {
    app_theme: 'invalid-neon-pink-theme',
    'preferences:offline_demo': { theme: 'cyber-corrupted' },
  };
  const corruptedLocalStorage = {
    nexus_theme: 'random_junk_value',
  };

  const theme = resolveThemeFromStore(corruptedStore, 'offline_demo', corruptedLocalStorage);
  assert.equal(theme, 'nexus-dark', 'Deve sanitizar valor inválido para o tema padrão seguro');
});

test('Tema: preserva outras configurações (como app_update_channel) ao alterar tema', () => {
  const diskState: Record<string, any> = {
    app_update_channel: 'beta',
    'preferences:user_789': {
      updateChannel: 'beta',
      fontSize: 'sm',
      compactMode: true,
      theme: 'nexus-dark',
    },
  };

  // Usuário altera apenas o tema
  persistThemeToStore(diskState, 'midnight-black', 'user_789');

  assert.equal(diskState['app_update_channel'], 'beta', 'Canal deve ser preservado');
  assert.equal(diskState['preferences:user_789'].updateChannel, 'beta');
  assert.equal(diskState['preferences:user_789'].fontSize, 'sm');
  assert.equal(diskState['preferences:user_789'].compactMode, true);
  assert.equal(diskState['preferences:user_789'].theme, 'midnight-black');
});

test('Tema: recuperação de tema existente de conta após logout/inicialização em offline_demo', () => {
  // Simula disco onde conta anterior tinha salvo 'cyber-slate'
  const diskState: Record<string, any> = {
    'preferences:acc_prior': {
      theme: 'cyber-slate',
    },
  };

  // Ao abrir o app em modo inicial (offline_demo sem app_theme explícito), ele herda o tema configurado
  const theme = resolveThemeFromStore(diskState, 'offline_demo');
  assert.equal(theme, 'cyber-slate', 'Deve recuperar tema configurado anteriormente no disco');
});
