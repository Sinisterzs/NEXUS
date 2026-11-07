# NEXUS v0.1.1 — Temas Dinâmicos, Foto de Perfil, Detecção Offline e Retorno de Áudio

Esta versão traz importantes melhorias de usabilidade, personalização visual completa, áudio responsivo e correções fundamentais na sincronização de presença em tempo real.

---

### 🎨 1. Personalização Visual & Aparência em Tempo Real
- **Temas Dinâmicos Funcionais:** As opções de aparência agora reagem instantaneamente sem recarregar o aplicativo:
  - **NEXUS Dark:** Visual clássico grafite com acentos carmim inspirados em design gamer escuro.
  - **Midnight Steam:** Preto puro para telas OLED (#090a0e) com destaque azul glacial.
  - **Cyber Slate:** Grafite frio com estética neon ciano e teal inspirada no Opera GX.
- **Escala de Tipografia Ajustável:** As opções `SM`, `BASE` e `LG` alteram a proporção da fonte raiz da interface proporcionalmente.
- **Modo Compacto de Mensagens:** Reduz o padding vertical e espaçamento entre balões de mensagem para maior densidade de leitura no chat.

---

### 📷 2. Foto de Perfil Personalizada
- **Upload de Avatar:** O botão de câmera na aba de perfil agora permite selecionar imagens locais (`PNG`, `JPG`, `WebP`).
- **Persistência Completa:** A imagem é convertida em Data URL de alta performance e persistida nas preferências do usuário.
- **Exibição Universal:** O avatar atualizado é exibido imediatamente no perfil, na barra lateral inferior e em cabeçalhos de conversa.

---

### 👥 3. Sincronização e Detecção Precisa de Amigos Offline
- **Detecção de Conexão Ativa:** O servidor agora valida se um usuário possui de fato uma conexão WebSocket aberta no Gateway antes de marcá-lo como online. Se o aplicativo for fechado, o status passa imediatamente para `offline`.
- **Proteção contra Quedas Abruptas:** Adicionado timeout de inatividade de 60 segundos no Gateway. Desconexões repentinas, travamentos ou perda de sinal de rede são detectados automaticamente pelo servidor e transmitidos para a lista de amigos.
- **Desconexão Limpa:** Implementado evento de `beforeunload` no frontend para notificar o servidor no exato momento em que a janela do app é fechada.
- **Reset de Banco:** Ao iniciar o backend, quaisquer status residuais de execuções passadas no PostgreSQL são redefinidos como `offline`.

---

### 🎧 4. Retorno de Áudio no Teste de Microfone (Loopback)
- **Monitoramento em Tempo Real:** Ao testar o microfone nas configurações de Áudio & Vídeo, o áudio agora é direcionado para os fones de ouvido/alto-falantes selecionados.
- O usuário agora consegue **ouvir exatamente como sua voz soa**, verificando o nível de captação, o volume e a atuação da supressão de ruído e cancelamento de eco.

---

### 🔔 5. Efeitos Sonoros de Mute & Unmute
- **Feedback Acústico Instantâneo:** Integrado sintetizador com Web Audio API para tocar alertas discretos ao alternar o microfone:
  - **Mute:** Dois tons descendentes suaves (480 Hz → 360 Hz) indicando microfone silenciado.
  - **Unmute:** Dois tons ascendentes nítidos (360 Hz → 540 Hz) indicando microfone reativado.
- Também ativo ao alternar o modo ensurdecer (deafen).

---

### 🛠️ 6. Refinamentos Visuais e Interface
- **Versão Alinhada:** Corrigida a identificação da versão no cabeçalho superior esquerdo para refletir a versão atual (`v0.1.1`).
- **Selo de Conexão Limpo:** Removida a menção técnica a `PostgreSQL` no painel de conta online, exibindo apenas o status elegante `Conectado`.

---

### 📦 Arquivos deste Release
| Arquivo | Descrição |
|---|---|
| `nexus-windows-x64.zip` | Pacote compactado de atualização automática para o Tauri Updater |
| `nexus-windows-x64.zip.sig` | Assinatura digital Minisign do pacote de atualização |
| `latest.json` | Manifesto de release do Tauri Updater |
| `nexus.exe` | Executável standalone portátil para Windows |
