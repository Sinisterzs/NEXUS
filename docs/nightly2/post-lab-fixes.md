# Nightly 2 — correções pós-homologação

Data: 11/11/2026. Trabalho dividido em três agentes em paralelo, com integração no principal e revisão independente. As alterações Nightly 2 e Test Lab já presentes no workspace foram preservadas.

## Sidebar e ActiveCallBar

Causa: a Sidebar recolhida tem 64 px, mas o dock reservava 20 px de padding horizontal e mantinha dois botões numa linha interna. A coluna era aplicada ao contêiner externo, sem empilhar o grupo de microfone/fones. Padding, gaps e encolhimento flex disputavam o espaço disponível. ActiveCallBar também usava alvos dimensionados pelo conteúdo.

Correção: microfone/fones empilhados no dock recolhido; botões com largura/altura mínimas de 36 px, `shrink-0`, alinhamento central, rótulos acessíveis, `aria-pressed` e foco visível nos dois layouts. A navegação e os demais elementos da interface foram mantidos.

Arquivos: `src/app/Sidebar.tsx`, `src/components/ActiveCallBar.tsx`.

Validação no Lab: interfaces A/B carregadas com suas contas de teste; Sidebar expandida e recolhida inspecionadas visualmente. Uma chamada local foi iniciada em A e atendida em B, com A silenciado e B ensurdecido para testar os controles sem retorno acústico. Foi observado o contador ativo (mais de 20 s) e ActiveCallBar em layout expandido e com controles verticais durante o recolhimento. O teste não comprova qualidade audível. Mudanças em arquivos de teste provocaram reload do Vite e encerraram a chamada de ensaio; HMR/reload não deve ser interpretado como teste de reconexão ICE.

Pendente: confirmar o layout final em Cinema com transmissão ativa, várias alturas de janela, zoom/DPI e navegação por teclado durante uma sessão longa.

## Barra de compartilhamento

O caminho do NEXUS é `getDisplayMedia` → seletor/runtime WebView2 → track de vídeo → WebRTC. O aplicativo não desenha a barra nativa relatada. Uma barra com controles é compatível com a notificação de captura do runtime Chromium/WebView2; a borda amarela do Windows.Graphics.Capture é um indicador diferente. Sem identificar a janela/processo proprietário e comparar os frames recebidos no teste real, a origem exata e sua inclusão na transmissão continuam sem comprovação.

Não foi encontrada uma API documentada que exclua apenas essa barra dos frames, mantendo o indicador local, no caminho atual. A implementação usa a preferência suportada `displaySurface: 'window'` nas duas aquisições (normal/fallback), preservando a escolha livre do usuário. `getSettings().displaySurface` identifica a fonte efetiva, sem presumir que o hint foi obedecido. O tipo da fonte é exibido sem usar o título da janela; monitor/fonte desconhecida produzem aviso. A interface sugere janela antes da seleção e preserva Parar. Cancelamento, negação e outros erros de acesso não reabrem o seletor; o fallback de compatibilidade/qualidade respeita encerramento da sessão e libera streams tardios.

Não houve supressão de indicadores, flags, patches, recorte ou mudança de STUN/TURN/P2P. A preferência por janela reduz a superfície compartilhada; não garante a ausência da barra em toda versão do runtime. Captura real/comparação dos frames A/B seguem pendentes, conforme o roteiro e as [fontes oficiais](screen-capture-indicator.md).

Arquivos: `src/services/ScreenCaptureService.ts`, `src/lib/screenCapturePolicy.ts`, `src/stores/useAppStore.ts`, `src/features/calls/CallsView.tsx`, `tests/screen_capture_policy.test.ts`.

## Sensibilidade do microfone

Causas encontradas:

- Settings usava `VoiceActivityDetector` com energia normalizada em 0–100; a chamada usava média de bytes e fórmula de limiar legadas, sem o mesmo ataque/histerese/hangover.
- O efeito de teste capturava configuração na criação do detector; mover o slider recriava recursos em vez de atualizar uma única instância de monitoramento.
- `voiceHangoverMs`, `voiceAutoSensitivity` e `voiceSoftGate` não atravessavam save/hidratação do store, apesar do suporte no repositório de preferências.
- CallService acrescentava outro hangover ao callback local, atrasando a remoção do indicador verde.
- Timers de calibração/mensagem não eram cancelados na limpeza, e contextos suspensos não eram retomados explicitamente.

