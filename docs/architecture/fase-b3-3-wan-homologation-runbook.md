# Fase B3.3 — Runbook de Homologação WAN (2+ Computadores em Redes Diferentes)

**Branch de referência:** `feat/v0.4.0-phase-a-foundation`  
**Objetivo:** Validar ponta-a-ponta o sistema de salas de voz multipessoa (`MeshRoomService`) e compartilhamento de tela em **2 a 4 computadores físicos em redes distintas** (ex.: fibra residencial + 4G/5G hotspot ou duas redes domésticas diferentes), **sem uso de Tailscale** e **sem alterar o ambiente de produção AWS**.

---

## 1. Arquitetura de Referência Inspecionada no Repositório

### 1.1 Backend (`nexus-server`)
- **HTTP e WebSocket na mesma porta (`SERVER_PORT`, padrão `3001`):**
  - `nexus-server/src/main.rs` e `nexus-server/src/config/mod.rs`:
    - `SERVER_HOST`: padrão `127.0.0.1`. Quando definido como `127.0.0.1` ou `localhost`, o servidor escuta apenas em loopback (`127.0.0.1:<SERVER_PORT>`) e, se existir, na interface Tailscale detectada.
    - Para exposição em **WAN sem Tailscale**, defina `SERVER_HOST=0.0.0.0` (ou atrás de proxy reverso local na mesma máquina com `SERVER_HOST=127.0.0.1` e TLS terminado no proxy).
    - `TRUST_PROXY_HEADERS=true` e `PUBLIC_FQDN=<seu-dominio-de-teste>`: necessários quando houver proxy reverso TLS (Caddy/Nginx/Cloudflare Tunnel).
  - **Rotas utilizadas pela B3.2/B3.3 (`nexus-server/src/routes/mod.rs`):**
    - `GET /health` — verificação de disponibilidade.
    - `GET /v1/webrtc/ice-servers` — entrega lista de servidores STUN/TURN (autenticado via `Authorization: Bearer <token>`).
    - `GET /v1/communities/:community_id/voice-rooms` — estado atual das salas de voz da comunidade.
    - `GET /v1/ws` (e alias `/ws`) — Gateway WebSocket de sinalização (`room_join`, `room_leave`, `room_state_update`, `room_webrtc_offer`, `room_webrtc_answer`, `room_webrtc_ice_candidate`).

### 1.2 Endpoint `/v1/webrtc/ice-servers` (`nexus-server/src/handlers/webrtc.rs`)
- **STUN padrão (sempre incluído):**
  - `stun:stun.l.google.com:19302`
  - `stun:stun1.l.google.com:19302`
  - `stun:stun2.l.google.com:19302`
- **TURN efêmero (RFC 5766 / RFC 7635):**
  - Ativado quando **`TURN_SECRET`** e **`TURN_SERVER`** (ou alias `TURN_URLS`) estão configurados no ambiente do `nexus-server`.
  - Gera credenciais temporárias com `ttl_seconds = 86400` (24h):
    - `username`: `<unix_timestamp_expiry>:<user.id>`
    - `credential`: `base64(HMAC-SHA1(TURN_SECRET, username))`
  - Retorna:
    - `turn:<TURN_SERVER>:3478?transport=udp`
    - `turn:<TURN_SERVER>:3478?transport=tcp`
    *(Se `TURN_SERVER` já incluir `:porta`, mantém a porta informada; caso contrário, anexa `:3478`.)*

### 1.3 Cliente (`src/services/MeshRoomService.ts` e `src-tauri/src/commands.rs`)
- `fetchIceServers(forceRefresh = false)` em `MeshRoomService.ts`:
  - Cache em memória por `600_000 ms` (10 minutos).
  - No runtime **Tauri Desktop** (`window.__TAURI_INTERNALS__`), chama o comando IPC `webrtc_get_ice_servers` (`src-tauri/src/commands.rs`), que consulta `GET {api_base}/v1/webrtc/ice-servers`.
  - No runtime **Navegador / Vite Dev** (sem Tauri), lê `localStorage.getItem('nexus_test_api_base')` e `localStorage.getItem('nexus_test_token')` e faz `fetch` direto para `/v1/webrtc/ice-servers`.
  - Em caso de falha, cai para `FALLBACK_STUN_SERVERS` (apenas Google STUN, **sem TURN**).
