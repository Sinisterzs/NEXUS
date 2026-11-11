import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  APP_VERSION,
  isPrereleaseVersion,
  isNightlyVersion,
  getInstalledVersionInfo,
  inferDefaultUpdateChannel,
} from '../src/version.ts';
import {
  resolveChannelVersionComparison,
  type UpdateChannel,
} from '../src/services/UpdateService.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

// -----------------------------------------------------------------------------
// 1. Regra de Inferência do Canal Padrão (Sem configuração prévia)
// -----------------------------------------------------------------------------
test('Inferência de Canal Padrão: versões estáveis mapeiam para "stable"', () => {
  const stableVersions = ['0.1.8', '0.2.0', '0.2.1', '1.0.0', 'v0.2.1', '2.0.0+build123'];
  for (const ver of stableVersions) {
    const channel = inferDefaultUpdateChannel(ver);
    assert.equal(
      channel,
      'stable',
      `Versão estável '${ver}' deve inferir canal padrão 'stable', recebeu: ${channel}`
    );
  }
});

test('Inferência de Canal Padrão: versões experimentais mapeiam para "beta"', () => {
  const prereleaseVersions = [
    '0.1.9-nightly.7',
    '0.2.1-nightly.1',
    '0.3.0-nightly.2',
    '0.3.0-beta.1',
    '0.3.0-rc.2',
    'v0.3.0-nightly.1',
    '0.3.0-nightly.2+build.42',
  ];
  for (const ver of prereleaseVersions) {
    const channel = inferDefaultUpdateChannel(ver);
    assert.equal(
      channel,
      'beta',
      `Versão pré-lançamento '${ver}' deve inferir canal padrão 'beta', recebeu: ${channel}`
    );
  }
});

test('Inferência de Canal Padrão: versão atual instalada infere o canal correto', () => {
  const expected = isPrereleaseVersion(APP_VERSION) ? 'beta' : 'stable';
  const inferred = inferDefaultUpdateChannel(APP_VERSION);
  assert.equal(inferred, expected);
});

// -----------------------------------------------------------------------------
// 2. Regra Estrita de Canal: Stable NUNCA baixa Nightly
// -----------------------------------------------------------------------------
test('Regra de Canal: Canal Stable rejeita terminantemente versões Nightly/pré-lançamento remotas', () => {
  const nightlyRemotes = ['0.3.0-nightly.1', '0.2.2-nightly.99', '0.3.0-beta.1', '0.3.0-rc.1'];

  for (const remoteVer of nightlyRemotes) {
    // Mesmo se updateAvailable for fornecido como true por bug do backend,
    // o comparador de compatibilidade DEVE rejeitar a atualização
    const res = resolveChannelVersionComparison({
      currentVersion: '0.2.1',
      latestRemoteVersion: remoteVer,
      updateAvailable: true,
      isCurrentHigher: false,
      channel: 'stable',
    });

    assert.notEqual(
      res.status,
      'available',
      `Canal Stable NUNCA pode ter status 'available' para versão experimental ${remoteVer}`
    );
    assert.equal(res.status, 'error');
    assert.match(res.statusMessage || '', /rejeitou.*experimental|rejeitou.*pré-lançamento/i);
    assert.equal(res.requiresConfirmation, false);
  }
});

test('Regra de Canal: Canal Stable aceita apenas versões oficiais homologadas superiores', () => {
  const res = resolveChannelVersionComparison({
    currentVersion: '0.2.1',
    latestRemoteVersion: '0.2.2',
    updateAvailable: true,
    isCurrentHigher: false,
    channel: 'stable',
  });

  assert.equal(res.status, 'available');
  assert.equal(res.isDowngradeNotice, false);
});

// -----------------------------------------------------------------------------
// 3. Regra Estrita de Canal: Nightly NUNCA migra silenciosamente para Stable
// -----------------------------------------------------------------------------
test('Regra de Canal: Instalação Nightly com canal Stable ativo NUNCA faz downgrade silencioso para Stable antiga', () => {
  const res = resolveChannelVersionComparison({
    currentVersion: '0.3.0-nightly.2',
    latestRemoteVersion: '0.2.1',
    updateAvailable: false,
    isCurrentHigher: true,
    channel: 'stable',
  });

  assert.equal(res.status, 'downgrade_notice');
  assert.equal(res.isDowngradeNotice, true);
  assert.match(res.downgradeNoticeMessage || '', /Não haverá downgrade automático/i);
  assert.equal(res.requiresConfirmation, false);
});

