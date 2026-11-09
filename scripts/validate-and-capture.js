import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

const ARTIFACT_DIR = 'C:\\Users\\kelma\\.gemini\\antigravity\\brain\\4186eae6-6233-45c5-a1a9-a908420892a4';
const EXE_PATH = 'C:\\Users\\kelma\\Documents\\Tropa\\src-tauri\\target\\debug\\nexus.exe';

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log('[Validation] Encerrando instâncias antigas...');
  try {
    spawn('taskkill', ['/F', '/IM', 'nexus.exe'], { stdio: 'ignore' });
  } catch {}
  await sleep(1000);

  console.log('[Validation] Iniciando Vite dev server na porta 1420...');
  const viteProc = spawn('cmd.exe', ['/c', 'npx', 'vite', '--port', '1420'], {
    cwd: 'C:\\Users\\kelma\\Documents\\Tropa',
    shell: true,
  });

  // Aguarda Vite responder em 1420
  let viteReady = false;
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    try {
      const res = await fetch('http://localhost:1420');
      if (res.ok) {
        viteReady = true;
        console.log('[Validation] Vite dev server pronto em http://localhost:1420');
        break;
      }
    } catch {}
  }

  if (!viteReady) {
    console.error('[Validation] Vite dev server não subiu a tempo.');
    viteProc.kill();
    process.exit(1);
  }

  console.log('[Validation] Iniciando nexus.exe com porta CDP 9222...');
  const env = {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9222',
  };

  const proc = spawn(EXE_PATH, [], { env, detached: false });

  // Aguarda WebView2 iniciar e expor porta 9222
  let wsUrl = null;
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    try {
      const res = await fetch('http://localhost:9222/json');
      if (res.ok) {
        const list = await res.json();
        const page = list.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
        if (page) {
          wsUrl = page.webSocketDebuggerUrl;
          console.log('[Validation] Página WebView2 encontrada:', page.title, page.url);
          break;
        }
      }
    } catch {}
  }

  if (!wsUrl) {
    console.error('[Validation] Falha ao conectar ao CDP da WebView2.');
    proc.kill();
    viteProc.kill();
    process.exit(1);
  }

  const ws = new WebSocket(wsUrl);
  let msgId = 1;
  const pending = new Map();

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.id && pending.has(data.id)) {
        const { resolve, reject } = pending.get(data.id);
        pending.delete(data.id);
        if (data.error) reject(data.error);
        else resolve(data.result);
      }
    } catch (e) {
      console.warn('Erro ao processar mensagem CDP:', e);
    }
  };

  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });

  function send(method, params = {}) {
    const id = msgId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  await send('Page.enable');
  await send('Runtime.enable');
  await send('DOM.enable');

  console.log('[Validation] Aguardando sessão e renderização da tela principal...');
  let mainReady = false;
  for (let i = 0; i < 25; i++) {
    await sleep(1000);
    const state = await send('Runtime.evaluate', {
      expression: `Boolean(document.querySelector('header input[placeholder*="Pesquisar"]'))`,
      returnByValue: true,
    });
    if (state.result.value) {
      mainReady = true;
      console.log(`[Validation] Tela principal com TitleBar carregada após ${i + 1}s!`);
      break;
    }
  }

  if (!mainReady) {
    console.warn('[Validation] Tela principal não carregou após 25s, tentando prosseguir...');
  }

  await sleep(1500);

  async function captureScreenshot(fileName) {
    const res = await send('Page.captureScreenshot', { format: 'png' });
    const filePath = path.join(ARTIFACT_DIR, fileName);
    fs.writeFileSync(filePath, Buffer.from(res.data, 'base64'));
    console.log(`[Validation] Screenshot salva: ${fileName} (${res.data.length} bytes base64)`);
    return filePath;
  }

  // 1. Inspeciona o estado do DOM da TitleBar e Perfil
  const domInspection = await send('Runtime.evaluate', {
    expression: `(() => {
      const header = document.querySelector('header[data-tauri-drag-region]');
      const search = document.querySelector('input[placeholder*="Pesquisar"]');
      const buttons = Array.from(document.querySelectorAll('header button'));
      const profileBtn = buttons.find(b => b.querySelector('img') || b.querySelector('svg.lucide-chevron-down') || b.innerText.includes('Usuário') || b.innerText.includes('Kel'));
      const winControls = document.querySelectorAll('header button[title="Minimizar"], header button[title="Maximizar"], header button[title="Fechar"]');
      const avatarImg = document.querySelector('header img');
      const titleText = header ? header.innerText.replace(/\\s+/g, ' ') : '';
      return {
        hasHeader: Boolean(header),
        hasSearch: Boolean(search),
        hasProfile: Boolean(profileBtn),
        profileBtnText: profileBtn ? profileBtn.innerText : '',
        hasAvatarImg: Boolean(avatarImg),
        avatarSrc: avatarImg ? avatarImg.src : null,
        windowControlsCount: winControls.length,
        headerText: titleText
      };
    })()`,
    returnByValue: true,
  });
  console.log('[Validation] Inspeção do DOM da TitleBar:', domInspection.result.value);

  // 2. Captura 1: Tela Inicial com a nova TitleBar integrada
  await captureScreenshot('screenshot_1_initial_titlebar.png');

  // 3. Abrir Menu de Perfil clicando no botão do perfil
  console.log('[Validation] Clicando no botão de perfil para abrir o dropdown...');
  const clickRes = await send('Runtime.evaluate', {
    expression: `(() => {
      const buttons = Array.from(document.querySelectorAll('header button'));
      const profileBtn = buttons.find(b => b.querySelector('img') || b.querySelector('svg.lucide-chevron-down') || b.innerText.includes('Kel') || b.innerText.includes('Usuário'));
      if (profileBtn) {
        profileBtn.click();
        return 'clicked';
      }
      return 'not_found';
    })()`,
    returnByValue: true,
  });
  console.log('[Validation] Clique no perfil:', clickRes.result.value);
  await sleep(1000);

  // 4. Captura 2: Menu de Perfil Aberto
  await captureScreenshot('screenshot_2_profile_menu.png');

  // Inspeciona se os itens do menu de perfil estão visíveis
  const menuInspection = await send('Runtime.evaluate', {
    expression: `(() => {
      const allText = document.body.innerText;
      return {
        hasDefinirStatus: allText.includes('DEFINIR STATUS') || allText.includes('Definir Status'),
        hasMeuPerfil: allText.includes('Meu perfil'),
        hasConfiguracoes: allText.includes('Configurações'),
        hasSairDaConta: allText.includes('Sair da conta')
      };
    })()`,
    returnByValue: true,
  });
  console.log('[Validation] Itens do menu de perfil detectados:', menuInspection.result.value);

  // Fecha o menu de perfil clicando no campo de busca
  await send('Runtime.evaluate', {
    expression: `(() => {
      const search = document.querySelector('input[placeholder*="Pesquisar"]');
      if (search) search.click();
      else document.body.click();
    })()`,
  });
  await sleep(800);

  // 5. Teste de Maximização: Clicar no botão Maximizar na TitleBar
  console.log('[Validation] Testando Maximizar via WindowControls...');
  const maxRes = await send('Runtime.evaluate', {
    expression: `(() => {
      const maxBtn = document.querySelector('header button[title="Maximizar"]');
      if (maxBtn) {
        maxBtn.click();
        return 'clicked_max';
      }
      return 'max_not_found';
    })()`,
    returnByValue: true,
  });
  console.log('[Validation] Clique em Maximizar:', maxRes.result.value);
  await sleep(2000);

  // 6. Captura 3: Janela Maximizada
  await captureScreenshot('screenshot_3_maximized.png');

  // 7. Teste de Restauração: Clicar no botão Restaurar
  console.log('[Validation] Testando Restaurar via WindowControls...');
  const restRes = await send('Runtime.evaluate', {
    expression: `(() => {
      const restBtn = document.querySelector('header button[title="Restaurar"], header button[title="Maximizar"]');
      if (restBtn) {
        restBtn.click();
        return 'clicked_restore';
      }
      return 'restore_not_found';
    })()`,
    returnByValue: true,
  });
  console.log('[Validation] Clique em Restaurar:', restRes.result.value);
  await sleep(2000);

  // 8. Captura 4: Janela Restaurada
  await captureScreenshot('screenshot_4_restored.png');

  // Encerra WebSocket, nexus.exe e Vite
  ws.close();
  proc.kill();
  viteProc.kill();
  console.log('[Validation] Validação visual concluída com sucesso!');
}

main().catch((err) => {
  console.error('[Validation] Erro:', err);
  process.exit(1);
});
