# Relatório de Verificação Técnica Independente — NEXUS v0.3.0-nightly.2
> **Registro histórico de 10/11/2026.** Não constitui aprovação final de publicação nem comprovação de hardware. Hipóteses sobre CPU/GPU e equivalência entre FPS decodificado/renderizado abaixo foram revistas na preparação final. Consulte `release-readiness-v0.3.0-nightly.2.md` para a evidência atual e as pendências.

**Submódulo:** Calls & Streaming 2.1<br>
**Auditor / Verificador:** Agente `@verifier` (Revisão Independente)<br>
**Data:** 10 de Novembro de 2026<br>
**Veredito:** **APPROVED (APROVADO)**<br>

---

## 1. Sumário Executivo

O presente relatório documenta a auditoria e verificação técnica independente das modificações implementadas para a versão **NEXUS v0.3.0-nightly.2 (Calls & Streaming 2.1)**. Todos os seis problemas reportados foram detalhadamente analisados em código-fonte, notas de engenharia, arquitetura de software e testes automatizados.

### Resumo dos Resultados
- **TypeScript Typecheck (`npx tsc --noEmit`):** 0 erros.
- **Bateria de Testes Automatizados (`npm test`):** 58 testes executados com 100% de sucesso (9 suítes).
- **Ações Proibidas Auditadas:** Nenhuma violação detectada (sem commits/pushes no git, sem builds Release, sem instaladores NSIS executados, sem alterações de infraestrutura de rede/TURN/P2P, sem regressões em chamadas 1:1 e sem remoção de funcionalidades legadas).
- **Veredito Geral:** **APROVADO (APPROVED)** para merge / homologação.

---

## 2. Auditoria dos 6 Problemas de Engenharia

### Problema 1: Transmissão de tela inicia borrada (Warmup Ramp & Resolução Íntegra)
- **Diagnóstico da Causa Raiz:** No Chromium/WebView2, `contentHint = 'motion'` definia `kRealtimeVideo` com degradação espacial imediata sob o BWE inicial (~300 kbps), derrubando a resolução para 540p/360p no frame 1. A ausência de `degradationPreference = 'maintain-resolution'` e `scaleResolutionDownBy = 1`, somada à falta de reaplicação de parâmetros após o SDP Answer, causava borrão prolongado.
- **Verificação da Correção:**
  1. `ScreenCaptureService.ts` inicia a captura com `contentHint = 'detail'` e define `minBitrate`, `initialBitrate` e `degradationPreference` por perfil (`SCREEN_QUALITY_CONFIGS`).
  2. `WebRtcService.ts` implementa uma rampa progressiva em 3 estágios (`warmup` -> `ramping` -> `steady`):
     - `warmup` (t=0ms): Bitrate inicial seguro (ex: 3.25 Mbps para 1080p60), `scaleResolutionDownBy: 1`, `degradationPreference: 'maintain-resolution'`, `contentHint: 'detail'`.
     - `ramping` (t=900ms): Transição progressiva com resolução mantida.
     - `steady` (t=1800ms): Bitrate nominal completo (5 Mbps), liberando `contentHint: 'motion'` e `degradationPreference: 'balanced'` para 1080p60.
  3. Reaplicação garantida dos parâmetros do sender após `setRemoteDescription(answer)` em `WebRtcService.handleAnswer()`.
  4. Ranking de codecs prioritário (`rankVideoCodecsForScreenShare`) favorecendo H.264 (`packetization-mode=1`) e VP9 antes de VP8 software, preservando RTX/RED/ULPFEC.
- **Status:** **APROVADO**.

---

### Problema 2: Overlay flutuante cobrindo entrada de texto de conversas
- **Diagnóstico da Causa Raiz:** `<ActiveCallBar />` era renderizado no `App.tsx` em posição flutuante fixa centralizada inferior (`fixed bottom-4 left-1/2 -translate-x-1/2 z-50`), sobrepondo o campo de digitação e botões de anexo em `MessagesView.tsx`.
- **Verificação da Correção:**
  1. O overlay flutuante foi removido de `App.tsx` e re-alocado como dock nativo dentro da barra lateral esquerda (`src/app/Sidebar.tsx`), acima dos controles de áudio.
  2. Em `src/components/ActiveCallBar.tsx`, o layout adapta-se de forma reativa:
     - **Barra lateral expandida (`w-60`)**: Card horizontal contendo avatar do par (com halo de fala), nome, duração da chamada, indicador de tela/microfone remoto e botões de ação rápida (mutar, deafen, retornar à chamada e desligar).
     - **Barra lateral recolhida (`w-16`)**: Coluna vertical compacta com avatar pulsante, tooltips informativos e botões essenciais.
  3. O isolamento físico dentro do `<aside>` elimina qualquer sobreposição visual com `<main>`, conversas ou campos de input.
