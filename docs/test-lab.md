# NEXUS Test Lab 0.1

Laboratório Debug para homologar as alterações destinadas à nightly.2. Não altera a versão do produto, não instala nada e não publica artefatos. O frontend e os serviços de mídia existentes são reutilizados com Vite HMR.

## Arquivos desta entrega

Criados: `scripts/lab.ps1`, `scripts/lab-common.ps1`, `scripts/lab-accounts.ps1`, `scripts/test-lab.ps1`, `vite.lab.config.ts`, `src-tauri/src/lab.rs` e este guia.

Modificados: `.gitignore`; `src-tauri/Cargo.toml`, `src-tauri/build.rs`, `src-tauri/src/{lib,main,auth,network,updater}.rs`; `nexus-server/Cargo.toml`, `nexus-server/src/config/mod.rs`, `nexus-server/src/main.rs`.

As alterações frontend/nightly.2 e em `package.json` já presentes no workspace foram preservadas e não fazem parte da implementação do laboratório.

## Auditoria e decisões

- A configuração original usa `com.nexus.desktop`; SQLite usa `app_data_dir()/nexus.db`. A rede tem caminho próprio com esse identificador e procura candidatos públicos/privados quando o servidor falha. O laboratório substitui esses pontos antes de inicializar persistência e desativa a descoberta alternativa.
- O Credential Manager original usa serviço `nexus_desktop` e conta `session_token`. Mudar apenas SQLite ou o canal Nightly não separaria as sessões. A/B usam serviços `nexus_testlab_A` / `nexus_testlab_B`, com conta `session_token_lab`; o vínculo criptográfico à origem/identidade continua ativo.
- Tema, configurações e histórico usam Tauri Store e/ou localStorage; alguns valores são por conta e outros por instalação. Cada WebView tem diretório próprio, separando cookies, cache e localStorage mesmo no mesmo origin Vite.
- No Windows, alterar `APPDATA` não muda os Known Folders usados pelo Tauri. A verificação real detectou isso; a implementação final também define `appDirectoriesOverride` explicitamente dentro do perfil.
- Não há plugin single-instance na inicialização/dependências examinadas. Um único executável Debug é iniciado duas vezes, com `NEXUS_LAB_PROFILE=A/B` e identificadores distintos em runtime. O launcher recusa iniciar novamente um perfil registrado ainda ativo.
- O WebRTC roda no WebView2. Microfone e captura continuam sujeitos aos consentimentos existentes, ativados pelo fluxo de chamada/captura. Não são adicionadas flags para liberar dispositivos ou ignorar permissões.
- `scripts/dev.ps1` reutiliza PostgreSQL em 5432/backend em 3001 e não atende ao isolamento necessário. O novo launcher reutiliza somente os executáveis portáteis PostgreSQL em `.postgres/pgsql/bin`, nunca seu cluster/dados.
- O backend Axum normal lê dotenv, resolve identidade persistente e supervisiona Tailscale. O backend lab usa configuração própria antes de dotenv, identidade nova e somente um listener loopback.
- As macros SQLx 0.8 leem `.env` durante compilação mesmo com `DATABASE_URL` explícita. Por isso o launcher gera `.nexus-lab/server-build` com cópias temporárias de `src`, migrations, Cargo.toml/Cargo.lock e `.env` vazio. Isso não é uma segunda implementação mantida: cada Prepare regenera o stage a partir dos fontes atuais. Compila contra `nexus_lab_compile`, com apenas o schema, no PostgreSQL exclusivo. O banco runtime `nexus_lab` recebe as migrations normais ao iniciar.
- Na investigação houve uma tentativa inicial de compilar diretamente o backend que pode ter lido configuração `.env` do projeto. Não há comprovação de isolamento dessa tentativa; ela falhou e o fluxo foi substituído pelo stage. Nenhum instalador foi executado e não foi feita migração deliberada em banco existente.

