import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const ROOT = process.cwd();

async function collectSourceFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectSourceFiles(full)));
    } else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

async function loadWindowLifecycleModule() {
  const tmpDir = await fs.mkdtemp(path.resolve('node_modules/.nexus-window-lifecycle-'));
  const result = await build({
    stdin: {
      contents: `export * from './src/lib/windowLifecycle.ts';`,
      resolveDir: ROOT,
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    write: false,
  });
  const entry = path.join(tmpDir, 'windowLifecycle.mjs');
  await fs.writeFile(entry, result.outputFiles[0].text, 'utf8');
  const mod = await import(pathToFileURL(entry).href);
  return {
    mod,
    cleanup: () => fs.rm(tmpDir, { recursive: true, force: true }),
  };
}

test('Tauri capabilities include core:window:allow-close and core:window:allow-destroy for main window', async () => {
  const raw = await fs.readFile(path.join(ROOT, 'src-tauri/capabilities/default.json'), 'utf8');
  const parsed = JSON.parse(raw);

  assert.equal(Array.isArray(parsed.windows), true);
  assert.equal(parsed.windows.includes('main'), true);
  assert.equal(Array.isArray(parsed.permissions), true);
  assert.equal(parsed.permissions.includes('core:window:allow-close'), true);
  assert.equal(parsed.permissions.includes('core:window:allow-destroy'), true);
});

test('onCloseRequested handler exists exclusively in src/app/App.tsx with sync preventDefault and window controls contract', async () => {
  const srcFiles = await collectSourceFiles(path.join(ROOT, 'src'));
  const filesWithOnClose: string[] = [];

  for (const filePath of srcFiles) {
    const content = await fs.readFile(filePath, 'utf8');
    if (content.includes('onCloseRequested')) {
      filesWithOnClose.push(path.relative(ROOT, filePath).replace(/\\/g, '/'));
    }
  }

  assert.deepEqual(filesWithOnClose, ['src/app/App.tsx']);

  const appSource = await fs.readFile(path.join(ROOT, 'src/app/App.tsx'), 'utf8');
  assert.match(appSource, /onCloseRequested\s*\(/);
  assert.match(appSource, /event\.preventDefault\(\)/);
  const preventIdx = appSource.indexOf('event.preventDefault()');
  const cleanupIdx = appSource.indexOf('cleanupBeforeWindowClose(');
  const destroyIdx = appSource.indexOf('destroyMainWindow(');
  assert.ok(preventIdx > 0 && cleanupIdx > preventIdx && destroyIdx > cleanupIdx);

  assert.match(appSource, /data-testid="close-confirm-modal"/);
  assert.match(appSource, /data-testid="close-confirm-cancel"/);
  assert.match(appSource, /data-testid="close-confirm-accept"/);
  assert.match(appSource, /<WindowControls\s*\/>/);

  const diagnosticsRuntime = await fs.readFile(path.join(ROOT, 'src/components/DiagnosticsRuntime.tsx'), 'utf8');
  assert.equal(diagnosticsRuntime.includes('onCloseRequested'), false);

  const windowControls = await fs.readFile(path.join(ROOT, 'src/components/WindowControls.tsx'), 'utf8');
  assert.match(windowControls, /aria-label="Minimizar"/);
  assert.match(windowControls, /aria-label="Fechar"/);
  assert.match(windowControls, /data-testid="window-close-btn"/);
});

test('getActiveMediaSessionSummary distinguishes idle, 1:1 call, incoming call, voice room, and screen shares', async () => {
  const { mod, cleanup } = await loadWindowLifecycleModule();
  try {
    const idle = mod.getActiveMediaSessionSummary({
      voiceCallState: 'idle',
      incomingCall: null,
      voiceRoomState: 'idle',
      isScreenSharing: false,
      isStartingScreenShare: false,
      voiceRoomScreenSharing: false,
      nativeCaptureStatus: { active: false },
    });
    assert.equal(idle.hasActiveSession, false);
    assert.equal(idle.inVoiceCall, false);
    assert.equal(idle.hasIncomingCall, false);
    assert.equal(idle.inVoiceRoom, false);
    assert.equal(idle.isScreenSharing, false);

    const call1to1 = mod.getActiveMediaSessionSummary({
      voiceCallState: 'connected',
      incomingCall: null,
      voiceRoomState: 'idle',
    });
    assert.equal(call1to1.hasActiveSession, true);
    assert.equal(call1to1.inVoiceCall, true);
    assert.equal(call1to1.isScreenSharing, false);
    assert.match(call1to1.title, /Chamada/i);

    const incoming = mod.getActiveMediaSessionSummary({
      voiceCallState: 'idle',
      incomingCall: { callId: 'call-123' },
      voiceRoomState: 'idle',
    });
    assert.equal(incoming.hasActiveSession, true);
    assert.equal(incoming.hasIncomingCall, true);
    assert.match(incoming.title, /recebida/i);

    const voiceRoom = mod.getActiveMediaSessionSummary({
      voiceCallState: 'idle',
      incomingCall: null,
      voiceRoomState: 'connected',
    });
    assert.equal(voiceRoom.hasActiveSession, true);
    assert.equal(voiceRoom.inVoiceRoom, true);
    assert.match(voiceRoom.title, /sala de voz/i);

    for (const sharePatch of [
      { isScreenSharing: true },
      { isStartingScreenShare: true },
      { voiceRoomScreenSharing: true },
      { nativeCaptureStatus: { active: true } },
    ]) {
      const shareSummary = mod.getActiveMediaSessionSummary({
        voiceCallState: 'idle',
        incomingCall: null,
        voiceRoomState: 'idle',
        ...sharePatch,
      });
      assert.equal(shareSummary.hasActiveSession, true);
      assert.equal(shareSummary.isScreenSharing, true);
      assert.match(shareSummary.title, /Transmissão/i);
    }

    const callAndShare = mod.getActiveMediaSessionSummary({
      voiceCallState: 'connected',
      isScreenSharing: true,
      voiceRoomState: 'idle',
    });
    assert.equal(callAndShare.hasActiveSession, true);
    assert.equal(callAndShare.inVoiceCall, true);
    assert.equal(callAndShare.isScreenSharing, true);
    assert.match(callAndShare.title, /Chamada e transmissão/i);

    const roomAndShare = mod.getActiveMediaSessionSummary({
      voiceCallState: 'idle',
      voiceRoomState: 'connected',
      voiceRoomScreenSharing: true,
    });
    assert.equal(roomAndShare.hasActiveSession, true);
    assert.equal(roomAndShare.inVoiceRoom, true);
    assert.equal(roomAndShare.isScreenSharing, true);
    assert.match(roomAndShare.title, /Sala de voz e transmissão/i);
  } finally {
    await cleanup();
  }
});

test('cleanupBeforeWindowClose runs active teardown hooks and bounds hung promises with timeoutMs', async () => {
  const { mod, cleanup } = await loadWindowLifecycleModule();
  try {
    const calls: string[] = [];

    await mod.cleanupBeforeWindowClose({
      timeoutMs: 1000,
      deps: {
        getState: () => ({
          voiceCallState: 'connected',
          incomingCall: null,
          activeCallId: 'call-99',
          voiceRoomState: 'connected',
          activeVoiceCommunityId: 'comm-1',
          activeVoiceChannelId: 'ch-1',
          nativeCaptureStatus: { active: true },
        }),
        stopCapture: () => calls.push('stopCapture'),
        stopNativeShare: async () => {
          calls.push('stopNativeShare');
        },
        terminateCall: () => calls.push('terminateCall'),
        sendRoomLeave: (cId: string, chId: string) => calls.push(`sendRoomLeave:${cId}:${chId}`),
        leaveMeshRoom: async () => {
          calls.push('leaveMeshRoom');
        },
        flushSettings: async () => {
          calls.push('flushSettings');
        },
        hasActiveDiagnostics: () => true,
        closeDiagnostics: async () => {
          calls.push('closeDiagnostics');
        },
        disconnectGateway: () => calls.push('disconnectGateway'),
      },
    });

    assert.deepEqual(calls, [
      'stopCapture',
      'stopNativeShare',
      'terminateCall',
      'sendRoomLeave:comm-1:ch-1',
      'leaveMeshRoom',
      'flushSettings',
      'closeDiagnostics',
      'disconnectGateway',
    ]);

    // Bounded timeout: never hangs even when network/service promises stay unresolved forever
    const neverResolves = () => new Promise<void>(() => {});
    const started = Date.now();
    await mod.cleanupBeforeWindowClose({
      timeoutMs: 75,
      deps: {
        getState: () => ({
          voiceCallState: 'idle',
          incomingCall: null,
          activeCallId: null,
          voiceRoomState: 'connected',
          activeVoiceCommunityId: 'comm-2',
          activeVoiceChannelId: 'ch-2',
          nativeCaptureStatus: { active: true },
        }),
        stopCapture: () => {},
        stopNativeShare: neverResolves,
        leaveMeshRoom: neverResolves,
        flushSettings: neverResolves,
        hasActiveDiagnostics: () => true,
        closeDiagnostics: neverResolves,
        disconnectGateway: () => {},
      },
    });
    const elapsedMs = Date.now() - started;
    assert.ok(
      elapsedMs < 500,
      `cleanupBeforeWindowClose exceeded bounded timeout (elapsed=${elapsedMs}ms)`
    );

    // destroyMainWindow fails silently in non-Tauri Node runtime
    await assert.doesNotReject(() => mod.destroyMainWindow());
  } finally {
    await cleanup();
  }
});
