## NEXUS v0.3.0-nightly.5 — Recuperação de Senha V2 (Bridge HTTPS, Gmail & Deep Link `nexus://`), Google Login & Pre-Login Auto Updater 0.1

Pré-lançamento para Windows (Canal Beta/Nightly). Evolução da linha 0.3.0 com a **Recuperação de Senha V2**, garantindo funcionamento completo em clientes de e-mail restritivos (como Gmail Web/Mobile) e integração direta com o aplicativo desktop aberto ou fechado, preservando integralmente Google Login, Chamadas e Transmissão 2.1 e Pre-Login Auto Updater 0.1.

### Principais Novidades e Correções

- **Recuperação de Senha V2 (Bridge HTTPS & Compatibilidade com Gmail):** Os e-mails de redefinição agora utilizam um link HTTPS clicável (`https://nexus-api.dynv6.net/reset-password#token=...`) compatível com o Gmail e demais provedores que bloqueiam esquemas customizados em botões de e-mail. O token viaja exclusivamente no fragmento `#token=` (nunca enviado em requisições HTTP ao servidor ou logs) e é imediatamente removido da barra de endereços via `history.replaceState`.
- **Página Bridge Segura (`/reset-password`) e Cópia Manual do Código:** A página intermediária valida o formato hexadecimal de 64 caracteres no navegador, aciona automaticamente a abertura do aplicativo via `nexus://reset-password?token=...`, oferece o botão **"Abrir no aplicativo NEXUS"** e exibe o código de recuperação completo com botão **"Copiar código de recuperação"** para colagem manual caso o usuário esteja em outro dispositivo.
- **Protocolo `nexus://` no Windows (App Aberto ou Fechado):** Registro automático do protocolo `nexus://` no instalador NSIS (`src-tauri/nsis/hooks.nsh`, com desinstalação segura que preserva outras instâncias) e em tempo de execução no perfil do usuário (`HKCU\Software\Classes\nexus`). Com o app fechado, o link inicia o NEXUS já na tela de redefinição; com o app aberto, a nova instância encaminha o token via IPC local (`127.0.0.1`) para a janela principal e a traz para o primeiro plano.
- **Pre-Login Auto Updater 0.1:** Verificação automática de novas versões antes do login e do carregamento do SQLite, com confirmação de changelog no canal Beta e aplicação silenciosa via `/UPDATE`.
- **Autenticação Google Robusta:** Tratamento seguro de contas existentes, atalho contextual para recuperação de senha em conflitos de e-mail e proteção contra ataques de repetição via `nonce`.
- **Chamadas e Transmissão 2.1:** Estágio redimensionável, controles integrados na barra lateral, detecção de voz com persistência por conta e diagnósticos de mídia em tempo real.
- **Isolamento de Canais:** Atualizações no canal Beta/Nightly utilizam exclusivamente `latest-nightly.json`, preservando o canal Estável (`latest.json`).

### Compatibilidade e Atualização

- **Atualização Automática Pré-Login (`nightly.3 / nightly.4 → nightly.5`):** Usuários nas compilações anteriores do canal Beta recebem a notificação da `v0.3.0-nightly.5` diretamente no Pre-Login Auto Updater logo na inicialização do aplicativo (ou pelo atualizador interno autenticado).
- **Preparação para a Stable `v0.2.5`:** Consolida o fluxo definitivo de Recuperação de Senha V2 junto aos subsistemas da linha `0.3.0`, sem interferir na `v0.2.1` atualmente publicada no canal Estável.
