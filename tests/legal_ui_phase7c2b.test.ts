import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isSafeExternalUrl,
  LegalApiError,
  LegalDocumentsService,
} from '../src/services/LegalDocumentsService.ts';

test('isSafeExternalUrl allows only https URLs and blocks unsafe schemes', () => {
  assert.equal(isSafeExternalUrl('https://nexus.example/terms'), true);
  assert.equal(isSafeExternalUrl('http://nexus.example/terms'), false);
  assert.equal(isSafeExternalUrl('javascript:alert(1)'), false);
  assert.equal(isSafeExternalUrl('data:text/html,<script>alert(1)</script>'), false);
  assert.equal(isSafeExternalUrl('not a url'), false);
  assert.equal(isSafeExternalUrl(null), false);
});

test('fetchCurrentDocuments deduplicates concurrent requests and validates payload', async () => {
  const service = new LegalDocumentsService();
  let calls = 0;
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async () => {
    calls += 1;
    return new Response(
      JSON.stringify({
        documents: [
          {
            id: '11111111-1111-1111-1111-111111111111',
            doc_type: 'terms_of_use',
            version: '1.0.0',
            content_hash: 'a'.repeat(64),
            published_at: '2026-11-16T00:00:00Z',
            effective_at: '2026-11-16T00:00:00Z',
            content_markdown: '# Termos',
            official_url: null,
          },
        ],
        missing_required_types: ['privacy_policy'],
        complete: false,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as typeof fetch;

  try {
    const [r1, r2] = await Promise.all([
      service.fetchCurrentDocuments('http://localhost:3000'),
      service.fetchCurrentDocuments('http://localhost:3000'),
    ]);
    assert.equal(calls, 1);
    assert.equal(r1.documents.length, 1);
    assert.equal(r2.complete, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchCurrentDocuments maps network failure to LegalApiError NETWORK_ERROR', async () => {
  const service = new LegalDocumentsService();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new TypeError('Failed to fetch');
  }) as typeof fetch;

  try {
    await assert.rejects(
      () => service.fetchCurrentDocuments('http://localhost:3000'),
      (err: unknown) => err instanceof LegalApiError && err.code === 'NETWORK_ERROR',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('acceptDocument maps 409 LEGAL_VERSION_MISMATCH, 401 AUTH_REQUIRED and 503 LEGAL_DOCUMENT_UNAVAILABLE', async () => {
  const service = new LegalDocumentsService();
  const originalFetch = globalThis.fetch;

  const cases: Array<[number, string]> = [
    [409, 'LEGAL_VERSION_MISMATCH'],
    [401, 'AUTH_REQUIRED'],
    [503, 'LEGAL_DOCUMENT_UNAVAILABLE'],
  ];

  try {
    for (const [status, code] of cases) {
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ code, message: 'Erro' }), {
          status,
          headers: { 'Content-Type': 'application/json' },
        })) as typeof fetch;

      await assert.rejects(
        () =>
          service.acceptDocument('http://localhost:3000', 'tok', {
            doc_type: 'terms_of_use',
            version: '0.9.0',
            content_hash: 'b'.repeat(64),
            record_type: 'acceptance',
            flow_origin: 'regularization',
          }),
        (err: unknown) =>
          err instanceof LegalApiError && err.status === status && err.code === code,
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchCurrentDocuments supports AbortController cancellation', async () => {
  const service = new LegalDocumentsService();
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () => service.fetchCurrentDocuments('http://localhost:3000', controller.signal),
    (err: unknown) => err instanceof LegalApiError && err.code === 'NETWORK_ERROR',
  );
});

test('fetchLegalStatus deduplicates concurrent calls and handles ready/outdated/401', async () => {
  const service = new LegalDocumentsService();
  let calls = 0;
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async () => {
    calls += 1;
    return new Response(
      JSON.stringify({
        age_confirmed: true,
        terms_of_use: {
          doc_type: 'terms_of_use',
          status: 'outdated',
          current_version: '1.1.0',
          current_hash: 'a'.repeat(64),
          accepted_version: '1.0.0',
        },
        privacy_policy: {
          doc_type: 'privacy_policy',
          status: 'accepted',
          current_version: '1.0.0',
          current_hash: 'b'.repeat(64),
          accepted_version: '1.0.0',
        },
        ready: false,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as typeof fetch;

  try {
    const [s1, s2] = await Promise.all([
      service.fetchLegalStatus('http://localhost:3000', 'tok123456'),
      service.fetchLegalStatus('http://localhost:3000', 'tok123456'),
    ]);
    assert.equal(calls, 1);
    assert.equal(s1.terms_of_use.status, 'outdated');
    assert.equal(s2.ready, false);

    globalThis.fetch = (async () => new Response(null, { status: 401 })) as typeof fetch;
    await assert.rejects(
      () => service.fetchLegalStatus('http://localhost:3000', 'tok123456'),
      (err: unknown) =>
        err instanceof LegalApiError && err.status === 401 && err.code === 'AUTH_REQUIRED',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
