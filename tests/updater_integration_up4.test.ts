import test from 'node:test';
import assert from 'node:assert/strict';
import {
  UpdatePolicyService,
  isUpdateAllowedForChannel,
  isVersionCompatible,
} from '../src/services/UpdatePolicyService.ts';

function withMockStorage(fn: () => void) {
  const store = new Map<string, string>();
  const prev = (globalThis as { localStorage?: Storage }).localStorage;
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
  };
  try {
    fn();
  } finally {
    (globalThis as { localStorage?: Storage }).localStorage = prev;
  }
}

test('UP.4 Nightly flow: Nightly.8 -> Nightly.9 toast, Agora não persists, Nightly.10 re-notifies', () => {
  withMockStorage(() => {
    const policy = new UpdatePolicyService();
    assert.equal(policy.shouldShowNightlyNotification('0.4.0-nightly.8', '0.4.0-nightly.9', false), true);
    policy.dismissNightlyVersion('0.4.0-nightly.9');
    assert.equal(policy.shouldShowNightlyNotification('0.4.0-nightly.8', '0.4.0-nightly.9', false), false);
    assert.equal(policy.shouldShowNightlyNotification('0.4.0-nightly.8', '0.4.0-nightly.10', false), true);
  });
});

test('UP.4 Stable flow: accepts newer stable, rejects nightly and downgrades', () => {
  assert.equal(isUpdateAllowedForChannel('0.4.0', '0.4.1', 'stable'), true);
  assert.equal(isUpdateAllowedForChannel('0.4.0', '0.4.1-nightly.1', 'stable'), false);
  assert.equal(isUpdateAllowedForChannel('0.4.0', '0.3.9', 'stable'), false);
});

test('UP.4 Compatibility: GitHub unavailable without backend incompatibility allows entry', () => {
  assert.equal(isVersionCompatible('0.4.0-nightly.8', 'beta', null), true);
  assert.equal(isVersionCompatible('0.4.0', 'stable', undefined), true);
});
