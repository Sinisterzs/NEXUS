import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

test('Sidebar renders one compact audio control set, with fallback and end-call restoration', async () => {
  const directory = await mkdtemp(path.resolve('node_modules/.nexus-sidebar-test-'));
  try {
    // Render the real components as HTML. Store and call actions are replaced
    // before bundling, so no app service, native IPC, media or session is loaded.
    const result = await build({
      stdin: {
        contents: `export { Sidebar } from './src/app/Sidebar.tsx';
          export { useAppStore } from './src/stores/useAppStore';`,
        resolveDir: process.cwd(), loader: 'ts',
      },
      bundle: true, platform: 'node', format: 'esm', packages: 'external', write: false,
      plugins: [{
        name: 'isolated-sidebar-state',
        setup(builder) {
          builder.onResolve({ filter: /stores\/useAppStore(?:\.ts)?$/ }, () => ({ path: 'store', namespace: 'sidebar-test' }));
          builder.onResolve({ filter: /services\// }, args => {
            assert.match(args.path, /\/CallService(?:\.ts)?$/, 'unexpected service dependency');
            return { path: 'call-actions', namespace: 'sidebar-test' };
          });
          builder.onLoad({ filter: /.*/, namespace: 'sidebar-test' }, args => ({
            contents: args.path === 'store'
              ? `let state;
                 export const useAppStore = selector => selector(state);
                 useAppStore.setTestState = next => { state = next; };
                 useAppStore.getState = () => state;`
              : 'export const callService = { toggleMute() {}, toggleDeafen() {}, endCall() {} };',
            loader: 'js',
          }));
        },
      }],
    });
    const entry = path.join(directory, 'sidebar.mjs');
    await writeFile(entry, result.outputFiles[0].text);
    const { Sidebar, useAppStore } = await import(pathToFileURL(entry).href);
    const base = {
      authStatus: 'authenticated', conversations: [], currentUser: { name: 'Test' },
      onlineUser: null, settings: { profile: {} }, activeCommunityId: null,
      activeCallPeer: { name: 'Test peer' }, callDurationSecs: 1,
      reconnectAttempt: 1, maxReconnectAttempts: 3, isScreenSharing: true,
      isRemoteScreenSharing: true, isLocalSpeaking: false, isRemoteSpeaking: false,
      isPeerMuted: false, setActiveTab() {}, toggleSidebar() {}, setActiveCommunity() {},
    };
    const states = ['idle', 'calling', 'incoming', 'connecting', 'connected', 'reconnecting'];
    const render = overrides => {
      useAppStore.setTestState({ ...base, ...overrides });
      return renderToStaticMarkup(React.createElement(Sidebar));
    };
    const count = (html, labels) => (html.match(new RegExp(`aria-label="(?:${labels})"`, 'g')) || []).length;

    for (const voiceCallState of states) {
      for (const activeTab of ['home', 'calls']) {
        for (const isSidebarCollapsed of [true, false]) {
          for (const isMicMuted of [true, false]) {
            for (const isDeafened of [true, false]) {
              const html = render({ voiceCallState, activeTab, isSidebarCollapsed, isMicMuted, isDeafened });
              const barVisible = voiceCallState !== 'idle' && activeTab !== 'calls';
              const expectedSets = barVisible && !isSidebarCollapsed ? 2 : 1;
              const context = JSON.stringify({ voiceCallState, activeTab, isSidebarCollapsed, isMicMuted, isDeafened });
              assert.equal(count(html, 'Ativar microfone|Silenciar microfone|Silenciar'), expectedSets, context);
              assert.equal(count(html, 'Ativar áudio|Desativar áudio'), expectedSets, context);
              assert.equal(html.includes('bg-[#0a0c10]/90'), !(barVisible && isSidebarCollapsed), context);
              assert.equal(count(html, 'Desligar chamada'), Number(barVisible), context);
              if (barVisible) assert.match(html, /aria-label="(?:Abrir tela da chamada|Abrir tela de chamada)"/);
              assert.equal(count(html, isMicMuted ? 'Ativar microfone' : 'Silenciar microfone|Silenciar'), expectedSets);
              assert.equal(count(html, isDeafened ? 'Ativar áudio' : 'Desativar áudio'), expectedSets);
            }
          }
        }
      }
    }
    // Ending the call restores the actual dock markup instead of an empty spacer.
    for (const voiceCallState of ['connected', 'idle', 'connected']) {
      const html = render({ voiceCallState, activeTab: 'home', isSidebarCollapsed: true });
      assert.equal(count(html, 'Ativar microfone|Silenciar microfone|Silenciar'), 1);
      assert.equal(html.includes('bg-[#0a0c10]/90'), voiceCallState === 'idle');
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
