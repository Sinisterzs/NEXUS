#!/usr/bin/env node
/**
 * NEXUS - Atualizador de Versão para o Canal Nightly
 * Atualiza sincronizadamente:
 * 1. package.json
 * 2. src-tauri/tauri.conf.json
 * 3. src-tauri/Cargo.toml
 * 4. src/version.ts
 */

const fs = require('fs');
const path = require('path');

const version = process.argv[2] ? process.argv[2].trim() : null;

if (!version) {
  console.error('[ERRO] Informe a versão SemVer Nightly (ex: 0.1.9-nightly.1)');
  process.exit(1);
}

// Validação SemVer (ex: 0.1.7 ou 0.1.9-nightly.1)
const semverRegex = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/;
if (!semverRegex.test(version)) {
  console.error(`[ERRO] Versão '${version}' não é um SemVer válido.`);
  process.exit(1);
}

const rootDir = path.resolve(__dirname, '..');

// 1. package.json
const pkgPath = path.join(rootDir, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const oldVersion = pkg.version;
pkg.version = version;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
console.log(`[OK] package.json: ${oldVersion} -> ${version}`);

// 2. src-tauri/tauri.conf.json
const tauriConfPath = path.join(rootDir, 'src-tauri', 'tauri.conf.json');
const tauriConf = JSON.parse(fs.readFileSync(tauriConfPath, 'utf8'));
tauriConf.version = version;
fs.writeFileSync(tauriConfPath, JSON.stringify(tauriConf, null, 2) + '\n', 'utf8');
console.log(`[OK] tauri.conf.json: ${oldVersion} -> ${version}`);

// 3. src-tauri/Cargo.toml
const cargoPath = path.join(rootDir, 'src-tauri', 'Cargo.toml');
let cargoContent = fs.readFileSync(cargoPath, 'utf8');
cargoContent = cargoContent.replace(/^version = "[^"]+"/m, `version = "${version}"`);
fs.writeFileSync(cargoPath, cargoContent, 'utf8');
console.log(`[OK] src-tauri/Cargo.toml: version = "${version}"`);

// 4. src/version.ts
const versionTsPath = path.join(rootDir, 'src', 'version.ts');
fs.writeFileSync(versionTsPath, `export const APP_VERSION = '${version}';\n`, 'utf8');
console.log(`[OK] src/version.ts: APP_VERSION = '${version}'`);

console.log(`\n[SUCESSO] Todos os arquivos atualizados para ${version}`);
