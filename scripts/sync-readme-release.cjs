#!/usr/bin/env node
/**
 * NEXUS - Sincronizador Automatizado de Releases no README.md
 * 
 * Atualiza cirurgicamente apenas as seções e linhas delimitadas por marcadores HTML
 * invisíveis no README.md, garantindo que:
 * 1. Releases Stable atualizem exclusivamente as seções Stable.
 * 2. Releases Beta / Nightly atualizem exclusivamente a linha Beta.
 * 3. O resto do documento (incluindo diagramas Mermaid e textos) permaneça 100% intocado.
 * 4. A execução seja idempotente (sem commits vazios caso o README já esteja em dia).
 */

const fs = require('fs');
const path = require('path');

const MARKERS = {
  STABLE_HEADER_BADGE: {
    start: '<!-- NEXUS:STABLE_HEADER_BADGE:START -->',
    end: '<!-- NEXUS:STABLE_HEADER_BADGE:END -->',
  },
  STABLE_HEADER_LINKS: {
    start: '<!-- NEXUS:STABLE_HEADER_LINKS:START -->',
    end: '<!-- NEXUS:STABLE_HEADER_LINKS:END -->',
  },
  STABLE_ROW: {
    start: '<!-- NEXUS:STABLE_ROW:START -->',
    end: '<!-- NEXUS:STABLE_ROW:END -->',
  },
  BETA_ROW: {
    start: '<!-- NEXUS:BETA_ROW:START -->',
    end: '<!-- NEXUS:BETA_ROW:END -->',
  },
};

function parseArgs(argv) {
  const args = {
    channel: null,
    version: null,
    artifact: null,
    status: null,
    repo: 'Sinisterzs/NEXUS',
    dryRun: false,
    filePath: path.resolve(__dirname, '..', 'README.md'),
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--channel' && argv[i + 1]) {
      args.channel = argv[++i].toLowerCase();
    } else if (arg === '--version' && argv[i + 1]) {
      args.version = argv[++i].trim();
    } else if (arg === '--artifact' && argv[i + 1]) {
      args.artifact = argv[++i].trim();
    } else if (arg === '--status' && argv[i + 1]) {
      args.status = argv[++i].trim();
    } else if (arg === '--repo' && argv[i + 1]) {
      args.repo = argv[++i].trim();
    } else if (arg === '--file' && argv[i + 1]) {
      args.filePath = path.resolve(argv[++i]);
    } else if (arg === '--dry-run') {
      args.dryRun = true;
    }
  }

  return args;
}

function detectEol(content) {
  return content.includes('\r\n') ? '\r\n' : '\n';
}

function replaceBetweenMarkers(content, startMarker, endMarker, newBlock) {
  const eol = detectEol(content);
  const startIdx = content.indexOf(startMarker);
  const endIdx = content.indexOf(endMarker);

  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    throw new Error(
      `Marcadores não localizados ou corrompidos: '${startMarker}' e '${endMarker}'`
    );
  }

  // Normaliza o newBlock para o eol do documento
  const normalizedNewBlock = newBlock.replace(/\r?\n/g, eol);

  const before = content.slice(0, startIdx + startMarker.length);
  const after = content.slice(endIdx);
  return `${before}${eol}${normalizedNewBlock}${eol}${after}`;
}

