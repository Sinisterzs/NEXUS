import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as yaml from 'js-yaml';

const version = JSON.parse(await readFile('package.json', 'utf8')).version;
const nightlyFixtureVersion = /^\d+\.\d+\.\d+-nightly\.\d+$/.test(version)
  ? version
  : '0.3.0-nightly.5';

test('Release metadata (Stable or Nightly) is consistent across frontend, npm, Tauri, Rust locks, and user-facing release notes', async () => {
  const json = async file => JSON.parse(await readFile(file, 'utf8'));
  const pkg = await json('package.json');
  const lock = await json('package-lock.json');
  assert.match(pkg.version, /^\d+\.\d+\.\d+(-nightly\.\d+)?$/);
  assert.equal(lock.version, version);
  assert.equal(lock.packages[''].version, version);
  assert.equal((await json('src-tauri/tauri.conf.json')).version, version);
  assert.equal((await readFile('src/version.ts', 'utf8')).match(/APP_VERSION = '([^']+)'/)[1], version);
  assert.equal((await readFile('src-tauri/Cargo.toml', 'utf8')).match(/^version = "([^"]+)"/m)[1], version);
  assert.equal((await readFile('src-tauri/Cargo.lock', 'utf8')).match(/name = "nexus"\r?\nversion = "([^"]+)"/)[1], version);

  const notesPath = `scripts/release-notes-v${version}.md`;
  const notes = await readFile(notesPath, 'utf8');
  assert.ok(notes.trim().length > 100, `${notesPath} must exist and be non-empty`);
  if (/^\d+\.\d+\.\d+(-nightly\.\d+)?$/.test(version)) {
    assert.ok(
      notes.includes('### ✨ Novidades') || notes.includes('### 🚀 Melhorias') || notes.includes('### 🛠️ Correções'),
      `${notesPath} must follow the NEXUS Release Notes standard sections`
    );
    assert.doesNotMatch(
      notes,
      /\b(causa raiz|refatoração|pipeline|hotfix técnico)\b/i,
      `${notesPath} must not contain internal technical jargon`
    );
    assert.doesNotMatch(
      notes,
      /\b(src-tauri|\.rs\b|\.ts\b|\.cjs\b|hooks\.nsh|history\.replaceState|Argon2id|PKCE)\b/,
      `${notesPath} must not expose code files, functions or implementation details`
    );
  }
});

