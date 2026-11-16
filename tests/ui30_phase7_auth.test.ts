import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

test('Phase 7B: accessible fields, hidden passwords, shared requirements and non-blocking consent preview', async () => {
  const directory = await mkdtemp(path.resolve('node_modules/.nexus-phase7-auth-'));
  try {
    const result = await build({
      entryPoints: ['src/features/auth/AuthPrimitives.tsx'], bundle: true,
      platform: 'node', format: 'esm', packages: 'external', write: false,
    });
    const entry = path.join(directory, 'auth.mjs');
    await writeFile(entry, result.outputFiles[0].text);
    const { AuthField, AuthProgress, PasswordRequirements, AuthConsentPreview } = await import(pathToFileURL(entry).href);
    const render = (component: React.ComponentType<any>, props: object) => renderToStaticMarkup(React.createElement(component, props));
    const field = render(AuthField, { label: 'Senha', type: 'password', error: 'Confira sua senha.', defaultValue: '', autoComplete: 'current-password' });
    const inputId = field.match(/<input[^>]*\bid="([^"]+)"/)?.[1];
    assert.ok(inputId, 'field has a unique ID');
    assert.ok(field.includes(`for="${inputId}"`), 'label targets its input');
    assert.ok(field.includes('type="password"'), 'password is initially hidden');
    assert.ok(field.includes('aria-invalid="true"'), 'error is associated with the field');
    assert.ok(field.includes(`aria-describedby="${inputId}-hint"`));
    assert.ok(field.includes('aria-label="Mostrar senha"'));
    assert.ok(field.includes('type="button"'), 'visibility toggle cannot submit the form');
    assert.ok(field.includes('autoComplete="current-password"') || field.includes('autocomplete="current-password"'));

    const empty = render(PasswordRequirements, { password: '', confirmation: '' });
    const matching = render(PasswordRequirements, { password: 'fictitious-password', confirmation: 'fictitious-password' });
    const mismatch = render(PasswordRequirements, { password: 'fictitious-password', confirmation: 'different-password' });
    assert.equal((empty.match(/data-met="true"/g) || []).length, 0);
    assert.equal((matching.match(/data-met="true"/g) || []).length, 2);
    assert.equal((mismatch.match(/data-met="true"/g) || []).length, 1);

    const consent = render(AuthConsentPreview, { legalLink: (name: string) => React.createElement('button', { type: 'button' }, name) });
    assert.equal((consent.match(/type="checkbox"/g) || []).length, 3);
    assert.equal(/\schecked(?:=|\s|>)/.test(consent), false, 'no acceptance is preselected');
    assert.equal(/\srequired(?:=|\s|>)/.test(consent), false, 'preview cannot restrict existing registration');
    assert.ok(consent.includes('ainda não condicionam o cadastro'));
    assert.ok(consent.includes('Termos de Uso') && consent.includes('Política de Privacidade'));

    const progress = render(AuthProgress, { message: 'Autenticando...' });
    assert.ok(progress.includes('role="status"') && progress.includes('aria-live="polite"'));
    assert.ok(progress.includes('aria-atomic="true"') && progress.includes('Autenticando...'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
