import { createHash, randomUUID } from 'node:crypto';
import type { Rectangle } from 'electron';
import { BrowserWindow, WebContentsView } from 'electron';
import {
  annotationInputSchema,
  isTrustedWebUrl,
  prepareWebInputSchema,
  redactText,
  type AnnotationInput,
  type CapturedSignal,
  type CaptureStatus,
  type CollectorStopReceipt,
  type HarnessDeliveryState,
} from '@voidr/capture-contracts';
import {
  captureReducer,
  initialCaptureState,
  SingleFlight,
  type CaptureState,
  type EvidenceCategory,
} from '@voidr/capture-kernel';
import { parseLoopLaunch, safePageUrl } from './deep-link';
import {
  consoleErrorFromCdp,
  drainKnownCdpNetworkResponses,
  exceptionFromCdp,
  finishCdpNetworkRequest,
  RecentConsoleEventDeduper,
  type CanonicalConsoleError,
  type CanonicalNetworkRequestMeta,
  type CanonicalNetworkSignal,
} from './cdp-session-events';
import { CaptureLedger } from './ledger';
import {
  type SecretWebAuthorization,
  VoidrApiError,
  VoidrServiceClient,
} from './service-client';
import { inspectCollectorStopAttempt } from './collector-stop';
import { AnnotationOutbox, type DurableAnnotation } from './annotation-outbox';
import { allowCollectorInContentSecurityPolicy } from './collector-csp';
import { isExpectedNavigationAbort } from './target-navigation';

const COLLECTOR_WORLD = 1004;
const REGION_SELECTION_WORLD = 1005;
const ELEMENT_SELECTION_WORLD = 1006;
const MAX_COLLECTOR_SCRIPT_BYTES = 5 * 1024 * 1024;
const COLLECTOR_STOP_TIMEOUT_MS = 25_000;
const COLLECTOR_STOP_MAX_ATTEMPTS = 3;
const COLLECTOR_STOP_RETRY_DELAY_MS = 500;
const COLLECTOR_EVENT_WRITE_TIMEOUT_MS = 3_000;
const ANNOTATION_DRAIN_TIMEOUT_MS = 50_000;
const CDP_NETWORK_SETTLE_TIMEOUT_MS = 250;
const CDP_NETWORK_SETTLE_POLL_MS = 20;
const TARGET_LOAD_TIMEOUT_MS = 15_000;

type SignalName = 'pages' | 'clicks' | 'requests' | 'errors';

interface CaptureRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface SelectedTarget {
  selector?: string;
  rect?: CaptureRect;
}

interface SelectedElement extends SelectedTarget {
  selector: string;
}

interface SelectedRegion extends SelectedTarget {
  rect: CaptureRect;
}

interface VoiceVisualDraft {
  kind: 'region';
  selectionId: number;
  pageUrl: string;
  rect: CaptureRect;
  viewport: { width: number; height: number };
  screenshotBase64: string;
  cropBase64: string;
}

interface VoiceVisualContext {
  kind: 'region';
  pageUrl: string;
  rect: CaptureRect;
  viewport: { width: number; height: number };
  screenshotRef: string;
  cropRef: string;
}

interface SelectionEvent {
  owner: 'annotation' | 'voice';
  selectionId?: number;
  previousSelectionId?: number;
}

function boundedCaptureRectangle(rect: CaptureRect, viewport: Rectangle): Rectangle | undefined {
  const x = Math.max(0, Math.min(viewport.width - 1, Math.floor(rect.x)));
  const y = Math.max(0, Math.min(viewport.height - 1, Math.floor(rect.y)));
  const width = Math.min(viewport.width - x, Math.ceil(rect.width));
  const height = Math.min(viewport.height - y, Math.ceil(rect.height));
  return width >= 2 && height >= 2 ? { x, y, width, height } : undefined;
}

function isEscapeInput(input: Electron.Input): boolean {
  const nativeInput = input as Electron.Input & { keyCode?: string | number };
  return (
    input.key === 'Escape' ||
    input.key === 'Esc' ||
    input.key === '\u001b' ||
    input.code === 'Escape' ||
    nativeInput.keyCode === 'Escape' ||
    nativeInput.keyCode === 27
  );
}

function isKeyDownInput(input: Electron.Input): boolean {
  return input.type !== 'keyUp';
}

