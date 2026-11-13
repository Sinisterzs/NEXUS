#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function envelope(value) {
  const text = value.trim();
  return text.startsWith('untrusted comment:') ? text : Buffer.from(text, 'base64').toString('utf8').trim();
}
function decode(value, size) {
  if (!value || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error('Invalid Minisign encoding');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length !== size) throw new Error('Invalid Minisign length');
  return bytes;
}
function verifyMinisign(data, signature, publicKey) {
  const keyLines = envelope(publicKey).split(/\r?\n/);
  const sigLines = envelope(signature).split(/\r?\n/);
  if (keyLines.length !== 2 || sigLines.length !== 4 || !sigLines[2].startsWith('trusted comment: ')) {
    throw new Error('Invalid Minisign envelope');
  }
  const key = decode(keyLines[1], 42), sig = decode(sigLines[1], 74), global = decode(sigLines[3], 64);
  if (key.subarray(0, 2).toString() !== 'Ed' || !sig.subarray(2, 10).equals(key.subarray(2, 10))) {
    throw new Error('Minisign key mismatch');
  }
  const algorithm = sig.subarray(0, 2).toString();
  if (!['ED', 'Ed'].includes(algorithm)) throw new Error('Unsupported Minisign algorithm');
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), key.subarray(10)]);
  const publicObject = crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
  const message = algorithm === 'ED' ? crypto.createHash('blake2b512').update(data).digest() : data;
  if (!crypto.verify(null, message, publicObject, sig.subarray(10))) throw new Error('Artifact signature rejected');
  const trusted = Buffer.from(sigLines[2].slice(17), 'utf8');
  if (!crypto.verify(null, Buffer.concat([sig.subarray(10), trusted]), publicObject, global)) {
    throw new Error('Minisign trusted comment rejected');
  }
  return true;
}

function verifyDistribution(directory, root = path.resolve(__dirname, '..')) {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+-nightly\.\d+$/.test(config.version)) throw new Error('Nightly version required');
  const name = `nexus_${config.version}_x64-setup.exe`;
  const files = ['nexus.exe', name, `${name}.sig`, 'latest-nightly.json'];
  for (const file of files) if (!fs.statSync(path.join(directory, file)).size) throw new Error('Empty release artifact');
  const installer = fs.readFileSync(path.join(directory, name));
  const signature = fs.readFileSync(path.join(directory, `${name}.sig`), 'utf8').trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(signature) || !envelope(signature).startsWith('untrusted comment:')) {
    throw new Error('Updater signature must use the Tauri base64 envelope');
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'latest-nightly.json'), 'utf8'));
  const platform = manifest.platforms?.['windows-x86_64'];
  const expected = `https://github.com/Sinisterzs/NEXUS/releases/download/v${config.version}/${name}`;
  if (manifest.version !== config.version || platform?.url !== expected || platform.signature !== signature) {
    throw new Error('Updater manifest does not match the exact Nightly installer');
  }
  if (!Number.isFinite(Date.parse(manifest.pub_date))) throw new Error('Invalid updater date');
  verifyMinisign(installer, signature, config.plugins.updater.pubkey);
  const tampered = Buffer.from(installer); tampered[tampered.length - 1] ^= 1;
  let rejected = false;
  try { verifyMinisign(tampered, signature, config.plugins.updater.pubkey); } catch { rejected = true; }
  if (!rejected) throw new Error('Tampered installer was accepted');
  const hashes = files.map(file => ({ file, bytes: fs.statSync(path.join(directory, file)).size,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(directory, file))).digest('hex') }));
  fs.writeFileSync(path.join(directory, 'SHA256SUMS.txt'), hashes.map(x => `${x.sha256}  ${x.file}`).join('\n') + '\n');
  const result = { version: config.version, status: 'local-preparation-not-published',
    signatureVerified: true, trustedCommentVerified: true, tamperedInstallerRejected: true, files: hashes };
  fs.writeFileSync(path.join(directory, 'verification.json'), JSON.stringify(result, null, 2) + '\n');
  return result;
}
module.exports = { verifyMinisign, verifyDistribution };
if (require.main === module) {
  try { console.log(JSON.stringify(verifyDistribution(path.resolve(process.argv[2] || '.')), null, 2)); }
  catch (error) { console.error(`[ERROR] ${error.message}`); process.exitCode = 1; }
}
