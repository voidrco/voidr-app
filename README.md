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
