# Nightly 2 — polimento estático final

Data: 11/11/2026. Esta etapa usa somente leitura/edição de código, consulta de documentação por busca e verificações isoladas. Nenhum aplicativo, navegador desktop, cliente A/B, backend ou Test Lab foi iniciado/controlado. Não foram acessados credenciais, dados pessoais ou arquivos de sessões. Não houve captura de tela, automação de interface, instalação, build Release ou publicação.

## Correção da Sidebar

**Causa:** `Sidebar.tsx` renderizava `<ActiveCallBar />` e o dock permanente sem coordenação. Quando recolhida e fora da aba `calls`, uma chamada diferente de `idle` fazia `ActiveCallBar.tsx` renderizar seu conjunto compacto de mic/deafen, retorno e desligar; o dock permanente acrescentava outro conjunto de mic/deafen abaixo.

**Alteração mínima:** a Sidebar agora observa `voiceCallState` e omite o dock permanente inteiro quando:

```ts
isSidebarCollapsed && voiceCallState !== 'idle' && activeTab !== 'calls'
```

Isso corresponde às condições em que `ActiveCallBar` realmente exibe os controles compactos. Não se oculta somente o conteúdo interno: o contêiner, padding e borda do dock redundante também deixam de existir, sem espaçador vazio. Ao voltar a `idle`, o dock normal reaparece por renderização reativa.

| Sidebar | Estado | Aba | Resultado |
| --- | --- | --- | --- |
| Recolhida | `idle` | Qualquer | Dock normal; ActiveCallBar ausente |
| Recolhida | `calling`, `incoming`, `connecting`, `connected`, `reconnecting` | Fora de `calls` | Apenas controles compactos do ActiveCallBar; dock permanente ausente |
| Recolhida | Qualquer chamada | `calls` | Dock normal preservado, pois ActiveCallBar retorna `null`; controles da tela principal intactos |
| Expandida | `idle` | Qualquer | Comportamento anterior: dock normal |
| Expandida | Qualquer chamada | Fora de `calls` | Comportamento anterior preservado: ActiveCallBar expandido e dock permanente |
| Expandida | Qualquer chamada | `calls` | Dock normal; ActiveCallBar ausente |

O ajuste é limitado à duplicação no modo recolhido. Não redesenha o modo expandido nem os controles da tela principal. A árvore do ActiveCallBar não foi modificada nesta etapa: permanecem botões funcionais, alvos de mic/deafen de 36 px, tooltips, rótulos, estado pressionado, foco, retorno, desligar e os indicadores já existentes. Indicadores de transmissão não foram removidos ou alterados.

Arquivos desta etapa:

- `src/app/Sidebar.tsx`: seletor de estado e condição do dock.
- `tests/sidebar_controls.test.mjs`: renderização HTML estática dos componentes reais, com store/ações substituídos por stubs antes do bundle. Nenhum serviço do aplicativo é importado/executado.
- `package.json`: inclui o novo teste em `npm test`, sem dependências adicionais.
- Este relatório: diagnóstico de captura e registro da validação.

`ActiveCallBar.tsx`, `ScreenCaptureService.ts`, Tauri e os controles da tela principal não recebem alterações nesta etapa. Mudanças dessas áreas já presentes no workspace pertencem às etapas anteriores e foram preservadas.

## Barra nativa do compartilhamento

### Origem e escopo do diagnóstico

A mensagem informada, `http://127.0.0.1:1420 está compartilhando sua tela`, identifica o origin da página que iniciou `getDisplayMedia`, no ambiente de desenvolvimento. O serviço React solicita a captura; WebView2/Chromium controla o seletor e a notificação nativa. Essa barra não é um elemento DOM do NEXUS e não está sob controle de CSS React. A borda de captura gerida pelo Windows é um indicador separado.

Conclusão estática: **não foi encontrada uma API oficialmente documentada no caminho atual para remover seletivamente essa barra ou excluí-la dos frames, mantendo os indicadores locais de segurança.** Isso não prova que a barra esteja sendo transmitida neste runtime. Sem ensaio autorizado dos frames recebidos, sua inclusão permanece desconhecida. Nenhuma captura foi feita nesta etapa.

### Caminho atual

`ScreenCaptureService.ts` sinaliza consentimento temporário ao Tauri, chama `navigator.mediaDevices.getDisplayMedia()`, lê settings da track e fornece um `MediaStream` ao WebRTC existente. O Tauri decide permitir/negar `DisplayCapture`; esse consentimento não é uma API de manipulação da barra. A preferência por janela já existe na aquisição normal e no fallback, e a fonte efetiva vem de `track.getSettings().displaySurface`, não do hint ou título da janela.

### Alternativas suportadas e limitações

| Alternativa | Vantagem | Limitação / recomendação |
| --- | --- | --- |
| Preferência `displaySurface: 'window'` | Menor superfície compartilhada; mantém seletor e indicadores; já implementada | É preferência, não garantia de seleção nem de exclusão da barra. Manter e orientar janela específica |
| Captura de monitor | Permite demonstrar várias aplicações | Inclui a composição do desktop; pode expor notificações/controles. Manter aviso e não prometer remoção da barra |
| `monitorTypeSurfaces: 'exclude'` | Opção documentada pelo Chrome para não oferecer monitor inteiro | Suporte/comportamento WebView2 precisa de validação por runtime; reduz funcionalidade. Apenas opção futura de produto, sem alteração agora |
| `ScreenCaptureStarting` | Host pode cancelar a solicitação ou adiar a decisão | Cancelar impede a captura; não exclui pixels de uma captura permitida. Não usar como solução para a barra |
| Region Capture / Element Capture | Restringem captura de aba ao retângulo/DOM desejado | Não são APIs genéricas para excluir uma janela de notificação externa de uma captura de monitor/janela |
| Windows.Graphics.Capture nativo | Origem de frames e ciclo de captura sob controle do código Windows | Exige projeto separado de integração com WebRTC; mantém avisos/indicadores do Windows. Não implementado nesta tarefa |