- `startRoomSession({ ..., iceTransportPolicy })`:
  - Aceita `iceTransportPolicy?: 'all' | 'relay'` (padrão `'all'`).
  - Passado diretamente para `new RTCPeerConnection({ iceServers, iceTransportPolicy, bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require', iceCandidatePoolSize: 2 })`.
- `collectMetricsSnapshot()`:
  - Coleta via `RTCPeerConnection.getStats()` por peer: `rttMs`, `uploadKbps`, `downloadKbps`, `packetsLost`, `jitterMs`, `candidateType` (`host`, `srflx`, `prflx` ou `relay`), `iceConnectionState` e `jsHeapUsedMb`.

---

## 2. Topologia Isolada de Teste (Sem Tailscale e Sem Produção AWS)

> **Regra de segurança:** Nunca aponte clientes de teste para o banco ou domínio de produção AWS, e não utilize credenciais de produção.

### 2.1 Pré-requisitos de Rede e Contexto Seguro
1. **Contexto Seguro (`https://` / `wss://`):**
   - WebRTC (`getUserMedia` e `getDisplayMedia`) exige contexto seguro em máquinas remotas (fora de `localhost`).
   - Use um **túnel TLS temporário** ou **proxy reverso com domínio de teste** (ex.: Caddy com DuckDNS/dynv6, Cloudflare Tunnel apontando para `127.0.0.1:3001`, ou Nginx com certificado Let's Encrypt) apontando para o `nexus-server` de homologação.
2. **PostgreSQL 16 descartável** no host do servidor de teste (ex.: porta `55442`, banco `nexus_wan_test`).
3. **Servidor TURN isolado (`coturn`)** para validar o cenário de NAT simétrico / relay real:
   - Pode rodar em uma VM/VPS de teste com IP público ou em um container Docker Linux com rede `host` e portas liberadas no firewall:
     - `3478/udp` e `3478/tcp` (STUN/TURN)
     - `49152-49252/udp` (range de relay RTP — restrinja o range em teste para facilitar abertura de firewall).

### 2.2 Configuração do `coturn` de Homologação (`turnserver.conf`)
```ini
listening-port=3478
fingerprint
use-auth-secret
static-auth-secret=SUBSTITUA_POR_UM_SEGREDO_DE_TESTE_32_CHARS
realm=turn-test.seu-dominio.exemplo
external-ip=<IP_PUBLICO_DO_HOST_COTURN>
min-port=49152
max-port=49252
no-tlsv1
no-tlsv1_1
log-file=stdout
```

Exemplo rápido com Docker (em host Linux com IP público):
```bash
docker run -d --name nexus-coturn-test --network=host \
  -v $(pwd)/turnserver.conf:/etc/coturn/turnserver.conf:ro \
  coturn/coturn:latest -c /etc/coturn/turnserver.conf
```

### 2.3 Variáveis de Ambiente do `nexus-server` de Homologação
```env
DATABASE_URL=postgres://postgres:SENHA_TESTE@127.0.0.1:55442/nexus_wan_test
SERVER_HOST=127.0.0.1
SERVER_PORT=3001
TRUST_PROXY_HEADERS=true
PUBLIC_FQDN=api-wan-test.seu-dominio.exemplo

# TURN de homologação (deve bater exatamente com static-auth-secret do coturn)
TURN_SERVER=turn-test.seu-dominio.exemplo:3478
TURN_SECRET=SUBSTITUA_POR_UM_SEGREDO_DE_TESTE_32_CHARS

RUST_LOG=info,nexus_server=debug
```
*(Se não houver proxy reverso e o `nexus-server` precisar escutar na interface de rede local para testes em LAN/port-forward direto, use `SERVER_HOST=0.0.0.0`.)*

### 2.4 Preparação dos 2+ Computadores Físicos
- **PC A (Rede 1 — ex.: Fibra residencial):**
  - App Tauri Desktop apontando para `https://api-wan-test.seu-dominio.exemplo` **ou** navegador Edge/Chrome acessando o build/preview HTTPS do frontend com `localStorage` configurado (`nexus_test_api_base` e `nexus_test_token`, ou login normal pela UI).
  - Microfone físico + fone de ouvido (evitar microfonia) + 1 janela de vídeo/jogo/movimento para screen share.
- **PC B (Rede 2 — ex.: Roteador 4G/5G de celular ou outra residência):**
  - Mesma versão do frontend/Tauri apontando para `https://api-wan-test.seu-dominio.exemplo`.
  - Microfone físico + fone de ouvido.
- **PC C e PC D (Opcional para 3 e 4 participantes):**
  - Preferencialmente em redes diferentes ou atrás de NATs distintos (ex.: Wi-Fi corporativo/convidado ou segundo hotspot 4G/5G).

---

## 3. Procedimento de Execução Passo a Passo

### Etapa 1 — Pré-checagem do Servidor e Credenciais ICE
1. Confirme `GET https://api-wan-test.seu-dominio.exemplo/health` retornando `200 OK`.
2. Faça login com os usuários de teste (`userA`, `userB`, `userC`, `userD`) na mesma comunidade com um canal de voz criado e permissão de voz/compartilhamento habilitada.
3. Valide o endpoint ICE autenticado (substitua `<TOKEN>`):
   ```bash
   curl -s -H "Authorization: Bearer <TOKEN>" \
     https://api-wan-test.seu-dominio.exemplo/v1/webrtc/ice-servers | jq .
   ```
   - **Critério:** A resposta deve conter `ice_servers` com os 3 `stun:stun*.l.google.com:19302` **e** a entrada `turn:...3478?transport=udp` / `tcp` com `username` (`<expiry>:<user_id>`) e `credential` não vazios.

### Etapa 2 — Teste P2P WAN Normal (`iceTransportPolicy: 'all'`)
1. **2 Participantes (`PC A` + `PC B`):**
   - `PC A` entra no canal de voz; `PC B` entra em seguida.
   - Verifique na árvore de canais da comunidade que ambos aparecem conectados.
   - Fale nos dois sentidos e confirme áudio bidirecional audível, sem eco excessivo e com anel de atividade de voz (`is_speaking`) acendendo corretamente.
2. **Controles de Áudio:**
   - Em `PC A`, ajuste o slider de volume individual de `PC B` para `20%`, `100%` e `180%`; confirme variação real de volume no fone.
   - Ative **Mute** no `PC A` -> `PC B` deve deixar de ouvir `PC A` e ver o ícone de microfone mutado. Desative Mute.
   - Ative **Deafen** no `PC B` -> `PC B` deixa de ouvir `PC A` e fica automaticamente mutado para `PC A`. Desative Deafen.
3. **Entrada e Saída Dinâmica (3 e 4 Participantes):**
   - `PC C` entra na sala -> áudio entre A, B e C funciona sem interromper A↔B.
   - `PC D` entra na sala (4/4 participantes) -> todos os 4 se ouvem simultaneamente.
   - `PC C` sai e entra novamente após 10 segundos -> peer é limpo e renegociado sem áudio duplicado ou travamento.
4. **Reconexão (Queda de Rede):**
   - Desconecte o Wi-Fi/cabo do `PC B` por ~6–8 segundos (tempo suficiente para disparar `iceDisconnectTimer` de `5000ms` e tentativa de ICE restart) e reconecte.
   - Confirme que `PC B` volta ao estado conectado (`connected`) e retoma áudio bidirecional sem precisar reiniciar o app.
5. **Compartilhamento de Tela (1 e 2 Streams Simultâneos):**
   - **1 Stream:** `PC A` inicia compartilhamento em `1080p60`. Confirme em `PC B`, `PC C` e `PC D` vídeo fluido, legível e sem congelamento.
   - **2 Streams Simultâneos:** Com `PC A` ainda transmitindo, `PC B` inicia um segundo compartilhamento (`720p60` ou `1080p30`). Confirme que todos os participantes veem os 2 cards/players `<video>` independentes simultaneamente, inclusive ao alternar foco/expansão no `VoiceRoomPanel`.
   - Encerre ambos os compartilhamentos e confirme remoção imediata dos players de vídeo.

### Etapa 3 — Validação Obrigatória de Relay TURN Real (`iceTransportPolicy: 'relay'`)
> Esta etapa prova que a mídia realmente trafega pelo servidor TURN quando P2P direto (`host`/`srflx`) está bloqueado por NAT simétrico ou firewall restritivo.

1. No `PC A` e no `PC B`, abra o DevTools (`F12` ou `Ctrl+Shift+I` no WebView2/navegador) ou inicie uma sessão passando `iceTransportPolicy: 'relay'` para `meshRoomService.startRoomSession(...)`.
   - Alternativa rápida no console do DevTools antes de entrar no canal (em build dev):
     ```js
     // Inspecionar se o relay foi negociado após entrar com policy 'relay'
     ```
     *(Ou bloqueie temporariamente tráfego UDP direto entre os dois IPs no firewall do PC B para forçar fallback natural para `relay`, mantendo `3478/udp+tcp` liberado para o servidor TURN.)*
2. Entre na sala de voz com `PC A` e `PC B`.
3. **Evidência Obrigatória:**
   - No `VoiceRoomPanel` / `collectMetricsSnapshot()` (ou via `RTCPeerConnection.getStats()` no DevTools), confirme:
     - `candidateType === 'relay'` no par de candidatos selecionado (`nominated` / `succeeded`).
     - Áudio bidirecional audível durante 60 segundos contínuos.
     - 1 compartilhamento de tela em `720p30` ou `1080p30` funcionando através do relay, observando os logs do `coturn` confirmando alocação (`allocate`, `channel_bind`) e bytes trafegados.

---

## 4. Coleta de Métricas WAN

Durante os testes de **4 participantes em áudio** e **2 compartilhamentos de tela simultâneos**, registre os valores reais observados (nunca extrapole valores de loopback local):

| Cenário | Participantes | `candidateType` (`host`/`srflx`/`relay`) | RTT Médio (ms) | Jitter (ms) | Packet Loss (%) | Upload Total (kbps) | Download Total (kbps) | CPU App (%) | RAM App (MB) | Qualidade Subjetiva (Áudio/Vídeo) |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :--- |
| Áudio Mesh 2P (WAN) | 2 | | | | | | | | | |
| Áudio Mesh 4P (WAN) | 4 | | | | | | | | | |
| 1 Screen Share `1080p60` (WAN) | 2–4 | | | | | | | | | |
| 2 Screen Shares Simultâneos (WAN) | 3–4 | | | | | | | | | |
| Relay TURN Forçado (`relay`) | 2 | `relay` | | | | | | | | |

---

## 5. Checklist Final de Aprovação B3.3 WAN

- [ ] `GET /v1/webrtc/ice-servers` entrega STUN + credenciais TURN efêmeras HMAC-SHA1 válidas.
- [ ] Conexão entre **2 computadores em redes físicas distintas** estabelecida sem Tailscale.
- [ ] Sala escalada para **3 e 4 participantes** com entrada/saída dinâmica sem vazamento de peers.
- [ ] **Áudio bidirecional audível** em todos os pares, com VAD (`is_speaking`) coerente.
- [ ] **Volume individual (0–200%)**, **Mute** e **Deafen** funcionando corretamente entre redes.
- [ ] **Reconexão automática** validada após queda temporária de rede (5–8s).
- [ ] **1 compartilhamento de tela (`1080p60`)** e **2 compartilhamentos simultâneos** recebidos sem travamentos.
- [ ] **TURN Relay real validado** com `candidateType === 'relay'` (`iceTransportPolicy: 'relay'`), áudio + vídeo trafegando pelo `coturn` de homologação.
- [ ] **Métricas WAN** preenchidas na tabela acima (RTT, kbps, packet loss, jitter, CPU/RAM).
- [ ] Ambiente temporário (`coturn` de teste, túnel TLS, Postgres descartável) encerrado após a homologação.
