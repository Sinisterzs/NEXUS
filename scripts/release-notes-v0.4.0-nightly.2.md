# NEXUS v0.4.0-nightly.2

Compilação experimental (Canal Beta/Nightly) com a correção do compartilhamento de tela nativo da Nightly.1.

### 🛠️ Correções

- **Compartilhamento de tela que falhava ao iniciar:** Corrigido um problema que fazia a transmissão de tela falhar ao ser iniciada em chamadas e canais de voz com outros participantes, mesmo escolhendo um monitor específico ou desativando o áudio e o cursor.
- **Mensagens de erro mais claras:** Quando o compartilhamento de tela não consegue iniciar, o NEXUS agora mostra o motivo real da falha em vez de uma mensagem genérica, facilitando identificar e relatar o problema.
- **Estabilidade da captura no Windows:** Melhorada a compatibilidade da captura de tela com mais placas de vídeo e a negociação do vídeo transmitido com os outros participantes.

### 🚀 Melhorias

- **Diagnóstico para testes:** Foi adicionado um registro local de diagnóstico da captura de tela, salvo no seu computador, para ajudar a investigar qualquer falha que ainda apareça durante os testes. Nenhum dado pessoal ou senha é registrado.
