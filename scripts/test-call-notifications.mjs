/**
 * NEXUS - Teste Específico da Fase 2.4B.1: Notificações de Chamadas Recebidas
 * Valida que o destinatário recebe call.incoming, o chamador recebe call.ringing,
 * e que a notificação NÃO é rejeitada automaticamente.
 */

import http from 'http';

const BASE_URL = 'http://127.0.0.1:3001';
const WS_URL = 'ws://127.0.0.1:3001/v1/gateway';

function postJson(urlPath, data, token = null) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(data);
    const url = new URL(urlPath, BASE_URL);
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData),
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const req = http.request(
      url,
      {
        method: 'POST',
        headers,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          try {
            const parsed = body ? JSON.parse(body) : {};
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(parsed);
            } else {
              reject(new Error(`HTTP ${res.statusCode}: ${body}`));
            }
          } catch (e) {
            reject(e);
          }
        });
      }
    );

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

function connectWsAndAuth(ticket) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const events = [];

    ws.onopen = () => {
      ws.send(JSON.stringify({ op: 'authenticate', ticket }));
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data.toString());
        events.push(msg);
        if (msg.type === 'connection.ready' || msg.type === 'connected') {
          resolve({ ws, events });
        }
      } catch (e) {
        // ignore
      }
    };

    ws.onerror = (err) => {
      reject(err);
    };

    setTimeout(() => {
      reject(new Error('WebSocket connection & auth timeout'));
    }, 5000);
  });
}

function waitForEvent(eventsArray, predicate, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const interval = setInterval(() => {
      const found = eventsArray.find(predicate);
      if (found) {
        clearInterval(interval);
        resolve(found);
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(interval);
        reject(new Error(`Timeout aguardando evento (${timeoutMs}ms)`));
      }
    }, 50);
  });
}

async function run() {
  console.log('====================================================');
  console.log('   NEXUS - Teste de Diagnóstico de Notificações 2.4B.1');
  console.log('====================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`  [PASS] ${message}`);
      passed++;
    } else {
      console.error(`  [FAIL] ${message}`);
      failed++;
    }
  }

  const suffix = Math.random().toString(36).substring(2, 8);
  const userA_name = `alice_toast_${suffix}`;
  const userB_name = `bob_toast_${suffix}`;

  try {
    const userA = await postJson('/v1/auth/register', {
      username: userA_name,
      email: `${userA_name}@nexus.test`,
      password: 'Password123!',
      display_name: 'Alice Toast',
    });
    const userB = await postJson('/v1/auth/register', {
      username: userB_name,
      email: `${userB_name}@nexus.test`,
      password: 'Password123!',
      display_name: 'Bob Toast',
    });

    const tokenA = userA.session_token;
    const tokenB = userB.session_token;

    // Estabelece amizade
    const reqRes = await postJson(
      '/v1/friends/requests',
      { username: userB_name, target: userB_name },
      tokenA
    );
    const requestId = reqRes.request?.id || reqRes.id;
    await postJson(`/v1/friends/requests/${requestId}/accept`, {}, tokenB);

    // Conecta ambos via WebSocket
    const ticketA = await postJson('/v1/gateway/ticket', {}, tokenA);
    const ticketB = await postJson('/v1/gateway/ticket', {}, tokenB);
    const clientA = await connectWsAndAuth(ticketA.ticket);
    const clientB = await connectWsAndAuth(ticketB.ticket);

    assert(true, 'Alice e Bob conectados ao WebSocket Gateway');

    // Teste 1: Alice chama Bob
    console.log('\n--- TESTE 1: Alice envia convite de voz para Bob ---');
    clientA.ws.send(JSON.stringify({ op: 'call.invite', target_user_id: userB.user.id }));

    // Bob DEVE receber call.incoming
    const incoming = await waitForEvent(
      clientB.events,
      (e) => e.type === 'call.incoming'
    );
    assert(
      incoming.payload?.call_id && incoming.payload?.caller?.username === userA_name,
      'Bob recebeu evento call.incoming com id da chamada e perfil completo da Alice'
    );

    // Alice DEVE receber call.ringing com o mesmo call_id
    const ringing = await waitForEvent(
      clientA.events,
      (e) => e.type === 'call.ringing'
    );
    assert(
      ringing.payload?.call_id === incoming.payload?.call_id,
      'Alice recebeu evento call.ringing com o mesmo call_id'
    );

    // Teste 2: Verificar que Bob NÃO rejeita automaticamente
    console.log('\n--- TESTE 2: Garantir que não há auto-rejeição imediata ---');
    await new Promise((r) => setTimeout(r, 1000));
    const autoRejected = clientA.events.find((e) => e.type === 'call.rejected');
    assert(!autoRejected, 'Nenhuma auto-rejeição detectada após 1s de chamada tocando');

    // Teste 3: Bob aceita
    console.log('\n--- TESTE 3: Bob aceita e Alice recebe call.accepted ---');
    clientB.ws.send(JSON.stringify({ op: 'call.accept', call_id: incoming.payload.call_id }));

    const accepted = await waitForEvent(
      clientA.events,
      (e) => e.type === 'call.accepted'
    );
    assert(
      accepted.payload?.call_id === incoming.payload.call_id &&
        accepted.payload?.peer_id === userB.user.id,
      'Alice recebeu call.accepted confirmando Bob'
    );

    // Teste 4: Alice encerra
    console.log('\n--- TESTE 4: Encerramento de chamada e liberação ---');
    clientA.ws.send(JSON.stringify({ op: 'call.end', call_id: incoming.payload.call_id }));

    const ended = await waitForEvent(
      clientB.events,
      (e) => e.type === 'call.ended'
    );
    assert(ended.payload?.call_id === incoming.payload.call_id, 'Bob recebeu call.ended');

    // Teste 5: Nova chamada com cancelamento
    console.log('\n--- TESTE 5: Cancelamento pelo chamador notifica ambos os lados ---');
    clientA.ws.send(JSON.stringify({ op: 'call.invite', target_user_id: userB.user.id }));
    const incoming2 = await waitForEvent(
      clientB.events,
      (e) => e.type === 'call.incoming' && e.payload?.call_id !== incoming.payload.call_id
    );
    const callId2 = incoming2.payload.call_id;

    // Alice cancela
    clientA.ws.send(JSON.stringify({ op: 'call.cancel', call_id: callId2 }));

    const canceledB = await waitForEvent(
      clientB.events,
      (e) => e.type === 'call.canceled' && e.payload?.call_id === callId2
    );
    const canceledA = await waitForEvent(
      clientA.events,
      (e) => e.type === 'call.canceled' && e.payload?.call_id === callId2
    );

    assert(canceledB && canceledA, 'Ambos os clientes receberam call.canceled');

    clientA.ws.close();
    clientB.ws.close();

    console.log(`\n====================================================`);
    console.log(`Resultado: ${passed} passaram, ${failed} falharam.`);
    console.log(`====================================================\n`);

    if (failed > 0) {
      process.exit(1);
    }
  } catch (err) {
    console.error('Erro no teste:', err);
    process.exit(1);
  }
}

run();
