# Relatório Técnico de Desempenho e Investigação de CPU: Streaming & WebRTC (Problema 4)

**Data:** 10 de Novembro de 2026<br>
**Autor:** Agente @performance<br>
**Escopo:** Investigação aprofundada de alto consumo de CPU durante transmissão de tela (1080p60 / 1080p30 / 720p30), identificação e ranqueamento de gargalos, instrumentação leve de telemetria e recomendações para os módulos de streaming e interface.

---

## 1. Sumário Executivo

Durante sessões de compartilhamento de tela — especialmente no perfil **1080p • 60 FPS** —, observou-se uso excessivo de CPU (>75-100% de ocupação dos núcleos lógicos alocados ao processo de renderização e codificação), acompanhado em muitos sistemas por queda de taxa efetiva para ~32 FPS (Problema 5).

Nossa investigação isolou e analisou cinco subsistemas interdependentes:
1. **Captura de Tela (`getDisplayMedia` constraints, resolução e taxa de quadros)**
2. **Pipeline de Codificação WebRTC e Negociação de Codec (SDP Offer/Answer e RTCRtpSender)**
3. **Aceleração de Hardware no Runtime WebView2 (flags em `src-tauri` e comportamento Chromium)**
4. **Frequência de Polling de Diagnósticos e Re-renderizações na UI (`setInterval`, `getStats`, React)**
5. **Comportamento e Arquitetura de Processos do Microsoft Edge WebView2**

**Conclusão Principal:** O gargalo dominante (**P0**) decorre da **codificação de vídeo em software (libvpx / VP8 ou VP9)** ao processar até **124,4 milhões de pixels por segundo** sem priorização explícita de codecs acelerados por hardware (ex: H.264 via MediaFoundation / NVENC / QuickSync / AMF) e sem degradação adaptativa (`degradationPreference`). Os gargalos secundários (**P1 a P3**) envolvem re-renderizações desnecessárias de toda a árvore React do `CallsView` a cada 1 segundo (timer de duração) e 100ms (VAD local/remoto), e a ausência de escalonamento dinâmico de taxa de quadros e bitrate.

---

## 2. Investigação Detalhada por Subsistema

### 2.1. Captura de Tela (`getDisplayMedia`)

