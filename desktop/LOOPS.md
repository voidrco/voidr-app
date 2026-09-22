# Jornadas com IA · Voidr Loops

A aba **Jornadas com IA** abre a interface original da POC, com o mesmo layout, fontes, timeline, cursor animado, foco e painel de latências. Ela executa uma URL e passos em linguagem natural usando Jev (TypeSafe) e Playwright. O fluxo de captura e os Loops do workspace continuam disponíveis.

## Usar

1. Abra **Jornadas com IA → Configurar conexão** e selecione um arquivo `.env` contendo `TYPESAFE_API_KEY`. `TYPESAFE_DEFAULT_MODEL` é opcional e assume `jev-latest`.
2. Informe a URL e um passo por linha. O exemplo inicial usa `example.com` para demonstrar navegação e verificação sem dados de cliente ou produto.
3. Execute e acompanhe o navegador, o cursor, os passos, as recuperações e as latências. **Parar** cancela a execução.
4. Clique em **Assert · Ver evidência** em um passo concluído para rever a região verificada. **Abrir evidências** abre a pasta local com `result.json`, `final.png`, `trace.zip` e `videos/page-N.webm` (um vídeo por aba).

A chave permanece no arquivo escolhido e no processo da engine; a interface recebe somente o estado da configuração. O app guarda o caminho desse arquivo em `userData/loops/connection.json`. Mover o arquivo exige selecioná-lo novamente.

A execução usa um perfil de navegador novo. Não compartilha login com Chrome/Capture. A página e o contexto dos controles são enviados à API TypeSafe; imagens ficam no preview e nas evidências locais. Essas evidências podem conter dados do produto. Não há envio automático para os Cycles do workspace nem fallback para outro modelo.

## Comportamento

- Uma única jornada ou captura por vez; execução em um `utilityProcess` isolado da janela.
- O Chromium executa sem janela externa no desktop. A prévia permite cliques, rolagem e preenchimento durante uma solicitação de autenticação; “Continuar teste” devolve o controle ao agente, preservando a sessão, o Collector, o trace e o vídeo.
- Modais, frames, contexto de cards e reposicionamento de alvos antes de clicar; sem `force` para atravessar overlays.
- O agente recebe texto visível, nome acessível, seção, placeholder, estado e referências DOM dos controles. Seletores auxiliares dos passos são comparados ao DOM atual; o resultado ajuda a identificar o alvo sem substituir a intenção, o contexto ou as verificações de disponibilidade. Referências técnicas não entram como valores de preenchimento.
- Ações intermediárias podem atingir o objetivo sem reescrever a jornada. Valores solicitados e rejeições do produto são preservados.
- Até três recuperações por passo. Ações com efeito desconhecido não são repetidas no mesmo passo.
- Conclusão exige evidência do estado e Noul ≥ 0,60. Ações ambíguas exigem verificação adicional ≥ 0,60.
- Quando a confiança na escolha da região fica abaixo de 0,50, Jev avalia essa região isoladamente: suficiência da evidência e satisfação da condição precisam atingir 0,60. A conferência no DOM continua obrigatória; a avaliação adicional e sua latência ficam registradas nas evidências.
- As verificações vêm do texto dos passos; não há campo separado de textos esperados. Jev identifica a condição e seleciona uma região de evidência. Playwright reconfere visibilidade, texto e valores; expectativas literais de presença/ausência também são comparadas em código. Relações sem uma expectativa literal continuam dependendo do julgamento semântico, registrado como `semantic+dom`.
- Um passo somente de verificação não altera dados para produzir o resultado esperado. Um assert falho interrompe a jornada como `assertion_failed`; condição, valores observados, probabilidade e screenshot ficam no JSON. O trace contém grupos `ASSERT`, `PASS` e `FAIL`.
- O scroll usa uma animação de 120 ms somente quando necessário, com frames no preview. Substitui a pausa fixa anterior e respeita redução de movimento.
- Trace e vídeo são finalizados antes de anunciar o resultado, inclusive no cancelamento normal. Falhas ao salvar aparecem no resultado. O vídeo é um arquivo WebM junto do trace, não um vídeo embutido no ZIP.
- URLs técnicas dos controles são omitidas do contexto do modelo para evitar estouro de tokens com anúncios. A observação completa e o request/response da decisão ficam no JSON.
- Fechar a janela durante a execução a oculta; sair do app cancela a jornada. Um worker que não encerra em 15 s é interrompido, com aviso de evidências possivelmente incompletas.
- Latências usam tempo exclusivo por operação. “Aplicação / espera” inclui navegação e estabilização do DOM; não representa apenas latência do backend.

## Desenvolvimento e validação

O recebimento de execuções da plataforma no ambiente local usa SSE autenticado no processo principal, restrito à organização e ao usuário conectado. O canal recebe a fila inicial e notificações de novos pedidos. Heartbeats a cada 15 s não consultam o banco; uma reconciliação a cada 60 s recupera notificações perdidas ou pedidos recebidos por outra réplica. A conexão é renovada a cada cinco minutos para refazer a autenticação.

Sem SSE, o desktop consulta a fila em intervalos de aproximadamente 10, 20 e 30 s quando vazia. Falhas usam backoff até 60 s, com jitter. Foco e retorno da rede antecipam a consulta; offline, saída da conta e execução de uma jornada suspendem o recebimento. Não há consultas sobrepostas. O aviso aparece somente após três falhas consecutivas e é removido quando a comunicação volta.

Mudanças no processo principal e no preload precisam ser recompiladas com `npm run build:main --workspace @voidr/capture-desktop` e carregadas ao reabrir o desktop. Atualizar apenas o renderer não carrega os novos handlers IPC. Não executar builds, testes ou reiniciar serviços sem solicitação explícita do usuário.

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
