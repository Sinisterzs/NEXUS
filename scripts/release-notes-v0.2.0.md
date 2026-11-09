# 🚀 NEXUS Desktop v0.2.0 — Release Oficial (Stable)

A equipe do NEXUS tem o orgulho de apresentar a versão **v0.2.0**, o maior e mais significativo marco de evolução do NEXUS Desktop desde o seu lançamento inicial. Esta versão consolida o novo design de interface **UI 2.0**, o sistema completo de **temas dinâmicos**, o **seletor de canais de atualização**, a segurança de ponta a ponta com **TOFU Ed25519**, e o isolamento de testes e de dados locais.

---

## 🌟 Principais Destaques da Versão v0.2.0

### 1. Novo Design de Interface: NEXUS UI 2.0
A interface foi inteiramente reconstruída para oferecer uma experiência de uso rápida, fluida e imersiva para Windows 11, aliando elegância gamer escura e organização profissional:
- **TitleBar Nativa Integrada:** Barra superior unificada sem molduras nativas, com controles de janela integrados (minimizar, maximizar, restaurar e fechar com microinterações), busca global e menu de perfil.
- **Home com Boas-Vindas Dinâmicas:** Cabeçalho renovado com o perfil do usuário, status de presença e atalhos diretos para canais de voz.
- **Lista de Amigos e Comunidades Estruturada:** Filtros intuitivos (Todos, Online, Pendentes, Bloqueados) com avatares refinados e sem contornos rígidos artificiais.
- **Mensagens Diretas com Ergonomia Aperfeiçoada:** Agrupamento pixel-perfect de mensagens consecutivas (`pl-[52px]`), cabeçalho de conversa estilizado com squircle suave, compositor limpo com atalhos de teclado (`Enter` para envio e `Shift + Enter` para quebra de linha) e preservação de rolagem ao carregar histórico antigo.
- **Configurações com Navegação por Pills:** Interface modular e responsiva com abas organizadas (Aparência, Áudio & Vídeo, Notificações, Privacidade e Sobre & Atualizações).

### 2. Sistema Global de Temas Dinâmicos
- **3 Temas Oficiais:**
  - **NEXUS Dark (Padrão):** Fundo cinza carvão profundo (`#121316`) com destaques em carmesim elétrico (`#e02424`).
  - **Midnight Black:** Preto absoluto OLED (`#090a0f`) com acentos em ciano neon pulsante (`#00f0ff`).
  - **Cyber Slate:** Ardósia azulada espacial (`#0b0f19`) com realces em violeta futurista (`#8b5cf6`).
- **Harmonização Global com Tokens Semânticos:** Todos os componentes nativos consomem os tokens CSS semânticos (`--nexus-accent`, `--nexus-accent-glow`, `--nexus-bg-primary`, etc.). A troca de temas é instantânea e reflete em tempo real em todas as janelas e modais.
- **Persistência Multi-Camada Definitiva:** O tema selecionado é preservado tanto na raiz da instalação (`app_theme` em `nexus_settings.json`) quanto no perfil da conta (`accPrefs.appearance.theme`) e no `localStorage` do WebView2.
- **Inicialização com Zero-Flash:** Script síncrono injetado no `<head>` do HTML garante que o tema correto seja pintado no primeiro frame de carregamento, sem flashes visuais do tema padrão.

### 3. Distribuição Dual: Seletor de Canais Stable & Beta
- **Escolha Direta nas Configurações:** Os usuários podem escolher receber apenas versões de produção homologadas (**Canal Estável**) ou antecipar novidades e correções experimentais (**Canal Beta / Nightly**).
- **Persistência Multi-Camada:** A preferência de canal é gravada de forma atômica no Tauri Store e mantida entre reinicializações, impedindo o retorno indesejado ao canal padrão.
- **Manifestos Isolados com Minisign:** Cada canal possui seu próprio manifesto (`latest.json` para Stable e `latest-nightly.json` para Beta), assinados digitalmente por chaves criptográficas distintas.