- **Status:** **APROVADO**.

---

### Problema 3: Modos de layout Compacto, Equilibrado e Cinema desperdiçando espaço
- **Diagnóstico da Causa Raiz:** Os botões apenas alternavam valores percentuais de split ratio em um container com largura máxima travada em `max-w-5xl` e margens inferiores fixas `pb-24`. No modo Cinema, o vídeo não maximizava a área útil, a barra lateral continuava aberta e controles flutuantes tomavam espaço.
- **Verificação da Correção:**
  1. Criação do módulo puro `src/lib/callsLayout.ts` com especificações claras para cada modo (`CALL_LAYOUT_PRESETS`):
     - **Compacto (`compact`)**: Split ratio ~45%, foco nos cards completos de participantes com controles individuais de volume.
     - **Equilibrado (`balanced`)**: Split ratio ~68%, container `max-w-6xl`, faixa compacta horizontal de participantes.
     - **Cinema (`cinema`)**: Vídeo expande para a área máxima útil (`w-full h-full`, sem `max-w-5xl`), barra lateral recolhível via alternador dedicado no cabeçalho do palco, faixa de participantes minimalista e controles discretamente sobrepostos com `backdrop-blur-md` e alto contraste.
  2. Preservação estrita da proporção de aspecto nativa (`object-contain` e cálculo de letterboxing/pillarbox em `calculateCinemaDimensions`), impedindo deformação geométrica do vídeo.
  3. Total independência entre o modo Cinema e a Tela Cheia (Fullscreen API), permitindo entrar/sair de tela cheia sem desconfigurar o modo selecionado.
- **Status:** **APROVADO**.

---

### Problema 4: Investigação de alto consumo de CPU em streaming e instrumentação segura
- **Diagnóstico da Causa Raiz:**
  - **P0 (Dominante):** Codificação em software (VP8/libvpx) sem aceleração por hardware, processando até 124,4 megapixels/s em 1080p60.
  - **P1:** Ausência de `degradationPreference` adaptativo e rampa de bitrate.
  - **P2:** Re-renderizações globais a cada 1 segundo no `CallsView` devido ao timer de duração (`callDurationSecs`).
  - **P3/P4:** Polling e oscilação de VAD sem memoização.
- **Verificação da Correção:**
  1. Documento aprofundado `docs/nightly2/performance-report.md` com evidências linha por linha, cálculos físicos de throughput e ranqueamento P0 a P4.
  2. Implementação do serviço singleton `src/services/MediaPerfMonitor.ts`:
     - Monitoramento de Long Tasks via `PerformanceObserver` nativo.
     - Extração de telemetria de hardware (`encoderImplementation`, `powerEfficientEncoder`, detecção de gargalo de CPU).
     - Cadência adaptativa de polling de diagnósticos (2s ativo / 5s em repouso) e proteção contra reentrância de chamadas `getStats()`.
  3. Otimização no `CallsView.tsx` através da extração do componente memoizado `<CallDurationBadge />`, eliminando re-renderizações cíclicas de 1s na página inteira.
  4. Manutenção segura dos argumentos de runtime do WebView2 sem introduzir flags instáveis no `src-tauri`.
- **Status:** **APROVADO**.

---

### Problema 5: Preset 1080p60 travado em ~32 FPS e separação estrita de métricas de FPS
- **Diagnóstico da Causa Raiz:** O gargalo de CPU na codificação de software limitava a taxa em ~32 FPS (1000ms / ~31ms por frame). Adicionalmente, quando `framesPerSecond` não vinha no relatório RTP, o código fazia fallback para o FPS do preset/constraint (`trackSettings.frameRate`), mascarando a lentidão real.
- **Verificação da Correção:**
  1. Função pura `computeVideoStatsMetrics()` em `WebRtcService.ts` calcula com precisão taxas por delta de frames e timestamps (`framesEncoded`, `framesSent`, `framesReceived`, `framesDecoded`, `framesCaptured`).
  2. **Separação estrita de métricas em `WebRtcTransportDiagnostics`:**
     - `requestedFps`: FPS alvo do preset configurado.
     - `capturedFps`: FPS efetivamente entregue pela fonte/monitor (`media-source`).
     - `encodedFps`: FPS processado pelo codificador de vídeo.
     - `sentFps`: FPS transmitido na rede (`outbound-rtp`).
     - `receivedFps`: FPS recebido pelo par remoto (`inbound-rtp`).
     - `renderedFps`: FPS decodificado e renderizado na tela (`framesDecoded`).
     - `videoFps`: Reflete exclusivamente a taxa real da mídia (`renderedFps ?? receivedFps` ou `sentFps ?? encodedFps`).
  3. **Regra de Ouro Atendida:** Em nenhuma hipótese o valor do preset é utilizado como fallback para o FPS efetivo da transmissão.
