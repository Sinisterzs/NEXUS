import test from 'node:test';
import assert from 'node:assert/strict';
import { AvatarService, resolveAvatarUrl } from '../src/services/AvatarService.ts';

test('resolveAvatarUrl resolves relative /v1/avatars paths without duplicating /v1', () => {
  assert.equal(
    resolveAvatarUrl('/v1/avatars/abc-123.png', 'https://api.nexus.app/'),
    'https://api.nexus.app/v1/avatars/abc-123.png',
  );
  assert.equal(
    resolveAvatarUrl('https://cdn.nexus.app/v1/avatars/abc.png', 'https://api.nexus.app'),
    'https://cdn.nexus.app/v1/avatars/abc.png',
  );
});

test('resolveAvatarUrl rejects data: URLs and empty values', () => {
  assert.equal(resolveAvatarUrl('data:image/png;base64,AAAA'), undefined);
  assert.equal(resolveAvatarUrl('   '), undefined);
  assert.equal(resolveAvatarUrl(null), undefined);
});

test('AvatarService.uploadAvatar sends raw binary body with Content-Type and Bearer token', async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = '';
  let capturedMethod = '';
  let capturedHeaders: Record<string, string> = {};
  let capturedBodySize = 0;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    capturedUrl = String(input);
    capturedMethod = init?.method || '';
    capturedHeaders = (init?.headers as Record<string, string>) || {};
    capturedBodySize = (init?.body as ArrayBuffer)?.byteLength ?? 0;
    return new Response(
      JSON.stringify({ avatar_url: '/v1/avatars/550e8400-e29b-41d4-a716-446655440000.png' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as typeof fetch;

  try {
    const svc = new AvatarService();
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'avatar.png', {
      type: 'image/png',
    });
    const url = await svc.uploadAvatar(file, {
      apiBaseUrl: 'https://api.nexus.app',
      token: 'tok-123',
    });
    assert.equal(capturedUrl, 'https://api.nexus.app/v1/users/me/avatar');
    assert.equal(capturedMethod, 'POST');
    assert.equal(capturedHeaders.Authorization, 'Bearer tok-123');
    assert.equal(capturedHeaders['Content-Type'], 'image/png');
    assert.equal(capturedBodySize, 4);
    assert.equal(url, 'https://api.nexus.app/v1/avatars/550e8400-e29b-41d4-a716-446655440000.png');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('AvatarService.deleteAvatar calls DELETE /v1/users/me/avatar', async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = '';
  let capturedMethod = '';

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    capturedUrl = String(input);
    capturedMethod = init?.method || '';
    return new Response(null, { status: 200 });
  }) as typeof fetch;

  try {
    const svc = new AvatarService();
    await svc.deleteAvatar({ apiBaseUrl: 'https://api.nexus.app', token: 'tok-123' });
    assert.equal(capturedUrl, 'https://api.nexus.app/v1/users/me/avatar');
    assert.equal(capturedMethod, 'DELETE');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
