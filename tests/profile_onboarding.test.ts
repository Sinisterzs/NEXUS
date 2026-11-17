import assert from 'node:assert/strict';
import test from 'node:test';
import { ProfileOnboardingService } from '../src/services/ProfileOnboardingService.ts';

test('ProfileOnboardingService isolates pending state per userId', () => {
  const store = new Map<string, string>();
  const originalStorage = globalThis.localStorage;

  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
    },
  });

  try {
    const svc = new ProfileOnboardingService();
    svc.markPending('user-a');
    assert.equal(svc.isPending('user-a'), true);
    assert.equal(svc.isPending('user-b'), false);

    svc.clearPending('user-a');
    assert.equal(svc.isPending('user-a'), false);
  } finally {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: originalStorage,
    });
  }
});

test('ProfileOnboardingService handles unavailable localStorage without loops', () => {
  const originalStorage = globalThis.localStorage;
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() {
      throw new Error('Storage disabled');
    },
  });

  try {
    const svc = new ProfileOnboardingService();
    assert.doesNotThrow(() => svc.markPending('user-a'));
    assert.equal(svc.isPending('user-a'), false);
    assert.doesNotThrow(() => svc.clearPending('user-a'));
  } finally {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: originalStorage,
    });
  }
});
