/**
 * NEXUS - Atualizador de Versão para Homologação em CI
 * Ajusta temporariamente os metadados em sincronia para a versão isolada de laboratório:
 * 1. package.json e package-lock.json
 * 2. src-tauri/tauri.conf.json
 * 3. src-tauri/Cargo.toml e src-tauri/Cargo.lock
 * 4. src/version.ts
 */

const fs = require('fs');
const path = require('path');

const version = process.argv[2] ? process.argv[2].trim() : '0.3.0-homolog.1';

// Validação SemVer estrita
const semverRegex = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-[a-zA-Z0-9.-]+$/;
if (!semverRegex.test(version)) {
  console.error(`[ERRO] Versão '${version}' deve seguir formato SemVer pré-lançamento (ex: 0.3.0-homolog.1)`);
  process.exit(1);
}

const rootDir = path.resolve(__dirname, '..');

// 1. package.json
const pkgPath = path.join(rootDir, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const oldVersion = pkg.version;
pkg.version = version;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
console.log(`[Homologação] package.json: ${oldVersion} -> ${version}`);

// 1b. package-lock.json
const pkgLockPath = path.join(rootDir, 'package-lock.json');
if (fs.existsSync(pkgLockPath)) {
  const pkgLock = JSON.parse(fs.readFileSync(pkgLockPath, 'utf8'));
  pkgLock.version = version;
  if (pkgLock.packages && pkgLock.packages['']) {
    pkgLock.packages[''].version = version;
  }
  fs.writeFileSync(pkgLockPath, JSON.stringify(pkgLock, null, 2) + '\n', 'utf8');
}

// 2. src-tauri/tauri.conf.json
const tauriConfPath = path.join(rootDir, 'src-tauri', 'tauri.conf.json');
const tauriConf = JSON.parse(fs.readFileSync(tauriConfPath, 'utf8'));
tauriConf.version = version;
fs.writeFileSync(tauriConfPath, JSON.stringify(tauriConf, null, 2) + '\n', 'utf8');
console.log(`[Homologação] tauri.conf.json: ${oldVersion} -> ${version}`);

// 3. src-tauri/Cargo.toml
const cargoPath = path.join(rootDir, 'src-tauri', 'Cargo.toml');
let cargoContent = fs.readFileSync(cargoPath, 'utf8');
cargoContent = cargoContent.replace(/^version = "[^"]+"/m, `version = "${version}"`);
fs.writeFileSync(cargoPath, cargoContent, 'utf8');
console.log(`[Homologação] src-tauri/Cargo.toml: version = "${version}"`);

// 3b. src-tauri/Cargo.lock
const cargoLockPath = path.join(rootDir, 'src-tauri', 'Cargo.lock');
if (fs.existsSync(cargoLockPath)) {
  const lock = fs.readFileSync(cargoLockPath, 'utf8');
  const updated = lock.replace(/(\[\[package\]\]\r?\nname = "nexus"\r?\nversion = ")[^"]+("\r?\n)/,
    (_, prefix, suffix) => `${prefix}${version}${suffix}`);
  fs.writeFileSync(cargoLockPath, updated, 'utf8');
}

// 4. src/version.ts
const versionTsPath = path.join(rootDir, 'src', 'version.ts');
let versionTsContent = fs.readFileSync(versionTsPath, 'utf8');
if (/export const APP_VERSION = ['"][^'"]+['"];/.test(versionTsContent)) {
  versionTsContent = versionTsContent.replace(
    /export const APP_VERSION = ['"][^'"]+['"];/,
    `export const APP_VERSION = '${version}';`
  );
}
fs.writeFileSync(versionTsPath, versionTsContent, 'utf8');
console.log(`[Homologação] src/version.ts: APP_VERSION = '${version}'`);
