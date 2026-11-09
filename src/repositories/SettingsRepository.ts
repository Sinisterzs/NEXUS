import { PersistedPreferences, MainTab } from '../lib/types';
import { initialAppSettings } from '../mocks';

const STORE_FILENAME = 'nexus_settings.json';
const MAX_AVATAR_STORAGE_CHARS = 262_144; // 256 KB cap for local preference storage

export const DEFAULT_PREFERENCES: PersistedPreferences = {
  theme: initialAppSettings.appearance.theme,
  compactMode: initialAppSettings.appearance.compactMode,
  fontSize: initialAppSettings.appearance.fontSize,
  isSidebarCollapsed: false,
  activeTab: 'home',
  activeCommunityId: null,
  activeChannelId: null,
  activeDmId: null,
  inputDevice: initialAppSettings.audioVideo.inputDevice,
  outputDevice: initialAppSettings.audioVideo.outputDevice,
  inputSensitivity: initialAppSettings.audioVideo.inputSensitivity,
  outputVolume: initialAppSettings.audioVideo.outputVolume,
  noiseSuppression: initialAppSettings.audioVideo.noiseSuppression,
  echoCancellation: initialAppSettings.audioVideo.echoCancellation,
  desktopAlerts: initialAppSettings.notifications.desktopAlerts,
  soundEffects: initialAppSettings.notifications.soundEffects,
  mentionsOnly: initialAppSettings.notifications.mentionsOnly,
  dndMode: initialAppSettings.notifications.dndMode,
  allowDmsFrom: initialAppSettings.privacy.allowDmsFrom,
  showGameActivity: initialAppSettings.privacy.showGameActivity,
  streamerMode: initialAppSettings.privacy.streamerMode,
  avatarUrl: undefined,
  updateChannel: 'stable',
};

class SettingsRepository {
  private storeInstance: any = null;
  private isTauri: boolean = false;
  private currentAccountId: string = 'offline_demo';
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingByAccount: Record<string, Partial<PersistedPreferences>> = {};

  setAccountId(accountId?: string | null): void {
    const clean = accountId?.trim();
    this.currentAccountId = clean ? clean : 'offline_demo';
  }

  getAccountId(): string {
    return this.currentAccountId;
  }

  private resolveAccount(accountId?: string): string {
    const clean = accountId?.trim() || this.currentAccountId || 'offline_demo';
    return clean;
  }

  private getStoreKey(accountId?: string): string {
    const acc = this.resolveAccount(accountId);
    return `preferences:${acc}`;
  }

  private getLocalStorageKey(accountId?: string): string {
    const acc = this.resolveAccount(accountId);
    return `nexus_preferences:${acc}`;
  }

  private async getStore() {
    if (this.storeInstance) return this.storeInstance;

    try {
      const { Store } = await import('@tauri-apps/plugin-store');
      this.storeInstance = await Store.load(STORE_FILENAME);
      this.isTauri = true;
      return this.storeInstance;
    } catch {
      this.isTauri = false;
      return null;
    }
  }

  /**
   * Loads persisted preferences scoped by accountId with safe default validation
   */
  async loadPreferences(accountId?: string): Promise<PersistedPreferences> {
    const acc = this.resolveAccount(accountId);
    const storeKey = this.getStoreKey(acc);
    const localKey = this.getLocalStorageKey(acc);

    try {
      const store = await this.getStore();

      if (store && this.isTauri) {
        const saved = (await store.get(storeKey)) as Partial<PersistedPreferences> | null;
        if (saved && typeof saved === 'object') {
          return this.validateAndMerge(saved);
        }
        if (acc === 'offline_demo') {
          const legacy = (await store.get('preferences')) as Partial<PersistedPreferences> | null;
          if (legacy && typeof legacy === 'object') {
            return this.validateAndMerge(legacy);
          }
        }
      } else if (typeof window !== 'undefined') {
        const raw = window.localStorage.getItem(localKey);
        if (raw) {
          const parsed = JSON.parse(raw);
          return this.validateAndMerge(parsed);
        }
        if (acc === 'offline_demo') {
          const legacyRaw = window.localStorage.getItem('nexus_preferences');
          if (legacyRaw) {
            return this.validateAndMerge(JSON.parse(legacyRaw));
          }
        }
      }
    } catch (err) {
      console.warn('[SettingsRepository] Error loading preferences, falling back to defaults:', err);
    }

    return { ...DEFAULT_PREFERENCES };
  }

  /**
   * Debounced asynchronous save to disk scoped to the target account
   */
  async savePreferences(
    updates: Partial<PersistedPreferences>,
    accountId?: string
  ): Promise<void> {
    const acc = this.resolveAccount(accountId);
    this.pendingByAccount[acc] = {
      ...(this.pendingByAccount[acc] || {}),
      ...updates,
    };

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    return new Promise((resolve) => {
      this.debounceTimer = setTimeout(async () => {
        try {
          await this.flushSave(acc);
        } finally {
          resolve();
        }
      }, 300);
    });
  }

