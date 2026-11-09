# 🚀 NEXUS Desktop v0.2.0 — Release Oficial (Stable)

A equipe do NEXUS apresenta a versão **v0.2.0**, consolidando o novo design de interface **UI 2.0**, a harmonização e persistência global de **temas**, o **seletor de canais de atualização**, a segurança de ponta a ponta com **TOFU Ed25519**, e o isolamento estrito de testes e de dados locais.

---

## 🌟 Principais Destaques da Versão v0.2.0

### 1. Novo Design de Interface: NEXUS UI 2.0
A interface foi reconstruída com foco em usabilidade e organização para Windows 11:
- **TitleBar Nativa Integrada:** Barra superior unificada sem molduras nativas do SO, com controles de janela integrados (minimizar, maximizar, restaurar e fechar com microinterações), busca global e menu de perfil.
- **Home com Boas-Vindas Dinâmicas:** Cabeçalho com dados de perfil do usuário, status de presença em tempo real e atalhos diretos para canais de voz.
- **Lista de Amigos e Comunidades Estruturada:** Filtros intuitivos (Todos, Online, Pendentes, Bloqueados) com avatares refinados e sem contornos rígidos artificiais.
- **Mensagens Diretas Aperfeiçoadas:** Agrupamento contínuo de mensagens sucessivas do mesmo remetente (`pl-[52px]`), cabeçalho de conversa estilizado com squircle suave, compositor limpo com atalhos de teclado (`Enter` para envio e `Shift + Enter` para quebra de linha) e preservação de rolagem ao carregar histórico antigo.
- **Configurações com Navegação por Pills:** Interface modular e responsiva com abas organizadas (Aparência, Áudio & Vídeo, Notificações, Privacidade e Sobre & Atualizações).

### 2. Sistema Global de Temas Dinâmicos
- **3 Temas Oficiais Harmonizados:**
  - **NEXUS Dark (Padrão):** Fundo cinza carvão (`#111318`), superfície (`#1B1E25`) e acento carmesim (`#B8495A`, hover `#cf5668`).
  - **Midnight Black:** Fundo preto profundo OLED (`#090a0e`), superfície (`#101217`) e acento **Azul elétrico** (`#3b82f6`, hover `#60a5fa`).
  - **Cyber Slate:** Fundo ardósia escura (`#0b0f14`), superfície (`#121820`) e acento **Ciano tecnológico** (`#06b6d4`, hover `#22d3ee`).
- **Harmonização Global com Tokens Semânticos:** Todos os componentes nativos consomem os tokens CSS semânticos (`--nexus-accent`, `--nexus-accent-hover`, `--nexus-bg`, `--nexus-surface`, etc.). A troca de temas é instantânea e reflete em tempo real em todas as janelas e modais.
- **Persistência Multi-Camada Definitiva:** O tema selecionado é preservado tanto na raiz da instalação (`app_theme` em `nexus_settings.json`) quanto no perfil da conta (`preferences:${accountId}.theme`) e no `localStorage` do WebView2.
- **Inicialização com Zero-Flash:** Script síncrono injetado no `<head>` do HTML garante que o tema correto seja pintado no primeiro frame de carregamento, eliminando flashes visuais do tema padrão.

### 3. Distribuição Dual: Seletor de Canais Stable & Beta
- **Escolha Direta nas Configurações:** Os usuários podem escolher receber apenas versões de produção homologadas (**Canal Estável**) ou antecipar novidades e correções experimentais (**Canal Beta / Nightly**).
- **Persistência Multi-Camada:** A preferência de canal é gravada de forma atômica no Tauri Store e mantida entre reinicializações, impedindo o retorno indesejado ao canal padrão.
- **Manifestos Isolados com Minisign:** Cada canal possui seu próprio manifesto (`latest.json` para Stable e `latest-nightly.json` para Beta), assinados digitalmente por chaves criptográficas distintas.

### 4. Segurança Criptográfica & Isolamento de Dados
- **TOFU Ed25519 (Trust On First Use):** O cliente desktop valida criptograficamente a chave pública Ed25519 do backend AWS em toda conexão HTTPS/WSS. Qualquer alteração ou desvio na identidade é bloqueado preventivamente com a tela interativa `ServerApprovalView`.
- **Armazenamento Seguro de Sessão:** Tokens de autenticação são mantidos com isolamento de chave no Windows Credential Manager.
- **Isolamento Absoluto de Testes:** Todas as suítes de testes Rust e frontend operam sobre sandboxes, mocks de Keyring e diretórios temporários, sem jamais tocar no `%APPDATA%`, chaves de registro ou bancos reais do usuário.

