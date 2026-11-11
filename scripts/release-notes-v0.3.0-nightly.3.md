## NEXUS v0.3.0-nightly.3 — Integração Google Login & Pre-Login Auto Updater 0.1

Pré-lançamento para Windows (Canal Beta/Nightly). Publicação de teste fechado unificando melhorias de autenticação e atualizações automáticas pré-login.

### Principais Novidades e Correções

- **Pre-Login Auto Updater 0.1:** Verificação discreta e automática de novas versões antes do login e do carregamento do SQLite. Notificação com notas de lançamento e atualização silenciosa com `/UPDATE`.
- **Autenticação Google Robusta:** Tratamento seguro de contas existentes, mapeamento amigável de erros (conflitos de e-mail e vínculo de identidade) e proteção contra ataques de repetição via `nonce`.
- **Chamadas e Transmissão 2.1:** Estágio redimensionável, controles integrados na barra lateral, detecção de voz com persistência por conta e diagnósticos de mídia em tempo real.
- **Isolamento de Canais:** Atualizações no canal Beta/Nightly utilizam `latest-nightly.json` e nunca alteram nem forçam updates para usuários do canal Estável (`latest.json`).

### Compatibilidade e Atualização a partir da Nightly 2

- **Atualização Direta no App (Canal Beta):** Usuários autenticados no NEXUS `v0.3.0-nightly.2` com o canal Beta ativo recebem a notificação da `v0.3.0-nightly.3` pelo atualizador interno e podem atualizar diretamente dentro do aplicativo.
- **Novo Fluxo Pré-Login:** O mecanismo de verificação pré-login entra em vigor imediatamente após a atualização para a `v0.3.0-nightly.3`, passando a atuar logo na inicialização para todas as versões futuras.
- **Instalação Manual como Alternativa:** Caso o atualizador interno apresente falhas ou haja preferência por instalação direta, o instalador independente assinado (`nexus_0.3.0-nightly.3_x64-setup.exe`) permanece disponível como alternativa.
- **Canal Estável Preservado:** A versão oficial do canal Estável permanece em `0.2.1`. Esta compilação é estritamente experimental para o canal Beta.
