# Voidr App

Aplicação desktop oficial da Voidr para capturar verificações Web e Mobile com evidências
estruturadas, replay, anotações e entrega de contexto ao Voidr Loops.

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
