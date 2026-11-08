# NEXUS v0.1.7 — Descoberta Automática no Tailscale e Persistência de Rede

A versão **v0.1.7** traz melhorias críticas de conectividade para redes privadas Tailscale, garantindo que o aplicativo cliente encontre, conecte e mantenha a sessão ativa com o servidor NEXUS automaticamente, sem necessidade de configuração manual ou perda de conexão após atualizações.

---

### 🌐 1. Descoberta Automática Segura no Tailscale
- **Plug-and-play na Tailnet Privada:** Se o host padrão não responder na inicialização, o cliente consulta a interface local do Tailscale e sonda de forma anônima os nós da rede privada (`100.64.0.0/10`).
- **Validação de Identidade do Servidor:** Apenas servidores que respondem com `service: nexus-server` e o cabeçalho `X-Nexus-Service: nexus-server` são aceitos.
- **Conexão Instantânea e Silenciosa:** O app se conecta ao servidor legítimo em milissegundos sem exibir telas de erro para o usuário.

---

### 💾 2. Persistência de Endereço de Rede no Disco
- **Armazenamento Permanente (`nexus_network.json`):** Qualquer endereço configurado manualmente ou descoberto com sucesso via Tailscale é gravado no disco do aplicativo (`%APPDATA%/com.nexus.desktop`).
- **Resiliência a Reinicializações e Atualizações:** Ao reiniciar o computador ou receber uma nova versão via auto-updater, o aplicativo inicia diretamente conectado ao IP correto, eliminando resets indesejados para o endereço local.

---

### 🔒 3. Migração Segura de Origem de Sessão
- **Reconexão Contínua de Tokens:** Sessões autenticadas existentes agora transitam de forma transparente entre nós autorizados da mesma rede Tailscale verificada, impedindo desconexões forçadas e eliminando a necessidade de refazer login após updates.
