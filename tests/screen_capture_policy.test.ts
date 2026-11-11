import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canRetryDisplayCapture,
  getCaptureSourcePresentation,
  normalizeDisplaySurface,
} from '../src/lib/screenCapturePolicy.ts';
import {
  buildDisplayMediaVideoConstraints,
  buildDisplayVideoConstraints,
  ScreenCaptureService,
} from '../src/services/ScreenCaptureService.ts';

function captureFixture(surface: unknown = 'window') {
  let stopped = false;
  const track = {
    id: 'test-video',
    label: 'Private document - sensitive title',
    getSettings: () => ({ displaySurface: surface, width: 1280, height: 720, frameRate: 30 }),
    addEventListener() {},
    removeEventListener() {},
    stop() { stopped = true; },
  };
  const stream = { getVideoTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream;
  return { stream, wasStopped: () => stopped };
}

async function withCapture(
  getDisplayMedia: (options?: DisplayMediaStreamOptions) => Promise<MediaStream>,
  run: (service: ScreenCaptureService, consent: boolean[]) => Promise<void>
) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true, value: { mediaDevices: { getDisplayMedia } },
  });
  const service = new ScreenCaptureService();
  const consent: boolean[] = [];
  // Exercise lifecycle without loading Tauri or granting any real native permission.
  (service as any).setNativeConsent = async (granted: boolean) => { consent.push(granted); };
  try {
    await run(service, consent);
  } finally {
    service.destroy();
    if (original) Object.defineProperty(globalThis, 'navigator', original);
    else Reflect.deleteProperty(globalThis, 'navigator');
  }
}

test('window preference is acquisition-only, in both paths, with no exact source constraint', () => {
  for (const fallback of [false, true]) {
    const options = buildDisplayMediaVideoConstraints('1080p60', fallback) as any;
    assert.equal(options.displaySurface, 'window');
    assert.equal(options.cursor, 'always');
    assert.equal(options.frameRate.max, fallback ? 30 : 60);
    assert.equal(JSON.stringify(options).includes('exact'), false);
    assert.equal(JSON.stringify(options).includes('deviceId'), false);
  }
  assert.equal('displaySurface' in buildDisplayVideoConstraints('720p30'), false);
});

test('actual settings determine source and warnings; unknown values never imply window', () => {
  for (const surface of ['monitor', 'window', 'browser'] as const) {
    assert.equal(normalizeDisplaySurface(surface), surface);
  }
  for (const surface of [undefined, null, '', 'application', {}, 1]) {
    assert.equal(normalizeDisplaySurface(surface), null);
  }
  assert.match(getCaptureSourcePresentation('monitor').notice!, /barra/);
  assert.match(getCaptureSourcePresentation(null).notice!, /não informou/);
  assert.equal(getCaptureSourcePresentation('window').notice, null);
});

test('constraint fallback keeps window preference, audio disabled and revokes temporary consent', async () => {
  const fixture = captureFixture('monitor');
  const requests: DisplayMediaStreamOptions[] = [];
  await withCapture(async (options) => {
    requests.push(options!);
    if (requests.length === 1) throw Object.assign(new Error('quality'), { name: 'OverconstrainedError' });
    return fixture.stream;
  }, async (service, consent) => {
    assert.equal(await service.startCapture('1080p60'), fixture.stream);
    assert.equal(requests.length, 2);
    for (const request of requests) {
      assert.equal(request.audio, false);
      assert.equal((request.video as any).displaySurface, 'window');
    }
    assert.deepEqual(consent, [true, false]);
    const state = service.getState();
    assert.equal(state.displaySurface, 'monitor', 'picker hint must not override effective settings');
    assert.equal(state.sourceLabel, 'Monitor inteiro');
    assert.match(state.captureNotice!, /barra/);
    assert.equal(JSON.stringify(state).includes('Private document'), false);
    service.stopCapture();
    assert.equal(fixture.wasStopped(), true);
    assert.equal(service.getState().captureNotice, null);
  });
});

test('denial, cancellation, missing source and access errors never reopen picker', async () => {
  for (const name of ['NotAllowedError', 'AbortError', 'NotFoundError', 'DevicesNotFoundError', 'NotReadableError', 'InvalidStateError', 'SecurityError', 'Error']) {
    assert.equal(canRetryDisplayCapture({ name }), false);
    let requests = 0;
    await withCapture(async () => {
      requests++;
      throw Object.assign(new Error('test rejection'), { name });
    }, async (service, consent) => {
      assert.equal(await service.startCapture(), null);
      assert.equal(requests, 1, name);
      assert.deepEqual(consent, [true, false], name);
      assert.equal(service.getState().isCapturing, false);
    });
  }
});

test('TypeError compatibility retry still requires a fresh picker result', async () => {
  let requests = 0;
  await withCapture(async () => {
    requests++;
    throw requests === 1 ? new TypeError('unsupported constraints') : Object.assign(new Error('cancel'), { name: 'NotAllowedError' });
  }, async (service, consent) => {
    assert.equal(await service.startCapture(), null);
    assert.equal(requests, 2);
    assert.deepEqual(consent, [true, false]);
    assert.equal(service.getState().stream, null);
  });
});

test('stop during a pending selection prevents fallback and stops any late granted track', async () => {
  let rejectSelection!: (reason: unknown) => void;
  let requests = 0;
  await withCapture(async () => {
    requests++;
    return new Promise((_resolve, reject) => { rejectSelection = reject; });
  }, async (service) => {
    const pending = service.startCapture();
    await Promise.resolve();
    service.stopCapture();
    rejectSelection({ name: 'OverconstrainedError' });
    assert.equal(await pending, null);
    assert.equal(requests, 1);
  });
  const fixture = captureFixture();
  let resolveSelection!: (stream: MediaStream) => void;
  await withCapture(async () => new Promise((resolve) => { resolveSelection = resolve; }), async (service, consent) => {
    const pending = service.startCapture();
    await Promise.resolve();
    service.stopCapture();
    resolveSelection(fixture.stream);
    assert.equal(await pending, null);
    assert.equal(fixture.wasStopped(), true);
    assert.equal(consent.at(-1), false);
  });
});

test('missing settings are warned, never inferred from a sensitive track title', async () => {
  const fixture = captureFixture('unsupported');
  await withCapture(async () => fixture.stream, async (service) => {
    await service.startCapture();
    assert.equal(service.getState().displaySurface, null);
    assert.equal(service.getState().sourceLabel, 'Fonte não identificada');
    assert.match(service.getState().captureNotice!, /não informou/);
  });
});
