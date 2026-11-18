const { updateReadmeContent } = require('./sync-readme-release.cjs');

function parseSemver(tagOrVer) {
  if (typeof tagOrVer !== 'string') return null;
  const clean = tagOrVer.trim().replace(/^v/i, '');
  const match = clean.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) return null;
  return {
    raw: clean,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] ? match[4].split('.') : [],
  };
}

function compareSemver(aStr, bStr) {
  const a = parseSemver(aStr);
  const b = parseSemver(bStr);
  if (!a || !b) return 0;
  if (a.major !== b.major) return a.major > b.major ? 1 : -1;
  if (a.minor !== b.minor) return a.minor > b.minor ? 1 : -1;
  if (a.patch !== b.patch) return a.patch > b.patch ? 1 : -1;

  if (a.pre.length === 0 && b.pre.length === 0) return 0;
  if (a.pre.length === 0) return 1;
  if (b.pre.length === 0) return -1;

  const len = Math.max(a.pre.length, b.pre.length);
  for (let i = 0; i < len; i++) {
    if (i >= a.pre.length) return -1;
    if (i >= b.pre.length) return 1;
    const ap = a.pre[i];
    const bp = b.pre[i];
    const aNum = /^\d+$/.test(ap);
    const bNum = /^\d+$/.test(bp);
    if (aNum && bNum) {
      const diff = Number(ap) - Number(bp);
      if (diff !== 0) return diff > 0 ? 1 : -1;
    } else if (aNum !== bNum) {
      return aNum ? -1 : 1;
    } else if (ap !== bp) {
      return ap > bp ? 1 : -1;
    }
  }
  return 0;
}

function hasAsset(release, name, owner = 'Sinisterzs', repo = 'NEXUS') {
  if (!Array.isArray(release.assets)) return false;
  const expectedUrl = `https://github.com/${owner}/${repo}/releases/download/${release.tag_name}/${name}`;
  return release.assets.some((a) => a && a.name === name && a.browser_download_url === expectedUrl);
}

function selectLatestOfficialReleases(releases, currentStableVer = null, currentNightlyVer = null) {
  let bestStable = null;
  let bestNightly = null;

  for (const r of releases || []) {
    if (!r || r.draft) continue;
    const parsed = parseSemver(r.tag_name);
    if (!parsed) continue;
    const installerName = `nexus_${parsed.raw}_x64-setup.exe`;

    if (!r.prerelease && parsed.pre.length === 0) {
      if (!hasAsset(r, installerName) || !hasAsset(r, 'latest.json')) continue;
      if (currentStableVer && compareSemver(parsed.raw, currentStableVer) < 0) continue;
      if (!bestStable || compareSemver(parsed.raw, bestStable.version) > 0) {
        bestStable = { version: parsed.raw, artifact: installerName };
      }
    } else if (r.prerelease && parsed.pre.length > 0 && parsed.pre[0] === 'nightly') {
      if (!hasAsset(r, installerName) || !hasAsset(r, 'latest-nightly.json')) continue;
      if (currentNightlyVer && compareSemver(parsed.raw, currentNightlyVer) < 0) continue;
      if (!bestNightly || compareSemver(parsed.raw, bestNightly.version) > 0) {
        bestNightly = { version: parsed.raw, artifact: installerName };
      }
    }
  }

  return { stable: bestStable, nightly: bestNightly };
}

async function fetchGitHubReleases({
  owner = 'Sinisterzs',
  repo = 'NEXUS',
  fetchImpl = globalThis.fetch,
  timeoutMs = 10000,
  maxPages = 5,
} = {}) {
  const all = [];
  for (let page = 1; page <= maxPages; page++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const url = `https://api.github.com/repos/${owner}/${repo}/releases?per_page=30&page=${page}`;
      const resp = await fetchImpl(url, {
        headers: { 'User-Agent': 'NEXUS-Docs-Sync', Accept: 'application/vnd.github+json' },
        signal: controller.signal,
      });
      if (!resp.ok) {
        throw new Error(`GitHub API error: HTTP ${resp.status}`);
      }
      const batch = await resp.json();
      if (!Array.isArray(batch) || batch.length === 0) break;
      all.push(...batch);
      if (batch.length < 30) break;
    } finally {
      clearTimeout(timer);
    }
  }
  return all;
}

async function fetchGitHubReleasesWithRetry({
  owner = 'Sinisterzs',
  repo = 'NEXUS',
  fetchImpl = globalThis.fetch,
  timeoutMs = 10000,
  maxPages = 5,
  targetTag = null,
  retries = 3,
  retryDelayMs = 5000,
} = {}) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const releases = await fetchGitHubReleases({ owner, repo, fetchImpl, timeoutMs, maxPages });
    if (!targetTag) return releases;

    const target = releases.find((r) => r && r.tag_name === targetTag);
    const parsed = target ? parseSemver(target.tag_name) : null;
    if (target && !target.draft && parsed) {
      const installer = `nexus_${parsed.raw}_x64-setup.exe`;
      const manifest = !target.prerelease && parsed.pre.length === 0 ? 'latest.json' : 'latest-nightly.json';
      if (hasAsset(target, installer, owner, repo) && hasAsset(target, manifest, owner, repo)) {
        return releases;
      }
    }
    if (attempt < retries && retryDelayMs > 0) {
      await new Promise((r) => setTimeout(r, retryDelayMs));
    }
  }
  return fetchGitHubReleases({ owner, repo, fetchImpl, timeoutMs, maxPages });
}

function syncReadmeFromReleases({ readmeContent, releases }) {
  const currentStable = readmeContent.match(/<!-- NEXUS:STABLE_ROW:START -->[\s\S]*?<code>v([\d.]+)<\/code>/)?.[1] || null;
  const currentNightly = readmeContent.match(/<!-- NEXUS:BETA_ROW:START -->[\s\S]*?<code>v([^<]+)<\/code>/)?.[1] || null;

  const { stable, nightly } = selectLatestOfficialReleases(releases, currentStable, currentNightly);
  let next = readmeContent;

  if (stable) {
    next = updateReadmeContent({
      content: next,
      channel: 'stable',
      version: stable.version,
      artifact: stable.artifact,
      status: 'Homologada',
    });
  }
  if (nightly) {
    next = updateReadmeContent({
      content: next,
      channel: 'beta',
      version: nightly.version,
      artifact: nightly.artifact,
      status: 'Homologação Ativa',
    });
  }

  return { content: next, selected: { stable, nightly } };
}

module.exports = {
  parseSemver,
  compareSemver,
  selectLatestOfficialReleases,
  fetchGitHubReleases,
  fetchGitHubReleasesWithRetry,
  syncReadmeFromReleases,
};
