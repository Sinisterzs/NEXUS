import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ScreenCaptureService,
  toNativeStartOptionsPayload,
} from '../src/services/ScreenCaptureService.ts';

/**
 * Regressão Nightly.1: Tauri 2 só aceita argumentos de comandos Rust em camelCase
 * (peer_id -> peerId). O frontend enviava snake_case, o Tauri rejeitava a chamada com
 * "missing required key peerId" e o compartilhamento nativo era derrubado.
 */

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function snakeToCamel(name: string): string {
  return name.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/** Extrai { comando -> argumentos camelCase esperados } das assinaturas `#[tauri::command]`. */
function parseRustCommandArgs(): Map<string, string[]> {
  const src = fs.readFileSync(path.join(rootDir, 'src-tauri', 'src', 'capture', 'mod.rs'), 'utf8');
  const result = new Map<string, string[]>();
  const re = /#\[tauri::command\]\s*pub\s+(?:async\s+)?fn\s+(native_[a-z_]+)\s*\(([\s\S]*?)\)\s*(?:->|\{)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const params = m[2]
      .split(/,\s*(?![^<]*>)/)
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => ({ name: p.split(':')[0].trim(), type: p.split(':').slice(1).join(':').trim() }))
      // AppHandle e State são injetados pelo Tauri, não vêm do frontend.
      .filter((p) => !/AppHandle|State</.test(p.type))
      .map((p) => snakeToCamel(p.name));
    result.set(m[1], params);
  }
  return result;
}

async function withMockedTauri(
  run: (calls: Array<{ cmd: string; args: Record<string, unknown> }>) => Promise<void>
) {
  const calls: Array<{ cmd: string; args: Record<string, unknown> }> = [];
  const g = globalThis as any;
  const hadWindow = 'window' in g;
  const originalWindow = g.window;
  const internals = {
    invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
      calls.push({ cmd, args });
      return { sdp: 'v=0', peer_id: String(args.peerId ?? '') };
    },
    transformCallback: () => 1,
    unregisterCallback: () => {},
  };
  g.window = { __TAURI_INTERNALS__: internals, addEventListener() {}, removeEventListener() {} };
  try {
    await run(calls);
  } finally {
    if (hadWindow) g.window = originalWindow;
    else delete g.window;
  }
}

test('Rust command signatures are discovered for the native capture commands', () => {
  const commands = parseRustCommandArgs();
  assert.deepEqual(commands.get('native_log_screen_receiver'), ['snapshot'], 'commands returning unit must not consume the next command signature');
  for (const name of [
    'native_start_screen_share',
    'native_add_screen_peer',
    'native_handle_screen_ice',
    'native_set_adaptive_bitrate',
    'native_handle_screen_answer',
    'native_remove_screen_peer',
  ]) {
    assert.ok(commands.has(name), `${name} must be parsed from src-tauri/src/capture/mod.rs`);
  }
  assert.deepEqual(commands.get('native_add_screen_peer'), ['peerId', 'iceServers']);
  assert.deepEqual(commands.get('native_handle_screen_ice'), [
    'peerId',
    'candidate',
    'sdpMid',
    'sdpMlineIndex',
    'screenSessionId',
  ]);
  assert.deepEqual(commands.get('native_set_adaptive_bitrate'), ['bitrateBps']);
});

test('native_add_screen_peer sends camelCase peerId/iceServers and no snake_case keys', async () => {
  await withMockedTauri(async (calls) => {
    const svc = new ScreenCaptureService();
    await svc.addNativeScreenPeer('user-1', [{ urls: 'stun:stun.example.org:3478' }]);
    await svc.addNativeScreenPeer('user-2');
    assert.equal(calls[0].cmd, 'native_add_screen_peer');
    assert.deepEqual(Object.keys(calls[0].args).sort(), ['iceServers', 'peerId']);
    assert.equal(calls[0].args.peerId, 'user-1');
    assert.deepEqual(Object.keys(calls[1].args), ['peerId']);
  });
});

test('native_handle_screen_ice sends camelCase peerId/candidate/sdpMid/sdpMlineIndex', async () => {
  await withMockedTauri(async (calls) => {
    const svc = new ScreenCaptureService();
    await svc.handleNativeScreenIce('user-1', 'candidate:1 1 udp 1 1.1.1.1 1 typ host', '0', 0);
    await svc.handleNativeScreenIce('user-1', 'candidate:2 1 udp 1 192.0.2.1 9 typ host', undefined, undefined);
    assert.equal(calls[0].cmd, 'native_handle_screen_ice');
    assert.deepEqual(Object.keys(calls[0].args).sort(), [
      'candidate',
      'peerId',
      'sdpMid',
      'sdpMlineIndex',
    ]);
    assert.equal(calls[0].args.sdpMid, '0');
    assert.equal(calls[0].args.sdpMlineIndex, 0);
    assert.equal(calls[1].args.sdpMid, null);
    assert.equal(calls[1].args.sdpMlineIndex, null);
  });
});

