import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  compareSemver,
  selectLatestOfficialReleases,
  fetchGitHubReleases,
  syncReadmeFromReleases,
} = require('../scripts/sync-readme-github.cjs');

function mkRelease(tag: string, opts: { draft?: boolean; prerelease?: boolean; assets?: string[] } = {}) {
  return {
    tag_name: tag,
    draft: opts.draft ?? false,
    prerelease: opts.prerelease ?? tag.includes('-nightly.'),
    assets: (opts.assets ?? []).map((name) => ({ name })),
  };
}

test('compareSemver orders Stable and Nightly prereleases accurately', () => {
  assert.equal(compareSemver('0.4.0-nightly.11', '0.4.0-nightly.9'), 1);
  assert.equal(compareSemver('0.4.0-nightly.10', '0.4.0-nightly.11'), -1);
  assert.equal(compareSemver('0.4.0', '0.4.0-nightly.11'), 1);
  assert.equal(compareSemver('0.2.5', '0.2.1'), 1);
});

test('selectLatestOfficialReleases ignores drafts, unknown prereleases, missing assets and downgrades', () => {
  const releases = [
    mkRelease('v0.2.1', { assets: ['nexus_0.2.1_x64-setup.exe', 'latest.json'] }),
    mkRelease('v0.2.5', { assets: ['nexus_0.2.5_x64-setup.exe', 'latest.json'] }),
    mkRelease('v0.3.0', { draft: true, assets: ['nexus_0.3.0_x64-setup.exe', 'latest.json'] }),
    mkRelease('v0.4.0', { assets: ['nexus_0.4.0_x64-setup.exe'] }), // missing latest.json
    mkRelease('v0.5.0-rc.1', { prerelease: true, assets: ['nexus_0.5.0-rc.1_x64-setup.exe', 'latest-nightly.json'] }),
    mkRelease('v0.4.0-nightly.9', { prerelease: true, assets: ['nexus_0.4.0-nightly.9_x64-setup.exe', 'latest-nightly.json'] }),
    mkRelease('v0.4.0-nightly.11', { prerelease: true, assets: ['nexus_0.4.0-nightly.11_x64-setup.exe', 'latest-nightly.json'] }),
    mkRelease('v0.4.0-nightly.12', { prerelease: true, assets: ['latest-nightly.json'] }), // missing installer
  ];

  const selected = selectLatestOfficialReleases(releases, '0.2.5', '0.4.0-nightly.11');
  assert.equal(selected.stable?.version, '0.2.5');
  assert.equal(selected.nightly?.version, '0.4.0-nightly.11');

  // Never downgrades below current README version
  const olderOnly = [
    mkRelease('v0.2.1', { assets: ['nexus_0.2.1_x64-setup.exe', 'latest.json'] }),
    mkRelease('v0.4.0-nightly.9', { prerelease: true, assets: ['nexus_0.4.0-nightly.9_x64-setup.exe', 'latest-nightly.json'] }),
  ];
  const noDowngrade = selectLatestOfficialReleases(olderOnly, '0.2.5', '0.4.0-nightly.11');
  assert.equal(noDowngrade.stable, null);
  assert.equal(noDowngrade.nightly, null);
});

test('fetchGitHubReleases handles pagination and rejects API errors safely', async () => {
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
    () =>
      fetchGitHubReleases({
        fetchImpl: async () => ({ ok: false, status: 503 } as any),
      }),
    /HTTP 503/,
  );
});

test('syncReadmeFromReleases is idempotent on actual README with v0.2.5 and v0.4.0-nightly.11', () => {
  const readmePath = path.resolve(import.meta.dirname, '..', 'README.md');
  const actual = fs.readFileSync(readmePath, 'utf8');
  const releases = [
    mkRelease('v0.2.5', { assets: ['nexus_0.2.5_x64-setup.exe', 'latest.json'] }),
    mkRelease('v0.4.0-nightly.11', { prerelease: true, assets: ['nexus_0.4.0-nightly.11_x64-setup.exe', 'latest-nightly.json'] }),
  ];

  const first = syncReadmeFromReleases({ readmeContent: actual, releases });
  const second = syncReadmeFromReleases({ readmeContent: first.content, releases });
  assert.equal(first.content.trim(), actual.trim());
  assert.equal(second.content.trim(), first.content.trim());
});
