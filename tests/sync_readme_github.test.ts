import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  compareSemver,
  selectLatestOfficialReleases,
  fetchGitHubReleases,
  syncReadmeFromReleases,
} = require('../scripts/sync-readme-github.cjs');

function mkRelease(
  tag: string,
  opts: { draft?: boolean; prerelease?: boolean; assets?: Array<string | { name: string; browser_download_url?: string }> } = {},
) {
  return {
    tag_name: tag,
    draft: opts.draft ?? false,
    prerelease: opts.prerelease ?? tag.includes('-nightly.'),
    assets: (opts.assets ?? []).map((a) =>
      typeof a === 'string'
        ? { name: a, browser_download_url: `https://github.com/Sinisterzs/NEXUS/releases/download/${tag}/${a}` }
        : a,
    ),
  };
}

test('compareSemver orders Stable and Nightly prereleases numerically', () => {
  assert.equal(compareSemver('0.4.0-nightly.11', '0.4.0-nightly.9'), 1);
  assert.equal(compareSemver('0.4.0-nightly.10', '0.4.0-nightly.11'), -1);
  assert.equal(compareSemver('0.4.0', '0.4.0-nightly.11'), 1);
  assert.equal(compareSemver('0.2.5', '0.2.1'), 1);
});

test('selectLatestOfficialReleases enforces channel rules, assets, URLs, and anti-downgrade', () => {
  const releases = [
    mkRelease('v0.2.1', { assets: ['nexus_0.2.1_x64-setup.exe', 'latest.json'] }),
    mkRelease('v0.2.5', { assets: ['nexus_0.2.5_x64-setup.exe', 'latest.json'] }),
    mkRelease('v0.3.0', { draft: true, assets: ['nexus_0.3.0_x64-setup.exe', 'latest.json'] }),
    mkRelease('v0.4.0', { assets: ['nexus_0.4.0_x64-setup.exe'] }), // missing latest.json
    mkRelease('v0.5.0-rc.1', { prerelease: true, assets: ['nexus_0.5.0-rc.1_x64-setup.exe', 'latest-nightly.json'] }),
    mkRelease('v0.4.0-nightly.9', { prerelease: true, assets: ['nexus_0.4.0-nightly.9_x64-setup.exe', 'latest-nightly.json'] }),
    mkRelease('v0.4.0-nightly.11', { prerelease: true, assets: ['nexus_0.4.0-nightly.11_x64-setup.exe', 'latest-nightly.json'] }),
    mkRelease('v0.4.0-nightly.12', { prerelease: true, assets: ['latest-nightly.json'] }), // missing installer
    mkRelease('v0.4.0-nightly.13', {
      prerelease: true,
      assets: [
        { name: 'nexus_0.4.0-nightly.13_x64-setup.exe', browser_download_url: 'https://github.com/other/repo/releases/download/v0.4.0-nightly.13/nexus_0.4.0-nightly.13_x64-setup.exe' },
        { name: 'latest-nightly.json', browser_download_url: 'https://github.com/Sinisterzs/NEXUS/releases/download/v0.4.0-nightly.13/latest-nightly.json' },
      ],
    }),
  ];

  const selected = selectLatestOfficialReleases(releases, '0.2.5', '0.4.0-nightly.11');
  assert.equal(selected.stable?.version, '0.2.5');
  assert.equal(selected.nightly?.version, '0.4.0-nightly.11');

  const olderOnly = [
    mkRelease('v0.2.1', { assets: ['nexus_0.2.1_x64-setup.exe', 'latest.json'] }),
    mkRelease('v0.4.0-nightly.9', { prerelease: true, assets: ['nexus_0.4.0-nightly.9_x64-setup.exe', 'latest-nightly.json'] }),
  ];
  const noDowngrade = selectLatestOfficialReleases(olderOnly, '0.2.5', '0.4.0-nightly.11');
  assert.equal(noDowngrade.stable, null);
  assert.equal(noDowngrade.nightly, null);
});

test('fetchGitHubReleases handles pagination, HTTP errors, timeouts, and invalid JSON', async () => {
  const page1 = Array.from({ length: 30 }, (_, i) => mkRelease(`v0.4.0-nightly.${i + 1}`));
  const page2 = [mkRelease('v0.4.0-nightly.31')];
  let calls = 0;

  const releases = await fetchGitHubReleases({
    fetchImpl: async () => {
      calls++;
      return {
        ok: true,
        status: 200,
        json: async () => (calls === 1 ? page1 : page2),
      } as any;
    },
  });
  assert.equal(calls, 2);
  assert.equal(releases.length, 31);

  await assert.rejects(
    () => fetchGitHubReleases({ fetchImpl: async () => ({ ok: false, status: 503 } as any) }),
    /HTTP 503/,
  );

  await assert.rejects(
    () =>
      fetchGitHubReleases({
        timeoutMs: 10,
        fetchImpl: async (_url: string, init: any) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(new Error('Request aborted')));
          }),
      }),
    /aborted/,
  );

  await assert.rejects(
    () =>
      fetchGitHubReleases({
        fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token'); } } as any),
      }),
    /Unexpected token/,
  );
});

