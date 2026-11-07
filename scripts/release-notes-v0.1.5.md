# NEXUS v0.1.5 — Hardening de Segurança, Isolamento Multi-Conta e Estabilidade WebRTC

A versão **v0.1.5** é uma grande atualização com foco em segurança nativa, robustez na concorrência do backend, isolamento estrito de contas no SQLite, negociação idempotente de áudio WebRTC e hardening de CSP no Tauri 2.

---

### 🔒 1. Segurança e Privacidade
- **Vinculação de Tokens à Origem (Origin Binding):** Sessões autenticadas agora são vinculadas criptograficamente ao host/origem de rede no Windows Credential Manager. Tentativas de desvio ou conexão com servidores desconhecidos no cold start retêm o token.
- **Eliminação de Exposição de Tokens ao WebView:** Removido o comando nativo `gateway_get_auth_token`. Todo handshake no WebSocket utiliza tickets efêmeros (`POST /v1/gateway/ticket`, uso único, TTL 60s).
- **Redação de Segredos:** URLs de banco de dados (`DATABASE_URL`), credenciais e tokens são ofuscados nos logs do servidor e do cliente.
- **Revogação Explícita de Áudio:** Ao efetuar logout ou encerrar chamadas, faixas de microfone são fechadas via `track.stop()` e consentimentos nativos são limpos.

---

### ⚡ 2. Backend e Concorrência Resiliente
- **Fechamento Seguro de WebSockets:** O término de uma conexão WebSocket secundária não derruba mais chamadas em andamento de outros dispositivos do usuário.
- **Rate Limiting em Memória com Limite Fixo:** Substituída a confiança cega em `X-Forwarded-For`. Implementado controle com tabela LRU limitada e suporte a proxies locais confiáveis.
- **Serviço de Presença Idempotente:** Sincronização concorrente de presença sem contenção de conexões no PostgreSQL.

---

### 🎙️ 3. Estabilidade Definitiva de WebRTC e Áudio
- **Idempotência de Sinalização SDP:** Tratamento de transições assíncronas no `WebRtcService` (`have-remote-offer`, `have-local-offer`, `stable`). Ofertas duplicadas reutilizam respostas locais válidas sem lançar `InvalidStateError`.
- **Filtro de Instância Ativa (`CallService`):** Candidatos ICE e sinalizações são processados unicamente pela conexão que atendeu a chamada.
- **Servidores STUN Redundantes:** Adicionados servidores STUN oficiais para maior confiabilidade reflexiva em redes NAT e Tailscale.

---

### 💾 4. SQLite, Isolamento de Contas e Mensageria
- **Chave Primária Composta:** Tabela `messages` com `PRIMARY KEY (conversation_id, id)` e conversas com `PRIMARY KEY (account_id, id)`, garantindo isolamento total entre múltiplos perfis.
- **Trava de Migração no Host:** A migração estrutural v3 requer `confirm: true` no frontend E autorização explícita na camada nativa (`NEXUS_ALLOW_DB_MIGRATION_V3=1`). Bancos legados operam perfeitamente no esquema v2 sem migração automática no boot.
- **Backup Atômico e Rollback:** Criação obrigatória de `.bak.v2` com verificação de integridade antes de qualquer alteração de esquema, com rollback testado e validado.
- **Timestamps ISO-8601:** Carimbos temporais normalizados com ordenação monotônica estável.

---

### 🛡️ 5. Tauri 2 e Hardening Desktop
- **Política Restritiva de CSP:** Remoção de `"csp": null` e imposição de `script-src 'self'` sem `unsafe-eval`.
- **CSP Dinâmica no WebView2:** Intercepção em tempo real de requisições de navegação para autorizar cirurgicamente o IP Tailscale configurado (`100.x.x.x`), sem recorrer a wildcards genéricos (`http:`, `ws:`).
- **Validação de URLs Externas (`safe_open_url`):** Rejeição estrita de esquemas perigosos (`file:`, `javascript:`, `data:`) e metacaracteres de injeção de shell.

---

### 📥 Arquivos deste Release
| Arquivo | Descrição | SHA-256 |
|---|---|---|
| `nexus_0.1.5_x64-setup.exe` | Instalador assistido e pacote de atualização automática para Windows | `AAB2FF0FF02749DD11B0C51D3DB052BC55EFAE55A1AF356B98D6159637EDEC9D` |
| `nexus_0.1.5_x64-setup.exe.sig` | Assinatura digital Minisign Ed25519 do instalador | `09E823361614454D33E43D30CA2BD037827C052CB77FFBD38F50EB8F6332D74A` |
| `nexus_0.1.5_x64_en-US.msi` | Pacote Windows Installer (MSI) para ambientes gerenciados | `459BD676B610B5D3F00DCBFD73E4C13FD804DC0E59760684892F91B19779E654` |
| `nexus_0.1.5_x64_en-US.msi.sig` | Assinatura digital Minisign Ed25519 do pacote MSI | `3394F1000A2492E1397B0CF4795FCE9FC14CEB8BDB7001C4C5EB8E7FB6F5AA9E` |
| `latest.json` | Manifesto do Tauri Auto-Updater | `74590741FD80D70229AD24106841A22173F8664CF1384CF7A13485E9F9D6592C` |
| `nexus.exe` | Executável portátil para Windows | `A90248425E4C8FDAF2C8AC4C9F28D692A803467E21080A533A69F0ADC5F07CAC` |
