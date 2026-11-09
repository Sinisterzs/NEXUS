# Changelog — NEXUS Desktop

Todas as alterações notáveis deste projeto serão documentadas neste arquivo.

O formato é baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e este projeto adere ao [Semantic Versioning](https://semver.org/lang/pt-BR/).

---

## [Unreleased] — Futura Versão Estável v0.2.0 (Planejada)

> [!NOTE]
> Esta versão consolida o marco do **Redesign UI 2.0** para o canal estável (`latest.json`). Não está publicada ainda.

### Recursos Previstos para a v0.2.0 Stable
- **UI 2.0 Estável:** Nova TitleBar nativa integrada com controle de janela, busca global, Home renovada com perfil ativo e canais de voz integrados, e tela de Mensagens de alta ergonomia.
- **Harmonização de Temas:** Aplicação dos três temas oficiais (NEXUS Dark, Midnight Black, Cyber Slate) em todos os componentes nativos.
- **Seletor de Canais Integrado:** Escolha flexível entre canal Estável (padrão de produção) e Beta (recebimento antecipado de nightlies).
- **Conectividade de Alta Disponibilidade:** Conexão primária HTTPS/WSS com o cluster AWS e descoberta secundária resiliente via Tailscale Mesh P2P.
- **Segurança TOFU Ed25519:** Verificação criptográfica de integridade de endpoints e isolamento local de credenciais.

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
