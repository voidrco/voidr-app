# Contrato de notas de voz durante uma captura

Este documento define a experiência de voz do Voidr Capture. Voz é uma evidência deliberada: a pessoa grava, revisa e só então envia. O áudio local não desaparece por falha de rede, timeout ou transcrição.

## Princípios

- Gravar e enviar são ações diferentes. Parar sempre abre uma revisão local.
- Apenas **Descartar** destrói um áudio já gravado.
- Na revisão, a pessoa pode vincular opcionalmente uma região da tela à voz. A voz continua sendo uma única evidência, sem nota sintética ou contador duplicado.
- O recorte é produzido quando a região é escolhida. Enviar depois não recaptura uma tela que pode ter mudado.
- O áudio continua reproduzível depois de uma falha e a nova tentativa reutiliza o mesmo identificador.
- Depois da primeira tentativa de envio, áudio e área ficam congelados pelo `segmentId` até sucesso ou descarte. Mesmo após falha de upload ou navegação, o retry repete exatamente o mesmo payload idempotente.
- O microfone mostra estado, tempo e nível de entrada; nunca existe um toggle cego.
- `Esc` é seguro: durante a permissão cancela a espera; durante a gravação para e abre a revisão; na revisão não descarta.
- `Esc` durante a seleção de área cancela apenas a seleção. Ao alterar uma área, a anterior continua vinculada; o áudio nunca é perdido.
- O limite é 2 minutos e o app para automaticamente antes de excedê-lo.
- Uma voz pendente bloqueia ações que poderiam ocultá-la ou encerrar o ciclo.
- A interface fala em **gravar**, **revisar** e **adicionar ao ciclo**. Detalhes de áudio e transcrição ficam internos.

## Estados

```text
PRONTO ── Voz ──► PEDINDO MICROFONE ── permitido ──► GRAVANDO
  ▲                     │ Esc/falha                        │ Parar/Esc/02:00
  │                     └─────────────────────────────────┤
  │                                                       ▼
  │                                                  PREPARANDO
  │                                                       │
  │                                                       ▼
  ├── Descartar ◄──────────────────────────────────── REVISANDO
  │                                                       │ Enviar
  │                                                       ▼
  │                                                   ENVIANDO
  │                                                       │
  │                              falha ──► ERRO ◄──────────┤
  │                                         │ tentar       │ sucesso
  │                                         └──────────────┤
  │                                                       ▼
  └────────────────────────────────────────────────── CONFIRMADO
```

## Casos de uso

| Situação | Resultado esperado |
| --- | --- |
| Clicar em **Voz** | Fecha superfícies vazias, pede o microfone e mostra progresso. |
| Permissão concedida | Mostra ponto ao vivo, nível e `00:00 / 02:00`. |
| Permissão negada | Explica como liberar o microfone e permite tentar novamente. |
| Microfone inexistente/ocupado | Mostra mensagem específica, sem alterar evidências. |
| `Esc` enquanto pede permissão | Cancela a intenção. Uma resposta tardia é ignorada e o stream é fechado. |
| Clicar **Parar** ou pressionar `Esc` | Para o microfone e abre revisão; não envia. |
| Chegar a 2 minutos | Para automaticamente e abre revisão. |
| Microfone ser desconectado | Preserva o que foi capturado e abre revisão, quando houver áudio. |
| Gravação muito curta | Mantém preview para conferência, mas orienta gravar novamente. |
| Revisar | Permite ouvir com controle nativo, gravar novamente ou descartar. |
| **Gravar novamente** e o novo microfone falhar | Restaura a gravação anterior e explica a falha. |
| A nova gravação ficar curta demais | Descarta apenas a tentativa curta e mantém a gravação anterior. |
| `Esc` durante revisão | Não faz nada destrutivo. |
| Clicar **Selecionar área** | Oculta os controles, expõe toda a aplicação e permite arrastar um recorte. |
| `Esc` antes de concluir a área | Volta à revisão com áudio intacto. Se era uma alteração, preserva a área anterior. |
| `Esc` repetido ou recebido por mais de uma janela | Executa um único cancelamento e preserva exatamente o mesmo áudio e a área anterior. |
| Selecionar uma área | Captura tela e recorte naquele instante, mas mantém ambos apenas localmente até confirmar a voz. |
| Clicar **Alterar** e concluir | Substitui a área anterior pela nova. |
| Clicar **Remover área** | Remove somente o contexto visual; o áudio e o rascunho continuam disponíveis. |
| A página navegar após a seleção | Invalida somente o recorte e pede uma nova seleção; preserva o áudio. |
| Enviar | Mantém o preview enquanto a operação está em andamento. |
| Duplo clique em enviar | Dispara uma única operação. |
| Falha/timeout | Mantém o mesmo áudio, região e identificador e oferece **Tentar novamente**. |
| Rejeição definitiva antes de persistir, como áudio sem fala | Mantém o preview e libera gravar novamente; não força um retry inútil. |
| Tentar alterar/remover a área depois de uma falha de envio | A área permanece bloqueada; retry precisa representar exatamente a tentativa anterior, que pode já ter sido persistida. |
| Tentar gravar novamente depois de uma falha de envio ambígua | Mantém o segmento original e pede confirmar o retry antes de criar outro identificador. |
| Abrir outro convite com captura em andamento | Não troca a missão nem apaga o rascunho; orienta concluir o teste atual primeiro. |
| Resposta perdida depois de persistir | Retry usa o mesmo identificador; servidor e contador deduplicam. |
| Sucesso | Confirma a inclusão, mostra a transcrição e incrementa Voz uma vez. |
| Transcrição vazia | Service devolve falha; o áudio local permanece para nova tentativa. |
| Abrir Nota/Evidências com voz pendente | Mantém Voz visível e pede enviar ou descartar antes. |
| Finalizar com voz pendente | Não finaliza; orienta enviar ou descartar. |
| Fechar a janela | A captura continua viva e a UI volta no mesmo estado ao reabrir. |
| Processo encerrar/reiniciar | Rascunho de voz é efêmero; notas confirmadas permanecem no ciclo. |
| O ciclo terminar externamente | Fecha o microfone e remove dados transitórios que já não podem ser anexados. |

## Critérios de aceite E2E

1. A gravação exibe feedback contínuo de nível e duração.
2. `Esc` para a gravação e abre a revisão sem alterar `evidence.voiceNotes`.
3. O preview é reproduzível antes do envio.
4. Falha de envio preserva o preview e o identificador do segmento.
5. Retry não duplica o segmento nem o contador.
6. Finalizar, Nota e Evidências não fazem um áudio pendente desaparecer.
7. Sucesso remove o áudio local somente depois da confirmação durável.
8. Voz com área chega à revisão como um único feedback, com `cropRef` e fallback para `screenshotRef`.
9. `Esc`, navegação, alteração cancelada e retry nunca apagam o áudio.
10. Retry reutiliza as referências visuais já enviadas e não duplica uploads, transcrição ou contador.
11. Dois sinais simultâneos de `Esc` produzem um único cancelamento e não desalinham UI e processo principal.
