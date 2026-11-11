# NEXUS v0.3.0-nightly.2 — preparação final

> Atualização de autorização: o responsável informou aprovação da homologação manual e autorizou commit, push e publicação desta versão como pré-release. A revalidação de publicação permanece não interativa. A classificação e pendências abaixo registram a avaliação anterior à autorização; não significam execução de testes manuais pelo agente.

Data: 11/11/2026. Classificação: **APROVADA COM PENDÊNCIAS DE HOMOLOGAÇÃO**. Nenhuma publicação, commit, push, tag, instalação, execução do aplicativo, cliente A/B, navegador desktop ou serviço foi feita nesta etapa.

Este relatório substitui a aprovação histórica de `verification-report.md` para fins de decisão de publicação. Não houve testes manuais nesta etapa; resultados históricos não são tratados como prova nova de mídia, hardware ou desempenho.

## Auditoria dos seis problemas da Nightly 1

| Problema | Estado do código e evidência | Limite |
| --- | --- | --- |
| 1. Tela inicia borrada | Warmup com `detail`, resolução sem scale-down solicitado, rampa e reaplicação de parâmetros. Nesta etapa, timers passaram a começar após a answer; o teste verifica ausência deles enquanto a negociação aguarda e estágios em 900/1.800 ms depois da resposta | Flags de qualidade não garantem a imagem efetiva; nitidez inicial e adaptação real exigem receptor/hardware |
| 2. Barra cobre entrada de mensagens | ActiveCallBar está na Sidebar, não no overlay global. Dock permanente recolhido é omitido quando a barra compacta aparece. Teste HTML verifica 96 combinações e restauração em idle | Geometria, tooltips, foco/teclado e DPI são pendências manuais |
| 3. Compacto/Equilibrado/Cinema/Tela Cheia | Presets, proporção, estilos de participantes e fullscreen separados; 7 testes de layout aprovados | Verificação visual com transmissão e várias janelas/monitores pendente |
| 4. Alto consumo de CPU | Investigação e diagnóstico direto de encoder/limitação via getStats disponíveis. Nenhuma conclusão de ganho de desempenho é assumida | CPU/GPU não medidos nesta etapa. MediaPerfMonitor e long tasks são módulo auxiliar testado, ainda não integrado ao runtime; não anunciar como recurso ativo |
| 5. FPS ~32 e métricas confundidas | Separação de solicitado/capturado/codificado/enviado/recebido/decodificado. Correção final removeu equivalência decodificado=renderizado e fallback de cadência configurada como captura medida. `renderedFps` permanece null; UI usa `Dec` | Apresentação pelo elemento de vídeo não medida. 1080p60 e encoder GPU não garantidos |
| 6. Sensibilidade e indicador de voz | Detector/escala/cadência de 50 ms comuns a configurações e chamada, atualização ao vivo, reset mute, hangover único, calibração e save/flush/load A→B→A cobertos por testes | Fala/ruído reais, calibração física e comportamento em segundo plano pendentes |

Áudio permanece contínuo sem gate automático. Mute/deafen explícitos, hot-swap e volumes continuam no pipeline existente. Revisão estática não encontrou regressão demonstrada de chamada 1:1, ICE/P2P/TURN, persistência por conta ou isolamento do Lab. A correção da rampa altera apenas o momento de parametrização do encoder, não rotas, servidores ICE, codecs disponíveis ou protocolo de signaling.

## Validação executada

- `npm test`: aprovado, incluindo regressões de chamadas, layouts, VAD, preferências, captura simulada, Sidebar e preparação de release. Nenhum teste de mídia usa dispositivos reais.
- `npx tsc --noEmit`: aprovado.
- `npm run build -- --config <config temporário de auditoria>`: aprovado; importa o Vite config real e sobrescreve somente `envDir: false`, impedindo leitura de `.env`. Config temporário removido. Frontend gerado em `dist`, ignorado pelo Git. Não é build nativo.
- Avisos Vite: chunk principal de aproximadamente 719 kB (175 kB gzip), acima de 500 kB; imports estáticos/dinâmicos de APIs Tauri permanecem no mesmo chunk. Não são falhas de compilação; otimização fica fora desta sprint.
- Rust: testes isolados `lab::tests` (2), `updater::tests::nightly_fallback_uses_build_version` e `updater::tests::test_semver_downgrade_logic`. Todos aprovados com `--offline --locked --features test-lab --lib`, sem abrir aplicação. A feature evita leitura da configuração real no build.rs; os testes não inicializam DB/keyring/servidores.
- Testes Rust de backend/SQLx e testes de updater que dependem de rede/artefatos reais não foram executados: exigiriam serviços, configuração ou assinatura reais.
- `git diff --check`: aprovado. A linha em branco final antiga de `tests/calls_and_streaming_v030.test.ts` foi normalizada ao editar a regressão.
- Inspeção de nomes de arquivos e padrões de literais no diff/fontes novos: nenhum candidato a credencial privada encontrado. O `.env.example` rastreado é um nome de exemplo preexistente, não uma credencial nova. Não foram abertos `.env`, bancos, chaves ou credenciais.
- Assinaturas nos testes de scripts são fixtures textuais inertes; nenhuma chave real é usada e nenhum instalador é executado. Esses testes provam pareamento/nomenclatura/metadados, não criptografia de artefatos reais.
- `regression_review` confirmou a correção dos dois achados de FPS/warmup, sem bloqueador identificado. `release_verifier` conferiu independentemente os 64 caminhos, sete campos de versão, workflow, scripts e limites documentados: **APROVADA COM PENDÊNCIAS DE HOMOLOGAÇÃO**, sem bloqueador novo. Ambas as revisões foram somente leitura.