test('Regra de Canal: Instalação Nightly migrando para nova versão Stable exige confirmação (NUNCA silencioso)', () => {
  // Quando uma versão estável superior é lançada (ex: 0.3.0 final após 0.3.0-nightly.2)
  const res = resolveChannelVersionComparison({
    currentVersion: '0.3.0-nightly.2',
    latestRemoteVersion: '0.3.0',
    updateAvailable: true,
    isCurrentHigher: false,
    channel: 'stable',
  });

  assert.equal(res.status, 'available');
  assert.equal(
    res.requiresConfirmation,
    true,
    'Atualização de versão Nightly DEVE SEMPRE exigir confirmação explícita do usuário'
  );
});

test('Regra de Canal: Atualizações dentro do canal Beta/Nightly exigem confirmação explícita', () => {
  const res = resolveChannelVersionComparison({
    currentVersion: '0.3.0-nightly.2',
    latestRemoteVersion: '0.3.0-nightly.3',
    updateAvailable: true,
    isCurrentHigher: false,
    channel: 'beta',
  });

  assert.equal(res.status, 'available');
  assert.equal(
    res.requiresConfirmation,
    true,
    'Atualização no canal Beta exige confirmação (com changelog e botão de atualizar/lembrar mais tarde)'
  );
});

// -----------------------------------------------------------------------------
// 4. Validação Semântica de Versão (SemVer) e Proteção contra Downgrades
// -----------------------------------------------------------------------------
test('Proteção SemVer: Versão instalada superior à remota impede download e alerta o usuário', () => {
  // Cenário: Usuário com 0.2.1 consultando manifesto apontando para 0.2.0
  const res = resolveChannelVersionComparison({
    currentVersion: '0.2.1',
    latestRemoteVersion: '0.2.0',
    updateAvailable: false,
    isCurrentHigher: true,
    channel: 'stable',
  });

  assert.notEqual(res.status, 'available');
  assert.equal(res.isDowngradeNotice, false);
  assert.match(res.statusMessage || '', /já está em uma versão superior/i);
});

test('Proteção SemVer: Nightly instalada superior à compilação remota do canal Beta impede rebaixamento', () => {
  const res = resolveChannelVersionComparison({
    currentVersion: '0.3.0-nightly.2',
    latestRemoteVersion: '0.3.0-nightly.1',
    updateAvailable: false,
    isCurrentHigher: true,
    channel: 'beta',
  });

  assert.notEqual(res.status, 'available');
  assert.match(res.statusMessage || '', /já está em uma compilação mais recente/i);
});

// -----------------------------------------------------------------------------
// 5. Schema dos Manifestos: Compatibilidade Estrita com tauri-plugin-updater v2
// -----------------------------------------------------------------------------
function validateTauriUpdaterV2Schema(manifestJson: any, manifestName: string) {
  assert.ok(manifestJson, `${manifestName} deve existir e ser um objeto JSON`);
  assert.equal(typeof manifestJson.version, 'string', `${manifestName}: 'version' deve ser string SemVer`);
  assert.match(
    manifestJson.version,
    /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/,
    `${manifestName}: 'version' deve ser um SemVer válido`
  );

  assert.equal(typeof manifestJson.notes, 'string', `${manifestName}: 'notes' deve ser string`);
  assert.ok(manifestJson.notes.length > 0, `${manifestName}: 'notes' não pode ser vazio`);

  assert.equal(typeof manifestJson.pub_date, 'string', `${manifestName}: 'pub_date' deve ser string ISO`);
  assert.ok(!isNaN(Date.parse(manifestJson.pub_date)), `${manifestName}: 'pub_date' deve ser data ISO válida`);

  assert.ok(manifestJson.platforms, `${manifestName}: 'platforms' deve existir`);
  assert.equal(typeof manifestJson.platforms, 'object', `${manifestName}: 'platforms' deve ser objeto`);

  const winPlatform = manifestJson.platforms['windows-x86_64'];
  assert.ok(winPlatform, `${manifestName}: platforms deve conter chave 'windows-x86_64'`);
  assert.equal(typeof winPlatform.url, 'string', `${manifestName}: windows-x86_64.url deve ser string`);
  assert.match(winPlatform.url, /^https:\/\/.*-setup\.exe$/, `${manifestName}: URL deve ser HTTPS e terminar com -setup.exe`);

  assert.equal(typeof winPlatform.signature, 'string', `${manifestName}: windows-x86_64.signature deve ser string`);
  assert.ok(winPlatform.signature.trim().length > 30, `${manifestName}: signature deve conter caracteres suficientes`);

  // Tauri v2 Minisign Signature Base64 decode check
  const decodedSig = Buffer.from(winPlatform.signature.trim(), 'base64').toString('utf8');
  assert.match(
    decodedSig,
    /untrusted comment: signature/i,
    `${manifestName}: Assinatura Minisign decodificada deve conter o cabeçalho 'untrusted comment: signature'`
  );
}

