# NEXUS v0.1.6 — Transmissão de Tela P2P via WebRTC

A versão **v0.1.6** introduz a funcionalidade de transmissão de tela em tempo real entre participantes de chamadas 1:1, construída sobre a infraestrutura P2P consolidada do NEXUS.

---

### 🖥️ 1. Transmissão de Tela P2P em Tempo Real
- **Captura Nativa Flexível:** Suporte a seleção de monitores completos ou janelas individuais diretamente pelo seletor nativo do Windows e WebView2 (`DisplayCapture`).
- **Prévia Local em Tempo Real:** Visualização prévia da tela capturada diretamente na interface com indicação de status e taxa travada a 30 FPS.
- **Acoplamento P2P Direto:** A transmissão de vídeo utiliza a mesma conexão `RTCPeerConnection` da chamada de voz, sem tráfego de frames pelo servidor ou WebSocket de sinalização.

---

### ⚡ 2. WebRTC & Renegociação SDP Resiliente
- **Renegociação Sem Quedas:** A adição ou remoção de faixas de tela ocorre dinamicamente via `attachScreenTrack` e `detachScreenTrack`, sem interromper a chamada ou o áudio do microfone.
- **Padrão Perfect Negotiation:** Tratamento formal de colisões de sinalização (*Glare*) com `rollback` ordenado no peer cortês.
- **Qualidade e Economia de Banda:** Parâmetros otimizados para texto e janelas desktop com `maxBitrate: 2.5 Mbps`, `maxFramerate: 30 FPS` e `contentHint = 'detail'`.
- **Compatibilidade Retroativa:** Chamadas de voz iniciam puramente com `m=audio`, garantindo compatibilidade contínua com versões anteriores.

---

### 🎨 3. Visualizador Remoto Responsivo
- **Player Dinâmico:** O participante receptor visualiza a tela remota instantaneamente ao receber a renegociação, com badge pulsante "AO VIVO".
- **Modo Tela Cheia e Expansão:** Controles integrados de ampliação e ajuste de proporção.
- **Detecção de Pausa:** Overlay visual de pausa quando a transmissão é temporariamente suspensa pelo transmissor.

---

### 🛡️ 4. Segurança e Ciclo de Vida do Sistema
- **Permissão Transitória e Restrita:** A permissão nativa de captura no WebView2 é autorizada estritamente durante o diálogo de seleção nativo e revogada imediatamente ao término.
- **Sincronização Nativa com o Windows:** Ao parar o compartilhamento pela barra flutuante do Windows ou ao fechar a janela transmitida (`track.onended`), o encerramento é propagado ao peer remoto e a chamada retorna ao modo voz pura.
- **Limpeza Atômica:** Liberação de faixas locais e remotas no encerramento da chamada ou logout do usuário.
