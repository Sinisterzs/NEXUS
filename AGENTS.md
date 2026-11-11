Durante o desenvolvimento, priorize Vite HMR e verificações rápidas. Não execute builds Release ou gere instaladores após alterações pequenas, a menos que seja necessário validar funcionalidades nativas ou que o usuário solicite. Agrupe alterações relacionadas e faça um build Release ao final de cada etapa.

Nunca lance updates ou publique releases no GitHub sem autorização explícita do usuário.

Nunca execute instaladores NSIS (`setup.exe`) com argumentos silenciosos (`/S /D=...`) diretamente no host do Windows para testes locais sem isolar ou restaurar a chave de desinstalação `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\nexus`. Testes de integridade do updater devem utilizar extração de artefatos ou validação de manifestos sem alterar o registro do sistema operacional.

# NEXUS — Padrão Definitivo de Release Notes

Adotar este padrão para TODAS as futuras versões do NEXUS, incluindo Nightly, Stable e Hotfix.

## Objetivo

Produzir notas de lançamento profissionais, claras e voltadas aos usuários finais, semelhantes às de aplicativos como Discord, Steam e Spotify.

## Estrutura obrigatória

### ✨ Novidades
Apresentar funcionalidades novas, explicando brevemente o que o usuário agora pode fazer.

### 🚀 Melhorias
Descrever melhorias na experiência, estabilidade, desempenho ou usabilidade.

### 🛠️ Correções
Informar qual problema foi corrigido, em que situação ele acontecia e o que mudou para o usuário.

Omitir seções sem alterações relevantes.

## Regras de escrita

- Usar português brasileiro natural.
- Não explicar como o código foi implementado.
- Não mencionar nomes de arquivos, funções, classes, branches, commits ou detalhes internos.
- Não descrever investigações, auditorias, tentativas fracassadas ou processos de depuração.
- Não utilizar linguagem excessivamente técnica.
- Não expor vulnerabilidades ou detalhes de segurança sensíveis.
- Evitar textos longos e repetitivos.
- Não inventar funcionalidades ou correções.
- Priorizar os benefícios percebidos pelo usuário.
- Descrever correções com contexto suficiente para que o usuário reconheça o problema.
- Não usar termos como "causa raiz", "refatoração", "pipeline" ou "hotfix técnico" quando uma descrição simples for suficiente.

## Exemplo de correção

**Inadequado:**
"Identificado erro de sincronização do token no backend Rust devido a falha no listener IPC, corrigido com novo fluxo de eventos e armazenamento volátil."

**Adequado:**
"Corrigido um problema que impedia a abertura automática do NEXUS ao clicar no link de recuperação de senha recebido por e-mail."

## Separação de documentos

Manter dois tipos distintos:

1. **Release Notes públicas:** novidades, melhorias e correções voltadas aos usuários.
2. **Relatório técnico interno:** detalhes de implementação, testes, commits, riscos e procedimentos de implantação.

Nunca publicar automaticamente o relatório técnico como release notes.

## Aplicação

Aplicar imediatamente à preparação da v0.2.5 Stable e às próximas Nightlies.

Verificar também os scripts e workflows que geram as notas para garantir consistência.

Não modificar releases já publicadas sem autorização.