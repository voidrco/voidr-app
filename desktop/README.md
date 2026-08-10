# Voidr Capture Desktop

O Voidr Capture Desktop é o control plane Electron para captura Web, Mobile e API. O Service continua
sendo a autoridade de lifecycle e billing, o Collector continua sendo a autoridade da Session e o
Voidr Platform continua sendo a experiência canônica de replay, comparação, report e Defects.

## Estado deste corte

- Launch canônico: `voidr://` sem segredo, tenant explícito e não autorizativo,
  resolução org-scoped, startup, recriação de janela e second-instance.
- Handoff MCP: bridge stdio único para Cursor, Codex e Claude Code, abertura automática,
  receipt `VOIDR-APP-LAUNCH/1` e supressão de retries duplicados.
- Web gerenciado: capability isolada no main process, `WebContentsView` sandboxed, rrweb, páginas, cliques, requests,
  erros, screenshots, notas, seleção nativa de elemento, voz/transcript, Stop single-flight, seal,
  attach e deep link para o Cycle.
- Android: Doctor/descoberta por ADB, abertura allowlisted do package, descoberta da Session emitida
  pelo SDK e attach CAS ao Cycle local. A evidência semântica é capturada pelo SDK Voidr; o desktop
  não falsifica replay mobile.
- UI: componentes e tokens do Voidr Design System, logo oficial, estados honestos e finalização
  resumível.
- API: Cycle e surface chegam ao app sem cair no adapter Web; proxy/CA ainda permanecem indisponíveis
  até o gate de segurança.
- Não incluídos neste corte: autenticação PKCE de produção, região livre, Appium/scrcpy, iOS,
  proxy de API e distribuição pública assinada.

## Executar

Na raiz de `voidr-app`:

```bash
npm ci
npm run typecheck
npm test
npm run dev
```

Com o ambiente Verification local ativo, o smoke cria/reutiliza o fixture checkout-retry, realiza
uma captura real, anexa screenshot, sela a Session e aguarda o Cycle:

```bash
npm run smoke:web
```

Para gerar o app local sem publicar installer:

```bash
npm run capture:package
```

No macOS, copie o bundle gerado em
`desktop/out/Voidr Capture-darwin-*/Voidr Capture.app` para `~/Applications` ou
`/Applications` e abra-o uma vez. O handler canônico é o bundle
`co.voidr.capture`. O modo `npm run dev` deliberadamente não registra
`com.github.electron` como dono de `voidr://`; o bridge MCP pode apontar para o
checkout com `VOIDR_CAPTURE_DEV_APP_DIR=/caminho/absoluto/voidr-app/desktop`.

## Android

O desktop procura `adb` em `ANDROID_SDK_ROOT`, `ANDROID_HOME` e nos caminhos usuais de Android
Studio/Homebrew. Com um emulator ou device autorizado:

1. abra a aba **Android** e use **Verificar ambiente** se precisar de diagnóstico;
2. selecione o device e o identificador do app instrumentado com o Voidr Replay SDK;
3. abra o app, execute a missão e finalize a Session no app;
4. encontre a captura e envie as evidências para a verificação;
5. use **Revisar na Voidr** para abrir replay, frames, requests e comparação.

O APK não é instalado silenciosamente e comandos livres nunca atravessam IPC. Neste corte o botão
abre somente um package já instalado.

## Limites de segurança

- `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true` nos renderers;
- API preload estritamente allowlisted e todo payload validado em runtime;
- renderer de controle servido por `voidr-app://`, com CSP estrita e fontes locais;
- capability de gravação consumida no main process e removida antes de navegar o target;
- target remoto não recebe APIs Electron;
- HTTP é aceito somente em loopback; ambientes remotos exigem HTTPS e URLs sem credenciais;
- popups, downloads, protocolos não HTTP(S), redirects de código e permissões falham fechados;
- microfone é liberado somente para nota de voz no renderer de controle, com propósito declarado no
  diálogo nativo do macOS; câmera permanece negada;
- sessões persistentes são particionadas por organização e aplicação;
- ledger contém somente IDs/URLs sanitizadas, nunca capability ou collector token;
- o bundle usa ASAR com validação de integridade, fuses restritivos e assinatura ad-hoc para testes
  locais. Releases públicos ainda exigem certificados e notarização oficiais.

O threat model e os gates de release ficam em [`SECURITY.md`](./SECURITY.md).

## Contrato de experiência

- O wordmark Voidr permanece visível em todos os estados; o símbolo oficial identifica operações
  agentic, como a consolidação das evidências.
- A jornada principal usa linguagem de tarefa: **verificação**, **captura** e **evidências**. Termos
  de infraestrutura ficam restritos ao diagnóstico e à configuração avançada.
- Web oferece uma única ação primária. Android aplica disclosure progressivo em três etapas:
  conectar o device, abrir o app e enviar as evidências.
- Cor comunica somente estado semântico. Seleção e hierarquia usam contraste branco, superfícies e
  espaçamento do Voidr Design System.
- A finalização mostra cada etapa e, quando o contexto identifica um harness, informa nominalmente
  a entrega ao agente conectado.