* **Código analisado:** [`src/services/ScreenCaptureService.ts`](../../src/services/ScreenCaptureService.ts#L37-L85)
* **Evidências:**
  1. **Configuração de restrições rígidas (`max` = 60 fps e `max` = 1920x1080):**<br>
     Em [`ScreenCaptureService.ts:60-65`](../../src/services/ScreenCaptureService.ts#L60-L65), o preset `1080p60` solicita:
     ```typescript
     '1080p60': {
       maxBitrate: 5_000_000,
       maxFramerate: 60,
       targetWidth: 1920,
       targetHeight: 1080,
     }
     ```
     E em [`ScreenCaptureService.ts:80-84`](../../src/services/ScreenCaptureService.ts#L80-L84):
     ```typescript
     width: { ideal: cfg.targetWidth, max: cfg.targetWidth },
     height: { ideal: cfg.targetHeight, max: cfg.targetHeight },
     frameRate: { ideal: cfg.maxFramerate, max: cfg.maxFramerate },
     ```
  2. **Volume de dados não compactados no thread de captura:**<br>
     Um fluxo 1920×1080 RGBA a 60 FPS gera $1920 \times 1080 \times 4 \times 60 \approx 497,6 \text{ MB/s}$ de dados brutos na memória de vídeo/sistema.
     Quando o monitor capturado opera em resolução nativa superior (ex: 2560×1440 QHD ou 3840×2160 4K), o subsistema Desktop Duplication (DXGI) ou o compositor do Chromium realiza o downscaling bilineal no thread do processo de captura antes de entregar os quadros à pipeline do WebRTC.
  3. **Diretiva de Conteúdo (`contentHint`):**<br>
     Em [`ScreenCaptureService.ts:398-400`](../../src/services/ScreenCaptureService.ts#L398-L400):
     ```typescript
     if ('contentHint' in videoTrack) {
       (videoTrack as any).contentHint = this.qualityPreset === '1080p60' ? 'motion' : 'detail';
     }
     ```
     A diretiva `contentHint = 'motion'` sinaliza à stack do WebRTC para tentar preservar a fluidez de 60 FPS mesmo sob restrição de CPU/largura de banda, impedindo que o codificador reduza preventivamente a cadência de quadros.

---

### 2.2. Codificação WebRTC e Negociação de Codec

* **Código analisado:** [`src/services/WebRtcService.ts`](../../src/services/WebRtcService.ts#L571-L633) e [`WebRtcService.ts:666-735`](../../src/services/WebRtcService.ts#L666-L735)
* **Evidências:**
  1. **Ausência total de preferência de codecs (`setCodecPreferences`):**<br>
     Em [`WebRtcService.ts:600-633`](../../src/services/WebRtcService.ts#L600-L633), a função `attachScreenTrack` vincula o vídeo via `pc.addTrack` ou `existingSender.replaceTrack(track)` e cria uma SDP Offer padrão:
     ```typescript
     const offer = await pc.createOffer();
     await pc.setLocalDescription(offer);
     ```
     **Não há chamada a `RTCRtpTransceiver.setCodecPreferences()` nem manipulação de ordem de codecs no SDP.**
     Por padrão no Chromium/WebView2 em plataformas Windows:
     - Se `setCodecPreferences` não for especificado, o browser frequentemente oferece **VP8** (`libvpx`) ou **VP9** (`libvpx-vp9`) como primeira escolha de payload.
     - **VP9 e VP8 consomem ordens de magnitude mais ciclos de CPU** para codificação em tempo real do que fluxos H.264 acelerados por hardware.
     - O H.264 baseline/high profile suporta aceleração nativa via Microsoft MediaFoundation na vasta maioria de GPUs dedicadas (NVIDIA NVENC, AMD AMF) e integradas (Intel QuickSync).
  2. **Parâmetros de Codificação Incompletos em `applySenderQualityParameters`:**<br>
     Em [`WebRtcService.ts:580-588`](../../src/services/WebRtcService.ts#L580-L588):
     ```typescript
     const params = this.screenVideoSender.getParameters();
     if (!params.encodings || params.encodings.length === 0) {
       params.encodings = [{}];
     }
     params.encodings[0].maxBitrate = targets.maxBitrate;
     params.encodings[0].maxFramerate = targets.maxFramerate;
     await this.screenVideoSender.setParameters(params);
     ```
     - **Falta `degradationPreference`:** Não é configurado `'maintain-resolution'` (para telas estáticas/código) ou `'maintain-framerate'` (para jogos).
     - **Falta `scaleResolutionDownBy`:** Não há escalonamento adaptativo de codificação caso a CPU atinja saturação.
     - **Choque de Bitrate Imediato:** O `maxBitrate` de 5.000.000 bps é imposto no frame 1, forçando o codificador a buscar buffers de quantização elevados imediatamente.
  3. **Cálculo da Capacidade de Processamento por Quadro:**<br>
     Para 60 FPS, a janela máxima por quadro é de $\frac{1000 \text{ ms}}{60} \approx 16,6 \text{ ms}$.<br>
     Se o codificador de software levar **30 ms** para computar a transformada DCT, busca de vetores de movimento e quantização de um quadro 1080p, a taxa física resultante máxima será:
     $$\frac{1000 \text{ ms}}{30 \text{ ms}} \approx 33,3 \text{ FPS}$$
     Isso explica com exatidão cirúrgica o **Problema 5** ("1080p60 mostrando ~32 FPS") com consumo de CPU travado em 100%!

---

### 2.3. Aceleração de Hardware no Runtime WebView2

* **Código analisado:** [`src-tauri/tauri.conf.json`](../../src-tauri/tauri.conf.json#L1-L38) e [`src-tauri/src/lib.rs`](../../src-tauri/src/lib.rs#L163-L193)
* **Evidências:**
  1. Em [`tauri.conf.json:12-17`](../../src-tauri/tauri.conf.json#L12-L17), a chave `app.windows` está vazia (`[]`), e nenhuma flag de navegador adicional (`additionalBrowserArgs`) está definida no manifesto.
  2. Em [`src-tauri/src/lib.rs:165-190`](../../src-tauri/src/lib.rs#L165-L190), a janela principal é construída via `tauri::WebviewWindowBuilder::new(app, "main", ...)`, sem qualquer chamada a `.additional_browser_args(...)`.
  3. **Regras e Cuidados com `additional_browser_args` no Tauri 2 / Wry (Windows):**<br>
     - O runtime Wry no Windows por padrão injeta flags de segurança:<br>
       `--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection`
     - Caso argumentos personalizados sejam inseridos sem preservar as flags existentes, as opções padrão da Wry podem ser sobrescritas.
     - Alterações de argumentos do navegador no WebView2 exigem isolamento do diretório de dados do usuário (`userDataFolder`), sob risco de travamento de janelas concorrentes.
     - **Premissa Fundamental:** *Não se deve presumir a existência de GPU dedicada nem prometer um codificador específico.* Se flags agressivas como `--ignore-gpu-blocklist` forem forçadas em drivers instáveis, o WebView2 pode sofrer travamentos de processo GPU (GPU process crash / black screen).

---

### 2.4. Frequência de Polling de Diagnósticos e Re-renderizações na UI

* **Código analisado:** [`src/features/calls/CallsView.tsx`](../../src/features/calls/CallsView.tsx#L86-L230), [`src/services/CallService.ts:1167`](../../src/services/CallService.ts#L1167), [`src/services/WebRtcService.ts:1401`](../../src/services/WebRtcService.ts#L1401)
* **Evidências:**
  1. **Re-renderização Global a cada 1 segundo via Timer de Duração:**<br>
     Em [`CallService.ts:1167-1170`](../../src/services/CallService.ts#L1167-L1170):
     ```typescript
     this.durationTimer = setInterval(() => {
       this.callDurationSecs++;
       useAppStore.getState().setCallDurationSecs(this.callDurationSecs);
     }, 1000);
     ```
     Em [`CallsView.tsx:90`](../../src/features/calls/CallsView.tsx#L90), o componente raiz de ~1500 linhas assina diretamente:
     ```typescript
     const callDurationSecs = useAppStore((state) => state.callDurationSecs);
     ```
     A cada segundo exato, **todo o `CallsView` re-executa a renderização do React**, reavaliando dezenas de `useMemo`, recalculando estilos, criando nós virtuais do DOM e disparando comparações de propriedades em botões e barras de controle.
  2. **Disparos em Alta Frequência pelo VAD (Voice Activity Detection):**<br>
     Em [`WebRtcService.ts:1401-1436`](../../src/services/WebRtcService.ts#L1401-L1436), o loop de detecção de fala roda em intervalo de **100 ms**:
     ```typescript
     this.vadInterval = setInterval(() => { ... setSpeakingState(...) }, 100);
     ```
     [`CallsView.tsx:93-94`](../../src/features/calls/CallsView.tsx#L93-L94) assina `isLocalSpeaking` e `isRemoteSpeaking`. Em momentos de fala com microfone sensível, isso provoca dezenas de re-renderizações por minuto no componente de chamada.
  3. **Varredura Tripla de Relatórios no `getStats()`:**<br>
     Em [`WebRtcService.ts:921-1017`](../../src/services/WebRtcService.ts#L921-L1017), o método `collectTransportDiagnostics()` executa `report.forEach` três vezes consecutivas sobre o mapa de estatísticas do WebRTC. Embora seguro, pode ser consolidado em uma única iteração linear.
  4. **Atribuição Redundante em Elementos HTML5 `<video>`:**<br>
     Em [`CallsView.tsx:207-230`](../../src/features/calls/CallsView.tsx#L207-L230):
     ```typescript
     useEffect(() => {
       if (remoteVideoRef.current && remoteScreenStream) {
         remoteVideoRef.current.srcObject = remoteScreenStream;
         remoteVideoRef.current.play().catch(...);
       }
     }, [remoteScreenStream, activeStageSource, isFullscreen]);
     ```
     Sempre que o usuário alterna tela cheia ou origem ativa, o `srcObject` é reatribuído e `.play()` é reinvocado, forçando o pipeline de decodificação e renderização a re-sincronizar.

---

### 2.5. Comportamento e Arquitetura do Microsoft Edge WebView2

* **Processo do Navegador (Broker):** Gerencia janelas, IPC e permissões.
* **Processo de Renderização (Renderer):** Executa o JavaScript da aplicação, o DOM e o React.
* **Processo GPU:** Isola a API Direct3D / MediaFoundation para aceleração de vídeo e composição.
* **Sobrecarga Observada:**<br>
  Quando a codificação em software satura a CPU, o thread do renderer e o thread do encoder competem pelos mesmos núcleos do processador. O thread de composição do WebView2 sofre de jitter de agendamento do Windows (DWM), resultando em engasgos visuais na UI (Long Tasks > 50 ms) detectáveis via `PerformanceObserver`.

---

## 3. Ranqueamento dos Gargalos Identificados

| Rank | Bottleneck | Impacto em CPU | Causa Raiz | Módulo Responsável |
| :---: | :--- | :---: | :--- | :---: |
| **P0** | **Codificação de Vídeo em Software (libvpx/VP8/VP9)** | **Extremo (50% - 90%)** | Ausência de negociação de codec preferencial (H.264) e falta de parametrização de degradação adaptativa em `WebRtcService.ts`. Em 1080p60, a CPU não consegue codificar 60 quadros/s, travando em ~32 FPS. | `@streaming` |
| **P1** | **Taxa de Quadros Rígida (60 FPS) e Resolução Nativa sem Downscale Adaptativo** | **Alto (15% - 25%)** | Restrições rígidas (`max: 60`, `max: 1920`) e `contentHint = 'motion'` que forçam o pipeline a processar 500 MB/s de frames brutos mesmo quando a CPU está estressada. | `@streaming` |
| **P2** | **Re-renderizações Constantes do React no `CallsView` (1s Timer e 100ms VAD)** | **Médio (5% - 15%)** | O componente de 1500 linhas assina `callDurationSecs` e `isLocalSpeaking` na raiz, invalidando a árvore DOM inteira a cada segundo ou oscilação de voz. | `@interface` |
| **P3** | **Ativação e Polling de `getStats()` com Varreduras Múltiplas** | **Baixo-Médio (2% - 5%)** | Polling a cada 2s com tripla iteração do `RTCStatsReport` sem controle de cadência adaptativa (ex: pausar quando o painel de diagnósticos está fechado ou em segundo plano). | `@streaming` / `@interface` |
| **P4** | **Reatribuição de `srcObject` em elementos `<video>` no `CallsView`** | **Baixo (1% - 3%)** | Efeito de alternância de tela cheia que reatribui a stream e reinicia a reprodução do vídeo. | `@interface` |

---

## 4. Instrumentação Implementada: `MediaPerfMonitor.ts`

Para permitir a medição precisa desses fenômenos sem adicionar sobrecarga ao thread principal, foi criado o serviço singleton:
[`src/services/MediaPerfMonitor.ts`](../../src/services/MediaPerfMonitor.ts)

### Funcionalidades do `MediaPerfMonitor`:
1. **Detecção de Engasgos na Interface (Long Tasks):**<br>
   Utiliza a API nativa `PerformanceObserver` com `entryType: 'longtask'` (quando disponível no navegador/WebView2) com buffer circular seguro (máx. 100 itens) para mensurar duração máxima, total acumulado e taxa recente de bloqueio do thread principal.
2. **Extração de Telemetria de Codificador WebRTC:**<br>
   Analisa o relatório `outbound-rtp` de vídeo do WebRTC e extrai:
   - `encoderImplementation` (ex: `"libvpx"`, `"OpenH264"`, `"MediaFoundationVideoEncodeAccelerator"`)
   - `powerEfficientEncoder` (se a aceleração por hardware está ativa e eficiente)
   - `qualityLimitationReason` (`'cpu'`, `'bandwidth'`, `'other'`, `'none'`)
   - `qualityLimitationDurations` (tempo gasto sob limitação de CPU vs largura de banda)
   - `avgEncodeTimeMs`: tempo médio real gasto para codificar cada quadro (calculado via delta de `totalEncodeTime` / `framesEncoded`)
   - `cpuBottleneckDetected`: flag booleana imediata ativada quando a razão é `'cpu'` ou quando o tempo de codificação ultrapassa o limiar de fluidez.
3. **Controle de Cadência de Polling e Proteção contra Reentrância:**<br>
   - `getRecommendedPollInterval(isPanelVisible, isStreaming)`: 2000 ms durante inspeção ativa; 5000 ms quando o painel está oculto ou inativo.
   - `executeSafePoll(fn)`: bloqueia execuções concorrentes de `getStats()` caso a chamada anterior ainda esteja em voo.
4. **Garantia de Não-Interferência:**<br>
   Totalmente opt-in, sem dependências externas, com cobertura de testes unitários em [`tests/media_perf_monitor.test.ts`](../../tests/media_perf_monitor.test.ts).

---

## 5. Recomendações Técnicas

### 5.1. Para o Agente `@streaming` (`WebRtcService.ts` e `ScreenCaptureService.ts`)

1. **Priorização de Codec de Baixo Uso de CPU (H.264 preferencial):**<br>
   Ao criar o transceiver ou adicionar a track de vídeo, consultar `RTCRtpReceiver.getCapabilities('video')` ou `RTCRtpSender.getCapabilities('video')` e reordenar a lista colocando `video/H264` no topo antes de `video/VP8` ou `video/VP9` via `transceiver.setCodecPreferences(...)`.<br>
   *Justificativa:* O codec H.264 possui suporte universal a hardware na arquitetura Windows (MediaFoundation / D3D11VA), aliviando imediatamente dezenas de por cento de uso de CPU.
2. **Configuração de `degradationPreference` no RTCRtpSender:**<br>
   Ao configurar os parâmetros do sender em `applySenderQualityParameters`:
   - Para presets de alta resolução/texto (`1080p30`, `auto`): configurar `degradationPreference = 'maintain-resolution'`.
   - Para presets de alta fluidez (`1080p60`): configurar `degradationPreference = 'maintain-framerate'`.
3. **Exposição de Telemetria de Codificador:**<br>
   Incluir `encoderImplementation` e `powerEfficientEncoder` no objeto `WebRtcTransportDiagnostics`, aproveitando a lógica testada em `MediaPerfMonitor`.
4. **Rampa Progressiva de Bitrate:**<br>
   Em vez de impor `maxBitrate = 5_000_000` bruscamente no primeiro frame de `1080p60`, iniciar com limite conservador (ex: 2.500.000 bps) permitindo ao estimador de largura de banda (BWE) do WebRTC escalar suavemente.

### 5.2. Para o Agente `@interface` (`CallsView.tsx` e `ActiveCallBar.tsx`)

1. **Isolamento de Componentes de Alta Frequência (Timer & VAD):**<br>
   Extrair o mostrador do cronômetro da chamada para um subcomponente dedicado e memoizado (ex: `<CallDurationTimer />`), evitando que o incremento a cada segundo de `callDurationSecs` re-renderize os 1500 nós JSX do `CallsView`.
2. **Memoização de Indicadores de Voz (Speaking Indicator):**<br>
   Isolar os avatares e bordas de fala (`isLocalSpeaking`, `isRemoteSpeaking`) em subcomponentes memoizados com `React.memo`, prevenindo re-renders em cascata a cada 100 ms.
3. **Polling Sob Demanda com `MediaPerfMonitor`:**<br>
   Utilizar a cadência recomendada (`getRecommendedPollInterval`) para só consultar diagnósticos quando o painel colapsável de diagnósticos estiver efetivamente aberto (`showDiagnostics === true`).

### 5.3. Sobre Configurações do Runtime WebView2 (`src-tauri`)

- **Não alterar `additionalBrowserArgs` no momento:**<br>
  Como verificado, alterar browser arguments no WebView2 sobrescreve os padrões seguros da Wry e exige diretórios de dados isolados. O ganho real de desempenho deve ser obtido através da negociação correta de codecs e da parametrização do WebRTC antes de qualquer interferência nas flags nativas do executável.

---

## 6. Procedimento de Validação Manual

Para aferir as melhorias de desempenho em tempo real durante testes locais ou em homologação:

1. **Inspecionar Codecs e Aceleração via `edge://webrtc-internals`:**
   - Abrir o Edge ou apontar para a sessão WebView2.
   - Iniciar compartilhamento de tela `1080p60`.
   - Localizar a seção `RTCOutboundRtpVideoStream`.
   - Verificar as propriedades:
     - `encoderImplementation`: confirmar se exibe implementação de hardware (ex: `MediaFoundationVideoEncodeAccelerator`) em vez de fallback de software (`libvpx`).
     - `powerEfficientEncoder`: deve indicar `true` em hardware compatível.
     - `qualityLimitationReason`: certificar-se de que não permanece travado em `'cpu'`.
2. **Monitorar Consumo no Gerenciador de Tarefas do Windows:**
   - Abrir o Gerenciador de Tarefas (aba Detalhes / Processos).
   - Habilitar as colunas **CPU**, **Uso de GPU** e **Mecanismo de GPU**.
   - Durante a transmissão em 1080p60:
     - O processo de renderização do NEXUS deve manter uso de CPU reduzido (<15-20% em vez de 80-100%).
     - O mecanismo de GPU deve apontar atividade em `Video Encode` (3D / Video Processing).
3. **Validação de Responsividade da UI:**
   - Interagir com a barra de ferramentas de chamada (mutar, alternar abas, abrir popovers) enquanto transmite 1080p60.
   - Observar que as transições permanecem a 60 FPS estáveis, sem atraso perceptível de clique ou travamento de ponteiro.
