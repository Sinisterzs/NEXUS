/**
 * NEXUS - Gerador Oficial de Chaves Minisign para Homologação em CI
 * Utiliza o gerador oficial do Tauri CLI (`npx tauri signer generate --ci`)
 * para garantir 100% de conformidade com o formato Minisign esperado pelo tauri-plugin-updater v2.
 * Nenhuma chave de produção é utilizada; o par é gerado de forma isolada na sandbox.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

console.log('[Homologação] Gerando par de chaves Minisign oficial via Tauri CLI...');

const rootDir = path.resolve(__dirname, '..');
const labKeysDir = path.join(rootDir, '.lab_keys');
fs.mkdirSync(labKeysDir, { recursive: true });

const privKeyPath = path.join(labKeysDir, 'homologation_minisign.key');
const pubKeyPath = path.join(labKeysDir, 'homologation_minisign.key.pub');

// Executa o signer oficial do Tauri em modo CI e sem senha
try {
  execSync(`npx tauri signer generate -w "${privKeyPath}" -p "" --force --ci`, {
    cwd: rootDir,
    stdio: 'pipe',
  });
} catch (err) {
  console.error('[ERRO] Falha ao invocar npx tauri signer generate:', err.message);
  process.exit(1);
}

if (!fs.existsSync(privKeyPath) || !fs.existsSync(pubKeyPath)) {
  console.error('[ERRO] Arquivos de chave do Tauri signer não foram gerados!');
  process.exit(1);
}

const rawPrivContent = fs.readFileSync(privKeyPath, 'utf8').trim();
const rawPubContent = fs.readFileSync(pubKeyPath, 'utf8').trim();

// A chave pública Minisign gerada pelo Tauri contém comentários; o Tauri precisa da string pura Base64
// Exemplo de formato:
// untrusted comment: minisign public key 8FE40...
// RWS...
const pubLines = rawPubContent.split(/\r?\n/).filter(line => line.trim().length > 0);
const cleanPubKey = pubLines[pubLines.length - 1].trim();

console.log('[Homologação] Chave pública Minisign extraída com sucesso.');

// Injeta a chave pública de teste temporária no tauri.conf.json do runner para a compilação
const tauriConfPath = path.join(rootDir, 'src-tauri', 'tauri.conf.json');
const tauriConf = JSON.parse(fs.readFileSync(tauriConfPath, 'utf8'));

if (tauriConf.plugins && tauriConf.plugins.updater) {
  console.log('[Homologação] Injetando chave pública efêmera no tauri.conf.json do runner...');
  tauriConf.plugins.updater.pubkey = cleanPubKey;
  fs.writeFileSync(tauriConfPath, JSON.stringify(tauriConf, null, 2), 'utf8');
}

// Salva a chave pública limpa para verificação criptográfica posterior
fs.writeFileSync(path.join(labKeysDir, 'minisign_pubkey.txt'), cleanPubKey, 'utf8');

// Exporta variáveis com MASKING estrito no GitHub Actions para prevenir vazamento em logs
if (process.env.GITHUB_OUTPUT) {
  // Mascara cada linha da chave privada para proteção contra logs em stdout
  rawPrivContent.split(/\r?\n/).forEach(line => {
    if (line.trim().length > 6) {
      console.log(`::add-mask::${line.trim()}`);
    }
  });

  fs.appendFileSync(process.env.GITHUB_OUTPUT, `test_private_key_path=${privKeyPath}\n`);
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `test_private_key<<EOF\n${rawPrivContent}\nEOF\n`);
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `test_public_key=${cleanPubKey}\n`);
}

console.log('[Homologação] Par de chaves oficial do Tauri gerado e mascarado com sucesso.');
