import test from 'node:test';
import assert from 'node:assert/strict';
import { PreloginUpdaterService } from '../src/services/PreloginUpdaterService.ts';

async function scenario(contract: unknown, available: boolean, ipcFailure = false, checkFailure = false, installFailure = false) {
  const previous = (globalThis as any).window;
  let installs = 0, restarts = 0, proceeds = 0;
  (globalThis as any).window = { __TAURI_INTERNALS__: {
    invoke: async (command: string) => {
      assert.equal(command, 'updater_get_compatibility');
      if (ipcFailure) throw new Error('temporary compatibility failure');
      return contract;
    },
  }};
  try {
    const service = new PreloginUpdaterService({
      checkPrelogin: async () => {
        if (checkFailure) throw new Error('temporary update server failure');
        return {channel:'beta',currentVersion:'0.4.0-nightly.8',version:available?'0.4.0-nightly.9':undefined,updateAvailable:available};
      },
      downloadAndInstall: async () => { installs++; if (installFailure) throw new Error('mock installation failure'); },
      restart: async () => { restarts++; },
    });
    await service.runStartupSequence({channelOverride:'beta',onProceed:()=>{proceeds++;}});
    return {status:service.getState().status,installs,restarts,proceeds};
  } finally { (globalThis as any).window = previous; }
}

test('startup allows AWS null minimums and never invents incompatibility after IPC/network failure', async () => {
  const expected = {status:'up_to_date',installs:0,restarts:0,proceeds:1};
  assert.deepEqual(await scenario({min_client_version_stable:null,min_client_version_nightly:null},false),expected);
  assert.deepEqual(await scenario(null,false,true),expected);
});
test('temporary update-check outage permits compatible startup and preserves a declared mandatory update', async () => {
  assert.deepEqual(await scenario(null,false,false,true),
    {status:'connection_error',installs:0,restarts:0,proceeds:1});
  assert.deepEqual(await scenario({min_client_version_nightly:'0.4.0-nightly.9'},false,false,true),
    {status:'update_required',installs:0,restarts:0,proceeds:0});
});
test('mandatory install failure keeps access blocked for retry', async () => {
  assert.deepEqual(await scenario({min_client_version_nightly:'0.4.0-nightly.9'},true,false,false,true),
    {status:'install_error',installs:1,restarts:0,proceeds:0});
});
test('startup blocks only declared incompatibility when no compatible update is available', async () => {
  assert.deepEqual(await scenario({min_client_version_nightly:'0.4.0-nightly.9'},false),
    {status:'update_required',installs:0,restarts:0,proceeds:0});
});
test('startup auto-installs a Nightly only when backend declares it mandatory; compatible Nightly stays optional', async () => {
  assert.deepEqual(await scenario({min_client_version_nightly:'0.4.0-nightly.9'},true),
    {status:'restarting',installs:1,restarts:1,proceeds:0});
  assert.deepEqual(await scenario({min_client_version_nightly:null},true),
    {status:'update_found',installs:0,restarts:0,proceeds:1});
});
