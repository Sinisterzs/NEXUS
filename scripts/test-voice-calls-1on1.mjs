/**
 * NEXUS - Suite de Testes Automatizados de Chamadas de Voz 1:1 (Fase 2.4B)
 * Valida sinalização de chamada, aceitação, recusa, cancelamento, SDP Offer/Answer,
 * ICE Candidates, muting, encerramento, segurança, amizade e limpeza pós-queda.
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

async function runTests() {
  console.log('====================================================');
  console.log('   NEXUS - Testes Automatizados de Chamadas 1:1     ');
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
  const userA_name = `alice_call_${suffix}`;
  const userB_name = `bob_call_${suffix}`;
  const userC_name = `carol_call_${suffix}`;

  try {
    // 1. Registro de Alice, Bob e Carol
    const userA = await postJson('/v1/auth/register', {
      username: userA_name,
      email: `${userA_name}@nexus.test`,
      password: 'Password123!',
      display_name: 'Alice',
    });
    const userB = await postJson('/v1/auth/register', {
      username: userB_name,
      email: `${userB_name}@nexus.test`,
      password: 'Password123!',
      display_name: 'Bob',
    });
    const userC = await postJson('/v1/auth/register', {
      username: userC_name,
      email: `${userC_name}@nexus.test`,
      password: 'Password123!',
      display_name: 'Carol',
    });

    const tokenA = userA.session_token;
    const tokenB = userB.session_token;
    const tokenC = userC.session_token;

    assert(tokenA && tokenB && tokenC, 'Usuários de teste registrados com sucesso');

    // 2. Alice e Bob tornam-se amigos
    const reqRes = await postJson(
      '/v1/friends/requests',
      { username: userB_name, target: userB_name },
      tokenA
    );
    const requestId = reqRes.request?.id || reqRes.id;
    await postJson(
      `/v1/friends/requests/${requestId}/accept`,
      {},
      tokenB
    );
    assert(true, 'Amizade estabelecida entre Alice e Bob no banco');

    // 3. Conexão WebSocket dos dois participantes via tickets
    const ticketA = await postJson('/v1/gateway/ticket', {}, tokenA);
    const ticketB = await postJson('/v1/gateway/ticket', {}, tokenB);

    const clientA = await connectWsAndAuth(ticketA.ticket);
    const clientB = await connectWsAndAuth(ticketB.ticket);

    assert(
      clientA.ws.readyState === WebSocket.OPEN && clientB.ws.readyState === WebSocket.OPEN,
      'Alice e Bob conectados e autenticados no WebSocket Gateway'
    );

    // --- CENÁRIO 1: Convite de Chamada e Toque ---
    console.log('\n--- CENÁRIO 1: Convite de Chamada (Alice -> Bob) ---');
    clientA.ws.send(JSON.stringify({ op: 'call.invite', target_user_id: userB.user.id }));

    const incomingEvent = await waitForEvent(
      clientB.events,
      (e) => e.type === 'call.incoming' && e.payload?.caller?.id === userA.user.id
    );

    const callId = incomingEvent.payload.call_id;
    assert(callId && incomingEvent.payload.caller.username === userA_name, 'Bob recebeu evento call.incoming com call_id e dados da Alice');

    // --- CENÁRIO 2: Aceitação de Chamada ---
    console.log('\n--- CENÁRIO 2: Bob Aceita a Chamada ---');
    clientB.ws.send(JSON.stringify({ op: 'call.accept', call_id: callId }));

    const acceptedEvent = await waitForEvent(
      clientA.events,
      (e) => e.type === 'call.accepted' && e.payload?.call_id === callId
    );
    assert(acceptedEvent.payload.peer_id === userB.user.id, 'Alice recebeu evento call.accepted com confirmação do Bob');

    // --- CENÁRIO 3: Troca de SDP Offer e Answer ---
    console.log('\n--- CENÁRIO 3: Negociação WebRTC SDP Offer / Answer ---');
    const mockOfferSdp = 'v=0\r\no=alice 12345 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 50000 RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2';
    clientA.ws.send(
      JSON.stringify({
        op: 'call.webrtc.offer',
        call_id: callId,
        target_user_id: userB.user.id,
        sdp: mockOfferSdp,
      })
    );

    const offerEvent = await waitForEvent(
      clientB.events,
      (e) => e.type === 'call.webrtc.offer' && e.payload?.call_id === callId
    );
    assert(offerEvent.payload.sdp === mockOfferSdp, 'Bob recebeu SDP Offer criptografado retransmitido com integridade');

    const mockAnswerSdp = 'v=0\r\no=bob 67890 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 50002 RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2';
    clientB.ws.send(
      JSON.stringify({
        op: 'call.webrtc.answer',
        call_id: callId,
        target_user_id: userA.user.id,
        sdp: mockAnswerSdp,
      })
    );

    const answerEvent = await waitForEvent(
      clientA.events,
      (e) => e.type === 'call.webrtc.answer' && e.payload?.call_id === callId
    );
    assert(answerEvent.payload.sdp === mockAnswerSdp, 'Alice recebeu SDP Answer retransmitido com integridade');

    // --- CENÁRIO 4: Troca de ICE Candidates ---
    console.log('\n--- CENÁRIO 4: Troca de Candidatos ICE ---');
    const mockIceCandidateA = {
      candidate: 'candidate:1 1 udp 2122260223 100.117.183.97 50000 typ host',
      sdpMid: '0',
      sdpMLineIndex: 0,
    };
    clientA.ws.send(
      JSON.stringify({
        op: 'call.webrtc.ice_candidate',
        call_id: callId,
        target_user_id: userB.user.id,
        candidate: mockIceCandidateA,
      })
    );

    const iceEventB = await waitForEvent(
      clientB.events,
      (e) => e.type === 'call.webrtc.ice_candidate' && e.payload?.call_id === callId
    );
    assert(iceEventB.payload.candidate.candidate === mockIceCandidateA.candidate, 'Bob recebeu ICE candidate da Alice com rota Tailscale host');

    // --- CENÁRIO 5: Propagação de Mudo do Microfone ---
    console.log('\n--- CENÁRIO 5: Silenciamento e Ativação do Microfone ---');
    clientA.ws.send(JSON.stringify({ op: 'call.mute', call_id: callId, is_muted: true }));

    const muteEvent = await waitForEvent(
      clientB.events,
      (e) => e.type === 'call.participant_muted' && e.payload?.call_id === callId && e.payload?.is_muted === true
    );
    assert(muteEvent.payload.user_id === userA.user.id, 'Bob recebeu notificação de que Alice silenciou o microfone');

    clientA.ws.send(JSON.stringify({ op: 'call.mute', call_id: callId, is_muted: false }));
    const unmuteEvent = await waitForEvent(
      clientB.events,
      (e) => e.type === 'call.participant_muted' && e.payload?.call_id === callId && e.payload?.is_muted === false
    );
    assert(unmuteEvent.payload.user_id === userA.user.id, 'Bob recebeu notificação de que Alice reativou o microfone');

    // --- CENÁRIO 6: Encerramento Normal da Chamada ---
    console.log('\n--- CENÁRIO 6: Encerramento de Chamada ---');
    clientA.ws.send(JSON.stringify({ op: 'call.end', call_id: callId }));

    const endEvent = await waitForEvent(
      clientB.events,
      (e) => e.type === 'call.ended' && e.payload?.call_id === callId
    );
    assert(endEvent.payload.call_id === callId, 'Bob recebeu notificação de encerramento da chamada');

    // --- CENÁRIO 7: Recusa de Chamada ---
    console.log('\n--- CENÁRIO 7: Chamada Recusada pelo Destinatário ---');
    clientA.ws.send(JSON.stringify({ op: 'call.invite', target_user_id: userB.user.id }));
    const incoming2 = await waitForEvent(
      clientB.events,
      (e) => e.type === 'call.incoming' && e.payload?.call_id !== callId
    );
    const callId2 = incoming2.payload.call_id;

    clientB.ws.send(JSON.stringify({ op: 'call.reject', call_id: callId2, reason: 'Ocupado no momento.' }));
    const rejectedEvent = await waitForEvent(
      clientA.events,
      (e) => e.type === 'call.rejected' && e.payload?.call_id === callId2
    );
    assert(rejectedEvent.payload.reason === 'Ocupado no momento.', 'Alice recebeu rejeição de chamada com motivo customizado');

    // --- CENÁRIO 8: Cancelamento pelo Chamador ---
    console.log('\n--- CENÁRIO 8: Cancelamento de Chamada Pendente ---');
    clientA.ws.send(JSON.stringify({ op: 'call.invite', target_user_id: userB.user.id }));
    const incoming3 = await waitForEvent(
      clientB.events,
      (e) => e.type === 'call.incoming' && e.payload?.call_id !== callId && e.payload?.call_id !== callId2
    );
    const callId3 = incoming3.payload.call_id;

    clientA.ws.send(JSON.stringify({ op: 'call.cancel', call_id: callId3 }));
    const canceledEvent = await waitForEvent(
      clientB.events,
      (e) => e.type === 'call.canceled' && e.payload?.call_id === callId3
    );
    assert(canceledEvent.payload.call_id === callId3, 'Bob recebeu cancelamento da chamada antes de atender');

    // --- CENÁRIO 9: Segurança, Amizade e Proteção contra Chamada Dupla ---
    console.log('\n--- CENÁRIO 9: Regras de Segurança e Amizade ---');
    const ticketC = await postJson('/v1/gateway/ticket', {}, tokenC);
    const clientC = await connectWsAndAuth(ticketC.ticket);

    // Carol tenta chamar Bob sem ser amiga
    clientC.ws.send(JSON.stringify({ op: 'call.invite', target_user_id: userB.user.id }));
    const errNotFriend = await waitForEvent(
      clientC.events,
      (e) => e.type === 'call.error' && e.payload?.message?.includes('amigos')
    );
    assert(errNotFriend !== null, 'Carol (não-amiga) foi impedida de chamar Bob');

    // Alice tenta chamar a si mesma
    clientA.ws.send(JSON.stringify({ op: 'call.invite', target_user_id: userA.user.id }));
    const errCallSelf = await waitForEvent(
      clientA.events,
      (e) => e.type === 'call.error' && e.payload?.message?.includes('si mesmo')
    );
    assert(errCallSelf !== null, 'Usuário foi impedido de chamar a si mesmo');

    // --- CENÁRIO 10: Limpeza e Notificação de Desconexão Abrupta ---
    console.log('\n--- CENÁRIO 10: Queda de Conexão durante Chamada Ativa ---');
    clientA.ws.send(JSON.stringify({ op: 'call.invite', target_user_id: userB.user.id }));
    const incoming4 = await waitForEvent(
      clientB.events,
      (e) => e.type === 'call.incoming' && e.payload?.call_id !== callId && e.payload?.call_id !== callId2 && e.payload?.call_id !== callId3
    );
    const callId4 = incoming4.payload.call_id;
    clientB.ws.send(JSON.stringify({ op: 'call.accept', call_id: callId4 }));
    await waitForEvent(clientA.events, (e) => e.type === 'call.accepted' && e.payload?.call_id === callId4);

    // Alice fecha o socket abruptamente
    clientA.ws.close();

    const disconnectEndedEvent = await waitForEvent(
      clientB.events,
      (e) => e.type === 'call.ended' && e.payload?.call_id === callId4
    );
    assert(disconnectEndedEvent.payload.reason?.includes('perdeu a conexão'), 'Bob recebeu encerramento automático após Alice cair do WebSocket');

    clientB.ws.close();
    clientC.ws.close();

    console.log('\n====================================================');
    console.log(`Bateria de testes finalizada: ${passed} passaram, ${failed} falharam.`);
    console.log('====================================================');

    process.exit(failed > 0 ? 1 : 0);
  } catch (err) {
    console.error('[ERRO FATAL NA EXECUÇÃO DOS TESTES]:', err);
    process.exit(1);
  }
}

runTests();