test('native_set_adaptive_bitrate sends camelCase bitrateBps with the minimum clamp', async () => {
  await withMockedTauri(async (calls) => {
    const svc = new ScreenCaptureService();
    await svc.setNativeAdaptiveBitrate(1_234_567.4);
    await svc.setNativeAdaptiveBitrate(10);
    assert.deepEqual(calls[0].args, { bitrateBps: 1_234_567 });
    assert.deepEqual(calls[1].args, { bitrateBps: 200_000 });
  });
});

test('answer/remove peer commands use camelCase peerId', async () => {
  await withMockedTauri(async (calls) => {
    const svc = new ScreenCaptureService();
    await svc.handleNativeScreenAnswer('user-1', 'v=0');
    await svc.removeNativeScreenPeer('user-1');
    assert.deepEqual(calls[0].args, { peerId: 'user-1', sdp: 'v=0' });
    assert.deepEqual(calls[1].args, { peerId: 'user-1' });
  });
});

test('native_start_screen_share nests a camelCase options payload', async () => {
  await withMockedTauri(async (calls) => {
    const svc = new ScreenCaptureService();
    await svc.startNativeShare({
      source_id: 'monitor:0x10001',
      preset: '720p60',
      cursor_enabled: false,
      include_app_audio: false,
      force_software: true,
      ice_servers: [{ urls: ['stun:a'], username: 'u', credential: 'c' }],
    });
    assert.equal(calls[0].cmd, 'native_start_screen_share');
    assert.deepEqual(Object.keys(calls[0].args), ['options']);
    assert.deepEqual(calls[0].args.options, {
      sourceId: 'monitor:0x10001',
      preset: '720p60',
      cursorEnabled: false,
      includeAppAudio: false,
      forceSoftware: true,
      iceServers: [{ urls: ['stun:a'], username: 'u', credential: 'c' }],
    });
  });
  assert.deepEqual(toNativeStartOptionsPayload({ source_id: 'window:0xABCD' }), {
    sourceId: 'window:0xABCD',
  });
});

test('every payload sent by the service matches the camelCase args declared in Rust', async () => {
  const rustArgs = parseRustCommandArgs();
  await withMockedTauri(async (calls) => {
    const svc = new ScreenCaptureService();
    await svc.startNativeShare({ source_id: 'monitor:0x1' });
    await svc.stopNativeShare();
    await svc.setNativeScreenQuality('auto');
    await svc.setNativeAdaptiveBitrate(500_000);
    await svc.addNativeScreenPeer('p', [{ urls: 'stun:x' }]);
    await svc.removeNativeScreenPeer('p');
    await svc.handleNativeScreenAnswer('p', 'sdp');
    await svc.handleNativeScreenIce('p', 'candidate:3 1 udp 1 192.0.2.1 9 typ host', '0', 0);
    for (const { cmd, args } of calls) {
      const declared = rustArgs.get(cmd);
      assert.ok(declared, `${cmd} must exist as a Rust #[tauri::command]`);
      for (const key of Object.keys(args)) {
        assert.ok(!key.includes('_'), `${cmd}: key "${key}" must be camelCase`);
        assert.ok(declared.includes(key), `${cmd}: key "${key}" is not a Rust argument (${declared.join(', ')})`);
      }
      for (const required of declared.filter((d) => !/^iceServers$|^sdpMid$|^sdpMlineIndex$|^screenSessionId$/.test(d))) {
        assert.ok(required in args, `${cmd}: missing required argument "${required}"`);
      }
    }
  });
});

test('native error strings from Tauri are surfaced, never replaced by a generic message', () => {
  for (const file of [
    'src/stores/useAppStore.ts',
    'src/services/CallService.ts',
  ]) {
    const src = fs.readFileSync(path.join(rootDir, file), 'utf8');
    assert.match(src, /typeof err === 'string'/, `${file} must handle Tauri string rejections`);
  }
});


test('temporary bitrate experiment uses its own command and never edits official presets', async () => {
  await withMockedTauri(async calls => {
    const service = new ScreenCaptureService();
    await service.setNativeBitrateExperiment('b6');
    await service.setNativeBitrateExperiment('official');
    assert.deepEqual(calls.map(call => [call.cmd,call.args]), [
      ['native_set_screen_bitrate_experiment',{profile:'b6'}],
      ['native_set_screen_bitrate_experiment',{profile:'official'}],
    ]);
  });
});


test('native signaling carries the expected screen session across IPC', async () => {
  await withMockedTauri(async calls => {
    const svc=new ScreenCaptureService();
    await svc.handleNativeScreenAnswer('peer','v=0','123');
    await svc.handleNativeScreenIce('peer','candidate:1 1 udp 1 192.0.2.1 9 typ host','0',0,'123');
    assert.equal(calls[0].args.screenSessionId,'123');
    assert.equal(calls[1].args.screenSessionId,'123');
  });
});