test('version and manifest scripts reject Stable, align locks and select only the exact signed installer', async () => {
  const root = await mkdtemp(path.resolve('node_modules/.nexus-release-fixture-'));
  const run = (script, ...args) => spawnSync(process.execPath, [path.join(root, 'scripts', script), ...args], {
    cwd: root, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, GITHUB_REPOSITORY: 'fixture/nexus', GITHUB_REPOSITORY_OWNER: 'fixture' },
  });
  try {
    for (const directory of ['scripts', 'src', 'src-tauri/target/release/bundle/nsis']) {
      await mkdir(path.join(root, directory), { recursive: true });
    }
    for (const script of ['set-nightly-version.cjs', 'generate-nightly-manifest.cjs', 'audit-nightly-artifacts.cjs']) {
      await copyFile(`scripts/${script}`, path.join(root, 'scripts', script));
    }
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ version: '0.0.0' }));
    await writeFile(path.join(root, 'package-lock.json'), JSON.stringify({ version: '0.0.0', packages: { '': { version: '0.0.0' } } }));
    await writeFile(path.join(root, 'src-tauri/tauri.conf.json'), '{}');
    await writeFile(path.join(root, 'src-tauri/Cargo.toml'), '[package]\nname = "nexus"\nversion = "0.0.0"\n');
    await writeFile(path.join(root, 'src-tauri/Cargo.lock'), '[[package]]\nname = "nexus"\nversion = "0.0.0"\n');
    await writeFile(path.join(root, 'src/version.ts'), "export const APP_VERSION = '0.0.0';\n");
    for (const invalid of ['0.2.1', '0.2.5', '0.3.0-beta.1', '0.3.0-nightly.02']) {
      assert.notEqual(run('set-nightly-version.cjs', invalid).status, 0);
      assert.notEqual(run('generate-nightly-manifest.cjs', invalid).status, 0);
    }
    assert.equal(run('set-nightly-version.cjs', nightlyFixtureVersion).status, 0);
    assert.notEqual(run('audit-nightly-artifacts.cjs').status, 0, 'absent artifacts must never pass an audit');
    assert.ok((await readFile(path.join(root, 'src-tauri/Cargo.lock'), 'utf8')).includes(`version = "${nightlyFixtureVersion}"`));
    const directory = path.join(root, 'src-tauri/target/release/bundle/nsis');
    // These are inert text fixtures with installer-like names; never executed.
    await writeFile(path.join(directory, 'nexus_0.3.0-nightly.1_x64-setup.exe'), 'fixture');
    await writeFile(path.join(directory, 'nexus_0.3.0-nightly.1_x64-setup.exe.sig'), 'old-fixture-signature');
    assert.notEqual(run('generate-nightly-manifest.cjs', nightlyFixtureVersion).status, 0);
    const installer = `nexus_${nightlyFixtureVersion}_x64-setup.exe`;
    await writeFile(path.join(directory, installer), 'fixture');
    assert.notEqual(run('generate-nightly-manifest.cjs', nightlyFixtureVersion).status, 0, 'a different installer signature must not be reused');
    await writeFile(path.join(directory, `${installer}.sig`), '');
    assert.notEqual(run('generate-nightly-manifest.cjs', nightlyFixtureVersion).status, 0);
    await writeFile(path.join(directory, `${installer}.sig`), 'matching-fixture-signature');
    await writeFile(path.join(root, 'latest.json'), '{"version":"0.2.1","fixture":"keep-stable"}');
    assert.equal(run('generate-nightly-manifest.cjs', nightlyFixtureVersion, 'Fixture notes').status, 0);
    const manifest = JSON.parse(await readFile(path.join(root, 'latest-nightly.json'), 'utf8'));
    assert.equal(manifest.version, nightlyFixtureVersion);
    assert.equal(manifest.platforms['windows-x86_64'].signature, 'matching-fixture-signature');
    assert.ok(manifest.platforms['windows-x86_64'].url.endsWith(`/v${nightlyFixtureVersion}/${installer}`));
    assert.equal(await readFile(path.join(root, 'latest.json'), 'utf8'), '{"version":"0.2.1","fixture":"keep-stable"}');
    await writeFile(path.join(root, 'src-tauri/target/release/nexus.exe'), 'inert-native-fixture');
    assert.equal(run('audit-nightly-artifacts.cjs').status, 0);
    const previousManifest = await readFile(path.join(root, 'latest-nightly.json'), 'utf8');
    const customManifest = path.join(root, 'staged', 'latest-nightly.json');
    assert.equal(run('generate-nightly-manifest.cjs', nightlyFixtureVersion, 'Private staging fixture', customManifest).status, 0);
    assert.equal(await readFile(path.join(root, 'latest-nightly.json'), 'utf8'), previousManifest, 'staging must not modify the root manifest');
    assert.equal(run('audit-nightly-artifacts.cjs', customManifest).status, 0);
    const customJson = JSON.parse(await readFile(customManifest, 'utf8'));
    customJson.notes = 'BEGIN PRIVATE KEY - SYNTHETIC MARKER ONLY';
    await writeFile(customManifest, JSON.stringify(customJson));
    assert.notEqual(run('audit-nightly-artifacts.cjs', customManifest).status, 0, 'custom manifests must be inspected for private markers');
    await writeFile(path.join(directory, '.env.fixture'), 'not-a-real-secret');
    assert.notEqual(run('audit-nightly-artifacts.cjs').status, 0, 'private filenames must fail the artifact audit');
    // This test proves pairing/metadata only; no real signature is created or verified.
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Nightly workflow is valid YAML and preserves prerelease/Stable boundaries', async () => {
  const workflow = yaml.load(await readFile('.github/workflows/nightly.yml', 'utf8'));
  const steps = workflow.jobs['build-and-publish-nightly'].steps;
  const publish = steps.find(step => step.uses === 'softprops/action-gh-release@v2');
  assert.equal(workflow.on.workflow_dispatch.inputs.publish_release.default, false);
  assert.equal(publish.if, '${{ inputs.publish_release }}');
  assert.equal(publish.with.prerelease, true);
  assert.equal(publish.with.make_latest, 'false');
  assert.equal(publish.with.draft, false);
  assert.ok(publish.with.files.includes('latest-nightly.json'));
  assert.ok(!publish.with.files.split('\n').some(file => file.trim() === 'latest.json'));
  assert.ok(!publish.with.files.includes('*-setup.exe'), 'upload must use exact versioned filenames');
  assert.ok(steps.some(step => step.run?.includes('npm test')));
  assert.ok(!steps.some(step => /git push|git checkout main|git reset --hard/.test(step.run ?? '')), 'Nightly must not mutate main');
  assert.ok(steps.some(step => step.uses === 'actions/upload-artifact@v4'));
  for (const step of steps) {
    assert.ok(!step.run?.includes('${{ github.event.inputs.'), 'dispatch input must be passed through env, not injected as shell code');
    assert.ok(!step.run?.includes('--features test-lab'));
  }
});
