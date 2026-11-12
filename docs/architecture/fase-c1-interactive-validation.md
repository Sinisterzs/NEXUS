# Fase C.1 — Validação Interativa Real (Windows Desktop)

## 1. Diagnóstico do Ambiente Automatizado (Bloqueio de Sessão)

Durante a verificação da Prioridade 1 da Fase C.1 neste ambiente, foi constatado que o processo do agente **não possui acesso ao desktop interativo do usuário (`WinSta0\Default`)**, operando em um desktop isolado de sandbox:

- `query session`: sessão `console` (ID `1`, usuário `kelma`, estado `Ativo`).
- `whoami /groups`: `LOGON de CONSOLE` (`S-1-2-1`).
- Estação e Desktop do processo: `SessionId=1`, `WinSta=WinSta0`, `Desktop=exebox-Z6ZYVMHF4IQJNO25MNCBSCV63L` (não `Default`).
- `EnumWindows`: `TotalWindows=0`, `VisibleTitledWindows=0` (nenhuma janela real do usuário visível).
- `IDXGIOutput1::DuplicateOutput`: falha imediata com `0x80070005` (`E_ACCESSDENIED`).
- `cargo test --manifest-path src-tauri/Cargo.toml --lib capture`: **6 passed, 0 failed** (testes unitários de parsing, presets, bitrate clamping, resolução par, handles e NALUs — não exercitam captura real do desktop).

Por esse motivo, a validação visual e de captura real (DXGI Desktop Duplication, WGC de janelas reais e UI Tauri) **não pode ser concluída em sessão isolada** e deve ser executada manualmente em uma sessão Windows interativa real (`WinSta0\Default`).

---

## 2. Como Gerar e Executar o Build de Teste em Sessão Interativa Real

Execute os passos abaixo em um terminal aberto diretamente na sessão gráfica do Windows (`WinSta0\Default`):

1. **Verificar dependências e compilar o backend Rust (Tauri):**
   ```powershell
   cargo build --manifest-path src-tauri/Cargo.toml
   ```

2. **Executar o aplicativo em modo de desenvolvimento (Vite HMR + Tauri):**
   ```powershell
   npm run tauri dev
   ```
   *(Alternativa equivalente configurada no projeto: `npm run desktop:dev` ou `npm run dev:all` caso queira subir também o `nexus-server` local.)*

3. **Observações de segurança e higiene (conforme `AGENTS.md`):**
   - Priorize `npm run tauri dev` (Vite HMR) durante a bateria de testes.
   - **Não** execute instaladores NSIS (`setup.exe /S ...`) diretamente no host sem isolar/restaurar a chave de desinstalação do registro.

---

## 3. Checklist Objetivo Passo-a-Passo para Validação Manual

Marque cada item somente após observar o comportamento real na janela do NEXUS e no receptor remoto.

### 3.1 Seletor Próprio e Enumeração de Fontes
- [ ] Abrir uma chamada/sala e acionar o compartilhamento de tela no NEXUS.
- [ ] Confirmar que o **seletor próprio** do NEXUS abre listando monitores e janelas reais (sem abrir o picker nativo do navegador/OS com overlays indesejados).
- [ ] Confirmar que janelas minimizadas, invisíveis ou overlays de sistema irrelevantes não quebram a listagem nem as miniaturas/metadados.

### 3.2 DXGI Desktop Duplication (Monitor)
- [ ] Selecionar o monitor principal (`\\.\DISPLAY1`) e iniciar a transmissão.
- [ ] Confirmar captura fluida do desktop inteiro, sem tela preta e sem `E_ACCESSDENIED`.
- [ ] Se houver monitor secundário, repetir a seleção no segundo monitor e validar resolução/aspecto corretos.
- [ ] Encerrar o compartilhamento e iniciar novamente para confirmar limpeza de recursos DXGI (sem vazamento ou travamento).

### 3.3 WGC (Windows.Graphics.Capture — Janela)
- [ ] Selecionar uma janela real de aplicativo (ex.: navegador, editor ou player) e iniciar a transmissão.
- [ ] Mover uma segunda janela **por cima** da janela capturada e confirmar que a captura WGC continua mostrando apenas a janela alvo (sem oclusão pela janela sobreposta).
- [ ] Minimizar e restaurar a janela capturada; confirmar recuperação limpa da transmissão sem crash.

### 3.4 Borda Amarela (Comportamento Real do Windows)
- [ ] **Em captura de janela (WGC):** observar se a borda amarela padrão do Windows aparece ao redor da janela capturada (ou se está suprimida conforme suporte da versão do Windows 10/11) e registrar o comportamento observado.
- [ ] **Em captura de monitor (DXGI):** confirmar que **não** há borda amarela ao redor da tela.

### 3.5 Cursor e Redimensionamento
- [ ] Mover o cursor do mouse sobre o monitor/janela capturada e confirmar visibilidade e posição corretas no receptor.
- [ ] Redimensionar a janela capturada (aumentar, diminuir, maximizar e restaurar) durante a transmissão ativa e confirmar que o stream se adapta sem artefatos verdes, distorção ou congelamento (resolução par preservada).

### 3.6 Jogos em Janela / Borderless
- [ ] Abrir um jogo ou aplicação DirectX/Vulkan/OpenGL em modo **Janela (Windowed)** e **Sem Bordas (Borderless Windowed)**.
- [ ] Iniciar captura via WGC (janela) e via DXGI (monitor) e confirmar frames contínuos sem tela preta e com áudio/vídeo estáveis.

### 3.7 Qualidade 1080p60 Gratuito
- [ ] Selecionar o preset **1080p @ 60fps** na UI (sem bloqueio ou paywall).
- [ ] Validar no monitor de performance/estatísticas que a resolução entregue é `1920x1080` e o framerate sustenta ~60 fps com conteúdo em movimento.

### 3.8 Encoder HW vs SW Fallback (`mf_encoder`)
- [ ] Verificar nos logs/telemetria se o encoder Media Foundation está utilizando aceleração por hardware (NVENC / AMF / QuickSync) quando disponível.
- [ ] Forçar ou simular indisponibilidade de HW (ou testar em máquina sem encoder HW) e confirmar que o **fallback para SW** entra automaticamente sem interromper a chamada.

### 3.9 Ajuste Dinâmico de Bitrate
- [ ] Durante uma transmissão ativa, variar o movimento na tela (estático vs vídeo/jogo rápido) e/ou simular restrição de banda.
- [ ] Confirmar que o bitrate se ajusta dinamicamente dentro dos limites esperados, mantendo fluidez sem desconexão ou acúmulo excessivo de latência.

### 3.10 Dual-Stream 1:1 + Mesh (3–4 Participantes, 2 Streamers) e Controles de Áudio
- [ ] **1:1:** validar chamada com câmera/áudio + compartilhamento de tela simultâneos (Dual-Stream) entre 2 participantes.
- [ ] **Mesh (3–4 participantes):** conectar 3 a 4 participantes na mesma sala.
- [ ] **2 Streamers simultâneos:** dois participantes transmitindo tela ao mesmo tempo; confirmar renderização e troca de foco/layout na UI sem quedas.
- [ ] **Controles de áudio:** testar **Mute**, **Deafen** e **Volume individual** por participante durante a transmissão ativa e confirmar efeito imediato.
- [ ] **WAN (se aplicável):** validar conectividade e estabilidade de mídia em rede externa/WAN seguindo o runbook [fase-b3-3-wan-homologation-runbook.md](file:///c:/Users/kelma/Documents/Tropa/docs/architecture/fase-b3-3-wan-homologation-runbook.md).
