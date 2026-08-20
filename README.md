# Voidr App

Aplicação desktop oficial da Voidr para coordenar verificações Web, Mobile e API com evidências
estruturadas, replay, anotações e entrega de contexto ao Voidr Loops.

Loops chegam pelo contrato secret-free `VOIDR-CAPTURE-LAUNCH/1`; Platform abre
`voidr://capture/...` diretamente e Cursor, Codex e Claude Code usam o bridge MCP
stdio local do Hive. O bridge abre o mesmo descriptor no computador do harness e
devolve `VOIDR-APP-LAUNCH/1`, sem depender de uma instrução textual ao modelo. O
app resolve o Cycle autenticado antes de iniciar qualquer adapter. O descriptor
carrega somente o `organizationId` não secreto necessário para selecionar o tenant;
ele nunca concede acesso por si só.

## Desenvolvimento

Requer Node.js 22 ou superior.

```bash
npm ci
npm run typecheck
npm test
npm run dev
```

Convites externos usam o mesmo tenant Auth0, mas um Native Application e um
audience exclusivos. Para exercitar esse fluxo no desktop, configure no processo
main (client id é público; nunca inclua client secret):

```bash
VOIDR_PARTICIPANT_AUTH_DOMAIN=tenant.auth0.com
VOIDR_PARTICIPANT_AUTH_CLIENT_ID=native-public-client-id
VOIDR_PARTICIPANT_AUTH_AUDIENCE=https://api.voidr.co/loop-participant
```

O login usa Authorization Code + PKCE e callback loopback. O access token fica
somente na memória do main process e não cruza o deep link, renderer ou página capturada.

Para validar o fluxo Web com o ambiente Verification local ativo:

```bash
npm run smoke:web
```

Para gerar os artefatos da plataforma atual:

```bash
npm run capture:make
```

A arquitetura, suporte Android e limites atuais estão em
[`desktop/README.md`](./desktop/README.md). O threat model e os gates obrigatórios de distribuição
estão em [`desktop/SECURITY.md`](./desktop/SECURITY.md).
