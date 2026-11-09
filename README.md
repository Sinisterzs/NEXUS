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
[![Release](https://img.shields.io/badge/Release-v0.1.8%20Stable-0f1117?style=flat-square&logo=github)](https://github.com/Sinisterzs/NEXUS/releases/tag/v0.1.8)
[![Candidate](https://img.shields.io/badge/Candidate-v0.2.0%20(Homologação)-e02424?style=flat-square)](https://github.com/Sinisterzs/NEXUS/tree/release/v0.2.0)

</div>

---

## 🧭 Visão Geral

O **NEXUS** é um aplicativo desktop de comunicação em tempo real desenvolvido especificamente para o ecossistema Windows 11. Combinando a robustez e eficiência do **Rust** com a reatividade do **React 19**, o NEXUS foi projetado para oferecer alta performance com consumo de recursos significativamente menor que clientes convencionais baseados em Electron.

Sua arquitetura foi desenhada em torno de três princípios fundamentais:
- **Desempenho Extremo:** Inicialização rápida, renderização acelerada por GPU via WebView2 e empacotamento nativo em Tauri 2.
- **Design Imersivo:** Estética escura refinada com detalhes em carmesim, transições sutis e três temas adaptativos oficiais.
- **Segurança Verificável:** Proteção criptográfica de endpoints com TOFU Ed25519, guarda de tokens no Windows Credential Manager e atualizações assinadas por Minisign.

---

## 📥 Downloads e Canais de Distribuição

O NEXUS conta com canais de distribuição oficiais gerenciados diretamente nas configurações do aplicativo:

| Canal | Versão | Status | Instalador Windows | Manifesto de Atualização |
| :--- | :---: | :---: | :--- | :--- |
| **Estável (Stable Atual)** | `v0.1.8` | Produção Homologada | [Download nexus-0.1.8-setup.exe](https://github.com/Sinisterzs/NEXUS/releases/download/v0.1.8/nexus-0.1.8-setup.exe) | [`latest.json`](https://github.com/Sinisterzs/NEXUS/releases/latest/download/latest.json) |
| **Pré-lançamento (Nightly / Beta)** | `v0.1.9-nightly.7` | Candidata à v0.2.0 | [Download v0.1.9-nightly.7](https://github.com/Sinisterzs/NEXUS/releases/download/v0.1.9-nightly.7/nexus-0.1.9-nightly.7-setup.exe) | [`latest-nightly.json`](https://github.com/Sinisterzs/NEXUS/releases/download/v0.1.9-nightly.7/latest-nightly.json) |
| **Próxima Estável (Em Preparação)** | **`v0.2.0`** | Homologação Final | *Aguardando publicação oficial* | *Promoverá latest.json para v0.2.0* |

> [!TIP]
> Você pode alternar entre os canais **Estável** e **Beta / Nightly** a qualquer momento em **Configurações → Sobre & Atualizações**. A preferência é gravada de forma persistente e o aplicativo notificará automaticamente sobre novos pacotes assinados.

---

## ⚡ Principais Funcionalidades

- 🚀 **Arquitetura Nativa Ultraleve:** Desenvolvido em Tauri 2 e Rust, consumindo significativamente menos recursos de memória e CPU que clientes de mensagens convencionais.
- 🎨 **Sistema Global de Temas Dinâmicos:** Suporte completo aos temas **NEXUS Dark**, **Midnight Black** e **Cyber Slate**, com aplicação instantânea e sem flashes brancos no carregamento.
- 🛡️ **Segurança TOFU Ed25519:** Verificação criptográfica automática do backend oficial na nuvem AWS, com bloqueio imediato e aprovação visual manual caso a chave do servidor mude.
- 🎙️ **Voz e Tela P2P de Baixa Latência:** Chamadas de áudio 1on1 de altíssima fidelidade com supressão de ruído Opus e compartilhamento de tela com criptografia DTLS-SRTP direta.
- 💾 **Histórico Local e Modo Offline:** Banco SQLite v3 local com escrita atômica (WAL), permitindo ler e redigir mensagens mesmo com perda temporária de conexão.
- 🔄 **Atualizador Automático com Minisign:** Pacotes de atualização NSIS verificados criptograficamente por chave pública oficial antes de qualquer execução no sistema operacional.

---

## 🖥️ Visão Geral da UI 2.0

A interface do NEXUS foi inteiramente reconstruída na versão **v0.2.0** com foco em ergonomia e foco visual:

```
┌────────────────────────────────────────────────────────────────────────┐
│  ⚡ NEXUS   [ 🔍 Buscar conversas, amigos ou comandos... ]   [-] [□] [✕] │
├──────┬────────────────────────────────┬────────────────────────────────┤
│      │  👋 Bem-vindo de volta!        │  Direct Message                │
│  🏠  │  ┌──────────────────────────┐  │  ┌──────────────────────────┐  │
│      │  │ kelzyx • Online           │  │  │ [Avatar] kelzyx         │  │
│  💬  │  │ 🎙️ Entrar no Canal Rápido │  │  │ Olá! Build v0.2.0 OK.    │  │
│      │  └──────────────────────────┘  │  └──────────────────────────┘  │
│  👥  │  AMIGOS ONLINE (4)             │                                │
│      │  • Alice   (Em chamada)        │  ┌──────────────────────────┐  │
│  ⚙️  │  • Bob     (Disponível)        │  │ Escreva uma mensagem...  │  │
│      │  • Carol   (Ausente)           │  └──────────────────────────┘  │
└──────┴────────────────────────────────┴────────────────────────────────┘
```

1. **TitleBar Nativa Integrada:** Barra superior contínua e sem bordas do Windows, com controle de janela nativo por comandos do Rust, campo de busca global e acesso rápido ao perfil.
2. **Home Hub & Boas-Vindas:** Painel inicial contextual com status em tempo real, canais de voz acessíveis em um clique e lista de amigos estruturada por abas (Todos, Online, Pendentes e Bloqueados).
3. **Mensagens Diretas Pixel-Perfect:** Histórico contínuo com agrupamento automático de mensagens sucessivas, preservação da posição de rolagem e compositor inferior com suporte a atalhos de envio (`Enter`) e nova linha (`Shift + Enter`).
4. **Configurações em Abas Tipo Pill:** Gestão limpa de dispositivos de áudio e vídeo, seleção instantânea de temas visuais e controle do canal de atualizações.

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
- Consulte o [**CHANGELOG.md**](file:///c:/Users/kelma/Documents/Tropa/CHANGELOG.md) para o resumo estruturado de versões.
- Leia o documento de [**Release Notes da v0.2.0**](file:///c:/Users/kelma/Documents/Tropa/scripts/release-notes-v0.2.0.md) com a análise profunda deste marco.
- Acesse a página oficial de [**Releases no GitHub**](https://github.com/Sinisterzs/NEXUS/releases) para baixar artefatos e instaladores anteriores.

---

<div align="center">
  <sub>NEXUS Desktop • Desenvolvido com excelência técnica para o ecossistema Windows.</sub>
</div>
