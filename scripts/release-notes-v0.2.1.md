# NEXUS v0.2.1 (Stable) — Hotfix de Canais e Classificação de Versões

A versão estável **v0.2.1** é uma atualização de manutenção (**Hotfix**) focada exclusivamente em corrigir a lógica de classificação de versões locais e de consulta aos manifestos de atualização nos canais **Stable** e **Beta / Nightly**.

Esta compilação promove oficialmente as alterações homologadas e validadas na **v0.2.1-nightly.1**, sem introduzir novas funcionalidades ou alterações comportamentais de mídia ou rede.

---

### 🔍 1. Problema Corrigido (Causa Raiz)

#### Comportamento Anterior
Após instalar a versão estável oficial `v0.2.0`, caso o usuário acessasse **Configurações → Sobre & Atualizações** e selecionasse o canal **Beta / Nightly**, a interface apresentava indevidamente um card com o título fixo:
> *"Versão Experimental em Execução"*  
> *"Você está usando uma versão experimental (v0.2.0). A versão estável mais recente é a v0.1.9-nightly.7. Não haverá downgrade automático..."*

#### Causa Raiz Técnica
1. **Acoplamento Indevido de SemVer:** Ao selecionar o canal Beta, o atualizador consultava o manifesto `latest-nightly.json`, cuja última versão publicada ainda era `0.1.9-nightly.7`.
2. Como `0.2.0 > 0.1.9-nightly.7`, a comparação SemVer retornava `is_current_higher = true`.
3. O `UpdateService` assumia de forma estática que qualquer situação onde `is_current_higher` fosse verdadeiro significava que o usuário estava rodando uma versão experimental enquanto consultava um canal estável.
4. Além disso, o título do card no `SettingsView` estava estático como *"Versão Experimental em Execução"*, e a versão do canal Beta era incorretamente descrita como "versão estável mais recente".

---

### 🛠️ 2. Solução Arquitetural Aplicada

1. **Classificação Estritamente Imutável da Versão Instalada:**
   - A classificação da instalação é puramente calculada por `isPrereleaseVersion(installedVersion)`.
   - A versão `0.2.1` oficial é classificada como **Estável** de forma permanente e determinística, independentemente do canal selecionado ou de respostas de rede.
2. **Lógica Pura de Comparação (`resolveChannelVersionComparison`):**
   - **Versão Estável instalada + Canal Beta ativo (`0.2.1 > 0.1.9-nightly.7`):**
     - Status: `up_to_date`.
     - Mensagem amigável: *"Você está utilizando a versão estável oficial (v0.2.1). O Canal Beta / Nightly está ativo e novas compilações experimentais serão oferecidas automaticamente assim que uma versão superior for publicada (ex: v0.2.2-nightly.x)."*
     - **Sem falso aviso de versão experimental e sem tentativa indevida de downgrade.**
   - **Versão Experimental instalada + Canal Estável ativo:**
     - Mantém aviso legítimo com título dinâmico *"Versão Experimental com Canal Estável Ativo"*.
     - O botão *"Continuar recebendo Nightlies"* só é exibido se a versão instalada for de fato pré-lançamento.

---

### 🧪 3. Validação e Testes Automatizados

- **Nova Suíte de Testes Automatizada (`tests/version_channel_matrix.test.ts`):** 7 cenários completos cobrindo todas as permutações entre versões Stable e Nightly nos canais Stable e Beta.
- **Suíte de Testes de Sincronização de Documentação (`tests/sync_readme_release.test.ts`):** 5 testes garantindo a sincronização idempotente e isolada de releases no README.
- **Suíte Frontend Completa (`npm test`):** 28 testes passando com 100% de sucesso.
- **Suíte Nativa Rust (`cargo test`):** 50 testes passando com isolamento estrito de dados, Keyring e credenciais.

---

### 📦 4. Informações da Release e Distribuição

- **Canal de Distribuição:** `Estável (Stable)` (`latest.json`)
- **Versão:** `0.2.1`
- **Canal Beta / Nightly Vigente:** `latest-nightly.json` preservado e isolado.
- **Instalador Oficial:** `nexus_0.2.1_x64-setup.exe` (NSIS assinado digitalmente com Minisign).
