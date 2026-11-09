import cp from 'child_process';
import https from 'https';

function getGitToken() {
  const out = cp.execSync('git credential fill', { input: 'protocol=https\nhost=github.com\n\n' }).toString();
  const match = out.match(/password=(.+)/);
  if (!match) throw new Error('Não foi possível obter token do Git Credential Manager');
  return match[1].trim();
}

function githubRequest(path, method = 'GET', data = null) {
  const token = getGitToken();
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path,
      method,
      headers: {
        'Authorization': `token ${token}`,
        'User-Agent': 'NEXUS-Deployer',
        'Accept': 'application/vnd.github+json',
      },
    };

    let bodyData = null;
    if (data) {
      bodyData = JSON.stringify(data);
      options.headers['Content-Type'] = 'application/json';
      options.headers['Content-Length'] = Buffer.byteLength(bodyData);
    }

    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(raw ? JSON.parse(raw) : null);
        } else {
          reject(new Error(`GitHub API ${method} ${path} retornou ${res.statusCode}: ${raw}`));
        }
      });
    });

    req.on('error', reject);
    if (bodyData) req.write(bodyData);
    req.end();
  });
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const version = '0.2.0';
  const targetRef = 'release/v0.2.0';
  const releaseNotes = 'NEXUS v0.2.0 — Versão Estável Oficial com Redesign UI 2.0, Temas Globais e Segurança TOFU.';

  console.log(`[Dispatch] Disparando workflow stable.yml para versão ${version} a partir de ${targetRef}...`);
  await githubRequest('/repos/Sinisterzs/NEXUS/actions/workflows/stable.yml/dispatches', 'POST', {
    ref: 'main',
    inputs: {
      target_ref: targetRef,
      version: version,
      release_notes: releaseNotes,
    },
  });

  console.log('[Dispatch] Workflow stable.yml disparado com sucesso! Localizando execução...');
  await sleep(4000);

  let run = null;
  for (let i = 0; i < 20; i++) {
    const runsData = await githubRequest('/repos/Sinisterzs/NEXUS/actions/workflows/stable.yml/runs?per_page=5');
    if (runsData && runsData.workflow_runs && runsData.workflow_runs.length > 0) {
      const latest = runsData.workflow_runs[0];
      const runTime = new Date(latest.created_at).getTime();
      const now = Date.now();
      if (now - runTime < 180000) { // menos de 3 minutos
        run = latest;
        break;
      }
    }
    await sleep(2000);
  }

  if (!run) {
    console.log('[Dispatch] Workflow foi enviado, mas não foi possível obter o ID da run imediatamente.');
    process.exit(0);
  }

  console.log(`[Dispatch] Execução encontrada: ID ${run.id} (${run.html_url})`);
  console.log(`[Dispatch] Status inicial: ${run.status} | Conclusão: ${run.conclusion || 'em andamento'}`);

  // Monitora até a conclusão
  const startTime = Date.now();
  while (true) {
    await sleep(15000);
    const updated = await githubRequest(`/repos/Sinisterzs/NEXUS/actions/runs/${run.id}`);
    const elapsedMinutes = Math.floor((Date.now() - startTime) / 60000);
    const elapsedSeconds = Math.floor(((Date.now() - startTime) % 60000) / 1000);
    console.log(`[${elapsedMinutes}m ${elapsedSeconds}s] Status: ${updated.status} | Conclusão: ${updated.conclusion || 'em andamento'}`);

    if (updated.status === 'completed') {
      console.log(`\n======================================================`);
      console.log(`[Workflow Concluído] Conclusão: ${updated.conclusion}`);
      console.log(`URL da Run: ${updated.html_url}`);
      console.log(`Release Oficial: https://github.com/Sinisterzs/NEXUS/releases/tag/v${version}`);
      console.log(`======================================================`);
      if (updated.conclusion !== 'success') {
        process.exit(1);
      }
      break;
    }
  }
}

main().catch((err) => {
  console.error('[Dispatch Erro]:', err.message);
  process.exit(1);
});