---

## 📌 Limitações Reais de Mídia e Janela (Comunicação Transparente)

Para clareza técnica com a comunidade, documentamos as fronteiras arquiteturais desta versão estável:
- **Chamadas de Voz 1on1 (Peer-to-Peer):** O mecanismo de áudio opera através de conexão WebRTC direta ponto a ponto (P2P via codec Opus e criptografia DTLS-SRTP), otimizado para conversas entre dois participantes.
- **Transmissão de Tela (Screen Share P2P a 720p30):** O compartilhamento de tela com captura de monitores e janelas do Windows está configurado para resolução de 720p a 30fps (`frameRate: { max: 30 }`). Opera exclusivamente em canal direto P2P individual, sem relay SFU (Selective Forwarding Unit) ou servidor de conferência para múltiplos espectadores simultâneos.
- **Ausência de Áudio do Sistema na Transmissão:** O compartilhamento de tela não inclui captura do áudio interno do computador (`audio: false`), transmitindo unicamente a faixa do microfone do usuário.
- **Cancelamento de Eco e Supressão de Ruído:** Embora as opções de processamento de áudio estejam habilitadas no WebRTC, o cancelamento de eco e a supressão de ruído ainda não foram validados em testes formais com múltiplos hardwares físicos de microfone.
- **Modo Tela Cheia (Fullscreen):** Devido ao uso de uma TitleBar totalmente personalizada e sem molduras nativas do sistema operacional, a transição para tela cheia apresenta limitações conhecidas com a sobreposição da barra de tarefas do Windows e em configurações com múltiplos monitores com escalas de DPI divergentes.
- **Áudio em Salas e Comunidades:** A interface já apresenta os atalhos para os canais de áudio integrados, porém conferências simultâneas com múltiplos participantes na mesma sala (multi-party) ainda não utilizam servidor SFU centralizado nesta versão estável.

---

## 📊 Matriz Comparativa: v0.1.8 vs v0.2.0 Stable

| Área / Recurso | NEXUS v0.1.8 (Stable Anterior) | NEXUS v0.2.0 (Stable Oficial) |
| :--- | :--- | :--- |
| **Interface de Usuário** | UI 1.0 legado com moldura padrão do SO | **UI 2.0:** TitleBar nativa integrada, Home Hub renovada, Mensagens pixel-perfect com squircle |
| **Sistema de Temas** | Fixo com cores rígidas e perda ao reiniciar | **3 Temas Oficiais:** NEXUS Dark (carmesim), Midnight Black (azul elétrico), Cyber Slate (ciano), persistência multi-camada sem flashes |
| **Canal de Atualização** | Seletor introduzido, com perda ocasional | **Totalmente Persistente:** Duas camadas atômicas (Tauri Store + disco), manifestos Minisign isolados |
| **Segurança de Servidor** | Verificação básica | **TOFU Ed25519:** Bloqueio ativo e tela `ServerApprovalView` com confirmação explícita |
| **Isolamento de Testes** | Isolamento parcial | **Isolamento Absoluto:** Mocks de Keyring e bancos em memória, zero interferência no `%APPDATA%` |
| **Voz e Tela** | WebRTC básico | **WebRTC P2P Direto:** 1on1 Opus / DTLS-SRTP e captura de tela em 720p30 sem áudio do sistema |

---

## 📦 Artefatos de Instalação e Verificação

| Artefato | Descrição | Formato |
| :--- | :--- | :--- |
| **nexus_0.2.0_x64-setup.exe** | Instalador oficial do NEXUS Desktop para Windows 10/11 (64-bit) com suporte a atualizações automáticas integradas | Executável NSIS |
| **nexus_0.2.0_x64-setup.exe.sig** | Assinatura digital Minisign gerada durante a compilação oficial | Assinatura Criptográfica |
| **latest.json** | Manifesto oficial do Tauri Updater para o canal Estável | JSON Assinado |

### Chave Pública Oficial de Validação (Minisign)
Chave pública oficial configurada no updater nativo do aplicativo (`src-tauri/tauri.conf.json`):
```
RWSD5/ox8A8dk+NW9lqVAMuCKxJvH9kzKpUxCk1SmABC7b4+8zd5cfHf
```

---

<div align="center">
  <sub>NEXUS Desktop • Desenvolvido com Tauri 2, Rust 1.85 e React 19.</sub>
</div>