O [Chrome documenta `displaySurface` e `monitorTypeSurfaces`](https://developer.chrome.com/docs/web-platform/screen-sharing-controls). A documentação descreve o comportamento do Chrome; não certifica todas as versões do WebView2. O [rascunho W3C Screen Capture](https://www.w3.org/TR/screen-capture/) preserva escolha/consentimento do usuário e descreve feedback durante a captura. A condição da fonte deve ser conferida pelos settings; não inferida da preferência enviada.

Na API estável [ICoreWebView2ScreenCaptureStartingEventArgs](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2screencapturestartingeventargs), `Cancel` cancela o pedido e causa `NotAllowedError`. `GetDeferral` adia a decisão. **`Handled` controla a propagação dos handlers entre frame e WebView; não é um interruptor para ocultar a barra.** Nenhum desses membros documenta edição dos frames capturados ou supressão seletiva de indicadores numa captura permitida.

[Region Capture](https://developer.chrome.com/docs/web-platform/region-capture/) opera sobre uma captura de aba, recortando uma região de interesse. [Element Capture](https://developer.chrome.com/docs/web-platform/element-capture/) restringe essa captura a uma subárvore DOM. Uma janela nativa do runtime ou a composição de outro aplicativo não é um elemento DOM capturável por essas APIs. Não são recomendadas para mascarar a barra relatada.

### Viabilidade futura de captura nativa Windows

A [API Windows.Graphics.Capture](https://learn.microsoft.com/en-us/windows/apps/develop/media-authoring-processing/screen-capture) oferece seleção de janela/monitor e frames via Direct3D, com UI de seleção e borda geridas pelo sistema. O [interop `CreateForWindow`](https://learn.microsoft.com/en-us/windows/win32/api/windows.graphics.capture.interop/nf-windows-graphics-capture-interop-igraphicscaptureiteminterop-createforwindow) também permite criar um item para um HWND. O uso de interop não elimina a obrigação de seleção/consentimento explícitos no produto.

Para o NEXUS, isso exigiria gerenciar dispositivo/frame pool/sessão no Rust, redimensionamento, fechamento da fonte, sincronização, liberação e backpressure. Os frames nativos não são automaticamente uma `MediaStreamTrack` disponível ao `RTCPeerConnection` JavaScript. Seria preciso avaliar uma ponte para uma fonte de vídeo compatível no frontend ou uma arquitetura de mídia nativa. Transportar imagens/frames completos por IPC JSON tende a impor cópias/latência e não deve ser presumido adequado para 1080p60. Essa avaliação é inferência arquitetural baseada no código atual; não houve protótipo ou benchmark.

Substituir completamente a aquisição por uma origem nativa deixaria de iniciar essa captura através de `getDisplayMedia`; isso é uma alternativa de arquitetura, não uma API para ocultar a barra atual. Indicadores Windows e meios claros de parar continuariam necessários. Não há garantia de aceleração GPU, ausência de toda UI na imagem, qualidade ou desempenho. Não se recomenda substituir o pipeline nesta Nightly.

### Recomendação

Manter seleção de janela, rótulo da superfície efetiva, aviso para monitor/fonte desconhecida e controles de parada existentes. Não alterar runtime, flags, indicadores, CSS ou sobreposições para esconder a barra. Caso seja requisito futuro ter outra origem de captura, abrir uma tarefa específica de prova de conceito Windows, preservando indicadores, consentimento e P2P/TURN até existir uma proposta validada.

## Verificações e limites

- `node --test tests/sidebar_controls.test.mjs`: aprovado; 96 combinações de estado/aba/recolhimento/mute/deafen, mais três renderizações na sequência `connected → idle → connected`. Conta os botões realmente renderizados, verifica retorno/desligar e ausência do contêiner redundante. Não monta navegador ou aplicativo, nem exercita handlers ou uma transição reativa montada.
- `npx tsc --noEmit`: aprovado.
- Inspeção estática do diff desta etapa: condição acompanha o `return null` do ActiveCallBar, preserva o fallback na aba `calls` e não modifica captura/transportes.
- Revisão independente somente leitura concluída, sem achados bloqueadores.
- Homologação visual, teclado/foco/tooltips, zoom/DPI/Cinema e comparação de frames recebidos continuam pendentes. Os testes HTML não medem geometria nem pixels de uma transmissão real.

Agentes selecionados explicitamente: `sidebar_explorer` e `capture_explorer` com `gpt-6-luna`, esforço `low`; revisão final com `gpt-6.1-sol`, esforço `medium`. As chamadas de colaboração aceitam esses overrides; a resposta da ferramenta não fornece confirmação independente do modelo efetivo. Nenhum arquivo de sessões foi consultado nesta etapa para obter essa informação.