## Preparação de versão, canal e empacotamento

Versão alinhada em `package.json`, `package-lock.json` (raiz e pacote raiz), `src/version.ts`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` e pacote `nexus` de `src-tauri/Cargo.lock`: **0.3.0-nightly.2**. Nenhuma dependência foi adicionada ou atualizada intencionalmente.

- `CHANGELOG.md` contém o candidato Calls & Streaming 2.1; `scripts/release-notes-v0.3.0-nightly.2.md` está preparado.
- README continua anunciando a Nightly 1 já publicada. Não antecipar links para artefatos inexistentes; o workflow sincroniza somente a linha Beta após publicação bem-sucedida. Stable permanece `0.2.1`.
- Configuração pública de assinatura Tauri preservada. O workflow exige `TAURI_SIGNING_PRIVATE_KEY` e usa a senha opcional do secret correspondente; sua existência/validade não foi consultada. A chave privada não foi lida.
- Publicação Nightly permanece `prerelease: true`, `make_latest: false`, com `latest-nightly.json`. O manifesto Stable `latest.json` não é gerado/substituído por esse caminho.
- Usuários mantêm a preferência de canal existente; instalar uma Nightly não deve sobrescrever essa preferência. Para receber Nightlies, usar Beta/Nightly. A compatibilidade SemVer com Stable `0.2.1` e Nightly 1 foi verificada em teste Rust puro; assinatura/migração/instalação reais seguem pendentes.
- Fallback nativo Nightly agora deriva a tag da versão do build, em vez da tag fixa antiga `v0.1.9-nightly.1`. A descoberta de versões mais recentes ainda depende da API GitHub; indisponibilidade da API pode impedir descobrir a próxima versão, sem forçar downgrade.
- O sincronizador aceita apenas `X.Y.Z-nightly.N` e atualiza também Cargo.lock. O gerador exige exatamente um instalador da versão solicitada e a assinatura exata, não vazia. A auditoria recusa ausência dos quatro artefatos obrigatórios e não promete uma inspeção criptográfica/completa do conteúdo.
- O workflow passa inputs por variáveis de ambiente, executa testes/typecheck, recusa tags existentes e envia somente filenames NSIS exatos da versão. Isso evita interpolação de notas como shell e envio por wildcard de instaladores antigos. O workflow foi analisado como YAML e testado estaticamente; não foi disparado.

Artefatos futuros esperados: `nexus.exe`, `nexus_0.3.0-nightly.2_x64-setup.exe`, `nexus_0.3.0-nightly.2_x64-setup.exe.sig`, `latest-nightly.json`. **Nenhum deles foi gerado/assinado nesta etapa.** Não confundir `dist` ou o executável de testes Rust com artefatos publicáveis.

Não usar `scripts/publish-update.ps1` para esta Nightly: esse caminho publica `latest.json` e marca release como estável. `build-release.ps1` e `build-nsis-release.ps1` também encerram processos por nome; não foram executados nem são o caminho recomendado neste host. Preferir o workflow em runner descartável após autorização.

## Test Lab e arquivos privados

Isolamento revisado no código: identificadores A/B, diretórios SQLite/rede/Tauri/WebView próprios, namespaces de Credential Manager distintos, API fixa loopback, ausência de descoberta pública no Lab, updater/OAuth/Tailscale bloqueados e compile_error de test-lab sem debug_assertions. Backend Lab ignora dotenv, usa PostgreSQL dedicado e stage de compilação sem segredos; Vite Lab bloqueia árvore privada. Não foi iniciado o Lab nesta etapa.

O bundle Tauri não possui `resources` incluindo a árvore do workspace e o workflow usa allowlist de arquivos. `.nexus-lab`, bancos, `.env`, chaves, `target`, `dist`, logs e metadados locais `docs/nightly2/*-agent-models.json` permanecem ignorados. Metadados de sessões de agentes não fazem parte do release. Scripts/testes/docs do Lab podem ficar no repositório, mas não são anexos de distribuição nem código ativável no Release normal.

Importante: uma Nightly instalada mantém o identificador normal do produto. Não é uma instalação de homologação isolada da Stable; essa garantia pertence ao Test Lab Debug. Não fazer testes de instalador no host com dados reais.

## Inventário e histórico

Base auditada: branch `feature/v0.3.0-calls-streaming`, HEAD `65bf756d387ffdb76bdb159c79081bce2afbba49`. Sem novos commits/tags/pushes. O inventário exato do conjunto acumulado está em `release-file-inventory-v0.3.0-nightly.2.json`; inclui produto, testes, laboratório e documentação. Revisar esses grupos antes de compor qualquer commit; não usar adição indiscriminada de arquivos locais.

## Pendências e riscos conhecidos

1. Homologação de fala real, ruído/calibração, dispositivos/hot-swap, volumes e indicador de voz em segundo plano.
2. Tela remota, nitidez inicial, FPS medido, codec/encoder real, perda/reconexão ICE e duração prolongada em dois PCs. Dois clientes locais compartilham recursos e não são benchmark de internet.
3. Geometria/teclado/DPI dos quatro layouts com transmissão, Sidebar e telas cheias.
4. Barra nativa WebView2: não há API suportada identificada para remover seletivamente a barra mantendo indicadores. Preferência por janela reduz a área; inclusão nos frames permanece desconhecida sem comparação no receptor. Captura nativa seria projeto futuro e não foi implementada.
5. Monitor auxiliar de long tasks não integrado; não anunciar redução de CPU nem aceleração GPU. FPS renderizado não disponível sem medição de apresentação.
6. Build nativo, NSIS, assinatura real e instalação/updater em ambiente descartável ainda não validados. Testes de scripts não substituem essas etapas.

## Procedimento de publicação — somente após autorização explícita

Os comandos abaixo são roteiro futuro, **não foram executados**. Autorização deve abranger versionamento/envio do código e o workflow que gera NSIS, assina e publica automaticamente ao terminar. Resolver as pendências consideradas impeditivas e rever o inventário antes de prosseguir.

1. Revalidar `npm test`, `npx tsc --noEmit` e build frontend em checkout limpo sem arquivos `.env` locais. Confirmar versão, changelog e ausência de arquivos privados. Homologar mídia e UI no ambiente de teste autorizado; preservar dados reais.
2. Com autorização para Git, usar o inventário aprovado para compor o commit nesta branch:

```powershell
$inventory = Get-Content .\docs\nightly2\release-file-inventory-v0.3.0-nightly.2.json -Raw | ConvertFrom-Json
git add -- $inventory.files
git diff --cached --check
git diff --cached --stat
# Conferir o diff staged antes do commit.
git commit -m "release: prepare v0.3.0-nightly.2"
git push origin HEAD:feature/v0.3.0-calls-streaming
```

3. Confirmar no GitHub que a branch contém esse commit e que a tag `v0.3.0-nightly.2` não existe. Com autenticação GitHub já providenciada pelo operador autorizado e autorização para publicar:

```powershell
gh workflow run nightly.yml --repo Sinisterzs/NEXUS --ref feature/v0.3.0-calls-streaming -f version=0.3.0-nightly.2 -f release_notes="Calls & Streaming 2.1: correções de chamadas, layouts, VAD e diagnósticos; veja as limitações nas notas."
gh run list --repo Sinisterzs/NEXUS --workflow nightly.yml --branch feature/v0.3.0-calls-streaming --event workflow_dispatch --limit 5
```

4. Selecionar o ID da execução cujo `headSha` corresponde ao commit aprovado (não assumir que qualquer run recente seja a correta), então acompanhar com `gh run watch RUN_ID --repo Sinisterzs/NEXUS --exit-status`, substituindo `RUN_ID` pelo número conferido. Esse workflow compila NSIS somente no runner, valida presença do secret de assinatura, gera manifesto, audita e publica pré-release. A etapa final pode criar um commit de sincronização do README em `main`; isso também exige autorização futura.
5. Conferir `gh release view v0.3.0-nightly.2 --repo Sinisterzs/NEXUS --json tagName,isPrerelease,assets,url`, os quatro anexos/versão/URLs e assinatura, além da preservação da Stable/latest.json. Testar instalação/update assinado somente em VM/ambiente descartável, sem executar instaladores silenciosos neste host.

Não há chave privada, token ou senha no roteiro. Não executar dispatchers/publicadores apenas para verificar configuração.

## Subagentes

`release_audit`: override explícito `gpt-6-luna`/`low`; `regression_review`: `gpt-6.1-sol`/`medium`; `release_verifier`: `gpt-6.1-sol`/`medium`. Solicitações/aceitação da ferramenta são comprováveis. Não confundir esses parâmetros com telemetria independente do modelo de execução: a ferramenta retorna o nome da tarefa, sem esse dado. Nenhuma conta/sessão real foi consultada para tentar ampliar essa comprovação.
