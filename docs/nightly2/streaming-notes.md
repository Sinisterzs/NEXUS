# Notas de Diagnóstico e Correção — Streaming & WebRTC (Nightly 2)

Este documento registra a investigação técnica (Causa, Evidência e Correção) realizada antes de modificar cada módulo sob responsabilidade de `@streaming` para os **Problemas 1 e 5**.

---

## Problema 1: Transmissão começa borrada no início do compartilhamento de tela (especialmente em 1080p60)

### 1. Módulo `src/services/ScreenCaptureService.ts`
- **Causa:**
  1. Em `startCapture()` (`src/services/ScreenCaptureService.ts:398-401`), quando o preset era `'1080p60'`, `videoTrack.contentHint` era definido imediatamente como `'motion'` no frame zero (`t = 0`), antes da estimativa de banda (GCC/BWE) do WebRTC convergir. No Chromium/WebView2 (`VideoStreamEncoder`), `contentHint = 'motion'` ativa o modo de vídeo de câmera (`kRealtimeVideo`) com `degradationPreference = 'maintain-framerate'` por padrão, fazendo o adaptador espacial reduzir agressivamente a resolução (para 540p/360p) e elevar o QP nos primeiros segundos enquanto o BWE parte de ~300 kbps.
  2. Em `setQualityPreset()` (`src/services/ScreenCaptureService.ts:214-261`), a troca de preset em tempo real chamava `track.applyConstraints()`, mas não atualizava `videoTrack.contentHint` nem sincronizava os alvos solicitados (`requestedWidth`, `requestedHeight`, `requestedFrameRate`).
  3. Em `SCREEN_QUALITY_CONFIGS` (`src/services/ScreenCaptureService.ts:37-66`), não havia definição explícita de `minBitrate` / `initialBitrate` nem de `degradationPreference` por perfil para orientar a rampa progressiva sem estourar o link no frame 1.
- **Evidência:**
  - `src/services/ScreenCaptureService.ts:398-401`: `(videoTrack as any).contentHint = this.qualityPreset === '1080p60' ? 'motion' : 'detail';`
  - `src/services/ScreenCaptureService.ts:232-240`: `setQualityPreset` aplica `track.applyConstraints(constraints)` sem atualizar `contentHint`.
  - `src/services/ScreenCaptureService.ts:331-339`: o bloco de fallback de `getDisplayMedia` caía diretamente para `frameRate: { max: 30 }` sem tentar manter 60 FPS com resolução flexível quando o preset solicitado era `1080p60`.
- **Correção:**
  - Estender `ScreenEncodingTargets` com `minBitrate`, `initialBitrate` e `degradationPreference` recomendados por preset, preservando integralmente os presets existentes (`auto`, `720p30`, `1080p30`, `1080p60`) e seus valores de `maxBitrate`, `maxFramerate`, `targetWidth` e `targetHeight`.
  - Iniciar `videoTrack.contentHint = 'detail'` no warmup inicial de captura para garantir que o primeiro keyframe use codificação de tela nítida, permitindo transição controlada após o warmup e sincronizando `contentHint` também em `setQualityPreset()`.
  - No fallback de `startCapture`, quando `1080p60` falha por restrição de resolução do monitor/janela, tentar primeiro `{ cursor: 'always', frameRate: { ideal: 60, max: 60 } }` antes de cair para 30 FPS, ou registrar com precisão a resolução/FPS efetivamente obtidos via `track.getSettings()`.
  - Expor em `ScreenCaptureState` os campos separados `requestedWidth`, `requestedHeight`, `requestedFrameRate`, `capturedWidth`, `capturedHeight` e `capturedFrameRate` (nunca usando o FPS do preset como fallback quando `track.getSettings().frameRate` não estiver disponível).

