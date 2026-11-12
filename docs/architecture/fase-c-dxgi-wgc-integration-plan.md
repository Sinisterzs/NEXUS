# Fase C — Plano de Integração do Capturador Nativo Windows (DXGI + WGC)

**Branch de referência:** `feat/v0.4.0-phase-a-foundation`  
**Objetivo:** Substituir a dependência exclusiva de `navigator.mediaDevices.getDisplayMedia()` no desktop Windows pelo capturador nativo validado em `.nexus-lab/capture-prototype/` (**DXGI Desktop Duplication** para monitores + **Windows Graphics Capture** para janelas), eliminando overlays flutuantes próprios, evitando a borda amarela quando suportado pelo Windows, mantendo **`1080p60` gratuito** e preservando compatibilidade total com `MeshRoomService` (salas multipessoa) e chamadas 1:1 (`CallService` / `WebRtcService`).

---

## 1. Diagnóstico do Estado Atual vs. Protótipo Validado

### 1.1 Limitações do Fluxo Atual (`src/services/ScreenCaptureService.ts`)
- Hoje, `ScreenCaptureService` utiliza `navigator.mediaDevices.getDisplayMedia()` dentro do WebView2.
- Consequências observadas nos benchmarks anteriores (`docs/architecture/v0.4.0-frente1-frente2-media-plan.md`):
  - O seletor de fontes é controlado pelo diálogo genérico do navegador/WebView2.
  - O encoding de vídeo no WebView2 cai para `OpenH264` em CPU (`gpuEnc = 0%`).
  - Exige gerenciamento de avisos/estados extras (`captureNotice`, `qualityFallbackNotice`) e consentimento via IPC (`screen_set_capture_consent` / `screen_get_capture_consent` em `src-tauri/src/lib.rs`).
- Consumidores atuais que precisam continuar funcionando sem regressão:
  - **Salas de Voz Multipessoa:** `src/services/MeshRoomService.ts` (`startScreenShare`, `stopScreenShare`, `setScreenShareQuality`, `attachVideoTrackToPeer`, `remoteVideoStreams`).
  - **Chamadas 1:1:** `src/services/CallService.ts` e `src/services/WebRtcService.ts`.

### 1.2 O Que Já Foi Provado no Protótipo (`.nexus-lab/capture-prototype/`)
O diretório `.nexus-lab/capture-prototype/p2p-native/` e `native-bench/` já validaram em Rust (`windows = "0.62.2"`, `webrtc = "0.17.3"`) os seguintes componentes:

1. **Enumeração Nativa (`p2p-native/src/selector.rs`):**
   - `enumerate_all_sources()` lista:
     - `MonitorInfo`: `hmonitor_raw`, `device_name`, `friendly_name`, resolução, coordenadas, `dpi_x`/`dpi_y`, `scale_factor`, `is_primary`, e metadados HDR via `IDXGIOutput6`.
     - `WindowInfo`: `hwnd_raw`, `title`, `pid`, `process_name`, dimensões e `is_minimized`, filtrando janelas ocultas (`DWMWA_CLOAKED`) e `WS_EX_TOOLWINDOW`.
2. **Captura Nativa Híbrida (`p2p-native/src/capture_source.rs`):**
   - **Monitores (`DxgiCapturer`):** usa `IDXGIOutputDuplication` (`DXGI Desktop Duplication`), tratando `DXGI_ERROR_WAIT_TIMEOUT` e `DXGI_ERROR_ACCESS_LOST` com recriação do duplicador. **Não gera borda amarela do Windows.**
   - **Janelas (`WgcCapturer`):** usa `Direct3D11CaptureFramePool::CreateFreeThreaded` + `IGraphicsCaptureItemInterop::CreateForWindow` (com fallback `CreateForMonitor`).
   - **Remoção de Borda Amarela (comprovado em `bench-wgc.stdout.txt`):**
     - Solicita `GraphicsCaptureAccess::RequestAccessAsync(GraphicsCaptureAccessKind::Borderless)` -> `Allowed`.
     - **Detalhe crítico descoberto no benchmark:** chamar `session.SetIsBorderRequired(false)` **antes** de `session.StartCapture()` retornou `HRESULT 0x80070490` ("Elemento não encontrado"), enquanto chamar **após** `session.StartCapture()` retornou `Ok(())` com `IsBorderRequired() == false` e `yellow_detected == false`. O `WgcCapturer` já tenta antes e depois, registrando `borderless_ok = border_before || border_after`.
3. **Conversão GPU + Encode Hardware Zero-Copy (`p2p-native/src/mf_encoder.rs`):**
   - `GpuBgraToNv12` + `MfH264Encoder` via `IMFDXGIDeviceManager` (`AMDh264Encoder` medido em `1080p60` com `CPU = 0.72%`, `TOTAL_CAP_TO_NALU avg = 5.81 ms`, `p95 = 7.18 ms`, `bitrate = 5011.5 kbps`).
