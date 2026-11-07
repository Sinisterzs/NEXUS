# NEXUS — Segurança de Transporte, ACLs e Integração com Tailscale

Este documento detalha o modelo de segurança, as políticas de controle de acesso (ACL) e as características do transporte de rede para a comunicação entre os 3 usuários do **NEXUS** sem a necessidade de VPS paga.

---

## 1. Modelo de Defesa em Profundidade (Defense-in-Depth)

O NEXUS utiliza múltiplas camadas de isolamento e controle:

1. **Camada de Transporte (WireGuard P2P):** Todo o tráfego HTTP e WebSocket entre os clientes e o computador principal trafega dentro do túnel WireGuard criptografado do Tailscale (ChaCha20-Poly1305, Curve25519). Não há portas abertas no roteador doméstico nem exposição na internet pública.
2. **Restrição de Socket no Sistema Operacional:** O `nexus-server` faz bind exclusivo nas interfaces `127.0.0.1` (loopback) e no IP da interface Tailscale (`100.x.y.z`). A porta 3001 **não é aberta em 0.0.0.0**, garantindo que dispositivos na rede Wi-Fi local não consigam acessar o backend.
3. **Regra de Firewall Dedicada:** O Windows Defender Firewall bloqueia conexões de entrada na porta 3001 vindas de qualquer endereço fora do bloco `100.64.0.0/10` e `127.0.0.1`.
4. **Isolamento Total do PostgreSQL:** O PostgreSQL escuta estritamente em `127.0.0.1:5432` (`listen_addresses = 'localhost'` e `pg_hba.conf` restrito a `127.0.0.1/32` e `::1/128`). O banco de dados **nunca é exposto** nem mesmo aos outros nós do Tailnet.
5. **Autenticação de Aplicação Estrita:** A presença de um IP no bloco `100.64.0.0/10` **não concede acesso ou autorização**. Toda requisição exige autenticação NEXUS com tokens JWT, credenciais salgadas (Argon2), sessões persistentes no PostgreSQL e tickets efêmeros (60s) para o WebSocket.

---

## 2. Política de Controle de Acesso (ACL) no Tailscale Admin

No painel do Tailscale (*Tailscale Admin Console → Access Controls*), copie e aplique a política contida em `docs/tailscale-acl.json`:

```json
{
  "tagOwners": {
    "tag:nexus-server": ["autogroup:admin"],
    "tag:nexus-client": ["autogroup:admin"]
  },
  "acls": [
    {
      "action": "accept",
      "src": ["tag:nexus-client", "autogroup:admin"],
      "dst": ["tag:nexus-server:3001"]
    }
  ]
}
```

### Atribuição das Tags:
* **Computador Principal (Host):** Atribua a tag `tag:nexus-server`.
* **Computadores dos 2 Amigos:** Atribua a tag `tag:nexus-client`.
* **Resultado:** Os amigos conseguem alcançar exclusivamente a porta `3001` do host. Qualquer tentativa de acessar outras portas (como portas SMB, SSH, PostgreSQL 5432 ou RDP) é descartada diretamente pelo kernel do Tailscale.

---

## 3. Características e Limitações de Segurança do Transporte

* **Criptografia em Trânsito:** Criptografia ponta-a-ponta nativa do protocolo WireGuard.
* **Inspeção de Rede Local:** O tráfego não pode ser lido por provedores de internet (ISP) ou pessoas conectadas na mesma rede Wi-Fi pública/doméstica.
* **Limitações:** O transporte dentro do túnel opera em HTTP claro sobre WireGuard. Se um dispositivo no Tailnet for comprometido com privilégios de administrador (root), o administrador desse dispositivo pode capturar pacotes locais. Para ambientes corporativos de desconfiança mútua total, pode-se emitir certificados automáticos via `tailscale cert nexus-server.ts.net` para adicionar TLS sobre WireGuard. Para grupos de amigos de confiança, a criptografia WireGuard é suficiente e padrão.

---

## 4. Resolução Automática via MagicDNS

Com o MagicDNS ativado no Tailscale:
* O computador principal responde pelo nome `nexus-server` ou `nexus-server.<seu-tailnet>.ts.net`.
* Os clientes desktop NEXUS resolvem automaticamente `http://nexus-server:3001` sem necessidade de memorizar ou digitar endereços IP.
