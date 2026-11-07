# NEXUS v0.1.0 — Chamadas de Voz WebRTC, Histórico de Chamadas e DSP de Áudio

Bem-vindo ao primeiro release oficial do **NEXUS** (`v0.1.0`)! Esta versão traz o motor de chamadas de voz ponto a ponto via WebRTC sobre a malha privada do Tailscale, correção crítica de deadlock ao encerrar chamadas, sincronização visual de microfone mutado, histórico de chamadas persistente, processamento de sinal acústico (DSP) nativo em tempo real e sistema completo de atualizações automáticas integradas via GitHub Releases com verificação criptográfica Minisign.

---

### 🎙️ 1. Motor de Chamadas de Voz WebRTC & P2P Mesh (Tailscale)
- **Topologia P2P Mesh Criptografada**: Chamadas de voz 1:1 diretas utilizando **WebRTC (DTLS-SRTP)** com transporte de áudio protegido fim a fim.
- **Sinalização Segura via Axum Gateway**: Troca de ofertas, respostas (SDP) e candidatos ICE transmitida com autenticação via WebSocket Gateway existente no backend Rust.
- **Opus Codec**: Configurado para baixa latência e alta fidelidade de voz com bitrate dinâmico adaptativo.

---

### 🛠️ 2. Correções Críticas de Bugs
- **Deadlock e Congelamento de Tela ao Desligar Chamada**:
  - Resolvido o problema de reentrância em `CallService.cleanup()`.
  - Adicionada flag atômica de limpeza para evitar disparos em cascata de eventos `closed`.
  - Destruição de recursos WebRTC sem renotificar o peer quando a chamada já está sendo finalizada localmente.
  - Feedback visual imediato no botão de desligar com estado de clique responsivo e spinner de carregamento.
- **Sincronização Visual de Mute em Tempo Real**:
  - Implementado o evento `call.participant_muted` transmitido pelo gateway e sincronizado com o store global.
  - Quando qualquer um dos participantes silencia o microfone, ambos veem distintamente o selo de `Microfone Silenciado` e badge vermelho no avatar.
  - Botão de Mute na barra inferior agora destaca em vermelho de forma inequívoca quando o usuário está mutado.

---

### 🚀 3. Melhorias de Interface e Experiência (UI/UX)
- **Histórico Completo de Chamadas na Aba "Chamadas"**:
  - A aba lateral de Chamadas agora exibe o histórico organizado cronologicamente (chamadas efetuadas, recebidas, perdidas ou recusadas), com duração, carimbo de data/hora e botão de retorno rápido.
- **Repositório e Botão de Chamada Otimizado**:
  - O botão de iniciar chamada agora fica em destaque direto no cabeçalho da conversa em `Mensagens`, eliminando ambiguidades.
  - Adicionado componente `ActiveCallBar` persistente e flutuante no topo de todas as abas quando uma chamada está em andamento, permitindo navegar pelo app sem perder o controle da chamada.
- **Remoção de Placeholders e Dados Fictícios**:
  - Eliminados todos os mocks de comunidades e amigos fictícios.
  - Adicionados estados vazios elegantes (*empty states*) para amigos e servidores, garantindo que apenas dados reais sincronizados via Tailscale e backend apareçam.

---

### 🎛️ 4. Seleção Real de Dispositivos e DSP Acústico Nativo
- **Enumeração Real de Dispositivos de Áudio**:
  - Integração com `navigator.mediaDevices.enumerateDevices()` via `AudioDeviceService.ts`.
  - Detecção dinâmica de todos os microfones e alto-falantes conectados ao sistema operacional Windows.
  - Seleção de saída de som via `setSinkId()` (quando suportado pelo WebView2/dispositivo de áudio).
- **Processamento de Sinal Digital (DSP) WebRTC Nativo**:
  - **Cancelamento de Eco Acústico (AEC)** real ativado nas restrições de mídia.
  - **Supressão de Ruído (Noise Suppression)** ativa em hardware/DSP nativo.
  - **Controle Automático de Ganho (AGC)** para normalização de volume de voz.
  - **Medidor Acústico em Tempo Real** na tela de Configurações de Voz com indicador dinâmico de decibéis (dB) e feedback visual de fala.

---

### 🔄 5. Atualizador Automático Embutido (Tauri v2 + Minisign)
- Atualização em segundo plano sem necessidade de baixar um instalador manualmente.
- Validação criptográfica de binários com chaves públicas e assinaturas Ed25519/Minisign.
- O executável verifica `latest.json` diretamente neste release do GitHub e aplica os patches de forma transparente.

---

### 📦 Arquivos deste Release
| Arquivo | Descrição |
|---|---|
| `nexus-windows-x64.zip` | Pacote compactado do binário para atualização automática |
| `nexus-windows-x64.zip.sig` | Assinatura digital Minisign do pacote de atualização |
| `latest.json` | Manifesto do Tauri Updater com metadados e assinaturas |
| `nexus.exe` | Executável portátil standalone para instalação inicial |
