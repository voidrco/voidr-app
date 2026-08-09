import { createHash, randomUUID } from 'node:crypto';
import type { Rectangle } from 'electron';
import { BrowserWindow, WebContentsView } from 'electron';
import {
  annotationInputSchema,
  collectorStopReceiptSchema,
  isTrustedWebUrl,
  prepareWebInputSchema,
  redactText,
  type AnnotationInput,
  type CaptureStatus,
  type CollectorStopReceipt,
} from '@voidr/capture-contracts';
import {
  captureReducer,
  initialCaptureState,
  SingleFlight,
  type CaptureState,
  type EvidenceCategory,
} from '@voidr/capture-kernel';
import { parseLoopLaunch, safePageUrl } from './deep-link';
import { CaptureLedger } from './ledger';
import { type SecretWebAuthorization, VoidrServiceClient } from './service-client';

const COLLECTOR_WORLD = 1004;
const MAX_COLLECTOR_SCRIPT_BYTES = 5 * 1024 * 1024;

type SignalName = 'pages' | 'clicks' | 'requests' | 'errors';

interface SelectedElement {
  selector: string;
  rect?: { x: number; y: number; width: number; height: number };
}

function escapeCssIdentifier(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, (character) => {
    const code = character.codePointAt(0)?.toString(16) ?? 'fffd';
    return `\\${code} `;
  });
}

