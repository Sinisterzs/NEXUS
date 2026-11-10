# Changelog — NEXUS Desktop

Todas as alterações notáveis deste projeto serão documentadas neste arquivo.

O formato é baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e este projeto adere ao [Semantic Versioning](https://semver.org/lang/pt-BR/).

---

## [Unreleased]

---

## [0.2.1] — 2026-11-10

> [!NOTE]
> Esta versão de manutenção oficial (**Hotfix**) corrige de forma cirúrgica a classificação e exibição de versões no seletor de canais de atualização, eliminando falsos avisos de versão experimental e garantindo a separação estrita entre a versão instalada e o canal de atualização ativo.

### Corrigido
- **Classificação de Versão Instalada:** A versão local passa a ser classificada de forma estritamente imutável via análise SemVer (`isPrereleaseVersion`), não sendo mais alterada dinamicamente pelo resultado das consultas de rede dos canais.
- **Falso Alerta de "Versão Experimental":** Eliminado o comportamento incorreto onde uma versão Estável oficial (como a `v0.2.0`), ao consultar o canal Beta/Nightly cujo último build remoto era inferior, disparava erroneamente o alerta *"Versão Experimental em Execução"* e rotulava a versão remota como "estável".
- **Lógica Pura de Comparação de Canais (`resolveChannelVersionComparison`):** Introduzida função pura no `UpdateService` que trata de forma determinística os 4 cenários de comparação SemVer entre versões instaladas e manifestos remotos.
- **Mensagens Contextuais e Título Dinâmico:** O card de atualizações em Configurações agora exibe status amigável de versão atualizada quando a versão estável está à frente do canal Beta, preservando o aviso de downgrade apenas para cenários legítimos (compilação experimental com canal Estável ativo).
- **Exibição Condicional de Botões:** O botão *"Continuar recebendo Nightlies"* agora só é exibido quando uma versão experimental real estiver instalada e o canal Estável estiver selecionado.
- **Cobertura de Regressão Automatizada:** Nova suíte de testes cobrindo a matriz completa de 7 cenários SemVer de transição entre versões estáveis e pré-lançamentos nos canais Stable e Beta.

---

## [0.2.0] — 2026-11-09

> [!NOTE]
> Esta versão oficial consolida o marco do **Redesign UI 2.0**, **Harmonização e Persistência Global de Temas**, **Seletor de Canais de Atualização**, e **Segurança Criptográfica TOFU** para o canal de distribuição Estável (`latest.json`).

### Adicionado
- **NEXUS UI 2.0 Oficial:** Interface de usuário completamente redesenhada para Windows 11:
  - **TitleBar Nativa Integrada:** Barra superior sem bordas com controles nativos de janela (minimizar, maximizar, restaurar e fechar com microinterações suaves), busca global integrada e menu de perfil.
  - **Home Renovada:** Cabeçalho com o perfil ativo, status de presença e atalhos rápidos para canais de voz.
  - **Lista de Amigos Aprimorada:** Filtros intuitivos (Todos, Online, Pendentes, Bloqueados) com avatares dinâmicos sem molduras rígidas.
  - **Mensagens Diretas Pixel-Perfect:** Agrupamento contínuo de mensagens de mesmo remetente (`pl-[52px]`), cabeçalho de conversa estilizado e compositor com atalhos inteligentes (`Enter` para envio e `Shift + Enter` para quebra de linha).
  - **Preservação de Rolagem:** Carregamento fluido do histórico antigo de mensagens preservando a posição visual do usuário.
  - **Configurações em Abas Tipo Pill:** Navegação intuitiva entre Aparência, Áudio & Vídeo, Notificações, Privacidade e Sobre & Atualizações.
- **Sistema Global de Temas com Zero-Flash:**
  - 3 temas nativos elegantes: **NEXUS Dark** (carmesim `#B8495A`), **Midnight Black** (azul elétrico `#3b82f6`) e **Cyber Slate** (ciano tecnológico `#06b6d4`).
  - Harmonização com tokens CSS semânticos em 100% dos botões, ícones, seleções e estados de hover/foco.
  - Persistência multi-camada em disco (`app_theme` em `nexus_settings.json` e `nexus_theme` no `localStorage`).
  - Script síncrono no `<head>` do HTML que elimina completamente flashes do tema padrão ao inicializar.
- **Seletor de Canais de Atualização (Stable & Beta):**
  - Opção no menu Sobre & Atualizações permitindo ao usuário alternar entre o canal **Estável (Padrão)** e o canal **Beta / Nightly**.
  - Persistência protegida contra reinicializações e manifestos isolados assinados com Minisign (`latest.json` e `latest-nightly.json`).
- **Segurança Criptográfica TOFU Ed25519:**
  - Validação de integridade da chave pública do servidor AWS em conexões HTTPS/WSS.
  - Tela interativa `ServerApprovalView` para confirmação manual explícita pelo usuário caso ocorra alteração na identidade do servidor remoto.
  - Armazenamento de credenciais de sessão isolado no Windows Credential Manager.

### Corrigido
- Persistência do canal de atualização que retornava ao padrão após reiniciar o aplicativo.
- Perda do tema selecionado após cold restart do aplicativo ou restauração de sessão.
- Borda quadrada vermelha rígida ao redor de avatares na Home e na TitleBar, substituída por acabamento suave com glow sutil.
- Isolamento estrito de testes em Rust para proteger dados reais de usuário no `%APPDATA%`, chaves do registro e credenciais do Windows Keyring.

### Limitações Conhecidas (Comunicação Transparente)
- **Chamadas de Voz:** Operam exclusivamente em conexão direta ponto a ponto (WebRTC Opus / DTLS-SRTP 1on1).
- **Transmissão de Tela (Screen Share):** Limitada a 720p a 30fps (`max: 30` fps) em conexão direta P2P sem retransmissão por relay SFU.
- **Áudio do Sistema na Transmissão:** O compartilhamento de tela não inclui captura do áudio interno do sistema operacional (captura exclusivamente a faixa do microfone).
- **Processamento de Áudio:** Cancelamento de eco e supressão de ruído habilitados via flags do WebRTC/WebView2, porém ainda não formalmente calibrados ou validados em testes com múltiplos dispositivos de microfone físicos.
- **Modo Tela Cheia (Fullscreen):** Devido à TitleBar customizada sem molduras nativas do SO, a alternância de tela cheia possui limitações de interação com a barra de tarefas do Windows e em múltiplos monitores com diferentes escalas de DPI.
- **Áudio em Salas e Comunidades:** Canais de voz em salas comunitárias funcionam como atalhos para comunicação direta, sem roteamento SFU centralizado para conferências multi-party simultâneas nesta versão estável.

---

## [0.1.9-nightly.7] — 2026-11-09

### Corrigido
- **Persistência Global de Temas:** Resolvido o problema em que o aplicativo retornava ao tema padrão após ser fechado e reaberto. Implementada persistência em nível de instalação (`app_theme` na raiz do `nexus_settings.json` e `nexus_theme` no `localStorage`).
- **Hidratação de Configurações na Autenticação:** A função `createAuthenticatedState()` no `useAppStore` agora recebe e hidrata adequadamente as preferências da conta ativa (`appearance`, `audioVideo`, `notifications`, `privacy`), eliminando o descarte do tema salvo após o login ou restauração de sessão.
- **Eliminação de Flash no Início:** Inserido script síncrono no `<head>` do `index.html` e `getInitialTheme()` no Zustand para aplicação imediata do atributo `data-theme` no primeiro frame de pintura do WebView2.

### Adicionado
- Suíte completa de testes automatizados de persistência de temas ([`tests/theme_persistence.test.ts`](tests/theme_persistence.test.ts)) cobrindo os 3 temas e reinicializações simuladas.
- Documento de Release Notes da Nightly.7 ([`scripts/release-notes-v0.1.9-nightly.7.md`](scripts/release-notes-v0.1.9-nightly.7.md)).

---

## [0.1.9-nightly.6] — 2026-11-09

### Adicionado
- Documento de Release Notes rico em Markdown (`scripts/release-notes-v0.1.9-nightly.6.md`).
- Workflow aprimorado no GitHub Actions para publicar Release Notes formatadas na página de releases, mantendo o manifesto do updater conciso.
- Testes automatizados de persistência multi-camada de canais (`tests/update_channel_persistence.test.ts`).

### Corrigido
- **Persistência do Canal de Atualização:** Corrigido bug em que a seleção Beta/Nightly retornava para Stable após reiniciar o aplicativo. Implementada persistência em duas camadas (Tauri Store + `nexus_update_channel`).
- **Harmonização de Temas:** Eliminadas cores hardcoded em componentes da UI 2.0; todos os botões, ícones, seleções e gradientes agora consomem os tokens semânticos `--nexus-accent` e reagem instantaneamente.
- **Borda Rígida do Avatar:** Removido o contorno quadrado artificial ao redor da foto de perfil na Home e na TitleBar, substituído por um glow suave dinâmico adaptado ao tema.

---

## [0.1.9-nightly.5] — 2026-11-09

### Segurança
- **Isolamento Estrito de Testes:** Impedido permanentemente que testes de integração Rust acessem pastas reais do AppData, chaves do Windows Credential Manager ou chaves de registro do host.
- **TOFU Ed25519 com Aprovação Visual:** Implementada tela interativa `ServerApprovalView` para confirmação explícita do usuário caso a identidade do servidor seja alterada.
- **Remoção de Referências Legadas:** Atualizados botões de interface para indicar conexão segura HTTPS oficial.

---

## [0.1.9-nightly.4] — 2026-11-09

### Adicionado
- **UI 2.0D (Polimento Final):** Alinhamento pixel-perfect de mensagens consecutivas (`pl-[52px]`), cabeçalho de conversa estilizado com squircle e botões de chamada com microinterações.
- Preservação da posição de rolagem (`scroll preservation`) ao carregar mensagens anteriores do histórico de conversas.
- Navegação de abas internas em Configurações alinhada à estética da Sidebar.

---

## [0.1.9-nightly.3] — 2026-11-09

### Adicionado
- **UI 2.0C (Redesign de Mensagens):** Nova lista de conversas com seleção elegante, prévias e avatares reais.
- Compositor inferior simplificado e focado, com atalhos de envio (`Enter` e `Shift + Enter`).

---

## [0.1.9-nightly.2] — 2026-11-09

### Adicionado
- **UI 2.0B.1 (Refinamento da Home):** Reconstrução do banner de boas-vindas com o Arco Celestial dinâmico, lista de amigos categorizada e canais de áudio instantâneos.

---

## [0.1.9-nightly.1] — 2026-11-09

### Adicionado
- **UI 2.0A (TitleBar e Shell):** TitleBar moderna sem bordas nativas com controles personalizados de janela (minimizar, maximizar, restaurar e fechar).

---

## [0.1.8] — 2026-11-09 (Stable Atual)

### Adicionado
- **Seletor de Canais (Stable vs Beta):** Possibilidade de alternar canais de atualização diretamente nas configurações.
- **Autenticação Obrigatória:** Validação de login com sessões seguras no Windows Credential Manager.

---

## [0.1.7] — 2026-11-08

### Adicionado
- **Descoberta Automática no Tailscale:** Conexão automática a nós da malha privada com validação de cabeçalhos de serviço.
- **Persistência de Rede:** Gravação de endereço ativo em `nexus_network.json` no AppData.

---

## [0.1.6] — 2026-11-08

### Adicionado
- **Transmissão de Tela P2P via WebRTC:** Suporte a compartilhamento de tela ponto a ponto de baixa latência.

---

## [0.1.5] — 2026-11-07

### Adicionado
- Chamadas de voz 1on1 de ultra baixa latência com codec Opus e negociação DTLS-SRTP.
- Migrações atômicas de banco de dados SQLite local v2 para v3 com backup prévio.

---

## [0.1.0] a [0.1.4] — 2026-11-07

- Lançamento inicial da fundação do NEXUS Desktop com Tauri 2, Rust, React 19 e PostgreSQL.
