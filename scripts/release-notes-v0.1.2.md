# NEXUS v0.1.2 — Correção de Deadlock de Presença, Carregamento Instantâneo de DMs e Auto-Updater Nativo

Esta atualização resolve o problema crítico de bloqueio que fazia a lista de amigos desaparecer e as conversas ficarem carregando indefinidamente, além de aprimorar a estabilidade da camada de rede e o pipeline do instalador de atualização automática.

---

### 🚀 1. Correção Crítica de Deadlock de Conexões e Presença
- **Eliminação de Deadlock no Backend (`PresenceManager`):**
  - Identificada e corrigida uma contenção mútua de locks assíncronos (`connections.write()` vs `live_presence.read()`).
  - Chamadas de banco de dados e serialização de rede foram completamente extraídas dos blocos de exclusão mútua (`RwLock`).
  - O processamento de `/v1/friends` e `/v1/dm/conversations` agora é executado em tempo sub-milissegundo (< 10ms) sem bloquear novas conexões do WebSocket Gateway.
- **Fim do "Carregando conversas..." infinito:**
  - A interface do NEXUS não trava mais ao inicializar conversas diretas, exibindo o histórico de mensagens e amigos imediatamente.

---

### 🛡️ 2. Timeouts Defensivos na Ponte Nativa (Rust / Tauri)
- **Proteção contra Hangs na Interface:**
  - Adicionados timeouts estritos de 8 segundos em todas as requisições HTTP do cliente Tauri (`src-tauri/src/friends.rs` e `src-tauri/src/dm.rs`).
  - Caso haja oscilação de rede ou queda de servidor, o app não congela a interface do usuário e responde com tratamento de erro ou fallback seguro de dados locais em SQLite.

---

### 👥 3. Sincronização e Navegação Reativa de Amigos
- **Carregamento Automático ao Autenticar:**
  - A tela inicial (`HomeView`) agora monitora o estado de autenticação e dispara a sincronização de amigos e solicitações assim que o login é confirmado ou a rede reconecta.
- **Abertura Direta de Conversas:**
  - Clicar sobre um amigo na lista da aba Início agora inicia/abre a conversa direta real na aba de mensagens, selecionando-a automaticamente.

---

### 📦 4. Auto-Updater e Instalador Windows NSIS
- **Instalador NSIS Assinado:**
  - O manifesto do auto-updater (`latest.json`) agora referencia diretamente o instalador compilado `nexus_0.1.2_x64-setup.exe` com assinatura Minisign válida e confiável.
- **Manifesto UTF-8 sem BOM:**
  - Garantida codificação estrita sem BOM para total compatibilidade com o parser de JSON do Tauri 2 Updater.

---

### 📥 Arquivos deste Release
| Arquivo | Descrição |
|---|---|
| `nexus_0.1.2_x64-setup.exe` | Instalador assistido e pacote de atualização automática para Windows |
| `nexus_0.1.2_x64-setup.exe.sig` | Assinatura digital Minisign do instalador |
| `latest.json` | Manifesto de verificação automática de updates do Tauri |
| `nexus.exe` | Executável standalone portátil para Windows |
