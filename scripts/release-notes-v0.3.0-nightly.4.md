## NEXUS v0.3.0-nightly.4 — Integração Completa (Recuperação de Senha, Google Login & Pre-Login Auto Updater 0.1)

Pré-lançamento para Windows (Canal Beta/Nightly). Versão de validação completa unificando todas as funcionalidades da linha 0.3.0 (Chamadas e Transmissão 2.1, Pre-Login Auto Updater 0.1 e Google Login) com o novo fluxo de recuperação de senha por e-mail.

### Principais Novidades e Correções

- **Recuperação de Senha por E-mail:** Fluxo completo ("Esqueci minha senha") integrado à tela de autenticação do app desktop, com tokens temporários de uso único (256 bits, hash SHA-256 em banco, validade de 15 minutos), resposta neutra contra enumeração de contas, revogação imediata de sessões anteriores e suporte a criação de senha local para contas originalmente criadas via Google sem remover o vínculo OAuth.
- **Pre-Login Auto Updater 0.1:** Verificação automática de novas versões antes do login e do carregamento do SQLite, com confirmação de changelog no canal Beta e aplicação silenciosa via `/UPDATE`.
- **Autenticação Google Robusta:** Tratamento seguro de contas existentes, mapeamento amigável de erros de conflito de identidade e proteção contra ataques de repetição via `nonce`.
- **Chamadas e Transmissão 2.1:** Estágio redimensionável, controles integrados na barra lateral, detecção de voz com persistência por conta e diagnósticos de mídia em tempo real.
- **Isolamento de Canais:** Atualizações no canal Beta/Nightly utilizam exclusivamente `latest-nightly.json`, preservando o canal Estável (`latest.json`).

### Compatibilidade e Atualização a partir da Nightly 3

- **Atualização Automática Pré-Login (`nightly.3 → nightly.4`):** Usuários na `v0.3.0-nightly.3` com o canal Beta ativo recebem a notificação da `v0.3.0-nightly.4` diretamente no Pre-Login Auto Updater logo na inicialização do aplicativo (ou pelo atualizador interno autenticado).
- **Preparação para a Stable `v0.2.5`:** Esta compilação valida em conjunto todos os subsistemas que comporão a atualização intermediária `v0.2.5` do canal Estável, sem interferir na `v0.2.1` atualmente publicada.
