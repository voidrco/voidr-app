# Segurança do Voidr Capture Desktop

## Fronteiras de confiança

O renderer de controle é código local empacotado. Páginas Web e aplicações Android capturadas são
conteúdo não confiável. O Service é autoridade de lifecycle e billing; Collector e Platform são
serviços separados. Tokens de preparação são capabilities curtas e não podem sobreviver em URL,
storage, ledger, logs ou mensagens de erro.

## Controles obrigatórios

- Renderers sem Node, isolados e sandboxed; conteúdo remoto nunca recebe preload privilegiado.
- IPC aceita somente o frame principal da janela de controle e valida todos os payloads em runtime.
- Navegação, popups, abertura externa e protocolos usam parser de URL e allowlists exatas.
- HTTPS fora de loopback; configuração local não pode apontar segredo de desenvolvimento para host
  remoto. Fetch de código rejeita redirects, conteúdo inesperado, timeout e payload excessivo.
- CSP de produção sem script ou style inline, assets locais e protocolo `voidr-app://` confinado ao
  diretório do renderer.
- Permissões negadas por padrão. Apenas áudio, solicitado pela UI de nota de voz, pode ser concedido
  ao renderer de controle; câmera e permissões da página capturada são negadas.
- Partição persistente inclui organização e aplicação para impedir mistura de cookies entre tenants.
- ASAR integrity, `OnlyLoadAppFromAsar`, cookie encryption e demais fuses V1 são obrigatórios.
- O snapshot V8 específico permanece explicitamente desligado enquanto não houver um
  `browser_v8_context_snapshot.bin` próprio e verificado no pacote.
- Logs e erros passam por redaction de bearer tokens, JWTs, API keys, segredos e credenciais de URL.

## Gates antes de distribuição pública

1. Assinar e notarizar macOS com Developer ID; assinar Windows com Authenticode; assinar os pacotes e
   metadados Linux. A assinatura ad-hoc existe apenas para o installer local.
2. Trocar credenciais locais por OAuth PKCE e armazenar refresh tokens no keychain do sistema por
   uma camada baseada em `safeStorage`; nunca persistir chaves no renderer.
3. Habilitar update assinado, SBOM, dependency review, secret scanning e política de resposta a CVE.
   O maker de DMG atual herda uma advisory de parsing de imagem sem correção upstream; a pipeline
   deve receber apenas ícones versionados e confiáveis até sua substituição ou correção.
4. Executar testes de IPC spoofing, traversal, SSRF/redirect, tenant isolation, XSS/CSP, permissões,
   adulteração do ASAR e redaction em cada release.
5. Revisar retenção, consentimento e remoção de áudio, transcript, screenshots, requests e replay por
   organização antes da disponibilidade geral.

## Validação local

```bash
npm run capture:typecheck
npm run test:capture
npm test
npm audit --omit=dev
npm run capture:make
```

No macOS, o artefato final também deve passar por `codesign --verify --deep --strict`. A inspeção dos
fuses deve confirmar todos os valores declarados em `desktop/forge.config.cjs`.