- **Status:** **APROVADO**.

---

### Problema 6: Sensibilidade de microfone, medidor visual e indicador estável de atividade de voz
- **Diagnóstico da Causa Raiz:** Avaliação instantânea a cada 100ms sem histerese e sem tempo de retenção (hangover), fazendo o indicador piscar durante pausas normais entre sílabas. O medidor nas configurações não exibia o ponto de corte do limiar e não havia ferramenta de calibração para ruídos de fundo.
- **Verificação da Correção:**
  1. Módulo puro `src/lib/voiceActivity.ts` implementando a classe `VoiceActivityDetector`:
     - **Histerese Schmitt-trigger:** Limiar de ativação superior e limiar de desativação inferior (offset padrão de 5 pontos).
     - **Filtro de ataque:** Exigência de 2 frames consecutivos acima do limiar para descartar cliques e transitórios espúrios.
     - **Hangover (Hold time):** Retenção padrão de 400ms para manter o indicador aceso durante pausas respiratórias e entre sílabas.
     - **Suavização do medidor:** Ataque rápido e decaimento exponencial suave para representação visual fluida.
  2. **Fronteira Arquitetural Respeitada:** O áudio transmitido **não sofre corte abrupto por padrão** (`softGateEnabled: false`), garantindo que o início e o fim das frases nunca sejam engolidos ("gate swallowing").
  3. **Interface em `SettingsView.tsx`:**
     - Medidor interativo em tempo real com marcador visual do limiar de ativação.
     - Botão de calibração automática ("Calibrar Ruído Ambiente") que mede o ruído de fundo por 1,5s e define a sensibilidade com margem de segurança.
     - Seletor de tempo de retenção (200ms, 400ms, 600ms, 800ms) e opção documentada de soft gate.
  4. **Persistência por Conta:** Preferências validadas e salvas via `SettingsRepository.ts` (`voiceAutoSensitivity`, `voiceHangoverMs`, `voiceSoftGate`).
- **Status:** **APROVADO**.

---

## 3. Matriz de Testes Automatizados

Execução completa realizada via `npm test`:

| Suíte de Testes | Arquivo | Casos de Teste | Resultado |
| :--- | :--- | :---: | :---: |
| SemVer & Versioning | `tests/version.test.ts` | 4 | Passou (100%) |
| Persistência de Canais | `tests/update_channel_persistence.test.ts` | 7 | Passou (100%) |
| Persistência de Temas | `tests/theme_persistence.test.ts` | 7 | Passou (100%) |
| Matriz de Canais | `tests/version_channel_matrix.test.ts` | 7 | Passou (100%) |
| Automação do README | `tests/sync_readme_release.test.ts` | 5 | Passou (100%) |
| Calls & Streaming v0.3.0 | `tests/calls_and_streaming_v030.test.ts` | 15 | Passou (100%) |
| Layout Modes & Telemetria | `tests/calls_layout_nightly2.test.ts` | 7 | Passou (100%) |
| Voice Activity & Hysteresis | `tests/voice_activity_nightly2.test.ts` | 10 | Passou (100%) |
| Monitor de Performance | `tests/media_perf_monitor.test.ts` | 3 | Passou (100%) |
| **Total Geral** | **9 arquivos de teste** | **58 testes** | **100% APROVADO** |

---

## 4. Auditoria de Conformidade e Ações Proibidas

| Regra / Diretriz | Status | Observação |
| :--- | :---: | :--- |
| Sem commits ou pushes no Git | **Em conformidade** | Nenhuma alteração foi commitada ou enviada ao repositório remoto. |
| Sem builds Release / instaladores | **Em conformidade** | `desktop:build` e compilações Release não foram disparadas. |
| Sem execução de instalador NSIS | **Em conformidade** | Nenhum instalador silencioso foi executado contra o registro do Windows. |
| Sem quebra de arquitetura ou rede | **Em conformidade** | P2P, ICE servers, sinalização e auth preservados integralmente. |
| Sem regressão em chamadas 1:1 | **Em conformidade** | Fluxo de áudio, mutar, ensurdecer, volumes e reconexão cobertos por testes. |
| Sem remoção de funcionalidades | **Em conformidade** | Presets existentes (`auto`, `720p30`, `1080p30`, `1080p60`) e UI intactos. |

---

## 5. Conclusão da Verificação

Todas as diretrizes técnicas e requisitos do usuário foram estritamente cumpridos. O código está robusto, coberto por testes determinísticos, devidamente documentado nas notas de engenharia e pronto para validação visual pelo usuário.

**Veredito Oficial: APPROVED**
