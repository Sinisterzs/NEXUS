#!/usr/bin/env node
/**
 * NEXUS - Gerador de Manifesto de Atualização para o Canal Stable (latest.json)
 * Gera o arquivo latest.json assinado para o updater oficial do Tauri 2.
 */

const fs = require('fs');
const path = require('path');

const version = process.argv[2] ? process.argv[2].trim() : '0.1.8';
const notes = process.argv[3] ? process.argv[3].trim() : 'NEXUS v0.1.8 — Atualização Estável com Seletor de Canais e Autenticação Obrigatória.';
const owner = process.env.GITHUB_REPOSITORY_OWNER || 'Sinisterzs';
const repo = process.env.GITHUB_REPOSITORY ? process.env.GITHUB_REPOSITORY.split('/')[1] : 'NEXUS';

const rootDir = path.resolve(__dirname, '..');
const nsisDir = path.join(rootDir, 'src-tauri', 'target', 'release', 'bundle', 'nsis');

if (!fs.existsSync(nsisDir)) {
  console.error(`[ERRO] Diretório NSIS não encontrado em: ${nsisDir}`);
  process.exit(1);
}

const files = fs.readdirSync(nsisDir);
const exeFile = files.find((f) => f.includes(version) && f.endsWith('-setup.exe'));
if (!exeFile) {
  console.error(`[ERRO] Nenhum instalador contendo a versão ${version} (*-setup.exe) encontrado em:`, nsisDir);
  process.exit(1);
}

const sigFile = files.find((f) => f === `${exeFile}.sig` || (f.includes(version) && f.endsWith('.sig') && f.includes('-setup.exe')));
if (!sigFile) {
  console.error(`[ERRO] Assinatura .sig não encontrada para o instalador: ${exeFile}`);
  process.exit(1);
}

const signature = fs.readFileSync(path.join(nsisDir, sigFile), 'utf8').trim();
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

const manifestPath = path.join(rootDir, 'latest.json');
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

console.log(`[OK] Manifesto Stable gerado em: ${manifestPath}`);
console.log(`[INFO] Versão: ${version}`);
console.log(`[INFO] Arquivo Alvo: ${exeFile}`);
console.log(`[INFO] URL: ${downloadUrl}`);
console.log(`[INFO] Assinatura Minisign: ${signature.slice(0, 30)}...`);
