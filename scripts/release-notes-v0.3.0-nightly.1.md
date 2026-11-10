# NEXUS v0.3.0-nightly.1 — Calls & Streaming 2.0 (Beta / Nightly)

A compilação **v0.3.0-nightly.1** inaugura a série **0.3.x** no canal **Beta / Nightly**, trazendo o pacote integrado **Calls & Streaming 2.0** com melhorias profundas em áudio em tempo real, compartilhamento de tela configurável, interface de chamada redimensionável com tela cheia nativa, reconexão controlada via ICE Restart e telemetria WebRTC sob demanda.

---

### 🎙️ 1. Áudio 2.0

- **Troca Dinâmica (*Hot-Swap*) em Chamada:** Seletor rápido integrado diretamente à dock da chamada para alternar microfone e saída de áudio (`setSinkId`) em tempo real via `RTCRtpSender.replaceTrack`, sem desconectar a sessão WebRTC.
- **Fallback Automático por Desconexão Física:** Monitoramento combinado de `track.onended` e `navigator.mediaDevices.ondevicechange`. Caso o microfone ou headset ativo seja desconectado durante a chamada, o NEXUS migra automaticamente para o dispositivo padrão do Windows e exibe um aviso discreto.
- **Volume Individual por Participante (`0%` a `200%`):** Controle deslizante dedicado no card do participante remoto com persistência local por contato, combinando atenuação (`0–100%`) e amplificação limpa via `GainNode` da Web Audio API (`101–200%`).
- **Controles DSP WebRTC & VAD Calibrado:** Suporte explícito e persistido para **Cancelamento de Eco (AEC)**, **Supressão de Ruído (NS)** e **Controle Automático de Ganho (AGC)**, além de limiar de atividade de voz (VAD) acoplado dinamicamente à sensibilidade configurada pelo usuário.

---

### 🖥️ 2. Compartilhamento de Tela 2.0

- **Perfis de Qualidade Selecionáveis:** Suporte aos presets **Automático**, **720p • 30 FPS**, **1080p • 30 FPS** e **1080p • 60 FPS**, aplicáveis antes de iniciar ou ao vivo durante a transmissão (`videoTrack.applyConstraints` + `RTCRtpSender.setParameters` para `maxBitrate` e `maxFramerate`).
- **Fallback Automático de Hardware:** Caso a fonte capturada rejeite o modo solicitado (`OverconstrainedError`), o serviço recua automaticamente para `720p • 30 FPS` sem interromper a chamada e informa a resolução/FPS efetivos reais (`track.getSettings()`).
- **Continuidade entre Abas:** Corrigido o ciclo de vida da visualização de chamadas para que navegar até a aba **Mensagens** mantenha a transmissão de tela ativa, com controles rápidos na barra flutuante (`ActiveCallBar`).

---

### 🎬 3. Calls UI 2.0 & Tela Cheia Real

- **Palco Redimensionável (Splitter):** Divisor horizontal arrastável (`30%` a `85%`) entre o palco de vídeo e os cards dos participantes, acompanhado de atalhos rápidos de proporção (**Compacto 45%**, **Equilibrado 65%** e **Cinema 80%**) com persistência automática.
- **Modo Tela Cheia Nativo:** Integração combinada da DOM Fullscreen API com a API nativa de janela do Tauri 2 (`setFullscreen`), incluindo barra de controles flutuantes em tela cheia e saída limpa via tecla `Esc`.

---

### 🔄 4. Estabilidade WebRTC & Diagnósticos de Mídia

- **Reconexão Controlada com ICE Restart:** Quando ocorrem oscilações temporárias de rede, o motor entra em estado `Reconectando (1/3)...`, aplica *backoff* exponencial e dispara ofertas de **ICE Restart** (`createOffer({ iceRestart: true })`) para recuperar o transporte de mídia sem derrubar prematuramente a chamada.
- **Painel de Diagnósticos Sob Demanda:** Novo botão **Diagnósticos** no cabeçalho da chamada (com custo zero de CPU quando fechado), exibindo estado ICE, rota de rede (`tailscale-cg-nat` / `lan-or-reflexive`), RTT de transporte (ida e volta), Jitter (ms), perda de pacotes (`%`), bitrate de áudio/vídeo (`kbps`) e resolução/FPS efetivos.

---

### 📦 5. Informações do Canal Beta / Nightly

- **Canal:** `Beta / Nightly` (`latest-nightly.json`)
- **Versão:** `0.3.0-nightly.1`
- **Canal Estável Vigente:** `v0.2.1 Stable` (`latest.json`) — **100% preservado sem alterações.**
- **Assinatura:** Minisign com verificação criptográfica estrita no atualizador nativo.