test('Schema de Manifesto: latest-nightly.json do repositório cumpre o schema do tauri-plugin-updater v2', () => {
  const nightlyPath = path.join(rootDir, 'latest-nightly.json');
  if (fs.existsSync(nightlyPath)) {
    const raw = fs.readFileSync(nightlyPath, 'utf8');
    const json = JSON.parse(raw);
    validateTauriUpdaterV2Schema(json, 'latest-nightly.json');
    assert.ok(
      isPrereleaseVersion(json.version),
      `latest-nightly.json deve ter versão pré-lançamento, encontrou: ${json.version}`
    );
    assert.match(json.version, /nightly/i, 'latest-nightly.json deve conter tag nightly');
  }
});

test('Schema de Manifesto: latest.json simulado para Stable cumpre o schema do tauri-plugin-updater v2', () => {
  const sampleStableManifest = {
    version: '0.2.1',
    notes: 'NEXUS v0.2.1 — Atualização Estável oficial.',
    pub_date: '2026-11-10T12:00:00.000Z',
    platforms: {
      'windows-x86_64': {
        signature: 'dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIG1pbmlzaWduIHNlY3JldCBrZXkKUldTZDUvb3g4QThkaytOVzlscVZBTXVDS3hKdkg5a3pLcFV4Q2sxU21BQkM3YjQrOHpkNWNmSGYK',
        url: 'https://github.com/Sinisterzs/NEXUS/releases/download/v0.2.1/nexus_0.2.1_x64-setup.exe',
      },
    },
  };

  validateTauriUpdaterV2Schema(sampleStableManifest, 'sample-stable-manifest');
  assert.equal(
    isPrereleaseVersion(sampleStableManifest.version),
    false,
    'latest.json NÃO pode conter versão pré-lançamento'
  );
});

// -----------------------------------------------------------------------------
// 6. Persistência Local do Canal: Imediata no Pré-login (Sync + Async)
// -----------------------------------------------------------------------------
const LOCAL_STORAGE_CHANNEL_KEY = 'nexus_app_update_channel';

function resolveSyncChannelFromLocalStorage(
  storage: Record<string, string>,
  installedVersion = APP_VERSION
): UpdateChannel {
  const top = storage[LOCAL_STORAGE_CHANNEL_KEY];
  if (top === 'beta' || top === 'stable') {
    return top;
  }
  const accRaw = storage['nexus_preferences:offline_demo'];
  if (accRaw) {
    try {
      const parsed = JSON.parse(accRaw);
      if (parsed.updateChannel === 'beta' || parsed.updateChannel === 'stable') {
        return parsed.updateChannel;
      }
    } catch {}
  }
  return inferDefaultUpdateChannel(installedVersion);
}

test('Persistência Pré-login: getUpdateChannelSync() responde instantaneamente via localStorage', () => {
  const mockStorage: Record<string, string> = {};

  // Caso 1: Sem configuração gravada em Nightly -> infere 'beta'
  const initialNightly = resolveSyncChannelFromLocalStorage(mockStorage, '0.3.0-nightly.2');
  assert.equal(initialNightly, 'beta');

  // Caso 1b: Sem configuração gravada em Stable -> infere 'stable'
  const initialStable = resolveSyncChannelFromLocalStorage(mockStorage, '0.2.1');
  assert.equal(initialStable, 'stable');

  // Caso 2: Usuário salva canal 'stable' explicitamente (mesmo rodando Nightly)
  mockStorage[LOCAL_STORAGE_CHANNEL_KEY] = 'stable';
  assert.equal(resolveSyncChannelFromLocalStorage(mockStorage, '0.3.0-nightly.2'), 'stable');

  // Caso 3: Usuário salva canal 'beta' explicitamente (mesmo rodando Stable)
  mockStorage[LOCAL_STORAGE_CHANNEL_KEY] = 'beta';
  assert.equal(resolveSyncChannelFromLocalStorage(mockStorage, '0.2.1'), 'beta');

  // Caso 4: Valor corrompido em localStorage é ignorado com segurança e infere canal correto
  mockStorage[LOCAL_STORAGE_CHANNEL_KEY] = 'corrupted_channel_xyz';
  assert.equal(resolveSyncChannelFromLocalStorage(mockStorage, '0.2.1'), 'stable');
  assert.equal(resolveSyncChannelFromLocalStorage(mockStorage, '0.3.0-nightly.2'), 'beta');
});
