import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// Bundle TypeScript once, then register every case in this process's node:test
// runner. A build/import error or any failed assertion fails the test file.
async function loadFixture(contents, plugins = []) {
  const cache = path.resolve('node_modules/.cache');
  fs.mkdirSync(cache, { recursive: true });
  const directory = fs.mkdtempSync(path.join(cache, 'up8-profile-'));
  try {
    const outfile = path.join(directory, 'profile.mjs');
    await build({
      stdin: { contents, resolveDir: process.cwd(), loader: 'ts' },
      bundle: true, platform: 'node', format: 'esm', packages: 'external',
      define: { 'import.meta.env': '{"DEV":false}' }, outfile, plugins,
    });
    return await import(pathToFileURL(outfile).href);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

const { useAppStore, authRepository, settingsRepository, profileOnboardingService, resolveAvatarUrl } =
  await loadFixture(`
    export { useAppStore } from './src/stores/useAppStore';
    export { authRepository } from './src/repositories/AuthRepository';
    export { settingsRepository } from './src/repositories/SettingsRepository';
    export { profileOnboardingService } from './src/services/ProfileOnboardingService';
    export { resolveAvatarUrl } from './src/lib/avatarUrl';
  `);

// SSR reads Zustand's getInitialState(), not a later setState(). Supply a real
// isolated Zustand store whose initial snapshot has the backend for this case.
// Only the store dependency is replaced; Avatar and its URL helper are real.
const { Avatar } = await loadFixture(`export { Avatar } from './src/components/Avatar';`, [{
  name: 'profile-avatar-ssr-store',
  setup(builder) {
    builder.onResolve({ filter: /stores\/useAppStore(?:\.ts)?$/ }, () => ({
      path: 'configured-store', namespace: 'profile-avatar-test',
    }));
    builder.onLoad({ filter: /.*/, namespace: 'profile-avatar-test' }, () => ({
      contents: `import { create } from 'zustand';
        export const useAppStore = create(() => ({
          networkStatus: { server_url: 'https://backend.example.invalid' }
        }));`,
      loader: 'js', resolveDir: process.cwd(),
    }));
  },
}]);

const originalState=useAppStore.getState();
const saved=[];
let originalStorage;
const mock=(object,key,value)=>{saved.push([object,key,object[key]]);object[key]=value;};
const user=(avatarUrl=undefined)=>({id:'up8-test',username:'up8',displayName:'UP8',email:'up8@example.invalid',avatarUrl,status:'online',createdAt:'2026-11-17'});
let memory;
beforeEach(()=>{
 originalStorage=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
 memory=new Map();
 Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:k=>memory.get(k)??null,setItem:(k,v)=>memory.set(k,v),removeItem:k=>memory.delete(k)}});
 mock(settingsRepository,'setAccountId',()=>{});
 mock(settingsRepository,'flushSave',async()=>{});
 mock(settingsRepository,'loadPreferences',async()=>({avatarUrl:'https://old.invalid/stale.png'}));
 mock(settingsRepository,'savePreferences',async()=>{});
 mock(authRepository,'register',async()=>user());
 mock(authRepository,'login',async()=>user());
 mock(authRepository,'updateProfile',async()=>user());
 useAppStore.setState(originalState,true);
 const empty=async()=>{};
 useAppStore.setState({loadFriends:empty,loadFriendRequests:empty,loadConversations:empty,loadCommunities:empty,initWebSocket:()=>{}});
});
afterEach(()=>{for(const [object,key,value] of saved.splice(0).reverse())object[key]=value;useAppStore.setState(originalState,true);if(originalStorage)Object.defineProperty(globalThis,'localStorage',originalStorage);else delete globalThis.localStorage;});
test('new registration opens onboarding immediately and completion stays completed on login',async()=>{
 await useAppStore.getState().registerOnline('up8','up8@example.invalid','test-only');
 assert.equal(useAppStore.getState().pendingProfileOnboarding,true);
 useAppStore.getState().completeProfileOnboarding();
 assert.equal(profileOnboardingService.isPending('up8-test'),false);
 await useAppStore.getState().loginOnline('up8','test-only');
 assert.equal(useAppStore.getState().pendingProfileOnboarding,false);
});
test('existing login never creates onboarding or resurrects a cached deleted avatar',async()=>{
 await useAppStore.getState().loginOnline('up8','test-only');
 assert.equal(useAppStore.getState().pendingProfileOnboarding,false);
 assert.equal(useAppStore.getState().currentUser.avatarUrl,undefined);
 assert.equal(useAppStore.getState().settings.profile.avatarUrl,undefined);
});
test('server avatar wins over stale account preferences after login',async()=>{
 authRepository.login=async()=>user('/v1/avatars/persisted.png');
 await useAppStore.getState().loginOnline('up8','test-only');
 assert.equal(useAppStore.getState().currentUser.avatarUrl,'/v1/avatars/persisted.png');
});
test('saving onboarding fields reaches the backend repository',async()=>{
 let sent;
 authRepository.updateProfile=async value=>{sent=value;return {...user(),displayName:value.displayName};};
 useAppStore.setState({authStatus:'authenticated',onlineUser:user()});
 await useAppStore.getState().saveProfile({displayName:'Saved name'});
 assert.equal(sent.displayName,'Saved name');
 assert.equal(useAppStore.getState().currentUser.displayName,'Saved name');
});
test('persistent relative avatar URLs resolve against the configured backend origin', () => {
  assert.equal(
    resolveAvatarUrl('/v1/avatars/persisted.png', 'https://backend.example.invalid'),
    'https://backend.example.invalid/v1/avatars/persisted.png',
  );
});

test('persistent relative avatar URLs render against the active backend origin', () => {
  const html = renderToStaticMarkup(React.createElement(Avatar, {
    name: 'UP8', avatarUrl: '/v1/avatars/persisted.png',
  }));
  assert.ok(html.includes('https://backend.example.invalid/v1/avatars/persisted.png'));
});
