import test from 'node:test';
import assert from 'node:assert/strict';
import {
  UpdatePolicyService,
  compareVersions,
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

test('compareVersions orders stable and nightly versions accurately', () => {
  assert.ok(compareVersions('0.4.0-nightly.10', '0.4.0-nightly.8') > 0);
  assert.ok(compareVersions('0.4.0', '0.4.0-nightly.9') > 0);
  assert.equal(compareVersions('0.4.0-nightly.8', '0.4.0-nightly.8'), 0);
});

test('stable channel rejects nightly/prerelease and downgrades', () => {
  assert.equal(isUpdateAllowedForChannel('0.4.0', '0.4.1', 'stable'), true);
  assert.equal(isUpdateAllowedForChannel('0.4.0', '0.4.1-nightly.1', 'stable'), false);
  assert.equal(isUpdateAllowedForChannel('0.4.0', '0.3.9', 'stable'), false);
});

test('nightly channel dismisses specific version across restarts and notifies on newer', () => {
  withMockStorage(() => {
    const svc = new UpdatePolicyService();
    assert.equal(svc.shouldShowNightlyNotification('0.4.0-nightly.8', '0.4.0-nightly.9', false), true);
    svc.dismissNightlyVersion('0.4.0-nightly.9');
    assert.equal(svc.shouldShowNightlyNotification('0.4.0-nightly.8', '0.4.0-nightly.9', false), false);
    assert.equal(svc.shouldShowNightlyNotification('0.4.0-nightly.8', '0.4.0-nightly.10', false), true);
  });
});

test('mandatory update overrides dismissed nightly version', () => {
  withMockStorage(() => {
    const svc = new UpdatePolicyService();
    svc.dismissNightlyVersion('0.4.0-nightly.9');
    assert.equal(svc.shouldShowNightlyNotification('0.4.0-nightly.8', '0.4.0-nightly.9', true), true);
  });
});

test('isVersionCompatible enforces min_client_version_stable and min_client_version_nightly', () => {
  const contract = {
    min_client_version_stable: '0.4.0',
    min_client_version_nightly: '0.4.0-nightly.8',
  };
  assert.equal(isVersionCompatible('0.4.0', 'stable', contract), true);
  assert.equal(isVersionCompatible('0.3.9', 'stable', contract), false);
  assert.equal(isVersionCompatible('0.4.0-nightly.8', 'beta', contract), true);
  assert.equal(isVersionCompatible('0.4.0-nightly.7', 'beta', contract), false);
  assert.equal(isVersionCompatible('0.1.0', 'stable', null), true);
});
