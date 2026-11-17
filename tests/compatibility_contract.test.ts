import test from 'node:test';
import assert from 'node:assert/strict';
import {
  UpdatePolicyService,
  isVersionCompatible,
} from '../src/services/UpdatePolicyService.ts';

test('UP.5 compatibility contract: null minimums allow all clients', () => {
  assert.equal(isVersionCompatible('0.4.0', 'stable', { min_client_version_stable: null, min_client_version_nightly: null }), true);
  assert.equal(isVersionCompatible('0.4.0-nightly.8', 'beta', { min_client_version_stable: null, min_client_version_nightly: null }), true);
});

test('UP.5 compatibility contract: enforces per-channel minimums independently', () => {
  const contract = {
    min_client_version_stable: '0.4.1',
    min_client_version_nightly: '0.4.0-nightly.9',
  };
  assert.equal(isVersionCompatible('0.4.0', 'stable', contract), false);
  assert.equal(isVersionCompatible('0.4.1', 'stable', contract), true);
  assert.equal(isVersionCompatible('0.4.0-nightly.8', 'beta', contract), false);
  assert.equal(isVersionCompatible('0.4.0-nightly.9', 'beta', contract), true);
});

test('UP.5 compatibility contract: backend unavailable (null) never invents incompatibility', () => {
  assert.equal(isVersionCompatible('0.3.0', 'stable', null), true);
  assert.equal(isVersionCompatible('0.4.0-nightly.1', 'beta', undefined), true);
});

test('UP.5 compatibility contract: mandatory update overrides dismissed nightly', () => {
  const store = new Map<string, string>();
  const prev = (globalThis as { localStorage?: Storage }).localStorage;
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
  };
  try {
    const svc = new UpdatePolicyService();
    svc.dismissNightlyVersion('0.4.0-nightly.9');
    assert.equal(svc.shouldShowNightlyNotification('0.4.0-nightly.8', '0.4.0-nightly.9', false), false);
    assert.equal(svc.shouldShowNightlyNotification('0.4.0-nightly.8', '0.4.0-nightly.9', true), true);
  } finally {
    (globalThis as { localStorage?: Storage }).localStorage = prev;
  }
});
