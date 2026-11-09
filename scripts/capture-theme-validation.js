import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

const ARTIFACT_DIR = 'C:\\Users\\kelma\\.gemini\\antigravity\\brain\\4186eae6-6233-45c5-a1a9-a908420892a4';
const EXE_PATH = 'C:\\Users\\kelma\\Documents\\Tropa\\src-tauri\\target\\debug\\nexus.exe';

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log('[Theme Capture] Encerrando nexus anterior...');
  try {
    spawn('taskkill', ['/F', '/IM', 'nexus.exe'], { stdio: 'ignore' });
  } catch {}
  await sleep(1000);

  console.log('[Theme Capture] Iniciando nexus.exe com CDP 9222...');
  const env = {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9222',
  };
  const proc = spawn(EXE_PATH, [], { env, detached: false });

  let wsUrl = null;
  for (let i = 0; i < 35; i++) {
    await sleep(1000);
    try {
      const res = await fetch('http://localhost:9222/json');
      if (res.ok) {
        const list = await res.json();
        console.log(`[Theme Capture] CDP Targets (${i + 1}s):`, list.map(t => ({ title: t.title, url: t.url, type: t.type })));
        const nexusPage = list.find(
          (item) => item.type === 'page' && item.webSocketDebuggerUrl && item.title === 'NEXUS'
        );
        if (nexusPage) {
          wsUrl = nexusPage.webSocketDebuggerUrl;
          console.log(`[Theme Capture] NEXUS detectado com title NEXUS após ${i + 1}s!`);
          break;
        }
      }
    } catch {}
  }

  if (!wsUrl) {
    console.error('NEXUS page not found');
    proc.kill();
    process.exit(1);
  }

  const ws = new WebSocket(wsUrl);
  let msgId = 1;
  const pending = new Map();

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.method === 'Runtime.consoleAPICalled') {
        const text = data.params.args.map(a => a.value || a.description).join(' ');
        console.log(`[Browser Console] ${text}`);
      }
      if (data.id && pending.has(data.id)) {
        const { resolve, reject } = pending.get(data.id);
        pending.delete(data.id);
        if (data.error) reject(data.error);
        else resolve(data.result);
      }
    } catch (e) {}
  };

  await new Promise((resolve) => { ws.onopen = resolve; });

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

  console.log('[Theme Capture] Aguardando tela principal com TitleBar...');
  let ready = false;
  for (let i = 0; i < 45; i++) {
    await sleep(1000);
    const evalRes = await send('Runtime.evaluate', {
      expression: `Boolean(document.querySelector('header'))`,
      returnByValue: true,
    });
    if (evalRes?.result?.value) {
      console.log(`[Theme Capture] TitleBar montada após ${i + 1}s!`);
      ready = true;
      break;
    }
    const snippet = await send('Runtime.evaluate', {
      expression: `document.body ? document.body.innerText.substring(0, 100).replace(/\\s+/g, ' ') : ''`,
      returnByValue: true,
    });
    console.log(`[Theme Capture] [${i + 1}s] Splash text: "${snippet?.result?.value}"`);
  }

  if (!ready) {
    console.error('Timeout aguardando TitleBar.');
    proc.kill();
    process.exit(1);
  }

  await sleep(2000);

  async function capture(fileName) {
    const res = await send('Page.captureScreenshot', { format: 'png' });
    const filePath = path.join(ARTIFACT_DIR, fileName);
    fs.writeFileSync(filePath, Buffer.from(res.data, 'base64'));
    const size = fs.statSync(filePath).size;
    console.log(`[Theme Capture] ${fileName} gravada com sucesso! (${size} bytes)`);
    return filePath;
  }

  // 1. Home com NEXUS Dark (Crimson)
  console.log('[Theme Capture] 1. Configurando NEXUS Dark na Home...');
  await send('Runtime.evaluate', {
    expression: `(() => {
      window.__NEXUS_STORE__.getState().setActiveTab('home');
      window.__NEXUS_STORE__.getState().updateAppearance({ theme: 'nexus-dark' });
    })()`,
  });
  await sleep(1500);
  await capture('nexus_theme_1_nexus_dark_home.png');

  // Inspeciona o avatar da Home
  const avatarCheck = await send('Runtime.evaluate', {
    expression: `(() => {
      const banner = document.querySelector('section');
      const avatarEl = banner ? banner.querySelector('img') : null;
      const avatarWrapper = avatarEl ? avatarEl.closest('.relative') : null;
      const classes = avatarWrapper ? avatarWrapper.className : '';
      return {
        hasAvatar: Boolean(avatarEl),
        avatarSrc: avatarEl ? avatarEl.src.substring(0, 40) : null,
        wrapperClasses: classes,
        hasSolidRedRing: classes.includes('ring-rose') || classes.includes('border-rose') || classes.includes('border-red') || classes.includes('ring-1'),
      };
    })()`,
    returnByValue: true,
  });
  console.log('[Theme Capture] Verificação do Avatar na Home:', JSON.stringify(avatarCheck.result.value, null, 2));

  // 2. Home com Midnight Black (Blue)
  console.log('[Theme Capture] 2. Alternando para Midnight Black (Azul) na Home...');
  await send('Runtime.evaluate', {
    expression: `(() => {
      window.__NEXUS_STORE__.getState().updateAppearance({ theme: 'midnight-black' });
    })()`,
  });
  await sleep(1500);
  await capture('nexus_theme_2_midnight_black_home.png');

  // 3. Home com Cyber Slate (Cyan)
  console.log('[Theme Capture] 3. Alternando para Cyber Slate (Ciano) na Home...');
  await send('Runtime.evaluate', {
    expression: `(() => {
      window.__NEXUS_STORE__.getState().updateAppearance({ theme: 'cyber-slate' });
    })()`,
  });
  await sleep(1500);
  await capture('nexus_theme_3_cyber_slate_home.png');

  // 4. Mensagens com Cyber Slate (Cyan)
  console.log('[Theme Capture] 4. Navegando para Mensagens em Cyber Slate...');
  await send('Runtime.evaluate', {
    expression: `(() => {
      const store = window.__NEXUS_STORE__.getState();
      store.setActiveTab('messages');
      const convs = store.conversations;
      if (convs && convs.length > 0) {
        store.selectConversation(convs[0].id);
      }
    })()`,
  });
  await sleep(2000);
  await capture('nexus_theme_4_cyber_slate_messages.png');

  // 5. Mensagens com Midnight Black (Blue)
  console.log('[Theme Capture] 5. Alternando para Midnight Black em Mensagens...');
  await send('Runtime.evaluate', {
    expression: `(() => {
      window.__NEXUS_STORE__.getState().updateAppearance({ theme: 'midnight-black' });
    })()`,
  });
  await sleep(1500);
  await capture('nexus_theme_5_midnight_black_messages.png');

  // 6. Configurações com Midnight Black (Blue)
  console.log('[Theme Capture] 6. Navegando para Configurações em Midnight Black...');
  await send('Runtime.evaluate', {
    expression: `(() => {
      window.__NEXUS_STORE__.getState().setActiveTab('settings');
    })()`,
  });
  await sleep(1500);
  await capture('nexus_theme_6_midnight_black_settings.png');

  // 7. Retorna para Home e nexus-dark
  await send('Runtime.evaluate', {
    expression: `(() => {
      window.__NEXUS_STORE__.getState().updateAppearance({ theme: 'nexus-dark' });
      window.__NEXUS_STORE__.getState().setActiveTab('home');
    })()`,
  });
  await sleep(1000);

  ws.close();
  proc.kill();
  try {
    spawn('taskkill', ['/F', '/IM', 'nexus.exe'], { stdio: 'ignore' });
  } catch {}
  console.log('[Theme Capture] Concluído com sucesso!');
  process.exit(0);
}

main().catch((err) => {
  console.error('[Theme Capture] Erro fatal:', err);
  process.exit(1);
});
