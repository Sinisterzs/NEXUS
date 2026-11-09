# NEXUS v0.1.9-nightly.6 — Consolidação da UI 2.0, Persistência de Canais e Temas Globais

A versão pré-lançamento **v0.1.9-nightly.6** consolida todas as melhorias visuais do redesign **UI 2.0**, resolve problemas críticos de persistência de canais de atualização e unifica o sistema de temas em todos os componentes da aplicação, preparando o caminho para a próxima versão estável **v0.2.0**.

---

### 🎨 1. Harmonização Global de Temas na UI 2.0
- **Tokens Semânticos Dinâmicos:** Todas as cores fixas e hardcoded introduzidas nas telas reconstruídas foram substituídas por tokens semânticos (`--nexus-accent`, `--nexus-accent-hover`, `--nexus-accent-dim`).
- **Alternância Instantânea sem Recarregar:** A troca entre os três temas oficiais (**NEXUS Dark** com Carmesim, **Midnight Black** com Azul Steam e **Cyber Slate** com Ciano Opera GX) reflete de imediato em toda a interface:
  - Arco celestial da Home e swoosh da TitleBar.
  - Pills ativas de navegação na Sidebar principal e Configurações.
  - Indicadores de unread, seleções na lista de conversas, botões primários e foco do compositor de mensagens.
- **Preservação Semântica:** Acentos de status funcional (Verde Esmeralda para presença online e Vermelho para ações destrutivas) foram rigorosamente mantidos.

---

### 👤 2. Avatar com Glow Suave e Remoção de Borda Rígida
- **Eliminação de Bordas Sólidas:** Removidos anéis, outlines e contornos rígidos (`ring-1 ring-rose-500/60`, `border-zinc-700/60`) que geravam uma moldura quadrada artificial ao redor da foto de perfil.
- **Glow Difuso Elegante:** Implementada iluminação externa difusa (`shadow-[0_0_16px_var(--nexus-accent-dim)]`) que absorve a tonalidade do tema selecionado.
- **Preservação de Identidade:** Foto original de alta resolução, squircle suave e indicador de status verde com anel de contraste `ring-2 ring-nexus-surface` 100% preservados.

---

### 🔄 3. Persistência Definitiva do Canal de Atualização (Stable / Beta)
- **Persistência Multi-Camada Confiável:** Implementada persistência síncrona em duas camadas no `SettingsRepository`: plugin-store nativo do Tauri acompanhado de fallback isolado em armazenamento local (`nexus_update_channel`).
- **Ciclo de Inicialização Confiável:** A escolha do canal Beta/Nightly não é mais perdida ao fechar ou reiniciar o NEXUS. O aplicativo carrega o canal salvo antes de inicializar o verificador de atualizações.
- **Isolamento de Manifestos:** O canal **Stable** consome exclusivamente `latest.json`, enquanto o canal **Beta** consulta `latest-nightly.json`.
- **Experiência Limpa:** O banner informativo que sugere "Continuar recebendo Nightlies" é automaticamente suprimido quando o canal Beta está intencionalmente ativo.

---

### 🛡️ 4. Segurança Criptográfica e Isolamento de Testes
- **Aprovação Interativa de Identidade (TOFU Ed25519):** Conexão HTTPS com o servidor de produção na AWS protegida por verificação de chave pública. Qualquer alteração de identidade exige aprovação explícita e manual do usuário pela interface (`ServerApprovalView`).
- **Isolamento Absoluto de Testes Automatizados:** Testes de integração em Rust e rotinas de validação utilizam diretórios temporários e mock em memória para o Windows Credential Manager / Keyring, garantindo que credenciais reais, tokens e o registro do Windows jamais sejam acessados ou sobrescritos durante suítes de teste.

---

### 📦 5. Informações da Release e Atualização
- **Canal de Distribuição:** `Beta / Nightly` (`latest-nightly.json`)
- **Canal Estável Vigente:** `v0.1.8` (`latest.json`) — Não modificado
- **Instalador Windows:** `nexus_0.1.9-nightly.6_x64-setup.exe` (NSIS assinado digitalmente com Minisign)
