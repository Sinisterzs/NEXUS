# Recuperação de contas Google legadas sem vínculo

> [!CAUTION]
> **Prova de posse obrigatória.** Nunca vincule uma identidade Google a uma conta NEXUS com base apenas em
> igualdade de e-mail, em adivinhação do `sub`, ou em resposta a um e-mail. Sem prova de posse da conta **e** um
> ID token Google validado, não há recuperação. Não existe atalho de operador.

## Contexto

O login Google identifica o usuário **somente** por `(provider='google', provider_subject=sub)` de um ID token
validado (`user_oauth_accounts`, restrição `uq_user_oauth_provider_subject`,
`nexus-server/migrations/0002_google_oauth.sql`). O e-mail (`user_credentials.email`, `UNIQUE`) nunca vincula contas.

Se o `sub` não está vinculado e o e-mail já existe, o servidor recusa com 409:

- `ACCOUNT_CONFLICT_EMAIL_EXISTS`: o dono do e-mail tem senha. Ele entra com a senha e vincula o Google em
  uma sessão autenticada.
- `GOOGLE_IDENTITY_NOT_LINKED`: a conta não tem senha e o `sub` não está vinculado (vínculo ausente ou `sub` diferente).

Contas criadas pelo Google são gravadas em uma única transação (`users` + `user_credentials` com
`password_hash = NULL` + `user_profiles` + `user_oauth_accounts`). O estado "conta Google-only sem vínculo" não é
produzido pelo código; só por perda ou restauração parcial de dados, remoção manual de linhas ou troca de banco. A causa em
um caso real depende do estado do banco e não é provável por análise estática.

## Diagnóstico (somente leitura, com autorização do dono do banco)

```sql
-- Contas sem senha e sem nenhum vínculo OAuth (candidatas)
SELECT c.user_id
FROM user_credentials c
WHERE c.password_hash IS NULL
  AND NOT EXISTS (SELECT 1 FROM user_oauth_accounts o WHERE o.user_id = c.user_id);
```

Não exporte e-mails nem `sub` para logs ou chamados.

## Procedimento seguro

1. **Conta com senha**: o usuário entra com e-mail/senha e usa "Vincular Google" autenticado
   (`link_google_account`, `nexus-server/src/services/auth.rs`). O `sub` vem do token validado; um `sub` já ligado a
   outro usuário é recusado (`OAUTH_ACCOUNT_ALREADY_LINKED`).
2. **Conta sem senha e sem vínculo (legada)**: hoje **não há fluxo automático**. O usuário deve contatar o suporte.
   A recuperação só pode ser implementada por um endpoint futuro que exija, no mesmo fluxo:
   - desafio de posse enviado ao e-mail cadastrado (código ou link de uso único e curta duração); e
   - ID token Google validado (assinatura, `aud`, `iss`, `exp`, nonce, `email_verified=true`) apresentado pelo
     próprio usuário.

   Só então o servidor insere o `sub` **do token validado**. O operador não obtém nem digita o `sub`: o servidor
   registra o vínculo diretamente a partir do token, sem gravar `sub` ou e-mail em logs.
3. Depois do vínculo, o login seguinte resolve pelo `sub` sem passar pela checagem de e-mail.

## Proibido

- Vincular por e-mail apenas, ou migração em massa atribuindo `sub`.
- Inserção manual de `sub` por operador, inventar senha, apagar dados.

## Migração

Nenhuma migração é necessária: o esquema já suporta `password_hash` nulo e vínculo por `(provider, sub)`. O banco não
guarda evidência do `sub` de contas antigas, então nenhuma migração segura pode reconstruí-lo.