### 2. Módulo `src/services/WebRtcService.ts`
- **Causa:**
  1. Em `applySenderQualityParameters()` (`src/services/WebRtcService.ts:573-595`), apenas `maxBitrate` e `maxFramerate` eram definidos em `params.encodings[0]`. Não eram configurados `params.degradationPreference`, `encodings[0].scaleResolutionDownBy = 1`, `encodings[0].priority = 'high'` nem `encodings[0].networkPriority = 'high'`. Sem `degradationPreference: 'maintain-resolution'` e `scaleResolutionDownBy: 1`, o encoder do WebView2 reduzia a resolução codificada (`frameWidth`/`frameHeight`) no início da transmissão.
  2. Em `attachScreenTrack()` (`src/services/WebRtcService.ts:600-633`) e `handleAnswer()` (`src/services/WebRtcService.ts:807-834`), `applySenderQualityParameters` era chamado apenas antes de `createOffer()`, e nunca reaplicado após `setRemoteDescription(answer)`. No Chromium, a finalização da resposta SDP pode recriar/reconfigurar o `VideoSendStream`, descartando ou atrasando parâmetros aplicados antes da negociação.
  3. Não havia rampa progressiva de bitrate/qualidade no início da transmissão (`warmup` -> `ramping` -> `steady`) nem preferência de codecs (`setCodecPreferences`) que priorizasse H.264 / VP9 sobre o encoder VP8 de software.
- **Evidência:**
  - `src/services/WebRtcService.ts:580-588`: `params.encodings[0].maxBitrate = targets.maxBitrate; params.encodings[0].maxFramerate = targets.maxFramerate;` (sem `scaleResolutionDownBy`, `degradationPreference`, `priority`).
  - `src/services/WebRtcService.ts:625-630`: `applySenderQualityParameters` executado apenas antes de `createOffer()`, ausente em `handleAnswer()` (`src/services/WebRtcService.ts:826-833`).
- **Correção:**
  - Configurar explicitamente `scaleResolutionDownBy: 1`, `priority: 'high'`, `networkPriority: 'high'` e `degradationPreference` (`'maintain-resolution'` para presets de detalhe e durante o warmup inicial de todos os presets, transicionando para `'balanced'` em steady-state no `1080p60` com `scaleResolutionDownBy: 1`).
  - Implementar rampa progressiva de bitrate em 3 estágios (`warmup` em `t=0ms` com 65% do `maxBitrate` + `maintain-resolution` + `contentHint='detail'`; `ramping` em `t=900ms` com 85% do `maxBitrate`; `steady` em `t=1800ms` com 100% do `maxBitrate` e liberação de `contentHint='motion'` + `'balanced'` para `1080p60`), evitando tanto o borrado inicial por queda de resolução quanto rajadas abruptas de 5 Mbps no frame 1.
  - Reaplicar parâmetros do sender e preferência de codecs após `setRemoteDescription(answer)` e na troca de preset em tempo real.
  - Adicionar negociação preferencial de codecs de vídeo (`applyPreferredVideoCodecs` via `RTCRtpTransceiver.setCodecPreferences`) priorizando `video/H264` (`packetization-mode=1`) -> `video/VP9` -> `video/AV1` -> `video/VP8` e preservando integralmente `rtx`/`red`/`ulpfec` para compatibilidade total P2P.

---

## Problema 5: Preset 1080p60 exibindo ~32 FPS e mistura entre FPS solicitado, capturado, codificado/enviado, recebido e renderizado

