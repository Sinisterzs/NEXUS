## NEXUS v0.3.0-nightly.3 — Integração Google Login & Pre-Login Auto Updater 0.1

Pré-lançamento para Windows (Canal Beta/Nightly). Publicação de teste fechado unificando melhorias de autenticação e atualizações automáticas pré-login.

### Principais Novidades e Correções

- **Pre-Login Auto Updater 0.1:** Verificação discreta e automática de novas versões antes do login e do carregamento do SQLite. Notificação com notas de lançamento e atualização silenciosa com `/UPDATE`.
- **Autenticação Google Robusta:** Tratamento seguro de contas existentes, mapeamento amigável de erros (conflitos de e-mail e vínculo de identidade) e proteção contra ataques de repetição via `nonce`.
- **Chamadas e Transmissão 2.1:** Estágio redimensionável, controles integrados na barra lateral, detecção de voz com persistência por conta e diagnósticos de mídia em tempo real.
- **Isolamento de Canais:** Atualizações no canal Beta/Nightly utilizam `latest-nightly.json` e nunca alteram nem forçam updates para usuários do canal Estável (`latest.json`).

### Notas de Instalação e Compatibilidade

- **Instalação Inicial:** Clientes em versões anteriores à `0.3.0-nightly.3` (que ainda não possuíam o Pre-Login Auto Updater) devem instalar esta versão manualmente executando o instalador `nexus_0.3.0-nightly.3_x64-setup.exe`.
- **Atualizações Subsequentes:** A partir desta compilação, o aplicativo atualizará automaticamente para futuras versões do canal configurado.
- **Canal Estável:** O canal Estável permanece em `0.2.1`. Esta compilação é estritamente experimental para o canal Beta.
