# AI Tester

## Recorte

Web, executado no desktop. Ao consolidar os testes humanos, o serviço interpreta as sessões e prepara o catálogo de cenários e jornadas do Loop. **Executar com AI Tester** executa uma cópia do plano já preparado, sem gerar outro. PRs e execução remota ficam para depois.

## Planejamento

- A descrição define objetivo, restrições e expectativas.
- Capturas humanas concluídas do mesmo Loop e ambiente fornecem ações, navegação, observações e evidências estruturadas. Capturas identificadas como AI Tester não entram como fonte humana.
- O Loop reúne cenários da feature. Cada cenário representa um comportamento; uma jornada o torna executável e uma execução registra o resultado.
- Cada captura é interpretada pela mesma implementação do MCP `recording_interpret_journey`. Ações estruturadas e relatos humanos continuam sendo a evidência principal; a interpretação é contexto complementar.
- Caminhos semelhantes são agrupados. Só entram variantes explicitamente observadas ou descritas. Não extrapolar dados, papéis, limites ou casos negativos. Cenários sem trecho verificável na fonte são descartados.
- Sugestões de código ficam fora deste recorte conservador.
- Cenários têm identidade persistente e revisões imutáveis. Jornadas e resultados apontam para a revisão usada. O desktop mostra cenários, origens, bloqueios e lacunas de cobertura.
- Expectativas podem ser inferidas do objetivo, da intenção das ações e da sequência capturada, como login abrir a área autenticada ou consulta exibir seu resultado. Continuam identificadas como hipóteses, mas são executáveis; resultados explícitos na descrição continuam identificados como confirmados. A execução verifica ambos contra a página real.
- O catálogo é consultável no desktop e em **O que testar** na página Web do Loop, com passos, pré-condições, dados e fontes. Preparações não aparecem como testes executados nem contam no histórico de resultados.
- Erros observados não viram resultados esperados. Só impedimentos concretos bloqueiam: dados obrigatórios sem valor ou seleção disponível, variáveis não configuradas, etapas essenciais irrecuperáveis ou requisitos conflitantes que impeçam definir a ação ou a verificação. Seletores desconhecidos, cupom opcional vazio e falta de confirmação gravada não bloqueiam. Evidência insuficiente durante a execução resulta em **não foi possível verificar**, nunca sucesso presumido.
- O planejamento usa o provedor estruturado do serviço. O JEV decide como executar cada passo na página. A classificação ação/verificação permanece fixa.

## Execução e resultados

- Jornadas sequenciais, com sessões isoladas e exclusividade com captura manual.
- Acessos do ambiente são resolvidos no processo de execução usando referências `{{env.KEY}}`. Os valores não são enviados ao modelo nem ao renderer. Preenchimento automático de credenciais fica restrito ao domínio do produto.
- Autenticação adicional pausa a execução. O usuário intervém no navegador e continua na mesma sessão.
- Resultados: **passou**, **divergência encontrada**, **não foi possível verificar**. Bloqueios e cancelamentos são registrados separadamente. Falha encerra aquela jornada.
- Cada jornada iniciada pela IA cria uma captura normal do Loop com autoria **AI Tester**. O Collector grava a sessão do navegador; replay, feedback das verificações e sinais técnicos seguem o mesmo fluxo de resultado humano. Planejamento e progresso continuam no registro de execução da IA, vinculado à captura.
- A finalização exige confirmação de gravação selada e indexada pelo Collector. O serviço registra o resultado e cada assert como anotações e usa a consolidação normal do teste. A listagem evita contar a execução de IA novamente quando ela já possui capturas.
- Vídeo e trace Playwright continuam disponíveis na mesma tela de evidências, junto ao replay do Collector. Execuções antigas sem captura mantêm a visualização anterior.
- Screenshots, JSON, vídeo e trace usam armazenamento privado. O desktop mantém um manifesto local e o receipt do Collector; **Reenviar resultados e evidências** retoma uploads e consolidação sem executar a jornada novamente. Falta de receipt é indicada como captura pendente, sem fabricar sucesso de gravação.
- Solicitação, posse do executor e atualizações usam identificadores estáveis. Uma execução iniciada não é transferida automaticamente para outro desktop.

## Limites desta versão

Limites por planejamento: 500 capturas (até 300 ações estruturadas por captura no planejador), 200 cenários e 20 jornadas com passos. Fontes indisponíveis ou maiores que o contexto permitido são sinalizadas. O plano registra lacunas; resultados positivos não significam cobertura completa da feature.

Resolver bloqueios concretos exige atualizar a descrição ou os acessos e consolidar novamente. A nova política é aplicada na próxima consolidação; planos antigos não são desbloqueados automaticamente e resultados anteriores são preservados. Planejamentos do mesmo Loop e ambiente são serializados; a preparação é persistida e pode ser retomada após interrupção. Falhas ficam visíveis e permitem nova tentativa pela consolidação.

Se o desktop encerrar inesperadamente, o reenvio recupera os resultados já gravados e registra a interrupção; não repete ações de resultado desconhecido.

## Validação pelo usuário

Validar pela interface após reiniciar os serviços: consolidar uma sessão humana, consultar o catálogo na Web e no desktop e executar a mesma revisão pelo AI Tester. Não criar nem executar testes automatizados durante o desenvolvimento sem solicitação explícita.