O diretório WebView2 é definido pela API nativa `data_directory`; a documentação do [Tauri](https://docs.rs/tauri/latest/tauri/webview/struct.WebviewWindowBuilder.html#method.data_directory) descreve esse controle. Os overrides dos diretórios da aplicação constam na [configuração oficial](https://v2.tauri.app/reference/config/).

## Isolamento final

| Recurso | Cliente A | Cliente B |
| --- | --- | --- |
| Identificador | `com.nexus.testlab.a` | `com.nexus.testlab.b` |
| SQLite/rede | `.nexus-lab/A/data` | `.nexus-lab/B/data` |
| Tauri Store/config/cache/log | `.nexus-lab/A/tauri` | `.nexus-lab/B/tauri` |
| WebView2/localStorage | `.nexus-lab/A/webview` | `.nexus-lab/B/webview` |
| Credential Manager | serviço `nexus_testlab_A` | serviço `nexus_testlab_B` |
| Conta sugerida | `nexus_lab_a` | `nexus_lab_b` |

Raiz absoluta: `<workspace>\.nexus-lab`. O launcher recusa junctions/symlinks nessa árvore. ACL da raiz restringe herança ao usuário atual. Arquivos privados são bloqueados no servidor HTTP do Vite e o Vite não carrega `.env` do projeto.

Backend: `127.0.0.1:13001`. PostgreSQL: `127.0.0.1:15432`, cluster novo com SCRAM e senha aleatória. Vite: `127.0.0.1:1420`. Porta ocupada causa erro; nenhum serviço existente é adotado ou encerrado. Não há endpoint de autenticação especial: cadastro, login e logout usam as rotas normais. OAuth Google, gerenciamento do Tailscale e updater são recusados no lab.

Ambos os crates exigem a feature `test-lab`, que falha em compilação sem `debug_assertions`. Variáveis de ambiente não ativam o modo lab no binário normal. O executável lab recusa perfil ausente ou diferente de A/B. Não distribuir esses executáveis de desenvolvimento.

## Preparar e iniciar

Execute na raiz do workspace, em PowerShell. Requer Rust/MSVC, Node/npm, dependências já instaladas e os executáveis portáteis PostgreSQL existentes.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\lab.ps1 Prepare
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\lab.ps1 Backend
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\lab-accounts.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\lab.ps1 A
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\lab.ps1 B
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-lab.ps1 -Live
```

`lab-accounts.ps1` pede duas senhas novas. Com `-Generate`, gera senhas aleatórias. As credenciais ficam cifradas por Windows DPAPI em `account-A.clixml` / `account-B.clixml`, utilizáveis somente pelo mesmo usuário Windows. O script testa o login e revoga as sessões de preparação em `finally`. Se falhar durante a criação, não repetir cegamente o cadastro: uma conta pode ter sido criada antes da falha ao salvar a credencial.

Para consultar uma senha gerada, somente no seu console local:

```powershell
(Import-Clixml .\.nexus-lab\account-A.clixml).GetNetworkCredential().Password
(Import-Clixml .\.nexus-lab\account-B.clixml).GetNetworkCredential().Password
```

Entre manualmente em A como `nexus_lab_a` e em B como `nexus_lab_b`. Confirme o servidor `http://127.0.0.1:13001` no rodapé do login e os títulos `NEXUS LAB A/B`. Não use contas Google nem credenciais reais. Alternativamente, use Criar Conta nas duas janelas, com identidades locais diferentes; nesse caso não execute o preparador para os mesmos nomes.

Prepare compila apenas Debug. Alterações React usam HMR; alterações Rust exigem Stop e Prepare novamente. Não há build Release ou NSIS nesse fluxo. Se uma etapa falhar, consulte os logs dentro de `.nexus-lab` e execute Stop antes de repetir.

## Roteiro de homologação manual

1. Em A, busque `nexus_lab_b`, envie amizade e aceite em B. Abra a DM entre eles.
2. Inicie uma chamada de voz em A e aceite em B. Selecione microfone/saída de teste e confirme captura, reprodução, mute/deafen e encerramento em ambos. Use fones para evitar realimentação acústica.
3. Em A, compartilhe uma janela inofensiva com movimento conhecido. Evite selecionar a janela B ou o monitor que a contém, para não criar captura recursiva. B deve receber a transmissão.
4. Abra os diagnósticos existentes na tela de chamadas. Compare FPS solicitado, capturado, enviado, recebido e renderizado; bitrate, perda, RTT/jitter, estado/rota ICE, resolução, codec e implementação do encoder quando disponíveis. Ausência de métrica significa indisponível, nunca prova de aceleração GPU.
5. Teste qualidade inicial e troca entre presets. Compare Compacto, Equilibrado e Cinema, controles, redimensionamento, tela cheia e overlay ao navegar para outra área do app.
6. Em configurações de áudio, varie a sensibilidade, fale baixo/alto e observe medidor/indicador de fala. Confirme o comportamento de mute e do gate opcional. Não confunda indicador de fala com corte do áudio transmitido.
7. Para reconexão do signaling sem derrubar o PostgreSQL, encerre o lab e reinicie os serviços/clientes; isso testa recuperação de sessão, mas não comprova ICE restart. Para ICE restart real, induza falha controlada apenas no transporte de teste e observe nova negociação/ICE e recuperação da mídia. Não desligue interfaces do host nem altere processos de outras aplicações. Esse teste segue pendente.
8. Feche e reabra A, mantendo B, e confirme restauração da conta correta e preferências distintas. Esse passo valida a persistência real dos tokens no Credential Manager, além dos namespaces declarados.

Não exporte logs brutos, SDP, candidates, tokens ou credenciais. Para registrar resultados, use apenas métricas agregadas, preset, papel A/B e estados ICE.

## Parar e limpar

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\lab.ps1 Status
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\lab.ps1 Stop
# Opcional: remove contas, bancos, perfis, logs, compilação e credenciais SOMENTE do lab.
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\lab.ps1 Clean
```

Stop usa PID, caminho do executável e instante de criação registrados para evitar atingir um PID reutilizado. Encerra somente clientes/backend/Vite próprios e usa `pg_ctl -m fast -w` no cluster dedicado. Não usa taskkill por nome nem encerra processos Stable. Clean verifica reparse points, processos lab e descendentes WebView2; se ainda houver processo/lock, recusa a limpeza. A exclusão dos dois namespaces do Credential Manager usa o próprio binário lab e propaga falhas. Se o executável estiver ausente, Clean recusa apagar os dados antes dessa verificação. Stop preserva dados e contas; Clean os remove, incluindo o cache de build.

## Limites e evidências

Dois clientes compartilham CPU/GPU/rede. Resultados locais não são benchmark de dois PCs nem garantem desempenho pela internet. STUN/P2P/TURN existentes foram preservados; STUN público pode gerar tráfego externo. O backend lab não importa segredos TURN de produção, portanto uma rota relay de produção não é validada aqui.

Os testes automatizados existentes cobrem cálculos de mídia, layouts, sensibilidade e reconexão simulada. `test-lab.ps1 -Live` verifica processos distintos, caminhos efetivos, SQLite separado, namespaces declarados de credenciais, listeners e bloqueio HTTP de um sentinela inofensivo. Isso não comprova uma chamada real, áudio, captura de tela, gravação de tokens no keyring ou aceleração de hardware.

Validação executada em 10/11/2026:

- `npm test`: suíte existente aprovada; `npx tsc --noEmit`: aprovado.
- Parser PowerShell: os quatro scripts do laboratório aprovados.
- Compilação Debug dos dois crates com `test-lab`: aprovada, com backend no stage sem segredos.
- `cargo test --manifest-path src-tauri/Cargo.toml --features test-lab --lib lab::tests -- --test-threads=1`, usando `CARGO_TARGET_DIR=.nexus-lab/target` e o mesmo `TAURI_CONFIG` do Prepare: 2/2 aprovados.
- `test-lab.ps1 -Live`: aprovado com A/B simultâneos, caminhos efetivos dentro da raiz, SQLite separado e argumentos reais dos processos WebView2 usando seus perfis. Sentinela HTTP retornou 403.
- Duas contas distintas: cadastro/login/logout normais aprovados. Senhas geradas ficaram cifradas por DPAPI; tokens não foram impressos.
- Duas janelas observadas pelo controle do computador, ambas na tela de login com servidor local online e identidade Ed25519 verificada.
- Helper de exclusão dos namespaces de credenciais A/B: aprovado. Stop executado: nenhum WebView lab ou listener nas três portas permaneceu. Os dados e builds foram preservados para homologação manual.
- Exclusão completa por Clean, persistência de tokens de login nas janelas, voz real, captura, ICE restart real, presets/layouts/overlay com mídia e comportamento de dispositivos permanecem sem comprovação manual.

O login nas janelas é manual: a skill de controle do computador determina “Do not automate user authentication dialogs.” A autenticação das contas foi validada pelas APIs normais, sem automação dos campos de senha.

Exploração: subagente com override `gpt-6-luna`, esforço `low`. Revisão independente: override `gpt-6.1-sol`, esforço `medium`. A implementação permaneceu na conversa principal. O runtime aceitou esses overrides; não expôs telemetria para comprovar o modelo efetivo nem identificador verificável do principal.
