import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

test('voice preferences survive account A/B switches through the actual store and repository', { timeout: 20000 }, async () => {
  const directory = await mkdtemp(path.resolve('node_modules/.nexus-post-lab-test-'));
  try {
    // Bundle the real TS modules into one test ESM module. No Vite server,
    // project dotenv, native store, backend connection or auth bypass is used.
    const output = await build({
      stdin: { contents: `export { useAppStore } from './src/stores/useAppStore.ts';
        export { settingsRepository } from './src/repositories/SettingsRepository.ts';
        export { authRepository } from './src/repositories/AuthRepository.ts';
        export { callService } from './src/services/CallService.ts';`,
        resolveDir: process.cwd(), loader: 'ts' },
      bundle: true, platform: 'node', format: 'esm', packages: 'external', write: false,
    });
    const entry = path.join(directory, 'preferences.mjs');
    await writeFile(entry, output.outputFiles[0].text);
    const { useAppStore, settingsRepository, authRepository, callService } = await import(pathToFileURL(entry).href);
    // In-memory Tauri Store adapter: exercise real validation, per-account keys,
    // save/flush/load and login hydration without native IPC or user data.
    const disk = new Map();
    settingsRepository.storeInstance = {
      get: async key => disk.get(key),
      set: async (key, value) => disk.set(key, structuredClone(value)),
      save: async () => {},
    };
    settingsRepository.isTauri = true;
    authRepository.login = async login => ({ id: login, username: login, displayName: login });
    useAppStore.setState({
      loadFriends: async () => {}, loadFriendRequests: async () => {},
      loadConversations: async () => {}, initWebSocket: () => {},
    });
    await useAppStore.getState().loginOnline('lab_test_A', 'unused-test-password');
    useAppStore.getState().updateAudioVideo({ inputSensitivity: 92, voiceHangoverMs: 600, voiceAutoSensitivity: false });
    await settingsRepository.flushSave();
    const savedA = await settingsRepository.loadPreferences('lab_test_A');
    assert.equal(savedA.inputSensitivity, 92);
    assert.equal(savedA.voiceHangoverMs, 600);
    assert.equal(savedA.voiceAutoSensitivity, false);

    await useAppStore.getState().loginOnline('lab_test_B', 'unused-test-password');
    useAppStore.getState().updateAudioVideo({ inputSensitivity: 13, voiceHangoverMs: 200 });
    await settingsRepository.flushSave();
    await useAppStore.getState().loginOnline('lab_test_A', 'unused-test-password');
    const restored = useAppStore.getState().settings.audioVideo;
    assert.equal(restored.inputSensitivity, 92);
    assert.equal(restored.voiceHangoverMs, 600);
    assert.equal(restored.voiceAutoSensitivity, false);
    assert.equal((await settingsRepository.loadPreferences('lab_test_B')).inputSensitivity, 13);
    // A stabilized VAD false must immediately clear the green local indicator.
    // It must not start another hangover timer in CallService.
    useAppStore.setState({ isMicMuted: false, isDeafened: false });
    callService.handleSpeakingEvent('local', true);
    assert.equal(useAppStore.getState().isLocalSpeaking, true);
    callService.handleSpeakingEvent('local', false);
    assert.equal(useAppStore.getState().isLocalSpeaking, false);
    useAppStore.setState({ isMicMuted: true });
    callService.handleSpeakingEvent('local', true);
    assert.equal(useAppStore.getState().isLocalSpeaking, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
