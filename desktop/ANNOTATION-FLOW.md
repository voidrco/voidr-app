# Contrato de notas durante uma captura

Este documento define o comportamento de produto para notas no Voidr Capture. O objetivo é permitir que a pessoa teste livremente, volte atrás e corrija a anotação sem gerar evidência fantasma nem perder texto por acidente.

## Princípios

- Selecionar algo nunca cria evidência. A evidência existe somente depois de uma nota não vazia ser salva com sucesso.
- `Esc` é sempre seguro: cancela a etapa atual, nunca salva e nunca incrementa o contador.
- Voltar preserva o rascunho; fechar explicitamente descarta o rascunho.
- Uma falha de captura ou rede devolve a pessoa ao mesmo composer, com texto e seleção disponíveis para tentar novamente.
- Durante o salvamento, a ação é single-flight: duplo clique, `Enter` repetido ou dois eventos concorrentes produzem uma única anotação.
- O site capturado e o controle desktop obedecem ao mesmo contrato de teclado.

## Estados

```text
FECHADO
   │ Nota
   ▼
ESCOLHENDO ── Tela ───────────────► ESCREVENDO
   │                                  │
   ├─ Elemento/Região ─► SELECIONANDO │ Salvar
   │                         │         ▼
   │                    seleção     SALVANDO ── sucesso ─► FECHADO
   │                         ▼         │
   └◄──── Esc/Cancelar ── ESCREVENDO ◄─┘ falha
              ▲               │
              └──── Voltar/Esc┘
```

`Esc` em `ESCREVENDO` volta para `ESCOLHENDO` e preserva o texto. Um novo `Esc`, agora no seletor, fecha e descarta. O botão `X` sempre fecha e descarta explicitamente.

## Casos de uso e resultados esperados

| Situação | Resultado |
| --- | --- |
| Abrir **Nota** | Mostra Elemento, Região e Tela. Nenhum contador muda. |
| Clicar novamente em **Nota** | Fecha o seletor e descarta qualquer rascunho. |
| Clicar fora do seletor vazio | Fecha o seletor. O clique no produto continua normal. |
| Escolher **Elemento** | Expande o produto, mostra realce e aguarda um clique. |
| Pressionar `Esc` na seleção de elemento | Remove realce/crosshair imediatamente e volta ao seletor. |
| Escolher **Região** | Expande o produto e aguarda um arraste com mínimo de 8 × 8 px. |
| Pressionar `Esc` ou fazer um arraste inválido | Remove o overlay e volta ao seletor, sem erro e sem evidência. |
| Escolher **Tela** | Abre o composer; a imagem só é capturada quando a nota é salva. |
| Selecionar Elemento/Região | Abre o composer com o alvo apenas em memória. Nenhuma evidência é criada. |
| Pressionar `Esc` ou **Voltar** no composer | Limpa o alvo anterior, volta ao seletor e preserva o texto. |
| Escolher outro tipo depois de voltar | Usa o novo alvo e mantém o rascunho. |
| Clicar no produto enquanto escreve | Mantém o composer e o texto; a pessoa pode conferir a aplicação antes de salvar. |
| Clicar em `X` | Fecha, descarta texto e alvo efêmero. |
| Salvar nota vazia | A ação permanece desabilitada. `Enter` não faz nada. |
| `Enter` | Salva; `Shift+Enter` cria uma nova linha. |
| Duplo clique/`Enter` repetido | Apenas um salvamento é iniciado. |
| Falha ao salvar | Reabre o composer com o mesmo texto e alvo para tentar novamente. |
| Sucesso ao salvar | Incrementa Notas uma vez, mostra confirmação e limpa o estado efêmero. |
| Abrir Evidências durante uma nota vazia | Fecha a nota e abre Evidências. |
| Tentar finalizar com rascunho escrito | Mantém o composer e pede para salvar ou descartar; nada é perdido silenciosamente. |
| Finalizar sem rascunho | Cancela seleção vazia, limpa overlays e finaliza normalmente. |
| Minimizar ou trocar de app | Preserva seleção/composer/rascunho. |
| Fechar a janela durante gravação | Oculta sem destruir a captura; reabrir restaura o mesmo ciclo e estado. |
| Encerrar o processo ou reiniciar a máquina | Rascunhos e seleções não salvos são efêmeros; evidências já confirmadas permanecem duráveis. |
| Navegar/recarregar o site durante o composer | Volta ao seletor, explica que a página mudou e preserva o rascunho; Elemento/Região precisam ser escolhidos novamente. |
| A gravação terminar por outro caminho | Fecha a UI de nota e remove qualquer seleção efêmera. |

## Persistência por modo

| Modo | Nota | Screenshot completo | Recorte | Seletor |
| --- | --- | --- | --- | --- |
| Tela | obrigatório | sim | não | não |
| Região | obrigatório | sim | sim, quando disponível | não |
| Elemento | obrigatório | sim | sim, quando disponível | sim, quando disponível |

O screenshot completo e a anotação textual continuam úteis se o recorte não puder ser produzido. Falhas antes da anotação durável não alteram o contador local.

## Critérios de aceite E2E

1. O `Esc` enviado ao renderer de controle e ao site capturado cancela Elemento e Região.
2. Cancelar, voltar, clicar fora e fechar não alteram `evidence.notes`.
3. Voltar e trocar de modo preserva o rascunho.
4. Elemento, Região e Tela persistem somente depois de confirmação explícita.
5. Região e Elemento persistem screenshot completo e recorte.
6. Depois de salvar, cancelar ou finalizar, o viewport retorna ao tamanho padrão e nenhum overlay fica ativo.
