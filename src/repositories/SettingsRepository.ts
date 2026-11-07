import { PersistedPreferences, MainTab } from '../lib/types';
import { initialAppSettings } from '../mocks';

const STORE_FILENAME = 'nexus_settings.json';

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
};

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let pendingPreferences: Partial<PersistedPreferences> = {};

class SettingsRepository {
  private storeInstance: any = null;
  private isTauri: boolean = false;

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
   * Loads persisted preferences with safe default validation
   */
  async loadPreferences(): Promise<PersistedPreferences> {
    try {
      const store = await this.getStore();

      if (store && this.isTauri) {
        const saved = (await store.get('preferences')) as Partial<PersistedPreferences> | null;
        if (saved && typeof saved === 'object') {
          return this.validateAndMerge(saved);
        }
      } else if (typeof window !== 'undefined') {
        const raw = window.localStorage.getItem('nexus_preferences');
        if (raw) {
          const parsed = JSON.parse(raw);
          return this.validateAndMerge(parsed);
        }
      }
    } catch (err) {
      console.warn('[SettingsRepository] Error loading preferences, falling back to defaults:', err);
    }

    return { ...DEFAULT_PREFERENCES };
  }

  /**
   * Debounced asynchronous save to disk
   */
  async savePreferences(updates: Partial<PersistedPreferences>): Promise<void> {
    pendingPreferences = { ...pendingPreferences, ...updates };

    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }

    return new Promise((resolve) => {
      debounceTimer = setTimeout(async () => {
        try {
          await this.flushSave();
        } finally {
          resolve();
        }
      }, 300);
    });
  }

  /**
   * Immediate flush for application lifecycle events
   */
  async flushSave(): Promise<void> {
    if (Object.keys(pendingPreferences).length === 0) return;

    const toSave = { ...pendingPreferences };
    pendingPreferences = {};

    try {
      const current = await this.loadPreferences();
      const merged = { ...current, ...toSave };

      const store = await this.getStore();
      if (store && this.isTauri) {
        await store.set('preferences', merged);
        await store.save();
      } else if (typeof window !== 'undefined') {
        window.localStorage.setItem('nexus_preferences', JSON.stringify(merged));
      }
    } catch (err) {
      console.error('[SettingsRepository] Error saving preferences:', err);
    }
  }

  private validateAndMerge(saved: Partial<PersistedPreferences>): PersistedPreferences {
    const validTabs: MainTab[] = ['home', 'messages', 'communities', 'calls', 'settings'];
    const validThemes = ['nexus-dark', 'midnight-black', 'cyber-slate'];
    const validFontSizes = ['sm', 'base', 'lg'];

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
    };
  }
}

export const settingsRepository = new SettingsRepository();
