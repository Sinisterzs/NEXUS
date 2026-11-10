import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { updateReadmeContent, MARKERS } from '../scripts/sync-readme-release.cjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const SAMPLE_README = `# NEXUS

<!-- NEXUS:STABLE_HEADER_BADGE:START -->
[![Versão](https://img.shields.io/badge/Versão-v0.2.0%20Stable-e02424?style=flat-square&logo=github)](https://github.com/Sinisterzs/NEXUS/releases/tag/v0.2.0)
[![Windows](https://img.shields.io/badge/Plataforma-Windows%2010%20%2F%2011%20x64-0f1117?style=flat-square&logo=windows11&logoColor=0078D4)](https://github.com/Sinisterzs/NEXUS/releases/download/v0.2.0/nexus_0.2.0_x64-setup.exe)
<!-- NEXUS:STABLE_HEADER_BADGE:END -->

<!-- NEXUS:STABLE_HEADER_LINKS:START -->
[**Baixar v0.2.0 Stable**](https://github.com/Sinisterzs/NEXUS/releases/download/v0.2.0/nexus_0.2.0_x64-setup.exe) • [**Notas de Lançamento**](scripts/release-notes-v0.2.0.md) • [**Releases no GitHub**](https://github.com/Sinisterzs/NEXUS/releases) • [**Histórico de Mudanças**](CHANGELOG.md)
<!-- NEXUS:STABLE_HEADER_LINKS:END -->

## 3. Downloads Oficiais e Canais de Atualização

| Canal | Versão | Status | Instalador Windows (64-bit) | Manifesto do Updater |
| :--- | :---: | :---: | :--- | :--- |
<!-- NEXUS:STABLE_ROW:START -->
| **Estável (Recomendado)** | **\`v0.2.0\`** | Homologada | [**nexus_0.2.0_x64-setup.exe**](https://github.com/Sinisterzs/NEXUS/releases/download/v0.2.0/nexus_0.2.0_x64-setup.exe) | [\`latest.json\`](https://github.com/Sinisterzs/NEXUS/releases/latest/download/latest.json) |
<!-- NEXUS:STABLE_ROW:END -->
<!-- NEXUS:BETA_ROW:START -->
| **Pré-lançamento (Beta)** | \`v0.1.9-nightly.7\` | Candidata Anterior | [nexus_0.1.9-nightly.7_x64-setup.exe](https://github.com/Sinisterzs/NEXUS/releases/download/v0.1.9-nightly.7/nexus_0.1.9-nightly.7_x64-setup.exe) | [\`latest-nightly.json\`](https://github.com/Sinisterzs/NEXUS/releases/download/v0.1.9-nightly.7/latest-nightly.json) |
<!-- NEXUS:BETA_ROW:END -->

## 6. Arquitetura

\`\`\`mermaid
flowchart TD
    UI["Interface UI 2.0"]
    Media <-->|"Áudio e Tela P2P (DTLS-SRTP)"| Peer
\`\`\`
`;

test('Automação README: canal Beta atualiza exclusivamente a linha Beta sem tocar em Stable', () => {
  const result = updateReadmeContent({
    content: SAMPLE_README,
    channel: 'beta',
    version: '0.2.1-nightly.1',
    artifact: 'nexus_0.2.1-nightly.1_x64-setup.exe',
    status: 'Homologação Ativa',
  });

  // Linha Beta deve ter sido atualizada
  assert.match(result, /v0\.2\.1-nightly\.1/);
  assert.match(result, /nexus_0\.2\.1-nightly\.1_x64-setup\.exe/);
  assert.match(result, /Homologação Ativa/);

  // Todas as referências da Stable v0.2.0 devem permanecer 100% intactas
  assert.match(result, /v0\.2\.0%20Stable/);
  assert.match(result, /Baixar v0\.2\.0 Stable/);
  assert.match(result, /\|\s+\*\*Estável \(Recomendado\)\*\*\s+\|\s+\*\*\`v0\.2\.0\`\*\*/);

  // Mermaid deve permanecer intacto
  assert.match(result, /\|"Áudio e Tela P2P \(DTLS-SRTP\)"\|/);
});

test('Automação README: canal Stable atualiza Header Badges, Links e Linha Stable sem tocar em Beta', () => {
  const result = updateReadmeContent({
    content: SAMPLE_README,
    channel: 'stable',
    version: '0.3.0',
    artifact: 'nexus_0.3.0_x64-setup.exe',
  });

  // Header Badge e Links devem apontar para v0.3.0
  assert.match(result, /v0\.3\.0%20Stable/);
  assert.match(result, /Baixar v0\.3\.0 Stable/);
  assert.match(result, /nexus_0\.3\.0_x64-setup\.exe/);
  assert.match(result, /scripts\/release-notes-v0\.3\.0\.md/);

  // Linha Stable deve apontar para v0.3.0
  assert.match(result, /\|\s+\*\*Estável \(Recomendado\)\*\*\s+\|\s+\*\*\`v0\.3\.0\`\*\*/);

  // Linha Beta pré-existente deve permanecer 100% inalterada
  assert.match(result, /v0\.1\.9-nightly\.7/);
  assert.match(result, /Candidata Anterior/);
});

test('Automação README: idempotência garante que reexecução não produz diff', () => {
  const step1 = updateReadmeContent({
    content: SAMPLE_README,
    channel: 'beta',
    version: '0.2.1-nightly.1',
  });

  const step2 = updateReadmeContent({
    content: step1,
    channel: 'beta',
    version: '0.2.1-nightly.1',
  });

  assert.equal(step1, step2, 'Reexecução com os mesmos parâmetros deve ser estritamente idempotente');
});

test('Automação README: ausência de marcadores lança erro seguro e não corrompe documento', () => {
  const corruptedReadme = '# README sem marcadores';

  assert.throws(
    () => {
      updateReadmeContent({
        content: corruptedReadme,
        channel: 'beta',
        version: '0.2.1-nightly.1',
      });
    },
    /Marcadores não localizados/
  );
});

test('Automação README: validação contra o README.md real do repositório', () => {
  const readmePath = path.join(rootDir, 'README.md');
  const actualReadme = fs.readFileSync(readmePath, 'utf8');

  // Verifica presença de todos os marcadores
  assert.ok(actualReadme.includes(MARKERS.STABLE_HEADER_BADGE.start));
  assert.ok(actualReadme.includes(MARKERS.STABLE_HEADER_BADGE.end));
  assert.ok(actualReadme.includes(MARKERS.STABLE_HEADER_LINKS.start));
  assert.ok(actualReadme.includes(MARKERS.STABLE_HEADER_LINKS.end));
  assert.ok(actualReadme.includes(MARKERS.STABLE_ROW.start));
  assert.ok(actualReadme.includes(MARKERS.STABLE_ROW.end));
  assert.ok(actualReadme.includes(MARKERS.BETA_ROW.start));
  assert.ok(actualReadme.includes(MARKERS.BETA_ROW.end));

  // Simula execução com a versão atual publicada: não deve alterar nada (idempotente)
  const simulated = updateReadmeContent({
    content: actualReadme,
    channel: 'beta',
    version: '0.2.1-nightly.1',
    artifact: 'nexus_0.2.1-nightly.1_x64-setup.exe',
    status: 'Homologação Ativa',
  });

  assert.equal(simulated.trim(), actualReadme.trim(), 'README.md atual deve coincidir com o cálculo do sincronizador');
});
