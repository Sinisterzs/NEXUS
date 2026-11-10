# NEXUS v0.2.1-nightly.1 — Hotfix de Classificação de Versões e Canais de Atualização

A compilação **v0.2.1-nightly.1** é um build de homologação do canal **Beta / Nightly** dedicado a validar a correção da lógica de identificação de versões locais em relação aos manifestos remotos de atualização.

---

### 🔍 1. Problema Corrigido (Causa Raiz)

#### Comportamento Anterior
Após atualizar para a **v0.2.0 Stable oficial**, caso o usuário acessasse as Configurações e selecionasse o canal **Beta / Nightly**, a interface apresentava indevidamente um card de alerta:
> *"Versão Experimental em Execução"*  
> *"Você está usando uma versão experimental (v0.2.0). A versão estável mais recente é a v0.1.9-nightly.7. Não haverá downgrade automático..."*

#### Causa Raiz Técnica
1. **Acoplamento Incorreto de SemVer:** Ao selecionar o canal Beta, o atualizador consultava o manifesto `latest-nightly.json`, cuja última versão remota disponível era `0.1.9-nightly.7`.
2. Como `0.2.0 > 0.1.9-nightly.7`, a verificação SemVer retornava `is_current_higher = true`.
3. O `UpdateService.ts` assumia de forma fixa que qualquer caso onde `is_current_higher` fosse verdadeiro significava que o usuário estava rodando uma versão experimental enquanto consultava um canal estável.
4. Além disso, o título do card no `SettingsView.tsx` estava estático como *"Versão Experimental em Execução"*, e o manifesto do canal Beta era chamado incorretamente de "versão estável mais recente".

---

### 🛠️ 2. Solução Arquitetural Aplicada

1. **Separação Estrita de Responsabilidades:**
   - **`installedVersion`:** Versão real em execução (ex: `0.2.0`).
   - **`installedReleaseType`:** Avaliada puramente por `isPrereleaseVersion(installedVersion)`. Como `0.2.0` não possui sufixo pré-lançamento, ela é classificada como **Estável** independentemente do canal ativo.
   - **`selectedUpdateChannel`:** Preferência de busca de novos updates (`stable` ou `beta`).
   - **`latestRemoteVersion`:** Versão presente no manifesto consultado. Se possuir sufixo `-nightly` ou `-beta`, é tratada como compilação prévia, nunca como estável.

2. **Lógica Pura de Comparação (`resolveChannelVersionComparison`):**
   - **Estável instalada + Canal Beta ativo (`0.2.0 > 0.1.9-nightly.7`):**
     - Status: `up_to_date` (sem downgrade notice, sem badge experimental indevido).
     - Mensagem amigável: *"Você está utilizando a versão estável oficial (v0.2.0). O Canal Beta / Nightly está ativo e novas compilações experimentais serão oferecidas automaticamente assim que uma versão superior for publicada (ex: v0.2.1-nightly.x)."*
   - **Experimental instalada + Canal Estável ativo (`0.1.9-nightly.7 > 0.1.8`):**
     - Mantém `downgrade_notice` legítimo com título dinâmico *"Versão Experimental com Canal Estável Ativo"*.
     - O botão *"Continuar recebendo Nightlies"* só é exibido se a versão instalada for de fato pré-lançamento.

---

### 🧪 3. Validação e Testes de Regressão

- **Nova Suíte de Testes Automatizada (`tests/version_channel_matrix.test.ts`):** 7 cenários completos testando todas as combinações entre Stable e Nightly nos canais Stable e Beta.
- **Suíte Frontend Completa (`npm test`):** 25 testes passando (versões, canais, temas e matriz).
- **Suíte Nativa Rust (`cargo test`):** 50 testes passando com isolamento estrito de disco, Keyring e banco.
- **Build de Produção:** Compilação do instalador NSIS assinado via Tauri CLI 2.

---

### 📦 4. Detalhes da Compilação Nightly

- **Canal:** `Beta / Nightly` (`latest-nightly.json`)
- **Versão:** `0.2.1-nightly.1`
- **Canal Estável Vigente:** `v0.2.0 Stable` (`latest.json`) — **Preservado 100% intacto sem alterações.**
- **Assinatura:** Minisign com verificação criptográfica estrita.