test('syncReadmeFromReleases updates channels independently, preserves external text, and fails on malformed markers', () => {
  const readmePath = path.resolve(import.meta.dirname, '..', 'README.md');
  const actual = fs.readFileSync(readmePath, 'utf8');

  // 1. Idempotency with current official versions
  const currentReleases = [
    mkRelease('v0.2.5', { assets: ['nexus_0.2.5_x64-setup.exe', 'latest.json'] }),
    mkRelease('v0.4.0-nightly.11', { prerelease: true, assets: ['nexus_0.4.0-nightly.11_x64-setup.exe', 'latest-nightly.json'] }),
  ];
  const first = syncReadmeFromReleases({ readmeContent: actual, releases: currentReleases });
  const second = syncReadmeFromReleases({ readmeContent: first.content, releases: currentReleases });
  assert.equal(first.content.trim(), actual.trim());
  assert.equal(second.content.trim(), first.content.trim());

  // 2. Updating Stable preserves Nightly and external text
  const stableUpgrade = syncReadmeFromReleases({
    readmeContent: actual,
    releases: [mkRelease('v0.2.6', { assets: ['nexus_0.2.6_x64-setup.exe', 'latest.json'] })],
  });
  assert.match(stableUpgrade.content, /v0\.2\.6/);
  assert.match(stableUpgrade.content, /v0\.4\.0-nightly\.11/);
  assert.match(stableUpgrade.content, /assinatura criptográfica Minisign/);

  // 3. Updating Nightly preserves Stable
  const nightlyUpgrade = syncReadmeFromReleases({
    readmeContent: actual,
    releases: [mkRelease('v0.4.0-nightly.12', { prerelease: true, assets: ['nexus_0.4.0-nightly.12_x64-setup.exe', 'latest-nightly.json'] })],
  });
  assert.match(nightlyUpgrade.content, /v0\.4\.0-nightly\.12/);
  assert.match(nightlyUpgrade.content, /v0\.2\.5/);

  // 4. Missing markers fail safely
  assert.throws(() =>
    syncReadmeFromReleases({
      readmeContent: '# Invalid README without markers',
      releases: currentReleases,
    }),
  );
});

test('git branch management merges advancing main into open auto-sync branch and supports post-merge cycle', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-doc443-'));
  const remoteDir = path.join(tmp, 'remote.git');
  const workDir = path.join(tmp, 'work');
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

  try {
    fs.mkdirSync(remoteDir);
    git(remoteDir, 'init', '--bare');
    git(tmp, 'clone', remoteDir, 'work');
    git(workDir, 'config', 'user.name', 'github-actions[bot]');
    git(workDir, 'config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com');
    git(workDir, 'checkout', '-b', 'main');
    fs.writeFileSync(path.join(workDir, 'README.md'), 'base\n');
    git(workDir, 'add', 'README.md');
    git(workDir, 'commit', '-m', 'init');
    git(workDir, 'push', '-u', 'origin', 'main');

    // Create docs/auto-sync-readme with a commit
    git(workDir, 'checkout', '-b', 'docs/auto-sync-readme', 'origin/main');
    fs.writeFileSync(path.join(workDir, 'README.md'), 'auto-sync\n');
    git(workDir, 'add', 'README.md');
    git(workDir, 'commit', '-m', 'auto-sync');
    git(workDir, 'push', '-u', 'origin', 'docs/auto-sync-readme');

    // Advance main with a non-conflicting file
    git(workDir, 'checkout', 'main');
    fs.writeFileSync(path.join(workDir, 'OTHER.md'), 'other\n');
    git(workDir, 'add', 'OTHER.md');
    git(workDir, 'commit', '-m', 'advance main');
    git(workDir, 'push', 'origin', 'main');

    // Simulate open PR workflow: merge origin/main into docs/auto-sync-readme and push without force
    git(workDir, 'checkout', 'docs/auto-sync-readme');
    git(workDir, 'fetch', 'origin', 'main');
    git(workDir, 'merge', '--no-edit', 'origin/main');
    git(workDir, 'push', 'origin', 'docs/auto-sync-readme');
    assert.equal(fs.existsSync(path.join(workDir, 'OTHER.md')), true);

    // Simulate PR merged into main -> new cycle starts cleanly from origin/main
    git(workDir, 'checkout', 'main');
    git(workDir, 'merge', '--no-edit', 'docs/auto-sync-readme');
    git(workDir, 'push', 'origin', 'main');
    git(workDir, 'fetch', 'origin', 'main');
    git(workDir, 'fetch', 'origin', 'docs/auto-sync-readme');
    // is-ancestor exits 0 when docs/auto-sync-readme is merged into origin/main
    git(workDir, 'merge-base', '--is-ancestor', 'origin/docs/auto-sync-readme', 'origin/main');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
