# Diagnóstico Somente Leitura do Login Google

Script: [`nexus-server/diagnostics/google_login_readonly_diagnostic.sql`](../nexus-server/diagnostics/google_login_readonly_diagnostic.sql).  
Sempre executa em transação `BEGIN READ ONLY ... ROLLBACK`. Emite estritamente **contagens agregadas e booleanos** (nunca projeta e-mails, `sub`, tokens, hashes de senha ou IDs de usuário).

> [!IMPORTANT]
> A execução deve ser realizada exclusivamente por operador autorizado em ambiente seguro.  
> Nunca vincule contas ou modifique dados com base apenas em igualdade de e-mail.

---

## Papel Somente Leitura Recomendado

```sql
CREATE ROLE nexus_diag LOGIN PASSWORD '<definir-fora-do-repositorio>';
GRANT CONNECT ON DATABASE nexus TO nexus_diag;
GRANT USAGE ON SCHEMA public TO nexus_diag;
GRANT SELECT ON users, user_credentials, user_oauth_accounts TO nexus_diag;
-- Em PostgreSQL 14+: GRANT pg_read_all_data TO nexus_diag;
```

---

## Modos de Execução

```bash
# 1. Visão global agregada (integridade e anomalias de schema/dados)
PGOPTIONS='-c default_transaction_read_only=on' \
  psql -v ON_ERROR_STOP=1 -f nexus-server/diagnostics/google_login_readonly_diagnostic.sql "$DATABASE_URL"

# 2. Diagnóstico de conta individual (o e-mail fica apenas na variável local do psql)
PGOPTIONS='-c default_transaction_read_only=on' \
  psql -v ON_ERROR_STOP=1 -v target_email='usuario@exemplo.com' \
  -f nexus-server/diagnostics/google_login_readonly_diagnostic.sql "$DATABASE_URL"
```

---

## Matriz de Interpretação: Fatos Comprovados vs. Hipóteses

As seções abaixo separam estritamente o que os dados do banco comprovam do que são apenas hipóteses que necessitam de evidências adicionais:

| Indicadores do Diagnóstico | Fatos Comprovados (Evidência Direta) | Hipóteses a Investigar (Não Comprovadas pelo SQL) | Ação Segura Recomendada |
|---|---|---|---|
| `has_any_normalized_credentials_match = false` | O e-mail informado não possui nenhuma linha correspondente na tabela `user_credentials`. | O usuário tentou entrar com outro endereço ou conectou-se a um ambiente/banco diferente. | Solicitar ao usuário a confirmação do endereço de e-mail exato utilizado no cadastro inicial. |
| `has_any_normalized_credentials_match = true`<br>`matching_credentials_unnormalized_in_db = true`<br>`has_exact_normalized_credentials_match = false` | **A linha no banco foi armazenada com maiúsculas ou espaços legados.** O backend moderno (`lower(btrim(email))`) fará `SELECT ... WHERE email = $1` falhar em encontrar correspondência exata, dependendo de como a query de consulta for formulada. | Criação de conta antiga anterior à padronização de normalização em minúsculas. | Não alterar diretamente sem validação de titularidade. Caso confirmado, aplicar correção controlada de normalização na linha correspondente. |
| `count_rows_matching_normalized_email > 1`<br>`multiple_accounts_share_normalized_email = true` | **Existem múltiplas contas na base que colidem após normalização.** (Ex: `User@domain` e `user@domain`). | Falha em restrição de unicidade em versões antigas do schema. | **Proibido fundir contas automaticamente.** Requer intervenção manual com auditoria forense dos perfis envolvidos. |
| `has_any_normalized_credentials_match = true`<br>`any_matched_account_is_passwordless = true`<br>`has_registered_google_link = false`<br>`total_google_links = 0` | **Conta sem senha existente sem nenhum vínculo na tabela `user_oauth_accounts`.** | O usuário criou a conta via Google no passado, mas o registro em `user_oauth_accounts` foi perdido (restauração parcial, exclusão de registros ou banco de dados divergente). | Encaminhar para fluxo de recuperação segura com desafio e prova de titularidade de e-mail. Nunca inventar senha nem vincular cegamente por e-mail. |
| `has_any_normalized_credentials_match = true`<br>`any_matched_account_has_password = true`<br>`has_registered_google_link = false` | **Conta possui senha definida no banco de dados e não possui vínculo com Google.** | O usuário cadastrou-se originalmente com senha tradicional e posteriormente tentou o botão "Continuar com Google". | Comportamento esperado da aplicação: orientar o usuário a realizar login com a senha existente e efetuar a vinculação nas configurações do app. |
| `has_any_normalized_credentials_match = true`<br>`has_registered_google_link = true`<br>*(e o usuário recebe erro 409)* | **FATO:** Existe uma linha com `provider = 'google'` para esta conta.<br>**FATO:** O backend rejeitou o login com `409 Conflict`, o que significa que `find_oauth_account('google', token.sub)` não encontrou o `sub` do token atual. | **HIPÓTESE 1:** O token atual veio de uma conta Google diferente da original.<br>**HIPÓTESE 2:** O usuário utiliza alias ou conta corporativa com identificador Google distinto.<br>**HIPÓTESE 3:** `provider` foi cadastrado com maiúsculas/espaços legados (verificar agregado global `providers_not_normalized`).<br>*Nota: O SQL não compara o sub do token atual porque tokens não residem no banco.* | Não presumir divergência de `sub` como certeza. Solicitar que o usuário verifique no navegador qual perfil Google está ativo na janela de consentimento. |
| `orphans_null_hash_no_link > 0` | Existem contas globais sem senha e sem qualquer provedor OAuth vinculado (inacessíveis por login normal). | Vítimas de inconsistência de persistência ou restaurações incompletas. | Alvos primários para o mecanismo de suporte e recuperação com desafio de e-mail. |
