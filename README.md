<div align="center">

# NEXUS

**A modern, high-performance desktop communication platform for Windows.**  
*Projetado com arquitetura nativa ultraleve, criptografia de ponta a ponta e interface imersiva.*

[![Tauri 2](https://img.shields.io/badge/Tauri-2.0-0f1117?style=flat-square&logo=tauri&logoColor=24C8DB)](https://tauri.app)
[![Rust](https://img.shields.io/badge/Rust-1.85-0f1117?style=flat-square&logo=rust&logoColor=DEA584)](https://www.rust-lang.org)
[![React 19](https://img.shields.io/badge/React-19.0-0f1117?style=flat-square&logo=react&logoColor=61DAFB)](https://react.dev)
[![Tailwind CSS 4](https://img.shields.io/badge/Tailwind-4.0-0f1117?style=flat-square&logo=tailwindcss&logoColor=38B2AC)](https://tailwindcss.com)
[![WebRTC](https://img.shields.io/badge/WebRTC-DTLS--SRTP-0f1117?style=flat-square&logo=webrtc&logoColor=E02424)](https://webrtc.org)
[![Windows 11](https://img.shields.io/badge/Windows-10%20%2F%2011%20x64-0f1117?style=flat-square&logo=windows11&logoColor=0078D4)](https://www.microsoft.com/windows)
[![Release](https://img.shields.io/badge/Release-v0.2.0%20Stable-e02424?style=flat-square&logo=github)](https://github.com/Sinisterzs/NEXUS/releases/tag/v0.2.0)
[![Nightly](https://img.shields.io/badge/Nightly-v0.1.9--nightly.7-0f1117?style=flat-square&logo=github)](https://github.com/Sinisterzs/NEXUS/releases/tag/v0.1.9-nightly.7)

</div>

---

## 🧭 Visão Geral

O **NEXUS** é um aplicativo desktop de comunicação em tempo real desenvolvido especificamente para o ecossistema Windows 11. Combinando a robustez do **Rust** com a agilidade do **React 19**, o NEXUS foi projetado para oferecer baixo consumo de recursos de memória e CPU quando comparado a soluções de mensagens baseadas em Electron.

Sua arquitetura é fundamentada em três pilares:
- **Eficiência Nativa:** Renderização acelerada por GPU via WebView2 e empacotamento nativo com Tauri 2.
- **Design Imersivo:** Estética escura refinada com três temas adaptativos oficiais harmonizados por tokens semânticos.
- **Segurança Verificável:** Proteção criptográfica de endpoints com TOFU Ed25519, armazenamento seguro de tokens no Windows Credential Manager e atualizações assinadas por Minisign.

---

## 📥 Downloads e Canais de Distribuição

O NEXUS conta com canais de distribuição oficiais gerenciados diretamente nas configurações do aplicativo:

| Canal | Versão | Status | Instalador Windows | Manifesto de Atualização |
| :--- | :---: | :---: | :--- | :--- |
| **Estável (Stable Oficial)** | **`v0.2.0`** | Produção Homologada | [**Download nexus_0.2.0_x64-setup.exe**](https://github.com/Sinisterzs/NEXUS/releases/download/v0.2.0/nexus_0.2.0_x64-setup.exe) | [`latest.json`](https://github.com/Sinisterzs/NEXUS/releases/latest/download/latest.json) |
| **Pré-lançamento (Nightly / Beta)** | `v0.1.9-nightly.7` | Candidata Anterior | [Download nexus_0.1.9-nightly.7_x64-setup.exe](https://github.com/Sinisterzs/NEXUS/releases/download/v0.1.9-nightly.7/nexus_0.1.9-nightly.7_x64-setup.exe) | [`latest-nightly.json`](https://github.com/Sinisterzs/NEXUS/releases/download/v0.1.9-nightly.7/latest-nightly.json) |

> [!TIP]
> Você pode alternar entre os canais **Estável** e **Beta / Nightly** a qualquer momento em **Configurações → Sobre & Atualizações**. A preferência é gravada de forma persistente e o aplicativo notificará automaticamente sobre novos pacotes assinados.

---

## ⚡ Principais Funcionalidades

- 🚀 **Arquitetura Nativa:** Desenvolvido em Tauri 2 e Rust, consumindo significativamente menos recursos que clientes de mensagens convencionais.
- 🎨 **Sistema Global de Temas Dinâmicos:** Suporte completo aos temas **NEXUS Dark** (carmesim), **Midnight Black** (azul elétrico) e **Cyber Slate** (ciano), com aplicação instantânea e sem flashes brancos no carregamento.
- 🛡️ **Segurança TOFU Ed25519:** Verificação criptográfica automática do backend oficial na nuvem AWS, com bloqueio preventivo e aprovação visual manual via `ServerApprovalView`.
- 🎙️ **Voz e Tela P2P Diretos:** Chamadas de áudio 1on1 com codec Opus e compartilhamento de tela com criptografia DTLS-SRTP direta.
- 💾 **Histórico Local e Modo Offline:** Banco SQLite v3 local com escrita atômica (WAL), permitindo ler e redigir mensagens mesmo com perda temporária de conexão.
- 🔄 **Atualizador Automático com Minisign:** Pacotes de atualização NSIS verificados criptograficamente por chave pública oficial antes da instalação.

---

## 🖥️ Visão Geral da UI 2.0

A interface do NEXUS foi inteiramente reconstruída na versão **v0.2.0** com organização em três áreas estruturadas:

- **TitleBar Nativa Integrada:** Barra superior contínua e sem bordas nativas do Windows, com controles de janela nativos (minimizar, maximizar, restaurar e fechar), campo de busca global e menu de perfil.
- **Sidebar & Home Hub:** Barra lateral de navegação rápida e painel inicial contextual com status em tempo real, canais de voz acessíveis em um clique e lista de amigos estruturada por abas (Todos, Online, Pendentes e Bloqueados).
- **Mensagens Diretas Pixel-Perfect:** Histórico contínuo com agrupamento automático de mensagens sucessivas (`pl-[52px]`), cabeçalho de conversa estilizado com squircle suave, preservação de rolagem e compositor com suporte a atalhos de envio (`Enter`) e nova linha (`Shift + Enter`).
- **Configurações em Abas Tipo Pill:** Gestão modular de dispositivos de áudio e vídeo, seleção instantânea de temas visuais e controle do canal de atualizações.

---

## 📌 Limitações Conhecidas de Mídia e Janela

- **Chamadas de Voz:** Operam em conexão direta ponto a ponto (WebRTC Opus / DTLS-SRTP 1on1). Canais de voz em salas comunitárias funcionam como atalhos para chamadas diretas; conferências simultâneas com múltiplos participantes na mesma sala (multi-party) ainda não utilizam servidor SFU centralizado nesta versão estável.
- **Transmissão de Tela (Screen Share):** Limitada a 720p a 30fps (`max: 30` fps) em canal direto P2P individual, sem relay SFU ou retransmissão para múltiplos espectadores simultâneos.
- **Áudio do Sistema na Transmissão:** O compartilhamento de tela não inclui áudio interno do sistema operacional (captura exclusivamente a faixa do microfone).
- **Processamento de Áudio:** Cancelamento de eco e supressão de ruído utilizam flags nativas do WebRTC/WebView2, porém ainda não foram formalmente calibrados em testes com múltiplos dispositivos físicos de microfone.
- **Modo Tela Cheia (Fullscreen):** Devido ao uso de uma TitleBar personalizada sem molduras nativas do SO, a alternância de tela cheia possui particularidades de sobreposição da barra de tarefas do Windows e em configurações com múltiplos monitores com escalas de DPI divergentes.

---

## 🏗️ Arquitetura do Sistema

```mermaid
flowchart TD
    subgraph Cliente Windows ["Cliente Windows 11 (Tauri 2 + WebView2)"]
        UI["Interface UI 2.0 (React 19 + Tailwind CSS 4)"]
        Store["Gerenciador de Estado (Zustand 5)"]
        Media["Mídia WebRTC (Opus / DTLS-SRTP)"]
        DB[("SQLite v3 Local (Histórico & Cache)")]
        Keyring["Windows Credential Manager (Tokens)"]
        Updater["Auto-Updater Nativo (Minisign)"]

        UI --> Store
        UI --> Media
        Store --> DB
        Store --> Keyring
    end

    subgraph Nuvem AWS ["Infraestrutura Nuvem (AWS Cloud)"]
        Caddy["Proxy Reverso Caddy (TLS / HTTPS / WSS)"]
        Gateway["Gateway WebSocket (Axum / Tokio)"]
        API["Serviço REST (Axum)"]
        CloudDB[(PostgreSQL 16 Multi-Tenant)]

        Caddy --> Gateway
        Caddy --> API
        API --- CloudDB
        Gateway --- API
    end

    subgraph Rede P2P ["Comunicação Direta P2P"]
        Media <-->|Áudio e Tela P2P Criptografados| Peer["Outro Cliente NEXUS"]
    end

    Store <-->|HTTPS / WSS Seguro (TOFU Ed25519)| Caddy
    Updater <-->|Verificação de Manifesto e Setup| GitHub["GitHub Releases"]
```

### Tecnologias Utilizadas

| Componente | Tecnologia | Finalidade |
| :--- | :--- | :--- |
| **Core Desktop** | [Tauri 2](https://tauri.app) + [Rust 1.85](https://www.rust-lang.org) | Execução nativa segura com baixo consumo de memória |
| **Camada de Apresentação**| [React 19](https://react.dev) + [TypeScript](https://www.typescriptlang.org) | Interface moderna, desacoplada e fortemente tipada |
| **Estilização** | [Tailwind CSS 4](https://tailwindcss.com) | Tokens de design semânticos dinâmicos para troca instantânea de temas |
| **Mídia e Chamadas** | WebRTC + Codec Opus | Transmissão ponto a ponto de áudio e compartilhamento de tela |
| **Backend de Rede** | [Axum](https://github.com/tokio-rs/axum) + [Tokio](https://tokio.rs) | Servidor assíncrono em Rust para presença, DMs e sinalização |
| **Banco Nuvem** | [PostgreSQL 16](https://www.postgresql.org) | Armazenamento relacional com isolamento multi-tenant |
| **Banco Local** | SQLite v3 com WAL | Armazenamento seguro de conversas locais e cache offline |
| **Criptografia** | Ed25519 + Minisign | Validação de endpoints e assinatura digital de executáveis |

---

## 🛠️ Instalação e Desenvolvimento

### Pré-requisitos
- **Sistema Operacional:** Windows 10 ou 11 (64-bit)
- **Node.js:** Versão 20+ ou 22 LTS
- **Rust Toolchain:** Versão 1.85+ (alvo `x86_64-pc-windows-msvc`)

### 1. Clonar o Repositório
```bash
git clone https://github.com/Sinisterzs/NEXUS.git
cd NEXUS
```

### 2. Instalar Dependências
```bash
npm install
```

### 3. Executar em Modo de Desenvolvimento
```bash
# Inicia a interface com Vite Hot-Module-Replacement (HMR) e Tauri
npm run desktop:dev
```

### 4. Executar os Testes Automatizados
```bash
# Testes de persistência de temas, canais e metadados de versão
npm test

# Testes nativos em Rust (executados com isolamento estrito de sandbox)
cargo test --manifest-path src-tauri/Cargo.toml
```

### 5. Compilar o Pacote de Produção
```bash
# Compila o frontend tipado e gera o executável nativo
npm run build
```

---

## 🔒 Segurança e Privacidade

- **Criptografia de Credenciais:** O NEXUS nunca armazena senhas ou tokens de sessão em arquivos de texto aberto. Toda credencial é gravada com segurança de hardware no Windows Credential Manager.
- **Validação TOFU (Trust On First Use):** O cliente desktop valida a chave pública Ed25519 da API remota da AWS em cada handshake. Qualquer tentativa de interceptação ou redirecionamento de tráfego dispara a tela `ServerApprovalView`, exigindo consentimento explícito do usuário.
- **Assinatura Digital com Minisign:** Todo instalador e atualização de versão é assinado criptograficamente antes da distribuição. O atualizador nativo do Tauri rejeita qualquer binário cuja assinatura não coincida com a chave pública oficial do projeto.
- **Isolamento Completo em Testes:** As suítes automatizadas de testes e rotinas de validação de ambiente utilizam exclusivamente bancos SQLite temporários em memória e mocks de credenciais, sem jamais interagir com as pastas reais de dados do usuário em `%APPDATA%`.

---

## 📜 Histórico de Versões e Changelog

Para conferir o histórico completo de lançamentos, migrações e notas detalhadas de cada atualização:
- Consulte o [**CHANGELOG.md**](CHANGELOG.md) para o resumo estruturado de versões.
- Leia o documento de [**Release Notes da v0.2.0**](scripts/release-notes-v0.2.0.md) com a análise profunda deste marco.
- Acesse a página oficial de [**Releases no GitHub**](https://github.com/Sinisterzs/NEXUS/releases) para baixar artefatos e instaladores anteriores.

---

<div align="center">
  <sub>NEXUS Desktop • Desenvolvido com excelência técnica para o ecossistema Windows.</sub>
</div>