  /**
   * Immediate flush for application lifecycle or account switch events
   */
  async flushSave(accountId?: string): Promise<void> {
    const accountsToFlush = accountId
      ? [this.resolveAccount(accountId)]
      : Object.keys(this.pendingByAccount);

    for (const acc of accountsToFlush) {
      const pending = this.pendingByAccount[acc];
      if (!pending || Object.keys(pending).length === 0) continue;

      const toSave = { ...pending };
      delete this.pendingByAccount[acc];

      try {
        const current = await this.loadPreferences(acc);
        const merged = this.validateAndMerge({ ...current, ...toSave });

        const store = await this.getStore();
        if (store && this.isTauri) {
          await store.set(this.getStoreKey(acc), merged);
          await store.save();
        } else if (typeof window !== 'undefined') {
          window.localStorage.setItem(this.getLocalStorageKey(acc), JSON.stringify(merged));
        }
      } catch (err) {
        console.error('[SettingsRepository] Error saving preferences:', err);
      }
    }
  }

  private validateAndMerge(saved: Partial<PersistedPreferences>): PersistedPreferences {
    const validTabs: MainTab[] = ['home', 'messages', 'communities', 'calls', 'settings'];
    const validThemes = ['nexus-dark', 'midnight-black', 'cyber-slate'];
    const validFontSizes = ['sm', 'base', 'lg'];

    const validAvatarUrl =
      typeof saved.avatarUrl === 'string' &&
      saved.avatarUrl.trim().length > 0 &&
      saved.avatarUrl.length <= MAX_AVATAR_STORAGE_CHARS
        ? saved.avatarUrl.trim()
        : DEFAULT_PREFERENCES.avatarUrl;

    return {
      theme: validThemes.includes(saved.theme as string) ? (saved.theme as any) : DEFAULT_PREFERENCES.theme,
      compactMode: typeof saved.compactMode === 'boolean' ? saved.compactMode : DEFAULT_PREFERENCES.compactMode,
      fontSize: validFontSizes.includes(saved.fontSize as string) ? (saved.fontSize as any) : DEFAULT_PREFERENCES.fontSize,
      isSidebarCollapsed: typeof saved.isSidebarCollapsed === 'boolean' ? saved.isSidebarCollapsed : DEFAULT_PREFERENCES.isSidebarCollapsed,
      activeTab: validTabs.includes(saved.activeTab as MainTab) ? (saved.activeTab as MainTab) : DEFAULT_PREFERENCES.activeTab,
      activeCommunityId: saved.activeCommunityId !== undefined ? saved.activeCommunityId : DEFAULT_PREFERENCES.activeCommunityId,
      activeChannelId: saved.activeChannelId !== undefined ? saved.activeChannelId : DEFAULT_PREFERENCES.activeChannelId,
      activeDmId: saved.activeDmId !== undefined ? saved.activeDmId : DEFAULT_PREFERENCES.activeDmId,
      inputDevice: saved.inputDevice || DEFAULT_PREFERENCES.inputDevice,
      outputDevice: saved.outputDevice || DEFAULT_PREFERENCES.outputDevice,
      inputSensitivity: typeof saved.inputSensitivity === 'number' ? saved.inputSensitivity : DEFAULT_PREFERENCES.inputSensitivity,
      outputVolume: typeof saved.outputVolume === 'number' ? saved.outputVolume : DEFAULT_PREFERENCES.outputVolume,
      noiseSuppression: typeof saved.noiseSuppression === 'boolean' ? saved.noiseSuppression : DEFAULT_PREFERENCES.noiseSuppression,
      echoCancellation: typeof saved.echoCancellation === 'boolean' ? saved.echoCancellation : DEFAULT_PREFERENCES.echoCancellation,
      desktopAlerts: typeof saved.desktopAlerts === 'boolean' ? saved.desktopAlerts : DEFAULT_PREFERENCES.desktopAlerts,
      soundEffects: typeof saved.soundEffects === 'boolean' ? saved.soundEffects : DEFAULT_PREFERENCES.soundEffects,
      mentionsOnly: typeof saved.mentionsOnly === 'boolean' ? saved.mentionsOnly : DEFAULT_PREFERENCES.mentionsOnly,
      dndMode: typeof saved.dndMode === 'boolean' ? saved.dndMode : DEFAULT_PREFERENCES.dndMode,
      allowDmsFrom: saved.allowDmsFrom || DEFAULT_PREFERENCES.allowDmsFrom,
      showGameActivity: typeof saved.showGameActivity === 'boolean' ? saved.showGameActivity : DEFAULT_PREFERENCES.showGameActivity,
      streamerMode: typeof saved.streamerMode === 'boolean' ? saved.streamerMode : DEFAULT_PREFERENCES.streamerMode,
      avatarUrl: validAvatarUrl,
    };
  }
}

export const settingsRepository = new SettingsRepository();