export class WebCaptureController {
  #state: CaptureState = { ...initialCaptureState, evidence: { ...initialCaptureState.evidence } };
  #view?: WebContentsView;
  #authorization?: SecretWebAuthorization;
  #client?: VoidrServiceClient;
  #collectorScript?: string;
  #stopReceipt?: CollectorStopReceipt;
  #stopFlight = new SingleFlight<CaptureStatus>();
  #signalTimer?: NodeJS.Timeout;
  #startedAt = 0;
  #requestMeta = new Map<string, { method: string; url: string; startedAt: number }>();
  #pendingElement?: {
    resolve: (value: SelectedElement) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  };

  constructor(
    private readonly window: BrowserWindow,
    private readonly ledger: CaptureLedger,
    private readonly emit: (status: CaptureStatus) => void,
    private readonly bounds: () => Rectangle,
  ) {}

  get status(): CaptureStatus {
    const elapsedMs = this.#startedAt ? Math.max(0, Date.now() - this.#startedAt) : 0;
    return {
      stage: this.#state.stage,
      elapsedMs,
      evidence: { ...this.#state.evidence },
      ...(this.#state.platform ? { platform: this.#state.platform } : {}),
      ...(this.#state.generation ? { generation: this.#state.generation } : {}),
      ...(this.#state.context ? { context: this.#state.context } : {}),
      ...(this.#state.sessionId ? { sessionId: this.#state.sessionId } : {}),
      ...(this.#state.message ? { message: this.#state.message } : {}),
      ...(this.#state.errorCode ? { errorCode: this.#state.errorCode } : {}),
    };
  }

  async prepare(input: unknown): Promise<CaptureStatus> {
    const parsed = prepareWebInputSchema.parse(input);
    await this.disposeTarget();
    const generation = randomUUID();
    this.#setState(captureReducer(this.#state, { type: 'PREPARE', platform: 'web', generation }));
    this.#client = new VoidrServiceClient(parsed.runtime);

    try {
      const launch = parseLoopLaunch(parsed.recordingUrl);
      const authorization = await this.#client.validateWebLaunch(launch, generation);
      this.#authorization = authorization;
      await this.ledger.append({
        type: 'web.prepared',
        generation,
        stage: 'preparing',
        data: {
          scenarioId: authorization.safeContext.scenarioId,
          cycleId: authorization.safeContext.cycleId,
          targetUrl: authorization.safeContext.safeTargetUrl,
        },
      });

      this.#view = this.#createTargetView(
        parsed.runtime.organizationId,
        authorization.safeContext.applicationId,
      );
      this.window.contentView.addChildView(this.#view);
      this.#view.setBounds(this.bounds());
      await this.#view.webContents.loadURL(authorization.safeContext.safeTargetUrl);
      this.#setState(
        captureReducer(this.#state, { type: 'PREPARED', context: authorization.safeContext }),
      );
      return this.status;
    } catch (error) {
      this.#fail(error, 'WEB_PREPARE_FAILED', undefined, true);
      throw error;
    }
  }

  async start(): Promise<CaptureStatus> {
    if (!this.#view || !this.#authorization || !this.#client) {
      throw new Error('Prepare a URL de Loop antes de iniciar.');
    }
    if (this.#state.stage !== 'ready') return this.status;
    try {
      await this.#attachDebugger();
      const result = await this.#injectCollector();
      this.#startedAt = Date.now();
      this.#setState(
        captureReducer(this.#state, {
          type: 'START',
          startedAt: this.#startedAt,
          sessionId: result.sessionId,
        }),
      );
      await this.#ingestLifecycle('recording.started', { host: 'electron', platform: 'web' });
      this.#increment('pages');
      await this.#trackInCollector('voidr.desktop.page', {
        url: this.#boundedResourceUrl(this.#view.webContents.getURL()),
        navigationType: 'initial',
      });
      this.#startSignalPolling();
      await this.ledger.append({
        type: 'web.started',
        generation: this.#state.generation,
        sessionId: result.sessionId,
        stage: 'recording',
      });
      return this.status;
    } catch (error) {
      this.#fail(error, 'WEB_START_FAILED', undefined, true);
      throw error;
    }
  }

  stop(): Promise<CaptureStatus> {
    return this.#stopFlight.run(async () => {
      if (this.#state.stage === 'ready_for_review' || this.#state.stage === 'processing') {
        return this.status;
      }
      if (this.#state.stage === 'recoverable_error' && this.#state.retryFrom === 'attach') {
        return this.#completeAfterSeal();
      }
      if (!this.#view || !this.#authorization || !this.#client) {
        throw new Error('Nenhuma captura Web está ativa.');
      }
      if (!['recording', 'recoverable_error'].includes(this.#state.stage)) return this.status;

      try {
        this.#setState(captureReducer(this.#state, { type: 'STOP' }));
        this.#stopSignalPolling();
        await this.#ingestLifecycle('seal.requested', { host: 'electron' });
        const raw = (await this.#view.webContents.executeJavaScriptInIsolatedWorld(
          COLLECTOR_WORLD,
          [
            {
              code: `Promise.resolve(globalThis.VoidrCollector?.stopAndFlush?.()).then((value) => value ?? null)`,
            },
          ],
        )) as Record<string, unknown> | null;
        if (!raw) throw new Error('O collector não retornou o receipt de Stop.');
        const sealedThrough = Number(raw.sealedThrough ?? raw.finalizedThrough ?? raw.finalChunkSeq);
        const receipt = collectorStopReceiptSchema.parse({
          sessionId: raw.sessionId,
          ok: raw.ok,
          flushed: raw.flushed,
          sealed: raw.sealed,
          sealedThrough,
        });
        this.#stopReceipt = receipt;
        this.#setState(
          captureReducer(this.#state, {
            type: 'SEALED',
            sessionId: receipt.sessionId,
            sealedAt: Date.now(),
          }),
        );
        await this.ledger.append({
          type: 'web.sealed',
          generation: this.#state.generation,
          sessionId: receipt.sessionId,
          stage: 'sealed',
          data: { sealedThrough: receipt.sealedThrough },
        });
        return await this.#completeAfterSeal();
      } catch (error) {
        const afterSeal = Boolean(this.#stopReceipt);
        this.#fail(error, afterSeal ? 'WEB_ATTACH_FAILED' : 'WEB_SEAL_FAILED', afterSeal ? 'attach' : 'stop');
        throw error;
      }
    });
  }

  async annotate(input: unknown): Promise<{ evidenceRef: string }> {
    const annotation: AnnotationInput = annotationInputSchema.parse(input);
    if (this.#state.stage !== 'recording' || !this.#view || !this.#authorization || !this.#client) {
      throw new Error('Anotações ficam disponíveis durante a gravação.');
    }
    const selected = annotation.kind === 'element' ? await this.#selectElement() : undefined;
    const dataBase64 = await this.#captureJpegBase64();
    const uploaded = await this.#client.verificationIngest(this.#authorization, 'evidence-assets', {
      generation: this.#authorization.safeContext.verificationGeneration,
      kind: 'screenshot',
      contentType: 'image/jpeg',
      dataBase64,
    });
    const evidenceRef = String(uploaded.evidenceRef ?? '');
    if (!evidenceRef) throw new Error('A evidência não recebeu uma referência durável.');

    const viewport = this.#view.getBounds();
    await this.#client.verificationIngest(this.#authorization, 'annotations', {
      version: 'HIL/1',
      lifecycleVersion: this.#authorization.safeContext.lifecycleVersion,
      idempotencyKey: `desktop-annotation:${this.#authorization.safeContext.verificationGeneration}:${randomUUID()}`,
      kind: annotation.kind,
      note: annotation.note,
      pageUrl: safePageUrl(this.#view.webContents.getURL()),
      timestampMs: Math.max(0, Date.now() - this.#startedAt),
      ...(selected?.selector ? { selector: selected.selector } : {}),
      ...(selected?.rect ? { rect: selected.rect } : {}),
      viewport: { width: viewport.width, height: viewport.height },
      screenshotRef: evidenceRef,
    });
    await this.#trackInCollector('voidr.note', {
      kind: annotation.kind,
      evidenceRef,
      timestampMs: Math.max(0, Date.now() - this.#startedAt),
    });
    this.#increment('notes');
    return { evidenceRef };
  }

  async #captureJpegBase64(): Promise<string> {
    if (!this.#view || this.#view.webContents.isDestroyed()) {
      throw new Error('A aplicação capturada não está disponível.');
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const image = await this.#view.webContents.capturePage();
        if (!image.isEmpty()) return image.toJPEG(82).toString('base64');
      } catch {
        // A cold or occluded macOS compositor can briefly expose no display
        // surface. Explicit annotation is allowed to surface the capture host.
      }
      if (this.window.isMinimized()) this.window.restore();
      if (!this.window.isVisible()) this.window.show();
      this.window.moveTop();
      this.window.focus();
      await new Promise((resolve) => setTimeout(resolve, 140));
    }
    if (!this.#view.webContents.debugger.isAttached()) {
      throw new Error('O viewport ainda não está pronto para uma captura de evidência.');
    }
    for (const fromSurface of [false, true]) {
      try {
        const result = (await this.#view.webContents.debugger.sendCommand('Page.captureScreenshot', {
          format: 'jpeg',
          quality: 82,
          fromSurface,
          captureBeyondViewport: false,
        })) as { data?: unknown };
        if (typeof result.data === 'string' && result.data.length >= 128) return result.data;
      } catch {}
    }
    throw new Error('O viewport ainda não retornou uma imagem válida. Tente novamente.');
  }

  async voiceSegment(input: {
    startedAtMs: number;
    endedAtMs: number;
    pcmBase64: string;
    language?: string;
  }): Promise<{ transcript: string }> {
    if (this.#state.stage !== 'recording' || !this.#authorization || !this.#client) {
      throw new Error('A nota de voz exige uma gravação ativa.');
    }
    if (
      !Number.isInteger(input.startedAtMs) ||
      !Number.isInteger(input.endedAtMs) ||
      input.endedAtMs <= input.startedAtMs ||
      input.endedAtMs - input.startedAtMs > 120_000 ||
      typeof input.pcmBase64 !== 'string' ||
      input.pcmBase64.length > 5_200_000
    ) {
      throw new Error('O segmento de voz não respeita os limites de captura.');
    }
    const result = await this.#client.verificationIngest(this.#authorization, 'voice-segments', {
      generation: this.#authorization.safeContext.verificationGeneration,
      segmentId: `desktop-voice-${randomUUID()}`,
      startedAtMs: input.startedAtMs,
      endedAtMs: input.endedAtMs,
      sampleRate: 16_000,
      language: input.language ?? 'pt-BR',
      pcmBase64: input.pcmBase64,
    });
    const segment = result.segment as Record<string, unknown> | undefined;
    const transcript = typeof segment?.text === 'string' ? segment.text : '';
    await this.#trackInCollector('voidr.voice', {
      transcriptRef: segment?.segmentId ?? null,
      startedAtMs: input.startedAtMs,
      endedAtMs: input.endedAtMs,
    });
    this.#increment('voiceNotes');
    return { transcript };
  }

  resize(): void {
    if (this.#view && !this.#view.webContents.isDestroyed()) this.#view.setBounds(this.bounds());
  }

  async disposeTarget(): Promise<void> {
    this.#stopSignalPolling();
    this.#pendingElement?.reject(new Error('A seleção foi cancelada.'));
    this.#pendingElement = undefined;
    if (this.#view) {
      try {
        if (this.#view.webContents.debugger.isAttached()) this.#view.webContents.debugger.detach();
      } catch {}
      try {
        this.window.contentView.removeChildView(this.#view);
      } catch {}
      this.#view.webContents.close({ waitForBeforeUnload: false });
      this.#view = undefined;
    }
    this.#authorization = undefined;
    this.#client = undefined;
    this.#collectorScript = undefined;
    this.#stopReceipt = undefined;
    this.#requestMeta.clear();
    this.#startedAt = 0;
    if (this.#state.stage !== 'idle') {
      this.#state = { ...initialCaptureState, evidence: { ...initialCaptureState.evidence } };
      this.emit(this.status);
    }
  }

  #createTargetView(organizationId: string, applicationId: string): WebContentsView {
    const partition = createHash('sha256')
      .update(`${organizationId}\0${applicationId}`)
      .digest('hex')
      .slice(0, 24);
    const view = new WebContentsView({
      webPreferences: {
        partition: `persist:voidr-capture-${partition}`,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        nodeIntegrationInWorker: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        experimentalFeatures: false,
        webviewTag: false,
        safeDialogs: true,
        spellcheck: false,
      },
    });
    view.webContents.setWindowOpenHandler(({ url }) => {
      if (isTrustedWebUrl(url)) void view.webContents.loadURL(url);
      return { action: 'deny' };
    });
    view.webContents.on('will-navigate', (event, url) => {
      if (!isTrustedWebUrl(url)) event.preventDefault();
    });
    view.webContents.on('will-frame-navigate', (event) => {
      if (!isTrustedWebUrl(event.url)) event.preventDefault();
    });
    view.webContents.on('did-finish-load', () => {
      if (this.#state.stage === 'recording') {
        void this.#injectCollector().catch((error) =>
          this.#fail(error, 'WEB_NAVIGATION_RECOVERY_FAILED', 'stop'),
        );
      }
    });
    view.webContents.on('render-process-gone', (_event, details) => {
      if (['recording', 'stopping'].includes(this.#state.stage)) {
        this.#fail(
          new Error(`O target encerrou (${details.reason}).`),
          'WEB_TARGET_GONE',
          this.#stopReceipt ? 'attach' : 'stop',
        );
      }
    });
    view.webContents.session.on('will-download', (event) => event.preventDefault());
    return view;
  }

  async #injectCollector(): Promise<{ sessionId: string }> {
    if (!this.#view || !this.#authorization || !this.#client) throw new Error('Target ausente.');
    if (!this.#collectorScript) {
      const response = await fetch(this.#client.runtime.collectorScriptUrl, {
        signal: AbortSignal.timeout(8_000),
        redirect: 'error',
        cache: 'no-store',
      });
      if (!response.ok) throw new Error(`Collector script indisponível (HTTP ${response.status}).`);
      const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
      if (!/(?:java|ecma)script|text\/plain|application\/octet-stream/.test(contentType)) {
        throw new Error('Collector script respondeu com um Content-Type inesperado.');
      }
      const source = await response.text();
      if (Buffer.byteLength(source, 'utf8') > MAX_COLLECTOR_SCRIPT_BYTES) {
        throw new Error('Collector script excede o limite do host.');
      }
      this.#collectorScript = source;
    }
    const context = this.#authorization.safeContext;
    const forcedSessionId = this.#state.sessionId ?? randomUUID();
    const options = {
      user: { id: 'voidr-desktop-capture' },
      apiKey: this.#authorization.collectorApiKey,
      collectorUrl: this.#client.runtime.collectorUrl,
      forcedSessionId,
      system: true,
      samplingRate: 1,
      url: safePageUrl(this.#view.webContents.getURL()),
      applicationId: context.applicationId,
      captureEnvironmentBundle: true,
      meta: {
        testCase: this.#authorization.mission,
        mode: 'loop-test',
        host: 'electron',
        loopTest: {
          scenarioId: context.scenarioId,
          cycleId: context.cycleId,
          cycleNumber: context.cycleNumber,
        },
        verification: {
          version: 'HIL/1',
          verificationId: context.verificationId,
          generation: context.verificationGeneration,
          loopId: context.scenarioId,
          cycleNumber: context.cycleNumber,
        },
      },
      loopTest: {
        scenarioId: context.scenarioId,
        cycleId: context.cycleId,
        cycleNumber: context.cycleNumber,
      },
      verification: {
        version: 'HIL/1',
        verificationId: context.verificationId,
        generation: context.verificationGeneration,
        loopId: context.scenarioId,
        cycleNumber: context.cycleNumber,
      },
    };
    const code = `${this.#collectorScript}\n;globalThis.__voidrDesktopSignals={clicks:0};document.addEventListener('click',()=>{globalThis.__voidrDesktopSignals.clicks+=1},{capture:true,passive:true});Promise.resolve(globalThis.VoidrCollector.init(${JSON.stringify(options)})).then(()=>({sessionId:globalThis.VoidrCollector.getSessionId?.()||null,ready:Boolean(globalThis.VoidrCollector.getSessionId?.())}));`;
    const result = (await this.#view.webContents.executeJavaScriptInIsolatedWorld(
      COLLECTOR_WORLD,
      [{ code }],
    )) as { sessionId?: unknown; ready?: unknown } | undefined;
    if (result?.ready !== true || typeof result.sessionId !== 'string') {
      throw new Error('O collector não confirmou uma Session autenticada.');
    }
    return { sessionId: result.sessionId };
  }

  async #attachDebugger(): Promise<void> {
    if (!this.#view) return;
    const target = this.#view.webContents;
    if (!target.debugger.isAttached()) target.debugger.attach('1.3');
    await Promise.all([
      target.debugger.sendCommand('Network.enable', { maxTotalBufferSize: 1_000_000 }),
      target.debugger.sendCommand('Page.enable'),
      target.debugger.sendCommand('Runtime.enable'),
      target.debugger.sendCommand('DOM.enable'),
      target.debugger.sendCommand('Overlay.enable'),
    ]);
    target.debugger.removeAllListeners('message');
    target.debugger.on('message', (_event, method, parameters) => {
      void this.#onDebuggerMessage(method, parameters as Record<string, unknown>);
    });
  }

  async #onDebuggerMessage(method: string, parameters: Record<string, unknown>): Promise<void> {
    if (!this.#view || this.#state.stage !== 'recording') return;
    if (method === 'Page.frameNavigated') {
      const frame = parameters.frame as Record<string, unknown> | undefined;
      if (!frame || typeof frame.parentId === 'string') return;
      const url = String(frame.url ?? '');
      if (!url || this.#isVoidrInfrastructure(url)) return;
      this.#increment('pages');
      await this.#trackInCollector('voidr.desktop.page', {
        url: this.#boundedResourceUrl(url),
        navigationType: String(frame.type ?? 'Navigation').slice(0, 80),
      });
      return;
    }
    if (method === 'Network.requestWillBeSent') {
      const request = parameters.request as Record<string, unknown> | undefined;
      const requestId = String(parameters.requestId ?? '');
      const url = String(request?.url ?? '');
      if (this.#isVoidrInfrastructure(url)) return;
      this.#requestMeta.set(requestId, {
        method: String(request?.method ?? 'GET').slice(0, 16),
        url: this.#boundedResourceUrl(url),
        startedAt: Date.now(),
      });
      return;
    }
    if (method === 'Network.responseReceived') {
      const requestId = String(parameters.requestId ?? '');
      const request = this.#requestMeta.get(requestId);
      if (!request) return;
      this.#requestMeta.delete(requestId);
      const response = parameters.response as Record<string, unknown> | undefined;
      this.#increment('requests');
      await this.#trackInCollector('voidr.desktop.request', {
        method: request.method,
        url: request.url,
        status: Number(response?.status ?? 0),
        mimeType: String(response?.mimeType ?? '').slice(0, 120),
        durationMs: Date.now() - request.startedAt,
      });
      return;
    }
    if (method === 'Runtime.exceptionThrown') {
      const details = parameters.exceptionDetails as Record<string, unknown> | undefined;
      const exception = details?.exception as Record<string, unknown> | undefined;
      const description = String(exception?.description ?? details?.text ?? 'Erro JavaScript');
      this.#increment('errors');
      await this.#trackInCollector('voidr.desktop.error', {
        message: redactText(description).slice(0, 500),
        line: Number(details?.lineNumber ?? 0),
        column: Number(details?.columnNumber ?? 0),
      });
      return;
    }
    if (method === 'Overlay.inspectNodeRequested' && this.#pendingElement) {
      const backendNodeId = Number(parameters.backendNodeId);
      try {
        const selected = await this.#describeElement(backendNodeId);
        clearTimeout(this.#pendingElement.timer);
        this.#pendingElement.resolve(selected);
      } catch (error) {
        this.#pendingElement.reject(error instanceof Error ? error : new Error(String(error)));
      } finally {
        this.#pendingElement = undefined;
        await this.#view.webContents.debugger.sendCommand('Overlay.setInspectMode', { mode: 'none' });
      }
    }
  }

  async #describeElement(backendNodeId: number): Promise<SelectedElement> {
    if (!this.#view) throw new Error('Target ausente.');
    const nodeResult = (await this.#view.webContents.debugger.sendCommand('DOM.describeNode', {
      backendNodeId,
      depth: 0,
    })) as { node?: { nodeName?: string; attributes?: string[] } };
    const node = nodeResult.node;
    if (!node?.nodeName) throw new Error('O elemento não pôde ser identificado.');
    const attributes = node.attributes ?? [];
    const map = new Map<string, string>();
    for (let index = 0; index < attributes.length; index += 2) {
      map.set(attributes[index]!, attributes[index + 1] ?? '');
    }
    const tag = node.nodeName.toLowerCase();
    const id = map.get('id');
    const testId = map.get('data-testid') ?? map.get('data-test');
    const selector = id
      ? `#${escapeCssIdentifier(id)}`
      : testId
        ? `${tag}[data-testid="${testId.replace(/["\\]/g, '\\$&')}"]`
        : tag;
    let rect: SelectedElement['rect'];
    try {
      const box = (await this.#view.webContents.debugger.sendCommand('DOM.getBoxModel', {
        backendNodeId,
      })) as { model?: { border?: number[] } };
      const points = box.model?.border ?? [];
      const xs = points.filter((_value, index) => index % 2 === 0);
      const ys = points.filter((_value, index) => index % 2 === 1);
      if (xs.length && ys.length) {
        const x = Math.min(...xs);
        const y = Math.min(...ys);
        rect = { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
      }
    } catch {}
    return { selector, ...(rect?.width && rect.height ? { rect } : {}) };
  }

  #selectElement(): Promise<SelectedElement> {
    if (!this.#view || !this.#view.webContents.debugger.isAttached()) {
      throw new Error('A inspeção de elementos não está pronta.');
    }
    if (this.#pendingElement) throw new Error('Uma seleção já está ativa.');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pendingElement = undefined;
        void this.#view?.webContents.debugger.sendCommand('Overlay.setInspectMode', { mode: 'none' });
        reject(new Error('A seleção de elemento expirou.'));
      }, 30_000);
      this.#pendingElement = { resolve, reject, timer };
      void this.#view!.webContents.debugger
        .sendCommand('Overlay.setInspectMode', {
          mode: 'searchForNode',
          highlightConfig: {
            showInfo: true,
            showStyles: false,
            showRulers: false,
            contentColor: { r: 125, g: 211, b: 252, a: 0.08 },
            borderColor: { r: 125, g: 211, b: 252, a: 0.9 },
          },
        })
        .catch((error) => {
          clearTimeout(timer);
          this.#pendingElement = undefined;
          reject(error instanceof Error ? error : new Error(String(error)));
        });
    });
  }

  async #completeAfterSeal(): Promise<CaptureStatus> {
    if (!this.#authorization || !this.#client || !this.#stopReceipt) {
      throw new Error('O receipt durável não está disponível para attach.');
    }
    try {
      if (this.#state.stage === 'recoverable_error') {
        this.#setState(captureReducer(this.#state, { type: 'ATTACH' }));
      } else if (this.#state.stage === 'sealed') {
        this.#setState(captureReducer(this.#state, { type: 'ATTACH' }));
      }
      await this.#client.attachWebSession(this.#authorization, this.#stopReceipt.sessionId);
      const indexedThrough = await this.#client.waitForCollectorReadiness(
        this.#stopReceipt.sessionId,
        this.#authorization.collectorApiKey,
        this.#stopReceipt.sealedThrough,
      );
      await this.#client.verificationIngest(this.#authorization, 'seal', {
        lifecycleVersion: this.#authorization.safeContext.lifecycleVersion,
        idempotencyKey: `desktop-seal:${this.#authorization.safeContext.verificationGeneration}:${this.#stopReceipt.sessionId}:${this.#stopReceipt.sealedThrough}`,
        sessionId: this.#stopReceipt.sessionId,
        watermark: {
          acceptedSequence: this.#stopReceipt.sealedThrough,
          durableSequence: this.#stopReceipt.sealedThrough,
          derivedSequence: indexedThrough,
        },
      });
      this.#setState(captureReducer(this.#state, { type: 'PROCESS' }));
      const ready = await this.#waitForCycleReady();
      if (ready) this.#setState(captureReducer(this.#state, { type: 'READY' }));
      await this.ledger.append({
        type: ready ? 'web.ready' : 'web.processing',
        generation: this.#state.generation,
        sessionId: this.#stopReceipt.sessionId,
        stage: this.#state.stage,
        data: { indexedThrough },
      });
      this.#authorization = undefined;
      this.#client = undefined;
      this.#collectorScript = undefined;
      return this.status;
    } catch (error) {
      this.#fail(error, 'WEB_ATTACH_FAILED', 'attach');
      throw error;
    }
  }

  async #waitForCycleReady(timeoutMs = 30_000): Promise<boolean> {
    if (!this.#authorization || !this.#client || !this.#client.runtime.localAdapter) return true;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const status = await this.#client
        .getVerificationStatus(this.#authorization.safeContext.verificationId)
        .catch(() => null);
      const state = status && typeof status.status === 'string' ? status.status : '';
      if (
        ['artifact_ready', 'diagnosing', 'diagnosis_ready', 'decision_required', 'open', 'confirmed'].includes(
          state,
        )
      ) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    return false;
  }

  async #ingestLifecycle(type: 'recording.started' | 'seal.requested', payload: Record<string, unknown>): Promise<void> {
    if (!this.#authorization || !this.#client) return;
    await this.#client.verificationIngest(this.#authorization, 'lifecycle-events', {
      version: 'HIL/1',
      lifecycleVersion: this.#authorization.safeContext.lifecycleVersion,
      idempotencyKey: `desktop-lifecycle:${type}:${this.#authorization.safeContext.verificationGeneration}`,
      type,
      occurredAt: new Date().toISOString(),
      payload,
    });
  }

  #startSignalPolling(): void {
    this.#stopSignalPolling();
    this.#signalTimer = setInterval(() => {
      if (!this.#view || this.#state.stage !== 'recording') return;
      void this.#view.webContents
        .executeJavaScriptInIsolatedWorld(COLLECTOR_WORLD, [
          {
            code: `(()=>{const value=globalThis.__voidrDesktopSignals?.clicks||0;if(globalThis.__voidrDesktopSignals)globalThis.__voidrDesktopSignals.clicks=0;return value})()`,
          },
        ])
        .then((clicks) => {
          if (Number.isInteger(clicks) && clicks > 0) this.#increment('clicks', clicks);
        })
        .catch(() => undefined);
    }, 700);
  }

  #stopSignalPolling(): void {
    if (this.#signalTimer) clearInterval(this.#signalTimer);
    this.#signalTimer = undefined;
  }

  async #trackInCollector(name: string, properties: Record<string, unknown>): Promise<void> {
    if (!this.#view || this.#view.webContents.isDestroyed()) return;
    await this.#view.webContents
      .executeJavaScriptInIsolatedWorld(COLLECTOR_WORLD, [
        {
          code: `globalThis.VoidrCollector?.track?.(${JSON.stringify(name)},${JSON.stringify(properties)});true`,
        },
      ])
      .catch(() => undefined);
  }

  #increment(category: EvidenceCategory, increment = 1): void {
    if (this.#state.stage !== 'recording') return;
    this.#setState(captureReducer(this.#state, { type: 'EVIDENCE', category, increment }));
  }

  #isVoidrInfrastructure(input: string): boolean {
    if (!this.#client) return false;
    return [
      this.#client.runtime.collectorUrl,
      this.#client.runtime.serviceUrl,
      this.#client.runtime.collectorScriptUrl,
    ].some((base) => input.startsWith(base));
  }

  #boundedResourceUrl(input: string): string {
    try {
      const url = new URL(input);
      return `${url.origin}${url.pathname}`.slice(0, 1_000);
    } catch {
      return '[invalid-url]';
    }
  }

  #fail(
    error: unknown,
    code: string,
    retryFrom?: 'stop' | 'attach',
    terminal = false,
  ): void {
    const message = redactText(error instanceof Error ? error.message : String(error));
    try {
      this.#setState(
        captureReducer(this.#state, { type: 'FAIL', message, code, retryFrom, terminal }),
      );
    } catch {
      this.#state = { ...this.#state, stage: terminal ? 'terminal_error' : 'recoverable_error', message, errorCode: code, retryFrom };
      this.emit(this.status);
    }
    void this.ledger.append({
      type: 'web.failure',
      generation: this.#state.generation,
      sessionId: this.#state.sessionId,
      stage: this.#state.stage,
      data: { code, message, retryFrom },
    });
  }

  #setState(state: CaptureState): void {
    this.#state = state;
    this.emit(this.status);
  }
}
