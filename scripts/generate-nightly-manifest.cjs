#!/usr/bin/env node
/**
 * NEXUS - Gerador de Manifesto de Atualização para o Canal Nightly
 * Gera o arquivo latest-nightly.json assinado para o updater do Tauri 2,
 * mantendo total isolamento do canal Stable (latest.json).
 */

const fs = require('fs');
const path = require('path');

const version = process.argv[2] ? process.argv[2].trim() : null;
const notes = process.argv[3] ? process.argv[3].trim() : 'Build Nightly automatizado do NEXUS.';
const owner = process.env.GITHUB_REPOSITORY_OWNER || 'Sinisterzs';
const repo = process.env.GITHUB_REPOSITORY ? process.env.GITHUB_REPOSITORY.split('/')[1] : 'NEXUS';

if (!version) {
  console.error('[ERRO] Uso: node generate-nightly-manifest.cjs <version> [notes]');
  process.exit(1);
}
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-nightly\.(0|[1-9]\d*)$/.test(version)) {
  console.error('[ERRO] Este gerador aceita somente X.Y.Z-nightly.N.');
  process.exit(1);
}

const rootDir = path.resolve(__dirname, '..');
const nsisDir = path.join(rootDir, 'src-tauri', 'target', 'release', 'bundle', 'nsis');

if (!fs.existsSync(nsisDir)) {
  console.error(`[ERRO] Diretório NSIS não encontrado em: ${nsisDir}`);
  process.exit(1);
}

const files = fs.readdirSync(nsisDir);
const installers = files.filter((f) => f.includes(`_${version}_`) && f.endsWith('-setup.exe'));
if (installers.length !== 1) {
  console.error('[ERRO] Esperado exatamente um instalador da versão solicitada em:', nsisDir);
  process.exit(1);
}
const exeFile = installers[0];

const sigFile = files.find((f) => f === `${exeFile}.sig`);
if (!sigFile) {
  console.error(`[ERRO] Assinatura .sig não encontrada para o instalador: ${exeFile}`);
  process.exit(1);
}

const signature = fs.readFileSync(path.join(nsisDir, sigFile), 'utf8').trim();
if (!signature) {
  console.error('[ERRO] Assinatura vazia; manifesto não gerado.');
  process.exit(1);
}
const tag = `v${version}`;
const downloadUrl = `https://github.com/${owner}/${repo}/releases/download/${tag}/${exeFile}`;

const manifest = {
  version: version,
  notes: notes,
  pub_date: new Date().toISOString(),
  platforms: {
    'windows-x86_64': {
      signature: signature,
      url: downloadUrl,
    },
  },
};

const manifestPath = process.argv[4] ? path.resolve(rootDir, process.argv[4]) : path.join(rootDir, 'latest-nightly.json');
if (path.basename(manifestPath) !== 'latest-nightly.json') {
  console.error('[ERRO] O manifesto Nightly deve se chamar latest-nightly.json.'); process.exit(1);
}
fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

console.log(`[OK] Manifesto Nightly gerado em: ${manifestPath}`);
console.log(`[INFO] Versão: ${version}`);
console.log(`[INFO] Arquivo Alvo: ${exeFile}`);
console.log(`[INFO] URL: ${downloadUrl}`);
console.log(`[INFO] Assinatura Minisign: ${signature.slice(0, 30)}...`);
