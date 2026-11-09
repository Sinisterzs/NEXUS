# NEXUS v0.1.9-nightly.7 — Persistência Global de Temas e Versão Candidata

A versão pré-lançamento **v0.1.9-nightly.7** atua como a **Release Candidate (RC)** prévia ao lançamento da versão estável **v0.2.0 Stable**. Esta build resolve de forma definitiva o problema de persistência do tema selecionado entre reinicializações do aplicativo e elimina qualquer flash visual durante a abertura.

---

### 🎨 1. Correção Definitiva da Persistência de Temas

#### Causa Raiz Investigada
- **Descarte de Preferências na Restauração de Sessão:** Ao abrir o aplicativo com sessão ativa salva no Keyring, a rotina `checkSession()` carregava com sucesso o objeto salvo de preferências do usuário autenticado no `nexus_settings.json` (que já continha o tema escolhido, como `midnight-black`). No entanto, a função interna `createAuthenticatedState()` atualizava apenas as propriedades de perfil (`currentUser` e `onlineUser`), descartando o objeto de configurações carregado. O estado Zustand de aparência permanecia congelado no padrão inicial (`nexus-dark`).
- **Falta de Escopo Global de Instalação:** O tema estava salvo apenas como preferência associada a contas (`preferences:${accountId}`), não existindo uma chave raiz para aplicação imediata durante o ciclo de vida inicial (splash screen e login).

#### Solução Arquitetural Aplicada
1. **Persistência em Nível de Instalação (`app_theme`):**
   - Introduzida a chave global `app_theme` na raiz do `nexus_settings.json` (Tauri Store) e a chave correspondente `nexus_theme` no `localStorage`, garantindo escopo em nível de aplicação idêntico ao já utilizado com sucesso para `app_update_channel`.
   - Implementadas as rotinas `getTheme()` e `setTheme()` no [`SettingsRepository.ts`](../src/repositories/SettingsRepository.ts) com hierarquia de resolução robusta.
2. **Hidratação Completa das Configurações de Conta:**
   - [`useAppStore.ts`](../src/stores/useAppStore.ts) agora repassa as preferências carregadas (`accPrefs`) para `createAuthenticatedState()`, hidratando imediatamente os blocos `appearance`, `audioVideo`, `notifications` e `privacy`.
   - As funções `checkSession()`, `loginOnline()`, `registerOnline()` e `loginGoogle()` agora garantem a restauração instantânea do tema da conta.
3. **Zero-Flash Pré-Renderização:**
   - Adicionado script síncrono no `<head>` do [`index.html`](../index.html) e inicialização reativa em [`mocks/index.ts`](../src/mocks/index.ts) (`getInitialTheme()`). O atributo `data-theme` é aplicado no primeiríssimo frame de pintura do WebView2, antes mesmo do React montar, eliminando qualquer flash do tema padrão.

---

### 🛡️ 2. Validações e Testes Automatizados
- **Nova Suíte de Testes de Temas ([`tests/theme_persistence.test.ts`](../tests/theme_persistence.test.ts)):** 7 testes cobrindo a seleção dos três temas oficiais (**NEXUS Dark**, **Midnight Black** e **Cyber Slate**), simulação de reinicialização a frio (cold start), sanitização de valores corrompidos e coexistência pacífica com `app_update_channel`.
- **Validação de Ciclo de Vida Real:** Testado via automação CDP no `nexus.exe` real com encerramento de processo (`taskkill`) e reabertura a frio para cada tema, confirmando 100% de persistência.
- **Isolamento de Segurança:** Confirmado que nenhum dado de produção em `%APPDATA%`, chaves do Windows Credential Manager ou conexões ativas na AWS foram impactados.

---

### 📦 3. Informações da Release e Atualização
- **Canal de Distribuição:** `Beta / Nightly` (`latest-nightly.json`)
- **Canal Estável Vigente:** `v0.1.8` (`latest.json`) — Mantido intacto sem alterações
- **Instalador Windows:** `nexus_0.1.9-nightly.7_x64-setup.exe` (NSIS assinado com Minisign)
- **Status do Projeto:** Última Nightly candidata à homologação da **Stable v0.2.0**.
