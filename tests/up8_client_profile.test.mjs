import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('UP.8 authenticated profile: onboarding and authoritative avatar survive account transitions', async () => {
  const directory = fs.mkdtempSync(path.resolve('node_modules/.cache/up8-profile-'));
  const contents = `
import test, {beforeEach, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {useAppStore} from './src/stores/useAppStore';
import {authRepository} from './src/repositories/AuthRepository';
import {settingsRepository} from './src/repositories/SettingsRepository';
import {profileOnboardingService} from './src/services/ProfileOnboardingService';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {Avatar} from './src/components/Avatar';
const originalState=useAppStore.getState();
const saved=[];
const mock=(object,key,value)=>{saved.push([object,key,object[key]]);object[key]=value;};
const user=(avatarUrl=undefined)=>({id:'up8-test',username:'up8',displayName:'UP8',email:'up8@example.invalid',avatarUrl,status:'online',createdAt:'2026-11-17'});
let memory;
beforeEach(()=>{
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
afterEach(()=>{for(const [object,key,value] of saved.splice(0).reverse())object[key]=value;useAppStore.setState(originalState,true);delete globalThis.localStorage;});
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
test('persistent relative avatar URLs render against the active backend origin',()=>{
 useAppStore.setState({networkStatus:{...originalState.networkStatus,server_url:'https://backend.example.invalid'}});
 const html=renderToStaticMarkup(React.createElement(Avatar,{name:'UP8',avatarUrl:'/v1/avatars/persisted.png'}));
 assert.ok(html.includes('https://backend.example.invalid/v1/avatars/persisted.png'));
});
`;
  try {
    const outfile = path.join(directory, 'profile.mjs');
    await build({ stdin: {contents, resolveDir:process.cwd(), loader:'ts'}, bundle:true, platform:'node', format:'esm', packages:'external', define:{'import.meta.env':'{"DEV":false}'}, outfile });
    const result = spawnSync(process.execPath,['--test','--test-concurrency=1',outfile],{encoding:'utf8',windowsHide:true});
    assert.equal(result.status,0,result.stdout+'\n'+result.stderr);
  } finally { fs.rmSync(directory,{recursive:true,force:true}); }
});