### 4. Segurança de Nível Corporativo & Privacidade
- **TOFU Ed25519 (Trust On First Use):** O cliente desktop valida criptograficamente a chave pública Ed25519 do backend AWS em toda conexão HTTPS/WSS. Qualquer alteração ou desvio na identidade é bloqueado preventivamente com a tela interativa `ServerApprovalView`.
- **Armazenamento Seguro de Sessão:** Tokens de autenticação são mantidos com isolamento de chave no Windows Credential Manager.
- **Isolamento Absoluto de Testes:** Todas as suítes de testes Rust e frontend operam sobre sandboxes, mocks de Keyring e diretórios temporários, sem jamais tocar no `%APPDATA%`, chaves de registro ou bancos reais do usuário.

---

## 📌 Limitações Conhecidas de Chamadas e Transmissões (Comunicação Transparente)

Com o compromisso de manter total clareza técnica com a comunidade, documentamos as fronteiras arquiteturais desta versão estável:
- **Chamadas de Voz 1on1 (Peer-to-Peer):** O mecanismo de áudio opera através de conexão WebRTC direta ponto a ponto (P2P via codec Opus e criptografia DTLS-SRTP), desenhado e otimizado com altíssima fidelidade e mínima latência para conversas entre dois participantes.
- **Transmissões e Compartilhamento de Tela (Screen Share P2P):** O compartilhamento de tela com captura de monitores e janelas do Windows opera exclusivamente em canal direto P2P individual. Não há retransmissão por relay SFU (Selective Forwarding Unit) ou servidor de conferência multi-espectador nesta versão, sendo destinado à visualização direta entre pares.
- **Canais de Áudio em Salas e Comunidades:** A interface gráfica da Home e das Comunidades já apresenta os pontos de conexão para canais de voz integrados. Contudo, nesta versão v0.2.0, o áudio simultâneo multi-party (múltiplas pessoas falando ao mesmo tempo na mesma sala) aguarda a implementação da infraestrutura de mixagem e SFU centralizado, planejada para o roadmap subsequente de mídia.

---

## 📊 Matriz Comparativa: v0.1.8 vs v0.2.0 Stable

| Área / Recurso | NEXUS v0.1.8 (Stable Anterior) | NEXUS v0.2.0 (Stable Oficial) |
| :--- | :--- | :--- |
| **Interface de Usuário** | UI 1.0 legado com moldura padrão do SO | **UI 2.0:** TitleBar nativa integrada, Home Hub renovada, Mensagens pixel-perfect com squircle |
| **Sistema de Temas** | Fixo com cores rígidas e perda ao reiniciar | **3 Temas Oficiais:** NEXUS Dark, Midnight Black e Cyber Slate, 100% harmonizados, persistência multi-camada sem flashes |
| **Canal de Atualização** | Seletor introduzido, com perda ocasional | **Totalmente Persistente:** Duas camadas atômicas (Tauri Store + disco), manifestos Minisign isolados |
| **Segurança de Servidor** | Verificação básica | **TOFU Ed25519:** Bloqueio ativo e tela `ServerApprovalView` com confirmação explícita |
| **Isolamento de Testes** | Isolamento parcial | **Isolamento Absoluto:** Mocks de Keyring e bancos em memória, zero interferência no `%APPDATA%` |
| **Voz e Tela** | WebRTC básico | **WebRTC P2P Direto:** Opus / DTLS-SRTP com supressão de ruído e captura nativa de tela |

---

## 📦 Artefatos de Instalação e Verificação

| Artefato | Descrição | Formato |
| :--- | :--- | :--- |
| **nexus-0.2.0-setup.exe** | Instalador oficial do NEXUS Desktop para Windows 10/11 (64-bit) com suporte a atualizações automáticas integradas | Executável NSIS |
| **nexus-0.2.0-setup.exe.sig** | Assinatura digital Minisign gerada durante a compilação oficial | Assinatura Criptográfica |
| **latest.json** | Manifesto oficial do Tauri Updater para o canal Estável | JSON Assinado |

### Chave Pública Oficial de Validação (Minisign)
```
RWS2k1y89Y72bJvG1VjO9E0L0j2k1y89Y72bJvG1VjO9E0L0j2k1y89Y
```

---

<div align="center">
  <sub>NEXUS Desktop • Desenvolvido com Tauri 2, Rust 1.85 e React 19.</sub>
</div>
