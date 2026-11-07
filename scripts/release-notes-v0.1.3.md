# NEXUS v0.1.3 — Resiliência de Áudio WebRTC e Sincronização de Versão

Esta atualização corrige o erro `OverconstrainedError` ao iniciar chamadas de voz, traz captura resiliente com fallback inteligente de dispositivos de som e unifica o controle de versão em toda a interface do aplicativo.

---

### 🎙️ 1. Correção Crítica de Áudio WebRTC (`OverconstrainedError`)
- **Restrições Flexíveis de Captura:**
  - Substituição da restrição estrita `exact` por `ideal` nos identificadores de dispositivo de microfone (`deviceId`).
  - Remoção de canais fixos (`channelCount: 1`), garantindo compatibilidade imediata com placas de som Realtek, headsets USB, microfones Bluetooth e interfaces de áudio variadas.
- **Mecanismo de Fallback em Cascata:**
  - Se o dispositivo previamente configurado tiver sido desconectado ou o identificador mudar entre sessões, o NEXUS tenta manter os filtros de DSP (cancelamento de eco e supressão de ruído) com o microfone padrão.
  - Se o driver de som ainda assim recusar restrições avançadas, a chamada conecta diretamente via áudio padrão do sistema operacional sem interromper a chamada ou lançar erro na interface.
- **Teste de Microfone Resiliente:**
  - A mesma proteção e tolerância a falhas foi aplicada à tela de configurações de Áudio & Vídeo para testes de microfone sem interrupções.

---

### 🏷️ 2. Sincronização Global da Versão
- Centralização da versão do aplicativo no frontend (`APP_VERSION`), sincronizando perfeitamente a barra de título superior (`TitleBar`) e a aba de Informações do Sistema (`SettingsView`).
- Todas as visualizações agora exibem consistentemente a versão atual instalada.

---

### 📥 Arquivos deste Release
| Arquivo | Descrição |
|---|---|
| `nexus_0.1.3_x64-setup.exe` | Instalador oficial e pacote de atualização automática para Windows |
| `nexus_0.1.3_x64-setup.exe.sig` | Assinatura digital Minisign do instalador |
| `latest.json` | Manifesto de verificação automática do updater |
| `nexus.exe` | Executável standalone portátil para Windows |