Correções: Settings e chamada usam o mesmo pipeline Analyser/VAD, mesma normalização e cadência de 50 ms. Sensibilidade e hangover são atualizados ao vivo, sem substituir stream/fonte/analyser ao mover o slider. Mute reseta o detector, impedindo retorno de um hangover antigo após unmute. Medidor/badge usam o resultado do mesmo detector; o indicador verde da chamada recebe o estado estabilizado, sem segundo atraso local. Timers de calibração são cancelados e AudioContext suspenso tem retomada solicitada. Preferências são salvas/restauradas por conta, com defaults na conta que não as possui.

O áudio continua sem gate de voz; o VAD não altera as tracks transmitidas. O controle que prometia silenciamento automático foi substituído pela informação de que essa função está indisponível e a transmissão permanece contínua. Mute/deafen explícitos continuam funcionando. `voiceAutoSensitivity` é uma preferência legada preservada; a calibração implementada é manual, não ajuste contínuo automático do ganho.

Arquivos: `src/lib/voiceActivity.ts`, `src/services/WebRtcService.ts`, `src/features/settings/SettingsView.tsx`, `src/services/CallService.ts`, `src/stores/useAppStore.ts`, `tests/microphone_integration.test.ts`, `tests/post_lab_preferences.test.mjs`.

Pendente: repetir fala baixa/normal/alta e ruído real no hardware do usuário, confirmar calibração em ambiente silencioso, comparar medidor/verde nos dois clientes e verificar o comportamento com WebView em segundo plano. A chamada de layout foi feita com áudio silenciado e não comprova esses itens.

## Validação e revisão

- `npm test`: suíte completa aprovada, incluindo os três arquivos de regressão novos adicionados ao script em `package.json`.
- `npx tsc --noEmit`: aprovado.
- VAD: testes de limiar/histerese/calibração existentes, mais integração com AudioContext/analyser simulados no próprio WebRtcService. O teste verifica atualização ao vivo, mesma fonte, intervalo real configurado de 50 ms, hangover de oito ticks para 400 ms e reset no mute.
- Preferências: bundle dos módulos reais de store/repositório, adaptador de armazenamento em memória e autenticação simulada somente no teste. Valida save/flush/load/hidratação A→B→A e indicador local desligando imediatamente após callback estabilizado falso. Não acessa credenciais, arquivos ou backend reais.
- Captura: 7 testes novos com mídia simulada e 15 regressões de chamadas/streaming. Não inicia captura de tela real.
- `scripts/test-lab.ps1 -Live`: aprovado com os perfis A/B, SQLite/diretórios separados, argumentos reais de perfil WebView2, serviços loopback e HTTP 403 para arquivo sentinela privado.
- Revisão independente encontrou a cadência real de 100 ms ainda divergindo do delta de 50 ms; foi corrigida, e a regressão passou a verificar o atraso recebido pelo timer e a duração do hangover. Reinspeção sem bloqueadores restantes.
- Diff check dos arquivos alterados nesta etapa: aprovado. O diff geral ainda contém uma linha em branco no final de `tests/calls_and_streaming_v030.test.ts` que já existia e foi preservada.

Não foram feitos builds Release, instaladores, commits ou publicações. Stable, configuração de produção e rotas P2P/TURN não foram alteradas. O Lab utilizou o backend existente validado por seus processos/portas; uma tentativa de iniciar outro backend foi recusada pela porta ocupada, sem encerrar o serviço existente.

## Modelos comprovados

Os campos `session_meta.source.subagent.thread_spawn.agent_path` e `turn_context.model/effort` dos registros locais confirmam:

| Agente | Modelo registrado | Esforço registrado |
| --- | --- | --- |
| sidebar_ui | gpt-6-luna | low |
| screen_capture | gpt-6.1-sol | medium |
| microphone | gpt-6-luna | low |
| post_lab_review | gpt-6.1-sol | medium |

O [extrato de evidências](post-lab-agent-models.json) contém os IDs e caminhos dos registros, sem mensagens ou segredos. Não se baseia em autorrelato dos agentes. O principal coordenou, integrou persistência/indicador/avisos e executou a validação; os três escopos foram efetivamente delegados.
