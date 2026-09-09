# Voidr Capture Desktop

Os contratos de interação e casos de borda estão documentados em [ANNOTATION-FLOW.md](./ANNOTATION-FLOW.md) e [VOICE-FLOW.md](./VOICE-FLOW.md).

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
- Autenticação de produção: OAuth PKCE com login organizacional; o token fica somente na memória do
  processo principal e as chamadas de Loops usam bearer token org-scoped.
- Não incluídos neste corte: região livre, Appium/scrcpy, iOS, proxy de API e atualização automática.

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

## Release macOS para clientes

O workflow `Capture Desktop release` gera os pacotes Apple Silicon e Windows x64. No macOS, assina
o app e o DMG com Developer ID, notariza e valida ambos com o Gatekeeper. O job macOS falha fechado
se qualquer credencial de release estiver ausente; o job Windows é independente. Os secrets Apple
esperados no GitHub são apenas referenciados pelo nome:

- `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` e `APPLE_TEAM_ID`;
- `MACOS_CERTIFICATE_P12_BASE64` e `MACOS_CERTIFICATE_PASSWORD`.

O workflow deriva `APPLE_CODESIGN_IDENTITY` do certificado Developer ID importado; não mantenha
uma segunda cópia manual desse nome nos secrets.

O artefato do workflow já sai com `capture/<versão>/...` e `capture/latest.json`, no layout consumido
pelo Service. Ao promover para o bucket privado, envie primeiro os arquivos versionados e publique
`latest.json` por último. Nunca distribua a um cliente o DMG gerado localmente com assinatura ad-hoc.

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
- o bundle usa ASAR com validação de integridade e fuses restritivos; builds locais recebem assinatura
  ad-hoc, enquanto o workflow público exige Developer ID, assinatura do DMG e notarização da Apple.

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

## Atualizações do desktop (0.1.18)

O macOS consulta o catálogo privado do canal gravado no build, 15 segundos após abrir,
ao autenticar um workspace/convite e a cada quatro horas. Sem uma sessão válida, a consulta
em segundo plano aguarda a conexão; não abre login sozinha. “Verificar agora” permite
reautenticar a conta do convite/workspace. O catálogo usa as rotas existentes de clientes
ou participantes; nenhum endpoint público novo é necessário.

Uma versão superior e compatível com a arquitetura é baixada automaticamente. A interface
informa bytes, percentual, velocidade e estimativa de tempo, depois verificação da assinatura,
prontidão e eventual erro com nova tentativa. O arquivo temporário, privado, é servido ao
Squirrel.Mac em uma porta exclusiva de loopback com caminho aleatório. Tokens e URLs assinadas
não atravessam o preload. O updater nativo verifica a assinatura do aplicativo; não basta um
HTTP 200. O temporário é removido após a verificação ou falha.

“Reiniciar e atualizar” só funciona sem captura/preparação ou evidências pendentes. O convite
válido ainda não consumido é salvo sem segredos antes do reinício e recuperado uma única vez,
com validade de 24 horas. Uma captura já concluída não é reaberta. Também preservamos o convite
quando o usuário fecha normalmente um app com atualização pronta, pois o updater nativo instala
na próxima abertura. Falhas de abertura têm aviso persistente; falhas de ambiente agora entram
no tratamento de erro e permitem repetir a abertura.

Windows e Linux mostram a nova versão e encaminham aos instaladores na plataforma; a instalação
automática desta implementação é macOS. Builds de desenvolvimento e preview não se atualizam.

### Publicação e primeira instalação

As versões anteriores não possuem updater: precisam receber uma primeira instalação manual do
DMG **assinado e notarizado** da 0.1.18. Depois, publicar um ZIP macOS assinado/notarizado da mesma
identidade de aplicativo, arquitetura e canal, com versão superior, habilita o fluxo automático.
O workflow existente já produz DMG, ZIP e manifesto. Promover o manifesto somente após os arquivos.
Esta alteração de código não publica nem substitui o aplicativo instalado.

O ensaio final de distribuição deve instalar uma versão assinada com updater, publicar uma versão
assinada superior no canal de staging e verificar download, validação nativa, reinício, versão nova
e retomada de um convite. Os testes automatizados simulam os eventos nativos e verificam o servidor
local e os bloqueios; não substituem esse ensaio com dois aplicativos notarizados.

### Associação de links no macOS

Backups antigos com o mesmo bundle ID podem assumir `voidr://`. No incidente de setembro de 2026,
o macOS apontava para `~/Applications/Voidr Capture.previous.app` apesar de a 0.1.17 estar instalada
em `/Applications`. A correção local removeu apenas os registros de protocolo das cópias antigas,
preservando seus arquivos, e registrou `/Applications/Voidr Capture.app` novamente.

Novos builds macOS só registram o protocolo quando estão em Applications e o bundle tem o nome
canônico `Voidr Capture.app`. Não abrir backups antigos depois de restaurar a associação: versões
antigas ainda podem executar seu próprio registro de protocolo.