function updateReadmeContent(params) {
  const { content, channel, version, artifact, status, repo = 'Sinisterzs/NEXUS' } = params;

  if (!channel || (channel !== 'stable' && channel !== 'beta' && channel !== 'nightly')) {
    throw new Error(`Canal inválido: '${channel}'. Utilize 'stable' ou 'beta'/'nightly'.`);
  }

  if (!version) {
    throw new Error('Versão SemVer é obrigatória.');
  }

  const cleanVersion = version.replace(/^v/i, '');
  const tag = `v${cleanVersion}`;
  const resolvedArtifact = artifact || `nexus_${cleanVersion}_x64-setup.exe`;
  let updated = content;

  if (channel === 'stable') {
    const resolvedStatus = status || 'Homologada';

    // 1. Header Badge
    const headerBadgeBlock = [
      `[![Versão](https://img.shields.io/badge/Versão-${encodeURIComponent(tag + ' Stable')}-e02424?style=flat-square&logo=github)](https://github.com/${repo}/releases/tag/${tag})`,
      `[![Windows](https://img.shields.io/badge/Plataforma-Windows%2010%20%2F%2011%20x64-0f1117?style=flat-square&logo=windows11&logoColor=0078D4)](https://github.com/${repo}/releases/download/${tag}/${resolvedArtifact})`,
    ].join('\n');
    updated = replaceBetweenMarkers(
      updated,
      MARKERS.STABLE_HEADER_BADGE.start,
      MARKERS.STABLE_HEADER_BADGE.end,
      headerBadgeBlock
    );

    // 2. Header Links
    const releaseNotesPath = `scripts/release-notes-${tag}.md`;
    const headerLinksBlock = `[**Baixar ${tag} Stable**](https://github.com/${repo}/releases/download/${tag}/${resolvedArtifact}) • [**Notas de Lançamento**](${releaseNotesPath}) • [**Releases no GitHub**](https://github.com/${repo}/releases) • [**Histórico de Mudanças**](CHANGELOG.md)`;
    updated = replaceBetweenMarkers(
      updated,
      MARKERS.STABLE_HEADER_LINKS.start,
      MARKERS.STABLE_HEADER_LINKS.end,
      headerLinksBlock
    );

    // 3. Stable Row na Tabela HTML
    const stableRowBlock = [
      '    <tr>',
      `      <td align="left"><strong>Estável (Recomendado)</strong></td>`,
      `      <td align="center"><strong><code>${tag}</code></strong></td>`,
      `      <td align="center">${resolvedStatus}</td>`,
      `      <td align="left"><a href="https://github.com/${repo}/releases/download/${tag}/${resolvedArtifact}"><strong>${resolvedArtifact}</strong></a></td>`,
      `      <td align="left"><a href="https://github.com/${repo}/releases/latest/download/latest.json"><code>latest.json</code></a></td>`,
      '    </tr>',
    ].join('\n');
    updated = replaceBetweenMarkers(
      updated,
      MARKERS.STABLE_ROW.start,
      MARKERS.STABLE_ROW.end,
      stableRowBlock
    );
  } else {
    // Canal Beta / Nightly Row na Tabela HTML
    const resolvedStatus = status || 'Homologação Ativa';
    const betaRowBlock = [
      '    <tr>',
      `      <td align="left"><strong>Pré-lançamento (Beta)</strong></td>`,
      `      <td align="center"><code>${tag}</code></td>`,
      `      <td align="center">${resolvedStatus}</td>`,
      `      <td align="left"><a href="https://github.com/${repo}/releases/download/${tag}/${resolvedArtifact}">${resolvedArtifact}</a></td>`,
      `      <td align="left"><a href="https://github.com/${repo}/releases/download/${tag}/latest-nightly.json"><code>latest-nightly.json</code></a></td>`,
      '    </tr>',
    ].join('\n');

    updated = replaceBetweenMarkers(
      updated,
      MARKERS.BETA_ROW.start,
      MARKERS.BETA_ROW.end,
      betaRowBlock
    );
  }

  return updated;
}

function main() {
  const args = parseArgs(process.argv);

  if (!args.channel || !args.version) {
    console.error('[ERRO] Uso: node sync-readme-release.cjs --channel <stable|beta> --version <semver> [--artifact <name>] [--status <text>] [--dry-run]');
    process.exit(1);
  }

  if (!fs.existsSync(args.filePath)) {
    console.error(`[ERRO] Arquivo não encontrado: ${args.filePath}`);
    process.exit(1);
  }

  const originalContent = fs.readFileSync(args.filePath, 'utf8');

  try {
    const updatedContent = updateReadmeContent({
      content: originalContent,
      channel: args.channel,
      version: args.version,
      artifact: args.artifact,
      status: args.status,
      repo: args.repo,
    });

    if (originalContent === updatedContent) {
      console.log(`[INFO] README já está perfeitamente sincronizado com o canal '${args.channel}' (${args.version}). Nenhuma modificação necessária.`);
      return;
    }

    if (args.dryRun) {
      console.log(`[DRY-RUN] Sincronização calculada com sucesso para canal '${args.channel}' (${args.version}). Nenhuma alteração gravada.`);
      return;
    }

    fs.writeFileSync(args.filePath, updatedContent, 'utf8');
    console.log(`[OK] README.md sincronizado com sucesso para o canal '${args.channel}' -> versão v${args.version.replace(/^v/i, '')}.`);
  } catch (err) {
    console.error(`[ERRO] Falha ao sincronizar README.md: ${err.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  MARKERS,
  updateReadmeContent,
  replaceBetweenMarkers,
};