function canonicalNetworkType(resourceType: string | undefined, failed: boolean): string {
  const normalized = String(resourceType ?? '').toLowerCase();
  if (normalized === 'xhr' || normalized === 'xmlhttprequest') return failed ? 'xhrError' : 'xhr';
  if (normalized === 'fetch') return failed ? 'fetchError' : 'fetch';
  return 'resource';
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class WebCaptureController {
  #state: CaptureState = {
    ...initialCaptureState,
    evidence: { ...initialCaptureState.evidence },
  };
  #view?: WebContentsView;
  #authorization?: SecretWebAuthorization;
  #client?: VoidrServiceClient;
  #collectorScript?: string;
  #stopReceipt?: CollectorStopReceipt;
  #stopFlight = new SingleFlight<CaptureStatus>();
  #cancelSelectionFlight = new SingleFlight<void>();
  #signalTimer?: NodeJS.Timeout;
  #startedAt = 0;
  #requestMeta = new Map<string, CanonicalNetworkRequestMeta>();
  #collectorEventWrites = new Set<Promise<void>>();
  #consoleEventDeduper = new RecentConsoleEventDeduper();
  #recentSignals: CapturedSignal[] = [];
  #readinessObserverGeneration?: string;
  #pendingElement?: {
    resolve: (value: SelectedElement) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  };
  #elementEscapeAttribute?: string;
  #selectedElement?: SelectedElement;
  #selectedRegion?: SelectedRegion;
  #selectedVoiceVisual?: VoiceVisualDraft;
  #regionSelectionActive = false;
  #activeRegionOwner?: 'annotation' | 'voice';
  #activeVoiceSelectionId?: number;
  #regionEscapeAttribute?: string;
  #voiceVisualSnapshots = new Map<string, VoiceVisualDraft | null>();
  #voiceVisualUploads = new Map<string, Promise<VoiceVisualContext>>();
  #targetNavigationEpoch = 0;
  #acknowledgedVoiceSegmentIds = new Set<string>();
  #annotationRetryTimer?: NodeJS.Timeout;
  #annotationRetryDelayMs = 2_000;
  #verificationMutationTail: Promise<void> = Promise.resolve();
  #queuedTargetWindowOpenUrl?: string;
  #targetLoadInProgress = false;

  constructor(
    private readonly window: BrowserWindow,
    private readonly ledger: CaptureLedger,
    private readonly annotationOutbox: AnnotationOutbox,
    private readonly emit: (status: CaptureStatus) => void,
    private readonly bounds: () => Rectangle,
    private readonly emitTargetPointerDown: () => void = () => undefined,
    private readonly emitSelectionInvalidated: (event: SelectionEvent) => void = () => undefined,
    private readonly emitSelectionCancelled: (event: SelectionEvent) => void = () => undefined,
  ) {}

  async recoverPendingAnnotations(): Promise<void> {
    await this.#drainAnnotationOutbox(false);
  }

  annotationPendingCount(): Promise<number> {
    return this.annotationOutbox.pendingCount();
  }

  get status(): CaptureStatus {
    const elapsedMs = this.#startedAt ? Math.max(0, Date.now() - this.#startedAt) : 0;
    return {
      stage: this.#state.stage,
      elapsedMs,
      evidence: { ...this.#state.evidence },
      recentSignals: [...this.#recentSignals],
      ...(this.#state.platform ? { platform: this.#state.platform } : {}),
      ...(this.#state.generation ? { generation: this.#state.generation } : {}),
      ...(this.#state.context ? { context: this.#state.context } : {}),
      ...(this.#state.sessionId ? { sessionId: this.#state.sessionId } : {}),
      ...(this.#state.message ? { message: this.#state.message } : {}),
      ...(this.#state.errorCode ? { errorCode: this.#state.errorCode } : {}),
    };
  }

  get selectionActive(): boolean {
    return Boolean(this.#pendingElement || this.#regionSelectionActive);
  }

  sendInputForAutomation(
    input: Electron.MouseInputEvent | Electron.MouseWheelInputEvent | Electron.KeyboardInputEvent,
  ): void {
    if (!this.#view || this.#view.webContents.isDestroyed()) {
      throw new Error('O target de automação não está disponível.');
    }
    this.window.focus();
    this.#view.webContents.focus();
    this.#view.webContents.sendInputEvent(input);
  }

  async completeRegionSelectionForAutomation(rect: Rectangle): Promise<void> {
    if (!this.#view || this.#view.webContents.isDestroyed() || !this.#regionSelectionActive) {
      throw new Error('A seleção de região de automação não está ativa.');
    }
    await this.#view.webContents.executeJavaScriptInIsolatedWorld(REGION_SELECTION_WORLD, [
      {
        code: `globalThis.__voidrDesktopRegionSelection?.select?.(${JSON.stringify(rect)}); null`,
      },
    ]);
  }

  async prepare(input: unknown): Promise<CaptureStatus> {
    const parsed = prepareWebInputSchema.parse(input);
    await this.disposeTarget();
    const generation = randomUUID();
    this.#setState(
      captureReducer(this.#state, {
        type: 'PREPARE',
        platform: 'web',
        generation,
      }),
    );
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
        this.#client.runtime.collectorUrl,
      );
      // Load while detached. Mounting an empty native view can block the
      // protocol handoff on an already-open macOS window.
      await this.#loadTargetUrl(authorization.safeContext.safeTargetUrl);
      this.window.contentView.addChildView(this.#view);
      this.#view.setBounds(this.bounds());
      this.#setState(
        captureReducer(this.#state, {
          type: 'PREPARED',
          context: authorization.safeContext,
        }),
      );
      return this.status;
    } catch (error) {
      this.#fail(error, 'WEB_PREPARE_FAILED', undefined, true);
      await this.#destroyTargetView();
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
      await this.#ingestLifecycle('recording.started', {
        host: 'electron',
        platform: 'web',
      });
      this.#addSignal('pages', 'Página inicial', this.#boundedResourceUrl(this.#view.webContents.getURL()));
      this.#increment('pages');
      await this.#trackInCollector('voidr.desktop.page', {
        url: this.#boundedResourceUrl(this.#view.webContents.getURL()),
        navigationType: 'initial',
      });
      await this.#captureExistingNetworkEntries();
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
        if (this.#state.stage === 'recording') await this.#settlePendingNetworkRequests();
        this.#setState(captureReducer(this.#state, { type: 'STOP' }));
        this.#stopSignalPolling();
        const annotationDrain = await withTimeout(
          this.#drainAnnotationOutbox(false),
          ANNOTATION_DRAIN_TIMEOUT_MS,
          'Suas notas continuam protegidas neste dispositivo, mas ainda não terminaram de sincronizar. Tente finalizar novamente.',
        );
        if (annotationDrain.pendingCount > 0) {
          throw new Error('Suas notas continuam protegidas neste dispositivo, mas a sincronização está pendente. Verifique a conexão e tente finalizar novamente.');
        }
        await withTimeout(
          this.#flushCollectorEventWrites(),
          COLLECTOR_EVENT_WRITE_TIMEOUT_MS,
          'Os últimos sinais técnicos ainda não foram sincronizados. Tente finalizar novamente.',
        );
        await this.#ingestLifecycle('seal.requested', { host: 'electron' });
        const receipt = await withTimeout(
          this.#stopCollectorDurably(),
          COLLECTOR_STOP_TIMEOUT_MS,
          'A consolidação está demorando mais que o esperado. Seus dados locais continuam preservados.',
        );
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

  async #stopCollectorDurably(): Promise<CollectorStopReceipt> {
    if (!this.#view) throw new Error('Nenhuma captura Web está ativa.');
    let lastMessage = 'O collector não retornou o receipt de Stop.';
    for (let attempt = 1; attempt <= COLLECTOR_STOP_MAX_ATTEMPTS; attempt += 1) {
      const raw = (await this.#view.webContents.executeJavaScriptInIsolatedWorld(
        COLLECTOR_WORLD,
        [
          {
            code: `(()=>{const collector=globalThis.VoidrCollector;const stop=collector?.stopAndFinalize;if(typeof stop!=="function")return null;return Promise.resolve(stop.call(collector)).then((value)=>value??null)})()`,
          },
        ],
      )) as unknown;
      const inspected = inspectCollectorStopAttempt(raw);
      if (inspected.receipt) return inspected.receipt;
      lastMessage = inspected.message;
      if (!inspected.retryable || attempt === COLLECTOR_STOP_MAX_ATTEMPTS) break;
      await new Promise((resolve) => setTimeout(resolve, COLLECTOR_STOP_RETRY_DELAY_MS * attempt));
    }
    throw new Error(lastMessage);
  }

  async annotate(input: unknown): Promise<{ localId: string; state: 'queued' }> {
    const annotation: AnnotationInput = annotationInputSchema.parse(input);
    if (this.#state.stage !== 'recording' || !this.#view || !this.#authorization || !this.#client) {
      throw new Error('Anotações ficam disponíveis durante a gravação.');
    }
    const selected: SelectedTarget | undefined =
      annotation.kind === 'element'
        ? this.#selectedElement
        : annotation.kind === 'region'
          ? this.#selectedRegion
          : undefined;
    if (annotation.kind !== 'screen' && !selected) {
      throw new Error(
        annotation.kind === 'element'
          ? 'Selecione um elemento antes de salvar a anotação.'
          : 'Selecione uma região antes de salvar a anotação.',
      );
    }
    const viewport = this.#view.getBounds();
    const cropRectangle = selected?.rect ? boundedCaptureRectangle(selected.rect, viewport) : undefined;
    const pageUrl = safePageUrl(this.#view.webContents.getURL());
    const navigationEpoch = this.#targetNavigationEpoch;
    const [screenshotBase64, cropBase64] = await Promise.all([
      this.#captureJpegBase64(),
      cropRectangle ? this.#captureJpegBase64(cropRectangle).catch(() => undefined) : undefined,
    ]);
    if (
      navigationEpoch !== this.#targetNavigationEpoch ||
      pageUrl !== safePageUrl(this.#view.webContents.getURL())
    ) {
      throw new Error('A página mudou durante a captura. Selecione a área novamente.');
    }
    const timestampMs = Math.max(0, Date.now() - this.#startedAt);
    const queued = await this.annotationOutbox.enqueue({
      runtime: this.#client.runtime,
      authorization: structuredClone(this.#authorization),
      annotation: {
        idempotencyKey: `desktop-annotation:${this.#authorization.safeContext.verificationGeneration}:${randomUUID()}`,
        kind: annotation.kind,
        note: annotation.note,
        pageUrl,
        timestampMs,
        ...(selected?.selector ? { selector: selected.selector } : {}),
        ...(selected?.rect ? { rect: selected.rect } : {}),
        viewport: { width: viewport.width, height: viewport.height },
        screenshotBase64,
        ...(cropBase64 ? { cropBase64 } : {}),
      },
    });
    this.#addSignal(
      'notes',
      annotation.kind === 'element'
        ? 'Nota em elemento'
        : annotation.kind === 'region'
          ? 'Nota em região'
          : 'Nota na tela',
      redactText(annotation.note).slice(0, 1_000),
    );
    this.#increment('notes');
    if (annotation.kind === 'element') this.#selectedElement = undefined;
    if (annotation.kind === 'region') this.#selectedRegion = undefined;
    this.#emitAnnotationSync('queued', queued.localId, await this.annotationOutbox.pendingCount());
    setTimeout(() => void this.#drainAnnotationOutbox(true), 0);
    return { localId: queued.localId, state: 'queued' };
  }

  async selectElement(): Promise<{ selected: true }> {
    if (this.#state.stage !== 'recording' || !this.#view || !this.#authorization) {
      throw new Error('A seleção de elementos exige uma gravação ativa.');
    }
    await this.clearSelection();
    this.window.focus();
    this.#view.webContents.focus();
    this.#selectedElement = await this.#selectElement();
    return { selected: true };
  }

  async selectRegion(): Promise<{ selected: true }> {
    if (this.#state.stage !== 'recording' || !this.#view || !this.#authorization) {
      throw new Error('A seleção de região exige uma gravação ativa.');
    }
    await this.clearSelection();
    this.window.focus();
    this.#view.webContents.focus();
    this.#activeRegionOwner = 'annotation';
    try {
      this.#selectedRegion = await this.#selectRegion();
    } finally {
      if (this.#activeRegionOwner === 'annotation') this.#activeRegionOwner = undefined;
    }
    return { selected: true };
  }

  async selectVoiceRegion(selectionId: number): Promise<{ selected: true }> {
    if (this.#state.stage !== 'recording' || !this.#view || !this.#authorization) {
      throw new Error('A seleção de região para voz exige uma gravação ativa.');
    }
    this.#selectedElement = undefined;
    this.#selectedRegion = undefined;
    this.window.focus();
    this.#view.webContents.focus();
    this.#activeRegionOwner = 'voice';
    this.#activeVoiceSelectionId = selectionId;
    try {
      const selected = await this.#selectRegion();
      const navigationEpoch = this.#targetNavigationEpoch;
      const pageUrl = safePageUrl(this.#view.webContents.getURL());
      const viewport = this.#view.getBounds();
      const cropRectangle = boundedCaptureRectangle(selected.rect, viewport);
      if (!cropRectangle) throw new Error('A região selecionada não pode ser capturada.');
      const [screenshotBase64, cropBase64] = await Promise.all([
        this.#captureJpegBase64(),
        this.#captureJpegBase64(cropRectangle),
      ]);
      if (
        navigationEpoch !== this.#targetNavigationEpoch ||
        pageUrl !== safePageUrl(this.#view.webContents.getURL())
      ) {
        throw new Error('A página mudou durante a captura. Selecione a área novamente.');
      }
      this.#selectedVoiceVisual = {
        kind: 'region',
        selectionId,
        pageUrl,
        rect: selected.rect,
        viewport: { width: viewport.width, height: viewport.height },
        screenshotBase64,
        cropBase64,
      };
      this.#voiceVisualSnapshots.clear();
      this.#voiceVisualUploads.clear();
      return { selected: true };
    } finally {
      if (this.#activeRegionOwner === 'voice') {
        this.#activeRegionOwner = undefined;
        this.#activeVoiceSelectionId = undefined;
      }
    }
  }

  async clearVoiceRegion(): Promise<void> {
    if (this.#activeRegionOwner === 'voice' && this.#regionSelectionActive) {
      await this.clearSelection();
      return;
    }
    this.#selectedVoiceVisual = undefined;
    this.#voiceVisualSnapshots.clear();
    this.#voiceVisualUploads.clear();
  }

  async clearSelection(options: { preserveVoiceUploads?: boolean } = {}): Promise<void> {
    this.#selectedElement = undefined;
    this.#selectedRegion = undefined;
    this.#selectedVoiceVisual = undefined;
    if (!options.preserveVoiceUploads) {
      this.#voiceVisualSnapshots.clear();
      this.#voiceVisualUploads.clear();
    }
    const pending = this.#pendingElement;
    if (pending) {
      clearTimeout(pending.timer);
      this.#pendingElement = undefined;
      pending.reject(new Error('A seleção foi cancelada.'));
      if (this.#view && !this.#view.webContents.isDestroyed()) {
        const cancellations: Promise<unknown>[] = [
          this.#view.webContents.executeJavaScriptInIsolatedWorld(ELEMENT_SELECTION_WORLD, [
            {
              code: `globalThis.__voidrDesktopElementSelection?.cancel?.(); null`,
            },
          ]),
        ];
        if (this.#elementEscapeAttribute) {
          cancellations.push(
            this.#view.webContents.executeJavaScript(
              `document.documentElement.setAttribute(${JSON.stringify(this.#elementEscapeAttribute)},'1'); true`,
            ),
          );
        }
        await Promise.allSettled(cancellations);
      }
    }
    if (this.#regionSelectionActive && this.#view && !this.#view.webContents.isDestroyed()) {
      const cancellations: Promise<unknown>[] = [
        this.#view.webContents.executeJavaScriptInIsolatedWorld(REGION_SELECTION_WORLD, [
          {
            code: `globalThis.__voidrDesktopRegionSelection?.cancel?.(); null`,
          },
        ]),
      ];
      if (this.#regionEscapeAttribute) {
        cancellations.push(
          this.#view.webContents.executeJavaScript(
            `document.documentElement.setAttribute(${JSON.stringify(this.#regionEscapeAttribute)},'1'); true`,
          ),
        );
      }
      await Promise.allSettled(cancellations);
    }
  }

  async cancelSelection(): Promise<void> {
    return this.#cancelSelectionFlight.run(async () => {
      const navigationEpoch = this.#targetNavigationEpoch;
      const generation = this.#state.generation;
      const wasActive = this.selectionActive;
      const preserveVoice = this.#activeRegionOwner === 'voice';
      const selectionEvent: SelectionEvent = preserveVoice && this.#activeVoiceSelectionId
        ? { owner: 'voice', selectionId: this.#activeVoiceSelectionId }
        : { owner: 'annotation' };
      const preserveVoiceVisual = preserveVoice
        ? this.#selectedVoiceVisual
        : undefined;
      const preserveVoiceUploads = preserveVoice
        ? new Map(this.#voiceVisualUploads)
        : undefined;
      const preserveVoiceSnapshots = preserveVoice
        ? new Map(this.#voiceVisualSnapshots)
        : undefined;
      await this.clearSelection();
      if (
        preserveVoice &&
        navigationEpoch === this.#targetNavigationEpoch &&
        generation === this.#state.generation
      ) {
        this.#selectedVoiceVisual = preserveVoiceVisual;
        if (preserveVoiceSnapshots) this.#voiceVisualSnapshots = preserveVoiceSnapshots;
        if (preserveVoiceUploads) this.#voiceVisualUploads = preserveVoiceUploads;
      }
      if (wasActive) this.emitSelectionCancelled(selectionEvent);
    });
  }

  async #captureJpegBase64(rect?: Rectangle): Promise<string> {
    if (!this.#view || this.#view.webContents.isDestroyed()) {
      throw new Error('A aplicação capturada não está disponível.');
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const image = await this.#view.webContents.capturePage(rect);
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
          ...(rect ? { clip: { ...rect, scale: 1 } } : {}),
        })) as { data?: unknown };
        if (typeof result.data === 'string' && result.data.length >= 128) return result.data;
      } catch {}
    }
    throw new Error('O viewport ainda não retornou uma imagem válida. Tente novamente.');
  }

  async #voiceVisualContext(
    segmentId: string,
    selected: VoiceVisualDraft | undefined,
    authorization: SecretWebAuthorization,
    client: VoidrServiceClient,
  ): Promise<VoiceVisualContext | undefined> {
    const existing = this.#voiceVisualUploads.get(segmentId);
    if (existing) return existing;
    if (!selected) return undefined;
    const upload = (async (): Promise<VoiceVisualContext> => {
      const [screenshot, crop] = await Promise.all([
        client.verificationIngest(authorization, 'evidence-assets', {
          generation: authorization.safeContext.verificationGeneration,
          kind: 'screenshot',
          contentType: 'image/jpeg',
          dataBase64: selected.screenshotBase64,
        }),
        client.verificationIngest(authorization, 'evidence-assets', {
          generation: authorization.safeContext.verificationGeneration,
          kind: 'crop',
          contentType: 'image/jpeg',
          dataBase64: selected.cropBase64,
        }),
      ]);
      const screenshotRef = String(screenshot.evidenceRef ?? '');
      const cropRef = String(crop.evidenceRef ?? '');
      if (!screenshotRef || !cropRef) {
        throw new Error('O recorte de voz não recebeu referências duráveis.');
      }
      return {
        kind: selected.kind,
        pageUrl: selected.pageUrl,
        rect: selected.rect,
        viewport: selected.viewport,
        screenshotRef,
        cropRef,
      };
    })();
    this.#voiceVisualUploads.set(segmentId, upload);
    try {
      return await upload;
    } catch (error) {
      this.#voiceVisualUploads.delete(segmentId);
      throw error;
    }
  }

  async voiceSegment(input: {
    segmentId: string;
    startedAtMs: number;
    endedAtMs: number;
    pcmBase64: string;
    language?: string;
    expectsVisual: boolean;
    visualSelectionId?: number;
  }): Promise<{ transcript: string; segmentId: string }> {
    if (this.#state.stage !== 'recording' || !this.#authorization || !this.#client) {
      throw new Error('A nota de voz exige uma gravação ativa.');
    }
    const authorization = this.#authorization;
    const client = this.#client;
    if (!this.#voiceVisualSnapshots.has(input.segmentId)) {
      const selected = input.expectsVisual ? this.#selectedVoiceVisual : undefined;
      if (
        input.expectsVisual &&
        (!selected || selected.selectionId !== input.visualSelectionId)
      ) {
        throw new Error(
          '[VOICE_VISUAL_UNAVAILABLE] A página mudou e a área não está mais disponível. Selecione-a novamente; sua gravação foi preservada.',
        );
      }
      this.#voiceVisualSnapshots.set(input.segmentId, selected ?? null);
    }
    const selectedVisual = this.#voiceVisualSnapshots.get(input.segmentId) ?? undefined;
    if (
      input.expectsVisual !== Boolean(selectedVisual) ||
      (selectedVisual && selectedVisual.selectionId !== input.visualSelectionId)
    ) {
      throw new Error(
        '[VOICE_VISUAL_UNAVAILABLE] O contexto visual desta voz mudou. Selecione a área novamente; sua gravação foi preservada.',
      );
    }
    if (
      !Number.isInteger(input.startedAtMs) ||
      !Number.isInteger(input.endedAtMs) ||
      typeof input.segmentId !== 'string' ||
      input.endedAtMs <= input.startedAtMs ||
      input.endedAtMs - input.startedAtMs > 120_000 ||
      typeof input.pcmBase64 !== 'string' ||
      input.pcmBase64.length > 5_200_000
    ) {
      throw new Error('O segmento de voz não respeita os limites de captura.');
    }
    let visual: VoiceVisualContext | undefined;
    let result: Record<string, unknown>;
    try {
      result = await this.#serializeVerificationMutation(async () => {
        visual = await this.#voiceVisualContext(
          input.segmentId,
          selectedVisual,
          authorization,
          client,
        );
        return client.verificationIngest(authorization, 'voice-segments', {
          generation: authorization.safeContext.verificationGeneration,
          segmentId: `desktop-voice-${input.segmentId}`,
          startedAtMs: input.startedAtMs,
          endedAtMs: input.endedAtMs,
          sampleRate: 16_000,
          language: input.language ?? 'pt-BR',
          pcmBase64: input.pcmBase64,
          ...(visual ? { visual } : {}),
        });
      });
    } catch (error) {
      if (
        error instanceof VoidrApiError &&
        error.status >= 400 &&
        error.status < 500 &&
        error.status !== 408
      ) {
        throw new Error(`[VOICE_SEND_DEFINITIVE] ${error.message}`);
      }
      throw error;
    }
    const segment = result.segment as Record<string, unknown> | undefined;
    const transcript = typeof segment?.text === 'string' ? segment.text : '';
    const isCurrent = () => this.#authorization === authorization &&
      this.#client === client &&
      this.#authorization?.safeContext.verificationGeneration ===
        authorization.safeContext.verificationGeneration;
    if (isCurrent() && !this.#acknowledgedVoiceSegmentIds.has(input.segmentId)) {
      this.#acknowledgedVoiceSegmentIds.add(input.segmentId);
      await this.#trackInCollector('voidr.voice', {
        transcriptRef: segment?.segmentId ?? null,
        startedAtMs: input.startedAtMs,
        endedAtMs: input.endedAtMs,
      });
      if (isCurrent()) {
        this.#addSignal(
          'voiceNotes',
          transcript ? 'Nota de voz transcrita' : 'Nota de voz capturada',
          transcript ? redactText(transcript).slice(0, 1_000) : undefined,
        );
        this.#increment('voiceNotes');
      }
    }
    if (isCurrent() && visual) {
      if (this.#selectedVoiceVisual === selectedVisual) this.#selectedVoiceVisual = undefined;
      this.#voiceVisualSnapshots.delete(input.segmentId);
      this.#voiceVisualUploads.delete(input.segmentId);
    } else if (isCurrent()) {
      this.#voiceVisualSnapshots.delete(input.segmentId);
    }
    return { transcript, segmentId: input.segmentId };
  }

  resize(): Rectangle | undefined {
    if (!this.#view || this.#view.webContents.isDestroyed()) return undefined;
    this.#view.setBounds(this.bounds());
    return this.#view.getBounds();
  }

  async disposeTarget(): Promise<void> {
    this.#stopSignalPolling();
    this.#acknowledgedVoiceSegmentIds.clear();
    await this.clearSelection();
    await this.#destroyTargetView();
    this.#authorization = undefined;
    this.#client = undefined;
    this.#collectorScript = undefined;
    this.#stopReceipt = undefined;
    this.#requestMeta.clear();
    this.#collectorEventWrites.clear();
    this.#consoleEventDeduper.clear();
    this.#recentSignals = [];
    this.#readinessObserverGeneration = undefined;
    this.#startedAt = 0;
    if (this.#state.stage !== 'idle') {
      this.#state = {
        ...initialCaptureState,
        evidence: { ...initialCaptureState.evidence },
      };
      this.emit(this.status);
    }
  }

  #createTargetView(
    organizationId: string,
    applicationId: string,
    collectorUrl: string,
  ): WebContentsView {
    const partition = createHash('sha256').update(`${organizationId}\0${applicationId}`).digest('hex').slice(0, 24);
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
    const targetSession = view.webContents.session;
    targetSession.webRequest.onHeadersReceived((details, callback) => {
      const isTargetMainFrame =
        details.webContentsId === view.webContents.id && details.resourceType === 'mainFrame';
      callback({
        responseHeaders: isTargetMainFrame
          ? allowCollectorInContentSecurityPolicy(details.responseHeaders, collectorUrl)
          : details.responseHeaders,
      });
    });
    view.webContents.setWindowOpenHandler(({ url }) => {
      if (isTrustedWebUrl(url) && this.#view === view) {
        // OAuth providers commonly request a popup. Keep the login inside the
        // capture surface, but never replace a navigation from inside
        // setWindowOpenHandler: Chromium can abort the in-flight load and, on
        // macOS, retrying while that view is torn down can crash the browser
        // process. The active load drains this queue once it settles.
        this.#queuedTargetWindowOpenUrl = url;
        if (!this.#targetLoadInProgress) this.#scheduleQueuedTargetWindowOpen(view);
      }
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
        void this.#injectCollector().catch((error) => this.#fail(error, 'WEB_NAVIGATION_RECOVERY_FAILED', 'stop'));
      }
    });
    view.webContents.on('did-start-navigation', (_event, _url, _isInPlace, isMainFrame) => {
      if (!isMainFrame) return;
      this.#targetNavigationEpoch += 1;
      const selectionEvent: SelectionEvent = this.#activeRegionOwner === 'voice' &&
        this.#activeVoiceSelectionId
        ? {
            owner: 'voice',
            selectionId: this.#activeVoiceSelectionId,
            ...(this.#selectedVoiceVisual
              ? { previousSelectionId: this.#selectedVoiceVisual.selectionId }
              : {}),
          }
        : this.#selectedVoiceVisual
          ? { owner: 'voice', selectionId: this.#selectedVoiceVisual.selectionId }
          : { owner: 'annotation' };
      const hadSelection = Boolean(
        this.#pendingElement ||
          this.#regionSelectionActive ||
          this.#selectedElement ||
          this.#selectedRegion ||
          this.#selectedVoiceVisual ||
          this.#activeRegionOwner,
      );
      if (!hadSelection) return;
      void this.clearSelection({ preserveVoiceUploads: true })
        .finally(() => this.emitSelectionInvalidated(selectionEvent));
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
    view.webContents.on('before-input-event', (event, input) => {
      if ((this.#pendingElement || this.#regionSelectionActive) && isKeyDownInput(input) && isEscapeInput(input)) {
        event.preventDefault();
        void this.cancelSelection();
      }
    });
    view.webContents.on('before-mouse-event', (_event, input) => {
      if (input.type === 'mouseDown') this.emitTargetPointerDown();
    });
    view.webContents.session.on('will-download', (event) => event.preventDefault());
    return view;
  }

  async #loadTargetUrl(url: string): Promise<void> {
    const view = this.#view;
    if (!view || view.webContents.isDestroyed()) throw new Error('Target Web ausente.');
    this.#targetLoadInProgress = true;
    let nextUrl = url;
    let retryAvailable = true;
    try {
      for (let redirectCount = 0; redirectCount < 8; redirectCount += 1) {
        if (this.#view !== view || view.webContents.isDestroyed()) {
          throw new Error('A aplicação capturada foi fechada durante a navegação.');
        }
        try {
          const trustedTargetLoad = this.#waitForTrustedTargetLoad(view);
          await withTimeout(
            Promise.race([
              view.webContents.loadURL(nextUrl).then(() => undefined),
              trustedTargetLoad,
            ]),
            TARGET_LOAD_TIMEOUT_MS,
            'A aplicação demorou demais para abrir no Voidr Capture.',
          );
        } catch (error) {
          await new Promise<void>((resolve) => setImmediate(resolve));
          const queuedUrl = this.#takeQueuedTargetWindowOpen(view);
          if (queuedUrl) {
            nextUrl = queuedUrl;
            continue;
          }
          if (isExpectedNavigationAbort(error)) {
            await withTimeout(
              this.#waitForTrustedTargetLoad(view),
              TARGET_LOAD_TIMEOUT_MS,
              'O redirecionamento de autenticação não terminou no Voidr Capture.',
            );
            return;
          }
          if (!retryAvailable) throw error;
          retryAvailable = false;
          view.webContents.stop();
          await view.webContents.session.clearCache();
          await this.ledger.append({
            type: 'web.load-retry',
            generation: this.#state.generation,
            stage: 'preparing',
            data: {
              reason: error instanceof Error ? error.message : 'Falha transitória.',
            },
          });
          continue;
        }

        await new Promise<void>((resolve) => setImmediate(resolve));
        const queuedUrl = this.#takeQueuedTargetWindowOpen(view);
        if (!queuedUrl) return;
        nextUrl = queuedUrl;
      }
      throw new Error('A autenticação abriu redirecionamentos demais no Voidr Capture.');
    } finally {
      if (this.#view === view) {
        this.#targetLoadInProgress = false;
        if (this.#queuedTargetWindowOpenUrl) this.#scheduleQueuedTargetWindowOpen(view);
      }
    }
  }

  #takeQueuedTargetWindowOpen(view: WebContentsView): string | undefined {
    if (this.#view !== view) return undefined;
    const url = this.#queuedTargetWindowOpenUrl;
    this.#queuedTargetWindowOpenUrl = undefined;
    return url;
  }

  #scheduleQueuedTargetWindowOpen(view: WebContentsView): void {
    setImmediate(() => {
      if (
        this.#view !== view ||
        view.webContents.isDestroyed() ||
        this.#targetLoadInProgress
      ) return;
      const url = this.#takeQueuedTargetWindowOpen(view);
      if (!url) return;
      void this.#loadTargetUrl(url).catch((error) => {
        if (this.#view !== view) return;
        this.#fail(
          error,
          'WEB_NAVIGATION_RECOVERY_FAILED',
          this.#state.stage === 'recording' ? 'stop' : undefined,
          this.#state.stage !== 'recording',
        );
      });
    });
  }

  #waitForTrustedTargetLoad(view: WebContentsView): Promise<void> {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        view.webContents.removeListener('did-finish-load', onFinish);
        view.webContents.removeListener('did-fail-load', onFail);
        view.webContents.removeListener('destroyed', onDestroyed);
      };
      const finish = () => {
        cleanup();
        resolve();
      };
      const fail = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onFinish = () => {
        const currentUrl = view.webContents.getURL();
        if (isTrustedWebUrl(currentUrl)) finish();
      };
      const onFail = (
        _event: Electron.Event,
        errorCode: number,
        errorDescription: string,
        validatedUrl: string,
        isMainFrame: boolean,
      ) => {
        if (!isMainFrame || errorCode === -3) return;
        fail(new Error(`${errorDescription} (${errorCode}) loading '${validatedUrl}'`));
      };
      const onDestroyed = () => fail(new Error('A aplicação capturada foi fechada durante o redirecionamento.'));

      view.webContents.on('did-finish-load', onFinish);
      view.webContents.on('did-fail-load', onFail);
      view.webContents.once('destroyed', onDestroyed);

      if (!view.webContents.isLoadingMainFrame() && isTrustedWebUrl(view.webContents.getURL())) {
        queueMicrotask(finish);
      }
    });
  }

  async #destroyTargetView(): Promise<void> {
    const view = this.#view;
    this.#view = undefined;
    this.#queuedTargetWindowOpenUrl = undefined;
    this.#targetLoadInProgress = false;
    if (!view) return;
    view.webContents.session.webRequest.onHeadersReceived(null);
    try {
      if (view.webContents.debugger.isAttached()) view.webContents.debugger.detach();
    } catch {}
    try {
      view.webContents.stop();
    } catch {}
    try {
      this.window.contentView.removeChildView(view);
    } catch {}
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (!view.webContents.isDestroyed()) {
      view.webContents.close({ waitForBeforeUnload: false });
    }
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
      networkCapture: true,
      // CDP is the desktop authority for resources. The collector runs in an
      // isolated world and cannot reliably intercept the application's fetch,
      // XHR or console APIs; enabling its resource observer as well would
      // duplicate static resources in the canonical network stream.
      captureResources: false,
      captureResourcesMaxPerSession: 200,
      captureResourcesSampleRate: 1,
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
    const code = `${this.#collectorScript}\n;globalThis.__voidrDesktopSignals={clicks:[]};document.addEventListener('click',(event)=>{const element=event.target instanceof Element?event.target.closest('[data-testid],[data-test],button,a,input,select,textarea,[role]'):null;const tag=element?.tagName?.toLowerCase?.()||'element';const testId=element?.getAttribute?.('data-testid')||element?.getAttribute?.('data-test')||'';const id=element?.id||'';const selector=(id?'#'+CSS.escape(id):testId?tag+'[data-testid="'+CSS.escape(testId)+'"]':tag).slice(0,240);const clicks=globalThis.__voidrDesktopSignals?.clicks;if(Array.isArray(clicks)){clicks.push({selector,x:Math.round(event.clientX),y:Math.round(event.clientY)});if(clicks.length>50)clicks.shift()}},{capture:true,passive:true});(()=>{const collector=globalThis.VoidrCollector;const durableStop=typeof collector?.stopAndFinalize==='function';const reportsReadiness=typeof collector?.isCaptureReady==='function';if(!durableStop||!reportsReadiness)return{sessionId:null,ready:false,durableStop:false};return Promise.resolve(collector.init(${JSON.stringify(options)})).then(()=>({sessionId:collector.getSessionId?.()||null,ready:collector.isCaptureReady(),durableStop:true}))})();`;
    const result = (await this.#view.webContents.executeJavaScriptInIsolatedWorld(COLLECTOR_WORLD, [{ code }])) as
      { sessionId?: unknown; ready?: unknown; durableStop?: unknown } | undefined;
    if (result?.durableStop !== true) {
      throw new Error(
        'O Collector publicado está incompatível com o Stop seguro. Atualize o bundle antes de iniciar o teste.',
      );
    }
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
      target.debugger.sendCommand('Network.enable', {
        maxTotalBufferSize: 1_000_000,
      }),
      target.debugger.sendCommand('Page.enable'),
      target.debugger.sendCommand('Runtime.enable'),
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
      this.#addSignal('pages', 'Navegação', this.#boundedResourceUrl(url));
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
      if (!requestId) return;
      const redirect = parameters.redirectResponse as Record<string, unknown> | undefined;
      const previous = this.#requestMeta.get(requestId);
      if (redirect && previous) {
        this.#recordNetworkSignal({
          requestId: `${previous.requestId}:${previous.sequence}`,
          method: previous.method,
          url: previous.url,
          status: Number(redirect.status ?? 0),
          statusText: String(redirect.statusText ?? '').slice(0, 200),
          mimeType: String(redirect.mimeType ?? '').slice(0, 120),
          durationMs: Date.now() - previous.startedAt,
          startedAt: previous.startedAt,
          resourceType: previous.resourceType,
          responseSize: Number(redirect.encodedDataLength ?? 0),
        });
      }
      if (!this.#isCapturableResource(url)) {
        this.#requestMeta.delete(requestId);
        return;
      }
      const wallTime = Number(parameters.wallTime);
      this.#requestMeta.set(requestId, {
        requestId,
        sequence: previous ? previous.sequence + 1 : 0,
        method: String(request?.method ?? 'GET').slice(0, 16),
        url: this.#boundedResourceUrl(url),
        startedAt:
          Number.isFinite(wallTime) && wallTime > 0 ? Math.round(wallTime * 1_000) : Date.now(),
        resourceType: String(parameters.type ?? 'Other').slice(0, 40),
      });
      return;
    }
    if (method === 'Network.responseReceived') {
      const requestId = String(parameters.requestId ?? '');
      const request = this.#requestMeta.get(requestId);
      if (!request) return;
      const response = parameters.response as Record<string, unknown> | undefined;
      request.resourceType = String(parameters.type ?? request.resourceType).slice(0, 40);
      request.response = {
        status: Number(response?.status ?? 0),
        statusText: String(response?.statusText ?? '').slice(0, 200),
        mimeType: String(response?.mimeType ?? '').slice(0, 120),
        responseSize: Number(response?.encodedDataLength ?? 0),
      };
      return;
    }
    if (method === 'Network.loadingFinished') {
      const requestId = String(parameters.requestId ?? '');
      const signal = finishCdpNetworkRequest(
        this.#requestMeta,
        requestId,
        Date.now(),
        Number(parameters.encodedDataLength),
      );
      if (signal) this.#recordNetworkSignal(signal);
      return;
    }
    if (method === 'Network.loadingFailed') {
      const requestId = String(parameters.requestId ?? '');
      const request = this.#requestMeta.get(requestId);
      if (!request) return;
      this.#requestMeta.delete(requestId);
      if (parameters.canceled === true || String(parameters.errorText ?? '') === 'net::ERR_ABORTED') return;
      const responseStatus = Number(request.response?.status ?? 0);
      this.#recordNetworkSignal({
        requestId: `${request.requestId}:${request.sequence}`,
        method: request.method,
        url: request.url,
        status: responseStatus >= 400 ? responseStatus : 0,
        statusText: request.response?.statusText,
        mimeType: request.response?.mimeType,
        durationMs: Date.now() - request.startedAt,
        startedAt: request.startedAt,
        resourceType: request.resourceType,
        responseSize: request.response?.responseSize,
        failure: redactText(String(parameters.errorText ?? 'Falha de rede')).slice(0, 240),
      });
      return;
    }
    if (method === 'Runtime.consoleAPICalled') {
      const error = consoleErrorFromCdp(parameters);
      if (error) this.#recordConsoleError(error);
      return;
    }
    if (method === 'Runtime.exceptionThrown') {
      const error = exceptionFromCdp(parameters);
      if (error) this.#recordConsoleError(error);
      return;
    }
  }

  #selectElement(): Promise<SelectedElement> {
    if (!this.#view || this.#view.webContents.isDestroyed()) {
      throw new Error('A aplicação capturada não está disponível.');
    }
    if (this.#pendingElement) throw new Error('Uma seleção já está ativa.');
    return new Promise((resolve, reject) => {
      const escapeAttribute = `data-voidr-element-escape-${randomUUID()}`;
      this.#elementEscapeAttribute = escapeAttribute;
      const timer = setTimeout(() => {
        if (this.#pendingElement?.timer !== timer) return;
        this.#pendingElement = undefined;
        void this.#view?.webContents.executeJavaScript(
          `document.documentElement.setAttribute(${JSON.stringify(escapeAttribute)},'1'); true`,
        );
        reject(new Error('A seleção de elemento expirou.'));
      }, 30_000);
      const pending = { resolve, reject, timer };
      this.#pendingElement = pending;
      void (async () => {
        try {
          await this.#view!.webContents.executeJavaScript(`(()=>{
            globalThis.__voidrDesktopElementEscapeCleanup?.();
            const attribute=${JSON.stringify(escapeAttribute)};
            const onKeyDown=(event)=>{
              if(event.key!=='Escape'&&event.key!=='Esc') return;
              event.preventDefault();
              event.stopImmediatePropagation();
              document.documentElement.setAttribute(attribute,'1');
            };
            document.addEventListener('keydown',onKeyDown,true);
            globalThis.__voidrDesktopElementEscapeCleanup=()=>{
              document.removeEventListener('keydown',onKeyDown,true);
              if(globalThis.__voidrDesktopElementEscapeCleanup) {
                globalThis.__voidrDesktopElementEscapeCleanup=undefined;
              }
            };
          })(); true`);
          const raw = await withTimeout(
            this.#view!.webContents.executeJavaScriptInIsolatedWorld(ELEMENT_SELECTION_WORLD, [
              {
                code: `new Promise((resolve) => {
                  globalThis.__voidrDesktopElementSelection?.cancel?.();
                  const escapeAttribute = ${JSON.stringify(escapeAttribute)};
                  const overlay = document.createElement('div');
                  const highlight = document.createElement('div');
                  const hint = document.createElement('div');
                  const cancel = document.createElement('button');
                  for (const node of [overlay, highlight, hint, cancel]) {
                    node.setAttribute('data-voidr-verification-overlay', '');
                  }
                  cancel.setAttribute('data-voidr-selection-cancel', '');
                  cancel.type = 'button';
                  Object.assign(overlay.style, {
                    position: 'fixed', inset: '0', zIndex: '2147483647', cursor: 'crosshair',
                    background: 'transparent', touchAction: 'none', userSelect: 'none'
                  });
                  Object.assign(highlight.style, {
                    position: 'fixed', display: 'none', pointerEvents: 'none',
                    border: '2px solid rgba(255,255,255,.94)', borderRadius: '5px',
                    background: 'rgba(255,255,255,.08)',
                    boxShadow: '0 0 0 9999px rgba(4,6,9,.42), 0 8px 28px rgba(0,0,0,.28)'
                  });
                  Object.assign(hint.style, {
                    position: 'fixed', top: '18px', left: '50%', transform: 'translateX(-50%)',
                    padding: '8px 12px', border: '1px solid rgba(255,255,255,.18)',
                    borderRadius: '999px', background: 'rgba(16,18,22,.96)', color: '#f4f4f5',
                    boxShadow: '0 12px 36px rgba(0,0,0,.35)',
                    font: '600 11px/1.2 system-ui, sans-serif', pointerEvents: 'auto',
                    display: 'flex', alignItems: 'center', gap: '10px'
                  });
                  hint.textContent = 'Clique em um elemento · Esc para cancelar';
                  Object.assign(cancel.style, {
                    appearance: 'none', border: '1px solid rgba(255,255,255,.22)',
                    borderRadius: '999px', background: 'rgba(255,255,255,.08)', color: '#f4f4f5',
                    padding: '4px 8px', font: '600 11px/1 system-ui, sans-serif', cursor: 'pointer'
                  });
                  cancel.textContent = 'Cancelar';
                  cancel.setAttribute('aria-label', 'Cancelar seleção de elemento');
                  hint.appendChild(cancel);
                  overlay.append(highlight, hint);
                  document.documentElement.appendChild(overlay);
                  let settled = false;
                  let escapeObserver;
                  let timeout;
                  const targetAt = (x, y) => {
                    overlay.style.visibility = 'hidden';
                    const target = document.elementFromPoint(x, y);
                    overlay.style.visibility = 'visible';
                    return target instanceof Element && !target.closest('[data-voidr-verification-overlay]')
                      ? target
                      : null;
                  };
                  const selectorFor = (element) => {
                    const escape = (value) => globalThis.CSS?.escape
                      ? globalThis.CSS.escape(value)
                      : String(value).replace(/[^A-Za-z0-9_-]/g, (character) => '\\\\' + character);
                    if (element.id) return '#' + escape(element.id);
                    for (const attribute of ['data-testid', 'data-test-id', 'data-test']) {
                      const value = element.getAttribute(attribute);
                      if (value) return element.tagName.toLowerCase() + '[' + attribute + '="' + escape(value) + '"]';
                    }
                    const parts = [];
                    let current = element;
                    while (current && current !== document.documentElement && parts.length < 5) {
                      let part = current.tagName.toLowerCase();
                      const siblings = current.parentElement
                        ? [...current.parentElement.children].filter((item) => item.tagName === current.tagName)
                        : [];
                      if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')';
                      parts.unshift(part);
                      current = current.parentElement;
                    }
                    return parts.join(' > ') || element.tagName.toLowerCase();
                  };
                  const finish = (value) => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timeout);
                    escapeObserver?.disconnect();
                    document.removeEventListener('keydown', onKeyDown, true);
                    overlay.removeEventListener('pointermove', onPointerMove, true);
                    overlay.removeEventListener('pointerdown', swallow, true);
                    overlay.removeEventListener('pointerup', swallow, true);
                    overlay.removeEventListener('click', onClick, true);
                    document.documentElement.removeAttribute(escapeAttribute);
                    overlay.remove();
                    globalThis.__voidrDesktopElementSelection = undefined;
                    resolve(value);
                  };
                  const update = (event) => {
                    const target = targetAt(event.clientX, event.clientY);
                    if (!target) {
                      highlight.style.display = 'none';
                      return;
                    }
                    const rect = target.getBoundingClientRect();
                    Object.assign(highlight.style, {
                      display: rect.width >= 2 && rect.height >= 2 ? 'block' : 'none',
                      left: Math.max(0, rect.x) + 'px', top: Math.max(0, rect.y) + 'px',
                      width: Math.max(0, Math.min(innerWidth - Math.max(0, rect.x), rect.width)) + 'px',
                      height: Math.max(0, Math.min(innerHeight - Math.max(0, rect.y), rect.height)) + 'px'
                    });
                  };
                  const onKeyDown = (event) => {
                    if (event.key !== 'Escape' && event.key !== 'Esc') return;
                    event.preventDefault();
                    event.stopImmediatePropagation();
                    finish(null);
                  };
                  const swallow = (event) => {
                    if (event.button !== 0) return;
                    event.preventDefault();
                    event.stopImmediatePropagation();
                    if (event.target instanceof Element && event.target.closest('[data-voidr-selection-cancel]')) {
                      finish(null);
                      return;
                    }
                    update(event);
                  };
                  const onPointerMove = (event) => update(event);
                  const onClick = (event) => {
                    event.preventDefault();
                    event.stopImmediatePropagation();
                    if (event.target instanceof Element && event.target.closest('[data-voidr-selection-cancel]')) {
                      finish(null);
                      return;
                    }
                    const target = targetAt(event.clientX, event.clientY);
                    if (!target) return;
                    const rect = target.getBoundingClientRect();
                    finish({
                      selector: selectorFor(target).slice(0, 500),
                      rect: {
                        x: Math.max(0, rect.x), y: Math.max(0, rect.y),
                        width: Math.max(0, Math.min(innerWidth - Math.max(0, rect.x), rect.width)),
                        height: Math.max(0, Math.min(innerHeight - Math.max(0, rect.y), rect.height))
                      }
                    });
                  };
                  document.addEventListener('keydown', onKeyDown, true);
                  overlay.addEventListener('pointermove', onPointerMove, true);
                  overlay.addEventListener('pointerdown', swallow, true);
                  overlay.addEventListener('pointerup', swallow, true);
                  overlay.addEventListener('click', onClick, true);
                  escapeObserver = new MutationObserver(() => {
                    if (document.documentElement.hasAttribute(escapeAttribute)) finish(null);
                  });
                  escapeObserver.observe(document.documentElement, {
                    attributes: true,
                    attributeFilter: [escapeAttribute],
                  });
                  if (document.documentElement.hasAttribute(escapeAttribute)) finish(null);
                  timeout = setTimeout(() => finish(null), 30000);
                  globalThis.__voidrDesktopElementSelection = { cancel: () => finish(null) };
                })`,
              },
            ]),
            31_000,
            'A seleção de elemento expirou.',
          );
          if (this.#pendingElement !== pending) return;
          clearTimeout(timer);
          this.#pendingElement = undefined;
          if (!raw || typeof raw !== 'object') {
            pending.reject(new Error('A seleção foi cancelada.'));
            this.emitSelectionCancelled({ owner: 'annotation' });
            return;
          }
          const value = raw as Record<string, unknown>;
          const rectValue = value.rect as Record<string, unknown> | undefined;
          const rect = rectValue
            ? {
                x: Number(rectValue.x),
                y: Number(rectValue.y),
                width: Number(rectValue.width),
                height: Number(rectValue.height),
              }
            : undefined;
          const selector = typeof value.selector === 'string' ? value.selector.trim() : '';
          const viewport = this.#view!.getBounds();
          if (
            !selector ||
            !rect ||
            !Object.values(rect).every(Number.isFinite) ||
            rect.x < 0 ||
            rect.y < 0 ||
            rect.width < 2 ||
            rect.height < 2 ||
            rect.x + rect.width > viewport.width + 1 ||
            rect.y + rect.height > viewport.height + 1
          ) {
            pending.reject(new Error('O elemento selecionado não é válido.'));
            return;
          }
          pending.resolve({ selector, rect });
        } catch (error) {
          if (this.#pendingElement !== pending) return;
          clearTimeout(timer);
          this.#pendingElement = undefined;
          pending.reject(error instanceof Error ? error : new Error(String(error)));
        } finally {
          if (this.#elementEscapeAttribute === escapeAttribute) {
            this.#elementEscapeAttribute = undefined;
          }
          if (this.#view && !this.#view.webContents.isDestroyed()) {
            try {
              await this.#view.webContents.executeJavaScript(`(()=>{
                globalThis.__voidrDesktopElementEscapeCleanup?.();
                document.documentElement.removeAttribute(${JSON.stringify(escapeAttribute)});
              })(); true`);
            } catch {}
          }
        }
      })();
    });
  }

  async #selectRegion(): Promise<SelectedRegion> {
    if (!this.#view || this.#view.webContents.isDestroyed()) {
      throw new Error('A aplicação capturada não está disponível.');
    }
    if (this.#pendingElement || this.#regionSelectionActive) {
      throw new Error('Uma seleção já está ativa.');
    }
    this.#regionSelectionActive = true;
    const escapeAttribute = `data-voidr-region-escape-${randomUUID()}`;
    this.#regionEscapeAttribute = escapeAttribute;
    try {
      await this.#view.webContents.executeJavaScript(`(()=>{
        globalThis.__voidrDesktopRegionEscapeCleanup?.();
        const attribute=${JSON.stringify(escapeAttribute)};
        const onKeyDown=(event)=>{
          if(event.key!=='Escape'&&event.key!=='Esc') return;
          event.preventDefault();
          event.stopImmediatePropagation();
          document.documentElement.setAttribute(attribute,'1');
        };
        document.addEventListener('keydown',onKeyDown,true);
        globalThis.__voidrDesktopRegionEscapeCleanup=()=>{
          document.removeEventListener('keydown',onKeyDown,true);
          if(globalThis.__voidrDesktopRegionEscapeCleanup) {
            globalThis.__voidrDesktopRegionEscapeCleanup=undefined;
          }
        };
      })(); true`);
      const raw = await withTimeout(
        this.#view.webContents.executeJavaScriptInIsolatedWorld(REGION_SELECTION_WORLD, [
          {
            code: `new Promise((resolve) => {
              globalThis.__voidrDesktopRegionSelection?.cancel?.();
              const escapeAttribute = ${JSON.stringify(escapeAttribute)};
              const overlay = document.createElement('div');
              const box = document.createElement('div');
              const hint = document.createElement('div');
              Object.assign(overlay.style, {
                position: 'fixed', inset: '0', zIndex: '2147483647', cursor: 'crosshair',
                background: 'rgba(15, 17, 21, .18)', touchAction: 'none', userSelect: 'none'
              });
              Object.assign(box.style, {
                position: 'fixed', display: 'none', pointerEvents: 'none',
                border: '2px solid rgba(255,255,255,.94)', borderRadius: '5px',
                background: 'rgba(255,255,255,.08)', boxShadow: '0 0 0 9999px rgba(4,6,9,.62)'
              });
              Object.assign(hint.style, {
                position: 'fixed', top: '18px', left: '50%', transform: 'translateX(-50%)',
                padding: '8px 12px', border: '1px solid rgba(255,255,255,.18)',
                borderRadius: '999px', background: 'rgba(16,18,22,.96)', color: '#f4f4f5',
                boxShadow: '0 12px 36px rgba(0,0,0,.35)', font: '600 11px/1.2 system-ui, sans-serif',
                pointerEvents: 'none'
              });
              hint.textContent = 'Arraste para selecionar · Esc para cancelar';
              overlay.append(box, hint);
              document.documentElement.appendChild(overlay);
              let start = null;
              let settled = false;
              let escapeObserver;
              let timeout;
              const update = (event) => {
                if (!start) return;
                const endX = Math.max(0, Math.min(innerWidth, event.clientX));
                const endY = Math.max(0, Math.min(innerHeight, event.clientY));
                const x = Math.min(start.x, endX);
                const y = Math.min(start.y, endY);
                Object.assign(box.style, {
                  display: 'block', left: x + 'px', top: y + 'px',
                  width: Math.abs(endX - start.x) + 'px', height: Math.abs(endY - start.y) + 'px'
                });
              };
              const finish = (value) => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                escapeObserver?.disconnect();
                document.removeEventListener('keydown', onKeyDown, true);
                document.documentElement.removeAttribute(escapeAttribute);
                overlay.remove();
                globalThis.__voidrDesktopRegionSelection = undefined;
                resolve(value);
              };
              const onKeyDown = (event) => {
                if (event.key !== 'Escape') return;
                event.preventDefault();
                event.stopImmediatePropagation();
                finish(null);
              };
              overlay.addEventListener('pointerdown', (event) => {
                if (event.button !== 0) return;
                event.preventDefault();
                start = { x: event.clientX, y: event.clientY };
                update(event);
              });
              overlay.addEventListener('pointermove', (event) => {
                if (!start) return;
                event.preventDefault();
                update(event);
              });
              overlay.addEventListener('pointerup', (event) => {
                if (!start || event.button !== 0) return;
                event.preventDefault();
                const rect = {
                  x: Math.min(start.x, event.clientX), y: Math.min(start.y, event.clientY),
                  width: Math.abs(event.clientX - start.x), height: Math.abs(event.clientY - start.y)
                };
                finish(rect.width >= 8 && rect.height >= 8 ? rect : null);
              });
              document.addEventListener('keydown', onKeyDown, true);
              escapeObserver = new MutationObserver(() => {
                if (document.documentElement.hasAttribute(escapeAttribute)) finish(null);
              });
              escapeObserver.observe(document.documentElement, {
                attributes: true,
                attributeFilter: [escapeAttribute],
              });
              if (document.documentElement.hasAttribute(escapeAttribute)) finish(null);
              timeout = setTimeout(() => finish(null), 30000);
              globalThis.__voidrDesktopRegionSelection = {
                cancel: () => finish(null),
                select: (rect) => finish(rect)
              };
            })`,
          },
        ]),
        31_000,
        'A seleção de região expirou.',
      );
      if (!raw || typeof raw !== 'object') throw new Error('A seleção foi cancelada.');
      const value = raw as Record<string, unknown>;
      const rect = {
        x: Number(value.x),
        y: Number(value.y),
        width: Number(value.width),
        height: Number(value.height),
      };
      const viewport = this.#view.getBounds();
      if (
        !Object.values(rect).every(Number.isFinite) ||
        rect.x < 0 ||
        rect.y < 0 ||
        rect.width < 8 ||
        rect.height < 8 ||
        rect.x + rect.width > viewport.width + 1 ||
        rect.y + rect.height > viewport.height + 1
      ) {
        throw new Error('A região selecionada não é válida.');
      }
      return { rect };
    } finally {
      this.#regionSelectionActive = false;
      this.#regionEscapeAttribute = undefined;
      if (this.#view && !this.#view.webContents.isDestroyed()) {
        try {
          await this.#view.webContents.executeJavaScript(`(()=>{
            globalThis.__voidrDesktopRegionEscapeCleanup?.();
            document.documentElement.removeAttribute(${JSON.stringify(escapeAttribute)});
          })(); true`);
        } catch {}
      }
    }
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
      const authorization = this.#authorization;
      const client = this.#client;
      const completion = await this.#waitForCycleReady(
        client,
        authorization.safeContext.verificationId,
        authorization.safeContext.harnessDeliveryState,
      );
      if (completion.deliveryState) {
        this.#setState(
          captureReducer(this.#state, {
            type: 'HARNESS_DELIVERY',
            state: completion.deliveryState,
          }),
        );
      }
      if (completion.ready) this.#setState(captureReducer(this.#state, { type: 'READY' }));
      await this.ledger.append({
        type: completion.ready ? 'web.ready' : 'web.processing',
        generation: this.#state.generation,
        sessionId: this.#stopReceipt.sessionId,
        stage: this.#state.stage,
        data: {
          indexedThrough,
          ...(completion.deliveryState ? { harnessDeliveryState: completion.deliveryState } : {}),
        },
      });
      if (completion.ready && completion.deliveryState && completion.deliveryState !== 'acknowledged') {
        void this.#observeHarnessAcknowledgement(
          this.#client,
          this.#authorization.safeContext.verificationId,
          this.#state.generation,
        );
      }
      if (completion.ready) {
        this.#releaseAuthorization(this.#state.generation);
      } else {
        this.#observeCycleReadiness({
          client,
          verificationId: authorization.safeContext.verificationId,
          generation: this.#state.generation,
          initialDeliveryState: completion.deliveryState,
          indexedThrough,
        });
      }
      return this.status;
    } catch (error) {
      this.#fail(error, 'WEB_ATTACH_FAILED', 'attach');
      throw error;
    }
  }

  async #waitForCycleReady(
    client: VoidrServiceClient,
    verificationId: string,
    initialDeliveryState?: HarnessDeliveryState,
    timeoutMs = 30_000,
  ): Promise<{ ready: boolean; deliveryState?: HarnessDeliveryState }> {
    if (!client.runtime.localAdapter) {
      return {
        ready: true,
        ...(initialDeliveryState ? { deliveryState: initialDeliveryState } : {}),
      };
    }
    const deadline = Date.now() + timeoutMs;
    let deliveryState = initialDeliveryState;
    let consecutiveStatusFailures = 0;
    while (Date.now() < deadline) {
      let status: Record<string, unknown> | null = null;
      try {
        status = await client.getVerificationStatus(verificationId);
        consecutiveStatusFailures = 0;
      } catch {
        consecutiveStatusFailures += 1;
        if (consecutiveStatusFailures >= 3) {
          throw new Error('A captura foi preservada, mas o Cycle não pôde ser localizado para preparar a revisão.');
        }
      }
      const state = status && typeof status.status === 'string' ? status.status : '';
      const candidateDeliveryState =
        status?.harnessDelivery && typeof status.harnessDelivery === 'object'
          ? (status.harnessDelivery as Record<string, unknown>).state
          : undefined;
      if (
        typeof candidateDeliveryState === 'string' &&
        ['waiting', 'preparing', 'available', 'acknowledged', 'failed'].includes(candidateDeliveryState)
      ) {
        deliveryState = candidateDeliveryState as HarnessDeliveryState;
      }
      if (
        ['artifact_ready', 'diagnosing', 'diagnosis_ready', 'decision_required', 'open', 'confirmed'].includes(state)
      ) {
        return { ready: true, ...(deliveryState ? { deliveryState } : {}) };
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    return { ready: false, ...(deliveryState ? { deliveryState } : {}) };
  }

  #observeCycleReadiness(input: {
    client: VoidrServiceClient;
    verificationId: string;
    generation?: string;
    initialDeliveryState?: HarnessDeliveryState;
    indexedThrough: number;
  }): void {
    if (!input.generation || this.#readinessObserverGeneration === input.generation) return;
    this.#readinessObserverGeneration = input.generation;
    void (async () => {
      try {
        const completion = await this.#waitForCycleReady(
          input.client,
          input.verificationId,
          input.initialDeliveryState,
          90_000,
        );
        if (this.#state.generation !== input.generation || this.#state.stage !== 'processing') {
          return;
        }
        if (!completion.ready) {
          throw new Error('A captura está preservada, mas a preparação da revisão excedeu o tempo esperado.');
        }
        if (completion.deliveryState) {
          this.#setState(
            captureReducer(this.#state, {
              type: 'HARNESS_DELIVERY',
              state: completion.deliveryState,
            }),
          );
        }
        this.#setState(captureReducer(this.#state, { type: 'READY' }));
        await this.ledger.append({
          type: 'web.ready',
          generation: input.generation,
          sessionId: this.#state.sessionId,
          stage: 'ready_for_review',
          data: {
            indexedThrough: input.indexedThrough,
            ...(completion.deliveryState ? { harnessDeliveryState: completion.deliveryState } : {}),
            resumedInBackground: true,
          },
        });
        this.#releaseAuthorization(input.generation);
        if (completion.deliveryState && completion.deliveryState !== 'acknowledged') {
          void this.#observeHarnessAcknowledgement(input.client, input.verificationId, input.generation);
        }
      } catch (error) {
        if (this.#state.generation === input.generation && this.#state.stage === 'processing') {
          this.#fail(error, 'WEB_PROCESSING_TIMEOUT', 'attach');
        }
      } finally {
        if (this.#readinessObserverGeneration === input.generation) {
          this.#readinessObserverGeneration = undefined;
        }
      }
    })();
  }

  #releaseAuthorization(generation?: string): void {
    if (!generation || this.#state.generation !== generation) return;
    this.#authorization = undefined;
    this.#client = undefined;
    this.#collectorScript = undefined;
  }

  async #observeHarnessAcknowledgement(
    client: VoidrServiceClient,
    verificationId: string,
    generation: string | undefined,
    timeoutMs = 120_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (
      Date.now() < deadline &&
      generation &&
      this.#state.generation === generation &&
      this.#state.stage === 'ready_for_review'
    ) {
      const status = await client.getVerificationStatus(verificationId).catch(() => null);
      const candidate =
        status?.harnessDelivery && typeof status.harnessDelivery === 'object'
          ? (status.harnessDelivery as Record<string, unknown>).state
          : undefined;
      if (
        typeof candidate === 'string' &&
        ['waiting', 'preparing', 'available', 'acknowledged', 'failed'].includes(candidate)
      ) {
        this.#setState(
          captureReducer(this.#state, {
            type: 'HARNESS_DELIVERY',
            state: candidate as HarnessDeliveryState,
          }),
        );
        if (candidate === 'acknowledged' || candidate === 'failed') return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    }
  }

  async #captureExistingNetworkEntries(): Promise<void> {
    if (!this.#view || this.#view.webContents.isDestroyed()) return;
    const entries = (await this.#view.webContents
      .executeJavaScriptInIsolatedWorld(COLLECTOR_WORLD, [
        {
          code: `(()=>{const normalize=(entry)=>({url:String(entry.name||''),method:'GET',status:Number(entry.responseStatus||0),mimeType:'',resourceType:String(entry.initiatorType||entry.entryType||'resource'),durationMs:Math.max(0,Math.round(Number(entry.duration||0))),startedAt:Math.round(Number(performance.timeOrigin||Date.now())+Number(entry.startTime||0)),responseSize:Math.max(0,Math.round(Number(entry.transferSize||entry.encodedBodySize||0)))});const navigation=performance.getEntriesByType('navigation').map(normalize);const resources=performance.getEntriesByType('resource').slice(-200).map(normalize);return [...navigation,...resources].slice(-200)})()`,
        },
      ])
      .catch(() => [])) as unknown;
    if (!Array.isArray(entries)) return;
    let captured = 0;
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;
      const value = entry as Record<string, unknown>;
      const url = String(value.url ?? '');
      if (!this.#isCapturableResource(url)) continue;
      this.#recordNetworkSignal(
        {
          method: String(value.method ?? 'GET'),
          url: this.#boundedResourceUrl(url),
          status: Number(value.status ?? 0),
          mimeType: String(value.mimeType ?? '').slice(0, 120),
          durationMs: Math.max(0, Math.round(Number(value.durationMs ?? 0))),
          startedAt: Math.round(Number(value.startedAt ?? Date.now())),
          resourceType: String(value.resourceType ?? 'resource').slice(0, 40),
          responseSize: Math.max(0, Math.round(Number(value.responseSize ?? 0))),
        },
        false,
      );
      captured += 1;
    }
    if (captured) this.#increment('requests', captured);
  }

  async #settlePendingNetworkRequests(): Promise<void> {
    if (this.#requestMeta.size === 0) return;
    const deadline = Date.now() + CDP_NETWORK_SETTLE_TIMEOUT_MS;
    while (this.#requestMeta.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, CDP_NETWORK_SETTLE_POLL_MS));
    }
    for (const signal of drainKnownCdpNetworkResponses(this.#requestMeta)) {
      this.#recordNetworkSignal(signal);
    }
  }

  #recordNetworkSignal(input: CanonicalNetworkSignal, increment = true): void {
    const method =
      input.method
        .trim()
        .toUpperCase()
        .replace(/[^A-Z]/g, '')
        .slice(0, 16) || 'GET';
    const status = Number.isFinite(input.status) ? Math.max(0, Math.round(input.status)) : 0;
    const url = this.#boundedResourceUrl(input.url);
    const durationMs = Number.isFinite(input.durationMs) ? Math.max(0, Math.round(input.durationMs)) : 0;
    const tone =
      status >= 500 || input.failure
        ? 'error'
        : status >= 400
          ? 'warning'
          : status >= 200 && status < 400
            ? 'success'
            : 'neutral';
    const outcome = input.failure || (status ? `HTTP ${status}` : 'Resposta não disponível');
    this.#addSignal(
      'requests',
      `${method} · ${outcome}`,
      `${url} · ${durationMs} ms${input.mimeType ? ` · ${input.mimeType}` : ''}`,
      tone,
    );
    if (increment) this.#increment('requests');
    this.#captureNetworkInCollector({
      type: canonicalNetworkType(input.resourceType, Boolean(input.failure)),
      ...(input.requestId ? { requestId: input.requestId } : {}),
      timestamp:
        typeof input.startedAt === 'number' && Number.isFinite(input.startedAt)
          ? Math.round(input.startedAt)
          : Date.now(),
      url,
      method,
      status,
      statusText: redactText(input.failure || input.statusText || '').slice(0, 200),
      duration: durationMs,
      contentType: String(input.mimeType ?? '').slice(0, 120),
      responseSize:
        typeof input.responseSize === 'number' && Number.isFinite(input.responseSize)
        ? Math.max(0, Math.round(input.responseSize))
        : 0,
    });
  }

  #recordConsoleError(error: CanonicalConsoleError): void {
    if (!this.#consoleEventDeduper.accept(error)) return;
    this.#addSignal('errors', error.name, error.message, 'error');
    this.#increment('errors');
    const { fingerprint: _fingerprint, ...durableError } = error;
    const serialized = JSON.stringify(durableError);
    this.#enqueueCollectorWrite(`(()=>{const value=${serialized};globalThis.VoidrCollector?.captureException?.(value.message,value.context);return true})()`);
  }

  #captureNetworkInCollector(event: Record<string, unknown>): void {
    this.#enqueueCollectorWrite(
      `Boolean(globalThis.VoidrCollector?.captureNetwork?.(${JSON.stringify(event)}))`,
    );
  }

  #enqueueCollectorWrite(code: string): void {
    if (!this.#view || this.#view.webContents.isDestroyed() || this.#state.stage !== 'recording') return;
    const write = this.#view.webContents
      .executeJavaScriptInIsolatedWorld(COLLECTOR_WORLD, [{ code }])
      .then(() => undefined)
      .catch(() => undefined);
    this.#collectorEventWrites.add(write);
    void write.then(() => this.#collectorEventWrites.delete(write));
  }

  async #flushCollectorEventWrites(): Promise<void> {
    while (this.#collectorEventWrites.size > 0) {
      await Promise.allSettled([...this.#collectorEventWrites]);
    }
  }

  async #ingestLifecycle(
    type: 'recording.started' | 'seal.requested',
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (!this.#authorization || !this.#client) return;
    const authorization = this.#authorization;
    const client = this.#client;
    await this.#serializeVerificationMutation(() =>
      client.verificationIngest(authorization, 'lifecycle-events', {
        version: 'HIL/1',
        lifecycleVersion: authorization.safeContext.lifecycleVersion,
        idempotencyKey: `desktop-lifecycle:${type}:${authorization.safeContext.verificationGeneration}`,
        type,
        occurredAt: new Date().toISOString(),
        payload,
      }).then(() => undefined),
    );
  }

  #startSignalPolling(): void {
    this.#stopSignalPolling();
    this.#signalTimer = setInterval(() => {
      if (!this.#view || this.#state.stage !== 'recording') return;
      void this.#view.webContents
        .executeJavaScriptInIsolatedWorld(COLLECTOR_WORLD, [
          {
            code: `(()=>{const value=Array.isArray(globalThis.__voidrDesktopSignals?.clicks)?globalThis.__voidrDesktopSignals.clicks.splice(0,50):[];return value})()`,
          },
        ])
        .then((clicks) => {
          if (!Array.isArray(clicks) || clicks.length === 0) return;
          const bounded = clicks.slice(0, 50).flatMap((entry) => {
            if (!entry || typeof entry !== 'object') return [];
            const value = entry as Record<string, unknown>;
            const selector = redactText(String(value.selector ?? 'element')).slice(0, 240);
            const x = Math.round(Number(value.x ?? 0));
            const y = Math.round(Number(value.y ?? 0));
            this.#addSignal('clicks', `Clique em ${selector}`, `x ${x} · y ${y}`);
            return [{ selector, x, y }];
          });
          if (!bounded.length) return;
          this.#increment('clicks', bounded.length);
          void this.#trackInCollector('voidr.desktop.click', {
            clicks: bounded,
          });
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

  async #uploadAnnotation(item: DurableAnnotation): Promise<void> {
    await this.#serializeVerificationMutation(async () => {
      const client = new VoidrServiceClient(item.runtime);
      const authorization = structuredClone(item.authorization);
      if (this.#authorization?.safeContext.verificationId === authorization.safeContext.verificationId) {
        authorization.safeContext.lifecycleVersion = Math.max(
          authorization.safeContext.lifecycleVersion,
          this.#authorization.safeContext.lifecycleVersion,
        );
      }
      const screenshot = await client.verificationIngest(authorization, 'evidence-assets', {
        generation: authorization.safeContext.verificationGeneration,
        kind: 'screenshot',
        contentType: 'image/jpeg',
        dataBase64: item.annotation.screenshotBase64,
      });
      const screenshotRef = String(screenshot.evidenceRef ?? '');
      if (!screenshotRef) throw new Error('A evidência não recebeu uma referência durável.');

      let cropRef: string | undefined;
      if (item.annotation.cropBase64) {
        const crop = await client.verificationIngest(authorization, 'evidence-assets', {
          generation: authorization.safeContext.verificationGeneration,
          kind: 'crop',
          contentType: 'image/jpeg',
          dataBase64: item.annotation.cropBase64,
        });
        const durableCropRef = String(crop.evidenceRef ?? '');
        if (durableCropRef) cropRef = durableCropRef;
      }

      await client.verificationIngest(authorization, 'annotations', {
        version: 'HIL/1',
        lifecycleVersion: authorization.safeContext.lifecycleVersion,
        idempotencyKey: item.annotation.idempotencyKey,
        kind: item.annotation.kind,
        note: item.annotation.note,
        pageUrl: item.annotation.pageUrl,
        timestampMs: item.annotation.timestampMs,
        ...(item.annotation.selector ? { selector: item.annotation.selector } : {}),
        ...(item.annotation.rect ? { rect: item.annotation.rect } : {}),
        viewport: item.annotation.viewport,
        screenshotRef,
        ...(cropRef ? { cropRef } : {}),
      });

      if (this.#authorization?.safeContext.verificationId === authorization.safeContext.verificationId) {
        this.#authorization.safeContext.lifecycleVersion = Math.max(
          this.#authorization.safeContext.lifecycleVersion,
          authorization.safeContext.lifecycleVersion,
        );
        await this.#trackInCollector('voidr.note', {
          kind: item.annotation.kind,
          evidenceRef: screenshotRef,
          timestampMs: item.annotation.timestampMs,
        });
      }
    });
  }

  async #drainAnnotationOutbox(scheduleRetry: boolean): Promise<{
    syncedIds: string[];
    failedIds: string[];
    pendingCount: number;
  }> {
    const result = await this.annotationOutbox.drain((item) => this.#uploadAnnotation(item));
    for (const localId of result.syncedIds) {
      this.#emitAnnotationSync('synced', localId, result.pendingCount);
    }
    if (result.failedIds.length > 0) {
      this.#emitAnnotationSync('pending', result.failedIds[0]!, result.pendingCount);
      if (scheduleRetry && !this.#annotationRetryTimer) {
        const delay = this.#annotationRetryDelayMs;
        this.#annotationRetryDelayMs = Math.min(60_000, delay * 2);
        this.#annotationRetryTimer = setTimeout(() => {
          this.#annotationRetryTimer = undefined;
          void this.#drainAnnotationOutbox(true);
        }, delay);
      }
    } else {
      this.#annotationRetryDelayMs = 2_000;
      if (this.#annotationRetryTimer) clearTimeout(this.#annotationRetryTimer);
      this.#annotationRetryTimer = undefined;
    }
    return result;
  }

  #emitAnnotationSync(
    state: 'queued' | 'synced' | 'pending',
    localId: string,
    pendingCount: number,
  ): void {
    if (this.window.isDestroyed() || this.window.webContents.isDestroyed()) return;
    this.window.webContents.send('capture:annotation-sync', { state, localId, pendingCount });
  }

  #serializeVerificationMutation<T>(task: () => Promise<T>): Promise<T> {
    const result = this.#verificationMutationTail.then(task, task);
    this.#verificationMutationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  #increment(category: EvidenceCategory, increment = 1): void {
    if (this.#state.stage !== 'recording') return;
    this.#setState(captureReducer(this.#state, { type: 'EVIDENCE', category, increment }));
  }

  #addSignal(
    category: CapturedSignal['category'],
    title: string,
    detail?: string,
    tone: CapturedSignal['tone'] = 'neutral',
  ): void {
    this.#recentSignals = [
      {
        id: randomUUID(),
        category,
        atMs: Math.max(0, Date.now() - this.#startedAt),
        title: redactText(title).slice(0, 240),
        ...(detail ? { detail: redactText(detail).slice(0, 1_000) } : {}),
        tone,
      },
      ...this.#recentSignals,
    ].slice(0, 60);
  }

  #isVoidrInfrastructure(input: string): boolean {
    if (!this.#client) return false;
    return [
      this.#client.runtime.collectorUrl,
      this.#client.runtime.serviceUrl,
      this.#client.runtime.collectorScriptUrl,
    ].some((base) => input.startsWith(base));
  }

  #isCapturableResource(input: string): boolean {
    try {
      const url = new URL(input);
      return ['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) && !this.#isVoidrInfrastructure(input);
    } catch {
      return false;
    }
  }

  #boundedResourceUrl(input: string): string {
    try {
      const url = new URL(input);
      return `${url.origin}${url.pathname}`.slice(0, 1_000);
    } catch {
      return '[invalid-url]';
    }
  }

  #fail(error: unknown, code: string, retryFrom?: 'stop' | 'attach', terminal = false): void {
    const message = redactText(error instanceof Error ? error.message : String(error));
    try {
      this.#setState(
        captureReducer(this.#state, {
          type: 'FAIL',
          message,
          code,
          retryFrom,
          terminal,
        }),
      );
    } catch {
      this.#state = {
        ...this.#state,
        stage: terminal ? 'terminal_error' : 'recoverable_error',
        message,
        errorCode: code,
        retryFrom,
      };
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
