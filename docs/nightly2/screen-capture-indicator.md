# Compartilhamento: fonte selecionada e indicadores

## Resultado implementado

O caminho normal e o fallback de `getDisplayMedia` passam `video.displaySurface: 'window'`. Essa preferência pode destacar a aba de janelas no seletor; o usuário continua podendo escolher outras fontes e o WebView2 pode ignorar o hint. Nenhuma configuração esconde indicador, borda, seletor ou controle de interrupção. `audio: false` permanece nas duas solicitações.

O estado lê `getSettings().displaySurface` e aceita somente `window`, `monitor` ou `browser`. Campo ausente, valor desconhecido ou falha de leitura produz fonte não identificada e aviso conservador. `sourceLabel` usa descrição genérica da categoria: não expõe `track.label`, títulos de janela ou documentos. `captureNotice` alerta monitor/unknown. A preferência não entra em `track.applyConstraints`: resolução e FPS continuam ajustáveis na fonte já autorizada.

O fallback de qualidade reabre um seletor somente para `OverconstrainedError` ou `TypeError`, uma vez, mantendo preferência por janela. Recusa, cancelamento, fonte indisponível, erro de acesso e sessão interrompida não geram nova tentativa. O consentimento temporário nativo continua revogado no `finally`; um stream resolvido após Parar tem suas tracks encerradas. Uma segunda chamada ainda exige escolha/consentimento do usuário, podendo ser rejeitada pelo runtime se a ativação transitória já terminou.

## Origem da barra e limites do diagnóstico

Há mecanismos distintos: a documentação de captura do Chromium identifica um widget de notificação de captura de desktop, com implementação em `screen_capture_notification_ui`; a Microsoft documenta uma borda amarela do Windows.Graphics.Capture ao redor do item capturado. Uma barra com controles é compatível com UI de notificação do runtime, mas isso é uma hipótese para este caso, não uma identificação do processo proprietário. A borda do Windows não deve ser confundida com essa barra.

`ScreenCaptureStarting` do WebView2 controla permitir/cancelar o pedido antes da UI. Não documenta uma opção de excluir somente a barra dos pixels do stream mantendo sua presença local. `getDisplayMedia` também não oferece esse contrato. A exigência W3C de não capturar o prompt de escolha não equivale a excluir indicadores persistentes.

Capturar uma janela é a mitigação suportada para reduzir a área compartilhada. Não há garantia de que uma barra não entre nos frames: depende da superfície efetiva e da composição de janelas no runtime. Nenhuma reprodução de captura real ou comparação A/B foi executada nesta alteração. Não afirmar correção visual comprovada até concluir o ensaio abaixo.

## Integração de interface

Em `CallsView`, apresentar `SCREEN_CAPTURE_SELECTION_NOTICE` antes do clique em Compartilhar e exibir `sourceLabel`/`captureNotice` durante compartilhamento, perto do botão Parar. O aviso não promete exclusão da barra. Manter o botão Parar acessível também em cinema/tela cheia. Se o usuário precisar mudar de monitor para janela, interromper e iniciar uma nova seleção por ação explícita; não fazer troca ou nova captura automaticamente.

## Ensaio manual pendente, coordenado

1. Registrar versão do NEXUS, Windows e WebView2; usar janela de teste sem conteúdo sensível e duas sessões autorizadas.
2. Após clique explícito, selecionar um monitor. Registrar `displaySurface` e observar separadamente indicador local, prévia local e frames recebidos no outro cliente. Uma captura de tela do monitor por si só não prova conteúdo do stream.
3. Parar pelo controle nativo e verificar encerramento no aplicativo/receptor. Iniciar novamente por clique e selecionar a janela de teste; repetir com mesma posição/estado das janelas e indicador. Comparar frames efetivamente recebidos A/B.
4. Identificar o processo proprietário da barra com inspeção de janelas permitida no ambiente de teste. Distinguir widget WebView2/Chromium da borda do Windows; registrar evidência antes de atribuir origem exata.
5. Repetir Parar pelo aplicativo e fechamento da janela capturada; verificar ausência de tracks ativas. Cancelar o seletor e confirmar que não reabre. Se settings não informar tipo, verificar aviso de fonte não identificada.
6. Registrar resultado por runtime/superfície, inclusive barra ainda presente. Não usar flags, patches, afinidade de exclusão, recorte ou supressão de controles de privacidade para obter o resultado.

## Fontes oficiais consultadas

- [Chrome: privacy-preserving screen sharing controls](https://developer.chrome.com/docs/web-platform/screen-sharing-controls#the_displaysurface_option): `displaySurface: 'window'` como preferência de apresentação do seletor. O comportamento documentado para Chrome não prova o comportamento de todas as versões WebView2.
- [W3C Screen Capture, seleção](https://www.w3.org/TR/screen-capture/#dom-mediadevices-getdisplaymedia): livre escolha do usuário, constraints após seleção, consentimento não persistido e prompt fora da nova track.
- [W3C, settings da track](https://www.w3.org/TR/screen-capture/#extensions-to-mediatracksettings): `getSettings` descreve o tipo efetivamente capturado.
- [W3C, feedback durante captura](https://www.w3.org/TR/screen-capture/#feedback-and-interface-during-capture): indicador proeminente, informação sobre conteúdo compartilhado e mecanismo para parar.
- [Microsoft: Windows screen capture](https://learn.microsoft.com/en-us/windows/uwp/audio-video-camera/screen-capture): borda amarela gerida pelo sistema ao usar Windows.Graphics.Capture.
- [Microsoft: WebView2 API overview, controle da UI de captura](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/overview-features-apis#screen-capture): evento `ScreenCaptureStarting` antes da UI, permitindo bloquear ou permitir o pedido.
- [Microsoft: ScreenCaptureStarting event args](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2screencapturestartingeventargs): cancelamento da solicitação e informação sobre o frame solicitante.
- [Chromium: media capture interfaces](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/docs/media/capture/): distinção entre seletor, widget indicador de captura e indicadores de abas; referência ao código de notificação nativa.

## Verificação automatizada

`node --experimental-strip-types tests/screen_capture_policy.test.ts` cobre preferência nas duas aquisições, settings efetivos divergentes do hint, ausência de títulos sensíveis, avisos, falhas sem repetição, fallback com nova escolha, revogação de consentimento, stop durante seleção e encerramento de stream tardio. Usa objetos simulados e não inicia clientes ou captura real.
