import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cache = path.join(root, 'node_modules', '.cache');
fs.mkdirSync(cache, { recursive: true });
const temporary = fs.mkdtempSync(path.join(cache, 'nexus-screen-lifecycle-'));
if (!temporary.startsWith(cache + path.sep)) throw new Error('Invalid test output path');
try {
  const integration = path.join(temporary, 'screen_lifecycle_integration.test.mjs');
  await build({ entryPoints: [path.join(root, 'tests/screen_lifecycle_integration.test.ts')],
    bundle: true, platform: 'node', format: 'esm', packages: 'external',
    define: { 'import.meta.env': '{}' }, outfile: integration });
  for (const file of [
    'tests/screen_preview.test.ts',
    'tests/screen_playback.test.ts',
    'tests/screen_p2p_policy.test.ts',
    'tests/screen_receive_diagnostics.test.ts',
    'tests/screen_share_lifecycle.test.ts',
    integration,
    'tests/native_screen_signaling.test.ts',
    'tests/native_capture_ipc_args.test.ts',
    'tests/calls_and_streaming_v030.test.ts',
  ]) {
    const result = spawnSync(process.execPath, ['--experimental-strip-types', '--test', '--test-concurrency=1', file],
      { cwd: root, stdio: 'inherit', windowsHide: true });
    if (result.error) throw result.error;
    if (result.status !== 0) { process.exitCode = result.status ?? 1; break; }
  }
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
