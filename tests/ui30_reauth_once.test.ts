import assert from 'node:assert/strict';
import test from 'node:test';
import { UI30_REAUTH_KEY, Ui30ReauthService } from '../src/services/Ui30ReauthService.ts';

test('Ui30ReauthService requires reauth until markCompleted is called and survives logout', () => {
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
    const svc = new Ui30ReauthService();
    assert.equal(svc.needsReauth(), true);

    // Failed login must not mark completed
    assert.equal(svc.needsReauth(), true);

    // Successful login marks completed
    svc.markCompleted();
    assert.equal(store.get(UI30_REAUTH_KEY), 'true');
    assert.equal(svc.needsReauth(), false);

    // Normal logout does not clear the marker
    assert.equal(svc.needsReauth(), false);
  } finally {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: originalStorage,
    });
  }
});

test('Ui30ReauthService handles unavailable localStorage safely', () => {
  const originalStorage = globalThis.localStorage;
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() {
      throw new Error('Storage disabled');
    },
  });

  try {
    const svc = new Ui30ReauthService();
    assert.equal(svc.needsReauth(), false);
    assert.doesNotThrow(() => svc.markCompleted());
  } finally {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: originalStorage,
    });
  }
});
