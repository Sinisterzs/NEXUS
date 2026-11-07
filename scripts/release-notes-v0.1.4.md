# NEXUS v0.1.4 — Correção Crítica de Negociação WebRTC e Resiliência de Conexões Concorrentes

Esta versão resolve a falha `"Falha ao negociar conexão de áudio"` que ocorria ao atender chamadas com múltiplas conexões ou eventos de sinalização duplicados, além de aprimorar a idempotência do motor WebRTC e o gerenciamento de sockets do Gateway.

---

### 🎙️ 1. Correção de Negociação de Chamadas WebRTC
- **Idempotência de SDP Offers e Answers:**
  - `handleOffer` agora identifica quando uma mesma oferta SDP já foi aplicada e reusa a `answer` pré-existente sem lançar `InvalidStateError`.
  - Tratamento defensivo de transições de estado para `have-remote-offer` e `have-local-offer`.
- **Filtro Estrito de Instância Ativa (`CallService`):**
  - Ofertas e candidatos ICE são consumidos unicamente pela sessão que atendeu a chamada (`voiceCallState === 'connecting' || 'connected'`).
  - Prevenção de término acidental de chamadas: sessões secundárias ou conexões inativas descartam ofertas sem disparar encerramento forçado da chamada.
  - Implementada trava contra processamento concorrente (`isProcessingOffer`).
- **Servidores STUN Redundantes:**
  - Inclusão dos servidores oficiais `stun1.l.google.com:19302` e `stun2.l.google.com:19302` além do primário para maior confiabilidade de reflexivos NAT.

---

### 🔌 2. Higienização de Conexões e Gateway Sockets
- **Desanexação Prévia de Handlers no Gateway:**
  - O cliente agora desconecta e neutraliza os eventos (`onclose`, `onerror`, `onmessage`, `onopen`) do socket anterior antes de fechar a conexão, impedindo a criação de conexões zumbis em background durante reconexões.
- **Sincronização Multi-Sessão no Servidor:**
  - Quando o usuário atende uma chamada, o backend envia `call.accepted_by_user` para as demais conexões do destinatário, fechando instantaneamente o alerta de toque sem interferir na sessão ativa.

---

### 📥 Arquivos deste Release
| Arquivo | Descrição |
|---|---|
| `nexus_0.1.4_x64-setup.exe` | Instalador assistido e pacote de atualização automática para Windows |
| `nexus_0.1.4_x64-setup.exe.sig` | Assinatura digital Minisign do instalador |
| `latest.json` | Manifesto do Tauri Auto-Updater |
| `nexus.exe` | Executável portátil para Windows |