4. **Áudio por Processo (`p2p-native/src/wasapi_loopback.rs`):**
   - Captura WASAPI Process Loopback (`IncludeTargetProcessTree` / `ExcludeTargetProcessTree`) para capturar áudio apenas da janela/jogo compartilhado sem eco dos colegas.
5. **Transporte WebRTC Nativo (`p2p-native/src/webrtc_sender.rs`):**
   - `webrtc-rs` (`0.17.3`) com `TrackLocalStaticSample`, `MIME_TYPE_H264` e tratamento de PLI/FIR para keyframes.

---

## 2. Decisões Arquiteturais para a Integração no NEXUS

### 2.1 Modelo Dual-Stream (Sem Quebrar Voz Atual)
- **Voz (Microfone / VAD / Volume 0..200% / Mute / Deafen):** continua no WebView2 (`MeshRoomService` e `WebRtcService`), preservando AEC3/NS/AGC, `GainNode`, `setSinkId` e troca de dispositivos.
- **Screen Share (Vídeo + Áudio da Janela/Sistema):** passa a ser capturado, convertido para NV12 e codificado **1 única vez na GPU** (*Encode Once*) dentro do processo Rust (`src-tauri`), enviando os pacotes RTP H.264/Opus diretamente aos peers via `webrtc-rs` usando os mesmos servidores ICE/TURN de `/v1/webrtc/ice-servers`.
- **Receptor no WebView2:** continua renderizando `<video>` HTML5 padrão dentro de `VoiceRoomPanel.tsx` e `CallsView`, aproveitando a decodificação por hardware do Edge/D3D11.

### 2.2 Política de Seleção de Backend e Zero Overlays
1. **Monitor -> `DXGI Desktop Duplication` (`DxgiMonitor`):**
   - Primeira escolha para compartilhamento de tela inteira (zero borda amarela nativa, latência mínima).
   - Fallback automático para `WgcMonitor` caso `DXGI_ERROR_UNSUPPORTED` ou ambiente híbrido/remoto impeça duplicação DXGI.
2. **Janela -> `Windows Graphics Capture` (`WgcWindow`):**
   - Usa `WgcCapturer` com `RequestAccessAsync(Borderless)` + `SetIsBorderRequired(false)` após `StartCapture()`.
   - Quando a API não for suportada (builds antigos do Windows 10 anteriores à 2104 / build 20348), expõe `borderless_ok: false` no estado da captura sem falhar a transmissão.
3. **Zero Overlays Flutuantes Próprios:**
   - **Não** criar janelas transparentes *always-on-top* (overlays) sobre o monitor ou janela capturada.
   - O feedback de "Transmitindo ao vivo" e o seletor de fontes vivem exclusivamente dentro da interface principal do NEXUS (React) e na barra compacta de voz.
4. **`1080p60` Gratuito Preservado:**
   - Manter os presets gratuitos já expostos em `ScreenCaptureService.ts` e `MeshRoomService.ts`: `auto`, `720p30`, `720p60` (quando aplicável), `1080p30` e `1080p60` (`5_000_000 bps`), sem gating de plano/assinatura.

### 2.3 Compatibilidade com `MeshRoomService` e Chamadas 1:1
- Introduzir uma abstração fina no frontend (`CaptureBackendKind = 'native_windows_dxgi_wgc' | 'browser_get_display_media'`):
  - **Em Tauri Windows (`__TAURI_INTERNALS__` + Windows):** `ScreenCaptureService` oferece a lista nativa via `invoke('native_list_capture_sources')` e delega o início/parada/troca de qualidade para o transporte nativo em Rust.
  - **Em Browser / Dev Web / Outros SOs:** mantém `navigator.mediaDevices.getDisplayMedia()` transparente como fallback.
- **Sinalização:**
  - **Salas Multipessoa (`MeshRoomService`):** o transmissor nativo em Rust replica os NALUs H.264 codificados uma única vez para até 3 peers (`N - 1`), negociando SDP/ICE pelo mesmo canal WebSocket do Gateway (`room_webrtc_offer` / `answer` / `ice_candidate` com identificador de fluxo `screen` ou conexão dedicada).
  - **Chamadas 1:1 (`CallService` / `WebRtcService`):** consome a mesma sessão nativa `native_start_screen_share` para o único peer remoto da chamada, preservando a API pública de `CallService.startScreenShare(preset)` e `stopScreenShare()`.

---

## 3. Plano de Execução por Etapas (Milestones)

