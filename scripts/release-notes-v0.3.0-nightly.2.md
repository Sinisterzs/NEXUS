## NEXUS v0.3.0-nightly.2 — Calls & Streaming 2.1

Pré-lançamento para Windows. Publicação autorizada após homologação manual aprovada pelo responsável.

### Correções desde a Nightly 1

- Compartilhamento mantém resolução e parâmetros de warmup durante a negociação; a rampa progressiva começa após a resposta SDP.
- Barra de chamada integrada à Sidebar, preservando a área de mensagens. Sidebar recolhida com um único conjunto compacto de microfone/fones e acesso a retornar/desligar.
- Modos Compacto, Equilibrado, Cinema e Tela Cheia com disposição própria e proporção de vídeo preservada.
- Sensibilidade aplicada ao detector de voz em tempo real, mesmo pipeline no teste e na chamada, persistência por conta e indicador verde sem atraso duplicado. O áudio continua sem gate automático.
- FPS solicitado separado da medição de captura/envio/recepção/decodificação. FPS decodificado não é apresentado como renderização do vídeo.
- Diagnósticos de codec/encoder quando disponíveis e preferência por compartilhar uma janela, com avisos para monitor/fonte desconhecida.
- Laboratório local de desenvolvimento com dois perfis isolados e guard de compilação para Debug.

### Antes de homologar

- Indicadores nativos de compartilhamento continuam ativos. Não há solução suportada identificada para remover seletivamente a barra WebView2 dos frames; prefira uma janela e confira a transmissão no receptor.
- Não há garantia de 1080p60, aceleração GPU ou redução de CPU. A integração do monitor auxiliar de long tasks continua pendente.
- A homologação manual foi aprovada pelo responsável; a revalidação desta publicação é automatizada/estática. Isso não representa uma medição independente de desempenho ou aceleração GPU.
- O canal Stable continua em `0.2.1`. Esta versão pertence ao canal Beta/Nightly, usa `latest-nightly.json` e não substitui `latest.json`.
- A Nightly instalada continua sendo uma atualização do NEXUS e pode compartilhar dados de produção com a Stable; para homologação isolada, use o Test Lab Debug. Nightly não implica uma segunda instalação isolada.