### 1. Módulos `src/lib/types.ts` e `src/services/WebRtcService.ts`
- **Causa:**
  1. **Gargalo de codificação e negociação:** Sem `setCodecPreferences` (usando VP8 software por padrão em 1080p), sem reaplicar `maxFramerate: 60` pós-Answer e mantendo `contentHint = 'detail'` quando o usuário iniciava em `'auto'` (30 FPS) e mudava para `'1080p60'` em `setQualityPreset()`, o controlador temporal de tela do Chromium/WebRTC limitava a cadência em ~30–32 FPS (quantização de timer de captura no Windows `1000ms / 31.25ms = 32.0 FPS` ou limite da camada temporal TL1 de screenshare).
  2. **Mistura de métricas em `collectTransportDiagnostics()` (`src/services/WebRtcService.ts:966-1037`):**
     - `inbound-rtp` e `outbound-rtp` sobrescreviam as mesmas variáveis `videoWidth`, `videoHeight` e `videoFps`.
     - Apenas `stat.framesPerSecond` instantâneo era lido; não eram calculados deltas de `framesEncoded`, `framesSent`, `framesReceived` e `framesDecoded` usando os timestamps do relatório `getStats()`.
     - Nas linhas `1020-1037`, quando `videoFps` não vinha no report RTP, o código fazia fallback para `trackSettings.frameRate` (`videoFps = Math.round(trackSettings.frameRate)`), exibindo o FPS de restrição/preset como se fosse o FPS efetivamente transmitido!
- **Evidência:**
  - `src/services/WebRtcService.ts:989-991` e `1009-1011`: `inbound-rtp` e `outbound-rtp` gravam na mesma variável `videoFps`.
  - `src/services/WebRtcService.ts:1032-1034`:
    ```ts
    if (!videoFps && typeof trackSettings.frameRate === 'number' && trackSettings.frameRate > 0) {
      videoFps = Math.round(trackSettings.frameRate);
    }
    ```
  - `src/services/WebRtcService.ts:141-145`: `prevStatsSnapshot` armazenava apenas `timestampMs`, `audioBytes` e `videoBytes`, sem contadores de frames (`framesEncoded`, `framesSent`, `framesReceived`, `framesDecoded`, `framesCaptured`) para cálculo de FPS por delta.
- **Correção:**
  - Adicionar em `src/lib/types.ts` (e reexportar em `src/services/WebRtcService.ts`) os novos campos diagnósticos em `WebRtcTransportDiagnostics`:
    - FPS separados: `requestedFps`, `capturedFps`, `encodedFps`, `sentFps`, `receivedFps`, `renderedFps`, além de `videoFps` (que reflete exclusivamente o FPS efetivo real: `renderedFps ?? receivedFps` ao receber vídeo remoto, ou `sentFps ?? encodedFps` ao transmitir tela local, **nunca** fazendo fallback para o FPS do preset ou `track.getSettings().frameRate`).
    - Resoluções separadas: `requestedWidth`, `requestedHeight`, `capturedWidth`, `capturedHeight`, `encodedWidth`, `encodedHeight`, `receivedWidth`, `receivedHeight`.
    - Contadores e diagnósticos de limitação: `framesEncoded`, `framesSent`, `framesReceived`, `framesDecoded`, `framesDropped`, `keyFramesEncoded`, `keyFramesDecoded`, `qualityLimitationReason`, `qualityLimitationDurations`, `qualityLimitationResolutionChanges`, `videoCodec`, `encoderImplementation`, `decoderImplementation`, `powerEfficientEncoder`, `powerEfficientDecoder`, `targetVideoBitrateKbps`, `bitrateRampStage`.
  - Extrair função pura `computeVideoStatsMetrics()` em `src/services/WebRtcService.ts` que calcula FPS por `framesPerSecond` e por delta de contadores (`framesEncoded`, `framesSent`, `framesReceived`, `framesDecoded`, `media-source.frames`) sobre o delta de timestamp, garantindo precisão mesmo quando `framesPerSecond` não é fornecido pelo navegador.

### 2. Módulo `tests/calls_and_streaming_v030.test.ts`
- **Causa / Necessidade:** Validar com testes automatizados determinísticos a separação entre FPS solicitado/capturado/codificado-enviado/recebido/renderizado, a proibição de exibir FPS do preset como efetivo, a preferência de codecs H.264/VP9, os parâmetros de sender (`degradationPreference`, `scaleResolutionDownBy: 1`, rampa progressiva de bitrate) e a atualização de `contentHint` ao alternar para `1080p60`.
- **Correção:** Estender `tests/calls_and_streaming_v030.test.ts` com novos testes cobrindo todos esses cenários sem quebrar os testes existentes.