### Etapa C1 — Módulo `capture` no `src-tauri` e Comandos IPC
- **Arquivos alvo:** `src-tauri/Cargo.toml`, `src-tauri/src/lib.rs`, novo módulo `src-tauri/src/capture/` (`mod.rs`, `selector.rs`, `dxgi_wgc.rs`, `mf_encoder.rs`, `wasapi_loopback.rs`, `webrtc_sender.rs`).
- **Ações:**
  1. Adicionar dependências `windows = "0.62"` (features DXGI/D3D11/WGC/MediaFoundation/WASAPI) e `webrtc = "0.17"` sob `[target.'cfg(target_os = "windows")'.dependencies]` em `src-tauri/Cargo.toml` para manter builds Linux/macOS compilando com stub limpo.
  2. Expor comandos Tauri:
     - `native_list_capture_sources() -> CaptureSources` (monitores + janelas).
     - `native_start_screen_share(target, preset, options) -> NativeCaptureStatus` (retornando `borderless_ok`, `encoder_name`, `backend_used`).
     - `native_stop_screen_share() -> ()`.
     - `native_set_screen_quality(preset) -> ()` (ajuste dinâmico de bitrate/FPS sem reiniciar captura).
  3. Garantir teardown limpo ao fechar a janela ou encerrar chamada (`Drop` + cancelamento de threads D3D11/MF).

### Etapa C2 — Seletor Integrado na UI e Remoção de Overlays
- **Arquivos alvo:** `src/services/ScreenCaptureService.ts`, novo componente `src/components/ScreenSourcePickerModal.tsx` (integrado na UI do app), `src/features/communities/VoiceRoomPanel.tsx`, `src/features/calls/CallsView.tsx`.
- **Ações:**
  1. Quando em Tauri Windows, abrir o seletor integrado do NEXUS exibindo **Monitores** (com indicação de primário/resolução/HDR) e **Janelas** (título + processo), além do seletor de qualidade (`Auto`, `720p30`, `1080p30`, `1080p60`) e toggle de áudio do aplicativo.
  2. Eliminar `captureNotice` / qualquer instrução dependente de overlay flutuante no desktop.
  3. Manter `getDisplayMedia()` apenas como fallback automático em ambiente web puro.

### Etapa C3 — Integração com `MeshRoomService` (Salas) e `WebRtcService` (1:1)
- **Arquivos alvo:** `src/services/MeshRoomService.ts`, `src/services/WebRtcService.ts`, `src/services/CallService.ts`, `nexus-server/src/handlers/ws.rs` (se necessário diferenciar `stream_kind` na sinalização).
- **Ações:**
  1. Conectar os eventos ICE/SDP do `webrtc_sender.rs` (Tauri events <-> frontend <-> Gateway WS) reutilizando `/v1/webrtc/ice-servers` (STUN + TURN).
  2. Validar **Encode Once -> N-1 Peers** em sala de 4 participantes e **2 transmissões simultâneas** na mesma sala.
  3. Validar chamadas 1:1 com troca de janela/monitor sem derrubar o áudio de voz.
  4. Aplicar fator de conservação de bitrate (`0.75x`) quando `candidateType === 'relay'` for detectado via `getStats()`.

### Etapa C4 — Matriz de Homologação de Campo (Windows)
- Testar obrigatoriamente antes de release:
  1. **GPUs:** AMD (AMF `AMDh264Encoder`), NVIDIA (NVENC), Intel (QSV) e fallback software (`H264 Encoder MFT`).
  2. **Jogos 3D em tela cheia / Borderless** rodando simultaneamente com `1080p60` (medir GPU VideoEncode%, queda de FPS no jogo, latência ponta-a-ponta).
  3. **Verificação visual de borda:** confirmar ausência de borda amarela em `DXGI` (monitores) e em `WGC` (janelas no Windows 11 / Windows 10 2104+), e ausência de qualquer overlay flutuante do NEXUS.
  4. **WAN real (2+ PCs):** validar estabilidade com 4 participantes e 2 screen shares simultâneos em redes distintas e via TURN relay.

---

## 4. Critérios de Aceite da Fase C

- [ ] Seletor nativo lista monitores e janelas reais no Windows sem abrir diálogo do WebView2.
- [ ] Captura de monitor usa `DXGI Desktop Duplication` (com fallback `WGC`) sem borda amarela.
- [ ] Captura de janela usa `WGC` com `SetIsBorderRequired(false)` aplicado após `StartCapture()`.
- [ ] Nenhum overlay flutuante próprio é criado pelo NEXUS durante a transmissão.
- [ ] Preset `1080p60` gratuito funcional com encode em hardware (`CPU < 2%` no transmissor para encode/captura) e *Encode Once* em salas de até 4 participantes.
- [ ] Compatibilidade preservada com `MeshRoomService` (salas de voz + 2 screen shares simultâneos) e `CallService` / `WebRtcService` (chamadas 1:1), mantendo fallback `getDisplayMedia()` no navegador.
