# Jornadas com IA · Voidr Loops

A aba **Jornadas com IA** abre a interface original da POC, com o mesmo layout, fontes, timeline, cursor animado, foco e painel de latências. Ela executa uma URL e passos em linguagem natural usando Jev (TypeSafe) e Playwright. O fluxo de captura e os Loops do workspace continuam disponíveis.

## Usar

1. Abra **Jornadas com IA → Configurar conexão** e selecione um arquivo `.env` contendo `TYPESAFE_API_KEY`. `TYPESAFE_DEFAULT_MODEL` é opcional e assume `jev-latest`.
2. Informe a URL e um passo por linha. O exemplo inicial é o fluxo de oito passos do Automation Exercise, com quantidade 3 e remoção do Blue Top.
3. Execute e acompanhe o navegador, o cursor, os passos, as recuperações e as latências. **Parar** cancela a execução.
4. **Abrir evidências** abre a pasta local de evidências. Cada execução gera `result.json`, `final.png` e, quando possível, `trace.zip`.

A chave permanece no arquivo escolhido e no processo da engine; a interface recebe somente o estado da configuração. O app guarda o caminho desse arquivo em `userData/loops/connection.json`. Mover o arquivo exige selecioná-lo novamente.

A execução usa um perfil de navegador novo. Não compartilha login com Chrome/Capture. A página e o contexto dos controles são enviados à API TypeSafe; imagens ficam no preview e nas evidências locais. Essas evidências podem conter dados do produto. Não há envio automático para os Cycles do workspace nem fallback para outro modelo.

## Comportamento

- Uma única jornada ou captura por vez; execução em um `utilityProcess` isolado da janela.
- Modais, frames, contexto de cards e reposicionamento de alvos antes de clicar; sem `force` para atravessar overlays.
- Ações intermediárias podem atingir o objetivo sem reescrever a jornada. Valores solicitados e rejeições do produto são preservados.
- Até três recuperações por passo. Ações com efeito desconhecido não são repetidas no mesmo passo.
- Conclusão exige evidência do estado e Noul ≥ 0,60. Ações ambíguas exigem verificação adicional ≥ 0,60.
- URLs técnicas dos controles são omitidas do contexto do modelo para evitar estouro de tokens com anúncios. A observação completa e o request/response da decisão ficam no JSON.
- Fechar a janela durante a execução a oculta; sair do app cancela a jornada. Um worker que não encerra em 15 s é interrompido, com aviso de evidências possivelmente incompletas.
- Latências usam tempo exclusivo por operação. “Aplicação / espera” inclui navegação e estabilização do DOM; não representa apenas latência do backend.

## Desenvolvimento e validação

```bash
npm ci
npx playwright-core install chromium
npm run typecheck
npm test
npm run build
VOIDR_LOOPS_ENV_FILE=/caminho/.env.staging npm run smoke:loops
```

O smoke usa um perfil temporário separado, executa o exemplo real pela interface, valida o resultado e o preview após recarregar a janela. Requer rede e consome a API TypeSafe. Screenshots ficam em `runs/loops-smoke`.

```bash
npm run capture:package:local
```

O empacotamento instala Chromium da versão fixada de `playwright-core`, inclui o runtime e o navegador no bundle, e não inclui o `.env`. O bundle local é copiado para a raiz do projeto no macOS. O nome e a identidade de distribuição continuam **Voidr Capture**, preservando atualizações e links `voidr://`; a funcionalidade aparece como **Voidr Loops / Jornadas com IA**.

A engine fica em `packages/loops-engine`; contrato IPC em `desktop/src/shared/journeys.ts`; processo principal e worker em `desktop/src/main/loops-*`; UI em `desktop/src/renderer/loops`.
