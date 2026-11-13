const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { verifyMinisign, verifyDistribution } = require('../scripts/verify-nightly-distribution.cjs');

function fixture(prehashed = true) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const key = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const id = Buffer.from('0102030405060708', 'hex');
  const data = Buffer.from('public synthetic installer fixture');
  const hash = prehashed ? crypto.createHash('blake2b512').update(data).digest() : data;
  const sig = crypto.sign(null, hash, privateKey);
  const trusted = 'timestamp:1\tfile:fixture';
  const global = crypto.sign(null, Buffer.concat([sig, Buffer.from(trusted)]), privateKey);
  const publicText = 'untrusted comment: public fixture\n' + Buffer.concat([Buffer.from('Ed'), id, key]).toString('base64');
  const sigText = 'untrusted comment: fixture signature\n' + Buffer.concat([Buffer.from(prehashed ? 'ED' : 'Ed'), id, sig]).toString('base64') +
    '\ntrusted comment: ' + trusted + '\n' + global.toString('base64');
  return { data, publicText, sigText };
}
test('verifies both Minisign algorithms, including Tauri base64 envelopes', () => {
  for (const prehashed of [true, false]) {
    const f = fixture(prehashed);
    assert.equal(verifyMinisign(f.data, f.sigText, f.publicText), true);
    assert.equal(verifyMinisign(f.data, Buffer.from(f.sigText).toString('base64'), Buffer.from(f.publicText).toString('base64')), true);
  }
});
test('rejects changed installer, different key, changed trusted comment and truncated signature', () => {
  const f = fixture();
  assert.throws(() => verifyMinisign(Buffer.from('tampered'), f.sigText, f.publicText));
  assert.throws(() => verifyMinisign(f.data, f.sigText, fixture().publicText));
  assert.throws(() => verifyMinisign(f.data, f.sigText.replace('timestamp:1', 'timestamp:2'), f.publicText));
  assert.throws(() => verifyMinisign(f.data, f.sigText.slice(0, -10), f.publicText));
});

function stagedFixture() {
  const root = fs.mkdtempSync(path.resolve('node_modules/.nexus-distribution-fixture-'));
  const f = fixture();
  const version = '0.4.0-nightly.4';
  const name = `nexus_${version}_x64-setup.exe`;
  fs.mkdirSync(path.join(root, 'src-tauri'));
  fs.writeFileSync(path.join(root, 'src-tauri/tauri.conf.json'), JSON.stringify({ version, plugins: { updater: { pubkey: f.publicText } } }));
  fs.writeFileSync(path.join(root, 'nexus.exe'), 'inert synthetic desktop fixture');
  fs.writeFileSync(path.join(root, name), f.data);
  const encodedSignature = Buffer.from(f.sigText).toString('base64');
  fs.writeFileSync(path.join(root, `${name}.sig`), encodedSignature);
  const manifest = { version, pub_date: '2026-11-13T00:00:00Z', platforms: { 'windows-x86_64': {
    url: `https://github.com/Sinisterzs/NEXUS/releases/download/v${version}/${name}`, signature: encodedSignature,
  } } };
  const manifestPath = path.join(root, 'latest-nightly.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  return { root, manifest, manifestPath };
}
test('verifies the exact distribution and produces hashes and tamper-check evidence', () => {
  const { root } = stagedFixture();
  try {
    const result = verifyDistribution(root, root);
    assert.equal(result.signatureVerified, true);
    assert.equal(result.tamperedInstallerRejected, true);
    assert.equal(result.files.length, 4);
    assert.match(fs.readFileSync(path.join(root, 'SHA256SUMS.txt'), 'utf8'), /^[a-f0-9]{64}  nexus.exe/m);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'verification.json'))).status, 'local-preparation-not-published');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('rejects divergent manifests and missing distribution files', () => {
  const { root, manifest, manifestPath } = stagedFixture();
  try {
    for (const change of [
      value => { value.version = '0.4.0-nightly.3'; },
      value => { value.platforms['windows-x86_64'].url = 'https://example.invalid/other.exe'; },
      value => { value.platforms['windows-x86_64'].signature = 'different'; },
    ]) {
      const changed = structuredClone(manifest); change(changed);
      fs.writeFileSync(manifestPath, JSON.stringify(changed));
      assert.throws(() => verifyDistribution(root, root));
    }
    const plain = Buffer.from(manifest.platforms['windows-x86_64'].signature, 'base64').toString('utf8');
    const signaturePath = path.join(root, 'nexus_0.4.0-nightly.4_x64-setup.exe.sig');
    fs.writeFileSync(signaturePath, plain);
    const plainManifest = structuredClone(manifest); plainManifest.platforms['windows-x86_64'].signature = plain;
    fs.writeFileSync(manifestPath, JSON.stringify(plainManifest));
    assert.throws(() => verifyDistribution(root, root), /Tauri base64/);
    fs.writeFileSync(signaturePath, manifest.platforms['windows-x86_64'].signature);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    fs.unlinkSync(path.join(root, 'nexus.exe'));
    assert.throws(() => verifyDistribution(root, root));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
