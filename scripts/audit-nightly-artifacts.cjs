#!/usr/bin/env node
/**
 * NEXUS - Auditoria Estrita de Segurança dos Artefatos de Release
 * Garante que nenhuma chave privada, credencial ou arquivo .env seja incluído
 * nos pacotes ou nos uploads do GitHub Releases.
 */

const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(rootDir, 'src-tauri', 'tauri.conf.json'), 'utf8'));
const installerName = `nexus_${config.version}_x64-setup.exe`;
const requiredFiles = [
  path.join(rootDir, 'src-tauri', 'target', 'release', 'nexus.exe'),
  path.join(rootDir, 'src-tauri', 'target', 'release', 'bundle', 'nsis', installerName),
  path.join(rootDir, 'src-tauri', 'target', 'release', 'bundle', 'nsis', `${installerName}.sig`),
  path.join(rootDir, 'latest-nightly.json'),
];
if (requiredFiles.some(file => !fs.existsSync(file) || fs.statSync(file).size === 0)) {
  console.error('[ERRO] Artefatos completos da versão atual são obrigatórios para a auditoria.');
  process.exit(1);
}
const forbiddenPatterns = [
  /^\.env/i,
  /\.key$/i,
  /\.pk8$/i,
  /\.pem$/i,
  /id_rsa/i,
  /secret/i,
  /password/i,
  /supervisor\.lock/i,
];

console.log('==================================================');
console.log('   NEXUS - Auditoria de Segurança dos Artefatos   ');
console.log('==================================================');

const searchDirs = [
  path.join(rootDir, 'src-tauri', 'target', 'release', 'bundle'),
  path.join(rootDir, 'src-tauri', 'target', 'release'),
];

let violations = [];
let auditedCount = 0;

function scanDir(dir, depth = 0) {
  if (depth > 4 || !fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (entry.name !== 'build' && entry.name !== 'deps' && entry.name !== 'incremental') {
        scanDir(fullPath, depth + 1);
      }
    } else if (entry.isFile()) {
      auditedCount++;
      const fileName = entry.name;

      // Ignora arquivos de assinatura legítimos .sig
      if (fileName.endsWith('.sig')) continue;

      for (const pattern of forbiddenPatterns) {
        if (pattern.test(fileName)) {
          violations.push(fullPath);
          break;
        }
      }
    }
  }
}

for (const dir of searchDirs) {
  scanDir(dir);
}

// Verifica também arquivos na raiz que possam ser vinculados
const rootFiles = ['latest-nightly.json', 'latest.json'];
for (const file of rootFiles) {
  const fullPath = path.join(rootDir, file);
  if (fs.existsSync(fullPath)) {
    auditedCount++;
    const content = fs.readFileSync(fullPath, 'utf8');
    // Verifica se há chaves privadas vazadas no JSON
    if (content.includes('BEGIN PRIVATE KEY') || content.includes('minisign secret key')) {
      violations.push(`${fullPath} (Contém chave privada!)`);
    }
  }
}

console.log(`[INFO] Total de arquivos inspecionados: ${auditedCount}`);

if (violations.length > 0) {
  console.error('\n[VIOLAÇÃO CRÍTICA DE SEGURANÇA] Arquivos proibidos detectados:');
  for (const v of violations) {
    console.error(`  - ${v}`);
  }
  process.exit(1);
}

console.log('[OK] Verificações de nomes e marcadores concluídas. Não substituem inspeção do conteúdo dos pacotes ou verificação criptográfica.');
