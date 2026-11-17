import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

test('MinimalSplashView defines all 7 updater demo states gated behind import.meta.env.DEV', () => {
  const src = fs.readFileSync(
    path.resolve(process.cwd(), 'src/features/startup/MinimalSplashView.tsx'),
    'utf8',
  );
  for (const stateId of [
    'initializing',
    'checking',
    'available',
    'preparing',
    'completed',
    'transient_error',
    'up_to_date',
  ]) {
    assert.ok(src.includes(`id: '${stateId}'`), `Missing demo state: ${stateId}`);
  }
  assert.ok(src.includes('.env?.DEV && demoMode'), 'Demo mode must be gated by import.meta.env.DEV');
});

test('App.tsx gates splashDemo=1 behind import.meta.env.DEV', () => {
  const src = fs.readFileSync(path.resolve(process.cwd(), 'src/app/App.tsx'), 'utf8');
  assert.ok(src.includes('.env?.DEV'), 'App.tsx must gate splashDemo behind import.meta.env.DEV');
  assert.ok(src.includes("get('splashDemo') === '1'"));
});
