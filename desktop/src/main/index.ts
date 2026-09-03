import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, globalShortcut, ipcMain, net, protocol, safeStorage, session, shell } from 'electron';
import { z } from 'zod';
import { buildLoopCodeHandoffUrl, loopCodeHandoffInputSchema } from './code-handoff';
import {
  androidLaunchInputSchema,
  desktopCaptureLaunchSchema,
  localRuntimeConfigSchema,
  mobileAttachInputSchema,
  PENDING_CAPTURE_ORGANIZATION_ID,
  prepareWebInputSchema,
  type DesktopCaptureLaunch,
  type CaptureStatus,
  type DesktopWorkspaceIdentity,
  type DesktopWorkspaceLink,
} from '@voidr/capture-contracts';
import { annotationInputSchema } from '@voidr/capture-contracts';
import { discoverAndroidSessions, doctorAndroid, launchAndroid } from './android-adapter';
import { CaptureLedger } from './ledger';
import { CONTROL_ORIGIN, CONTROL_SCHEME, isControlRendererUrl, resolveControlAsset } from './app-protocol';
import { VoidrServiceClient } from './service-client';
import { LoopParticipantAuthSession } from './loop-participant-auth';
import { WebCaptureController } from './web-capture-controller';
import { parseDesktopProtocolLink } from './deep-link';
import { AnnotationOutbox } from './annotation-outbox';
import {
  connectWorkspaceSession,
  createWorkspaceSession,
  workspacePlatformLoopsUrl,
} from './workspace-session';

const directory = __dirname;
const isDevelopment = Boolean(process.env.VOIDR_CAPTURE_DEV_SERVER_URL);
const isAutomation = !app.isPackaged && process.env.VOIDR_CAPTURE_E2E === '1';
const developmentUserDataDir = process.env.VOIDR_CAPTURE_DEV_USER_DATA_DIR;
if (!app.isPackaged && developmentUserDataDir && path.isAbsolute(developmentUserDataDir)) {
  // Keep source-checkout smoke tests isolated from an installed Capture. This
  // also gives the development instance its own single-instance lock without
  // touching the user's production session or ledger.
  app.setPath('userData', path.resolve(developmentUserDataDir));
}
const TOP_BAR_HEIGHT = 58;
const CAPTURE_DOCK_HEIGHT = 94;
const controlPanelModeSchema = z.enum([
  'default',
  'annotation',
  'annotation-composer',
  'evidence',
  'voice',
  'finalizing',
]);
type ControlPanelMode = z.infer<typeof controlPanelModeSchema>;
const CONTROL_PANEL_HEIGHT: Record<ControlPanelMode, number> = {
  default: CAPTURE_DOCK_HEIGHT,
  annotation: 196,
  'annotation-composer': 286,
  evidence: 270,
  voice: 354,
  finalizing: 174,
};

let mainWindow: BrowserWindow | undefined;
let webCapture: WebCaptureController | undefined;
let pendingLaunch: DesktopCaptureLaunch | undefined;
let pendingWorkspaceLink: DesktopWorkspaceLink | undefined;
let mainWindowCreation: Promise<void> | undefined;
let launchAcceptanceFlight: Promise<unknown> | undefined;
const loopParticipantAuth = new LoopParticipantAuthSession();
const workspaceIdentities = new Map<string, DesktopWorkspaceIdentity>();
let launchAcceptanceKey: string | undefined;
let activeCaptureAttempt:
  | {
      client: VoidrServiceClient;
      launch: DesktopCaptureLaunch;
      remoteAccessToken?: string;
      lastReported?: string;
      tail: Promise<void>;
    }
  | undefined;
let controlPanelMode: ControlPanelMode = 'default';
let appIsQuitting = false;
let selectionEscapeGuards = 0;
let selectionEscapeRegistered = false;

protocol.registerSchemesAsPrivileged([
  {
    scheme: CONTROL_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);
app.enableSandbox();
if (app.isPackaged) {
  app.commandLine.removeSwitch('remote-debugging-port');
  app.commandLine.removeSwitch('remote-debugging-pipe');
}

const openCycleSchema = loopCodeHandoffInputSchema;

function durableEncryptionAvailable(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false;
  return process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text';
}

const verificationIdInputSchema = z.object({
  runtime: localRuntimeConfigSchema,
  verificationId: z.string().uuid(),
});
const voiceInputSchema = z.object({
  segmentId: z.string().uuid(),
  startedAtMs: z.number().int().nonnegative(),
  endedAtMs: z.number().int().positive(),
  pcmBase64: z.string().min(428).max(5_200_000),
  language: z.string().min(2).max(16).optional(),
  expectsVisual: z.boolean(),
  visualSelectionId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
}).superRefine((input, context) => {
  if (input.expectsVisual !== (input.visualSelectionId !== undefined)) {
    context.addIssue({
      code: 'custom',
      path: ['visualSelectionId'],
      message: 'A seleção visual da voz está inconsistente.',
    });
  }
});
const voiceSelectionIdSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const acceptLaunchSchema = z.object({
  launch: desktopCaptureLaunchSchema,
  runtime: localRuntimeConfigSchema,
});
const workspaceLoopInputSchema = z.object({
  runtime: localRuntimeConfigSchema,
  loopId: z.string().trim().min(1).max(200),
});
const workspaceCycleInputSchema = workspaceLoopInputSchema.extend({
  cycleId: z.string().uuid(),
});
const automationTargetInputSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.enum(['keyDown', 'keyUp']),
    keyCode: z.string().min(1).max(40),
  }),
  z.object({
    type: z.enum(['mouseMove', 'mouseDown', 'mouseUp']),
    x: z.number().finite(),
    y: z.number().finite(),
    button: z.enum(['left', 'middle', 'right']).optional(),
    clickCount: z.number().int().min(0).max(3).optional(),
  }),
]);
const automationRegionSchema = z.object({
  x: z.number().finite().nonnegative(),
  y: z.number().finite().nonnegative(),
  width: z.number().finite().positive(),
  height: z.number().finite().positive(),
});
const automationVoiceDraftSchema = z.object({
  pcmBase64: z.string().min(19_200).max(160_000),
});

function protocolUrlFromArgv(argv: readonly string[]): string | undefined {
  return argv.find((value) => value.startsWith('voidr://'));
}

function publishPendingLaunch(): void {
  if (pendingLaunch && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('capture:launch-received', pendingLaunch);
  }
}

function publishPendingWorkspaceLink(): void {
  if (pendingWorkspaceLink && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('workspace:link-received', pendingWorkspaceLink);
  }
}

function canonicalAttemptState(status: CaptureStatus) {
  if (status.stage === 'preparing' || status.stage === 'ready') return 'preparing' as const;
  if (status.stage === 'recording') return 'recording' as const;
  if (['stopping', 'sealed', 'attaching'].includes(status.stage)) return 'finalizing' as const;
  if (status.stage === 'processing') return 'processing' as const;
  if (status.stage === 'ready_for_review') return 'ready_for_review' as const;
  if (status.stage === 'recoverable_error') return 'recoverable_error' as const;
  if (status.stage === 'terminal_error') return 'terminal_error' as const;
  return undefined;
}

function reportCaptureAttempt(status: CaptureStatus): void {
  const reporter = activeCaptureAttempt;
  const state = canonicalAttemptState(status);
  if (!reporter || !state) return;
  reporter.tail = reporter.tail
    .then(async () => {
      const key = `${state}:${status.errorCode ?? ''}`;
      if (reporter.lastReported === key) return;
      await reporter.client.reportDesktopLaunchState(
        reporter.launch,
        state,
        reporter.remoteAccessToken,
        status.errorCode,
      );
      reporter.lastReported = key;
    })
    // Attempt telemetry must never interrupt a recording. A later status
    // transition retries through the same serialized channel.
    .catch(() => undefined);
}

function revealMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  // macOS needs a visible key-window candidate before application activation;
  // focusing the app while the only window is hidden can leave the capture on
  // another Space even though the process opened successfully.
  if (process.platform === 'darwin') app.focus({ steal: true });
  mainWindow.focus();
  mainWindow.moveTop();
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

async function withNativeSelectionEscape<T>(select: () => Promise<T>): Promise<T> {
  selectionEscapeGuards += 1;
  if (selectionEscapeGuards === 1) {
    selectionEscapeRegistered = globalShortcut.register('Escape', () => {
      void webCapture?.cancelSelection();
    });
  }
  try {
    return await select();
  } finally {
    selectionEscapeGuards = Math.max(0, selectionEscapeGuards - 1);
    if (selectionEscapeGuards === 0 && selectionEscapeRegistered) {
      globalShortcut.unregister('Escape');
      selectionEscapeRegistered = false;
    }
  }
}

function shouldKeepCaptureAliveOnClose(): boolean {
  return Boolean(
    webCapture &&
    ['recording', 'stopping', 'sealed', 'attaching', 'processing', 'recoverable_error'].includes(
      webCapture.status.stage,
    ),
  );
}

async function ensureMainWindow(): Promise<void> {
  if (mainWindow && !mainWindow.isDestroyed()) {
    revealMainWindow();
    return;
  }
  if (!app.isReady()) return;
  if (!mainWindowCreation) {
    mainWindowCreation = createWindow().finally(() => {
      mainWindowCreation = undefined;
    });
  }
  await mainWindowCreation;
  publishPendingLaunch();
  publishPendingWorkspaceLink();
  revealMainWindow();
}

function scheduleMainWindow(): void {
  void ensureMainWindow().catch(() => {
    // Keep the descriptor pending so a later activate/open-url can retry safely.
  });
}

function receiveProtocolUrl(value: string): void {
  try {
    const link = parseDesktopProtocolLink(value);
    if (link.kind === 'capture') {
      pendingLaunch = link.value;
      publishPendingLaunch();
    } else {
      pendingWorkspaceLink = link.value;
      publishPendingWorkspaceLink();
    }
    scheduleMainWindow();
  } catch {
    // Untrusted protocol input fails closed and never reaches a renderer.
  }
}

function workspaceIdentityKey(runtime: { serviceUrl: string; organizationId: string }): string {
  return `${runtime.serviceUrl}|${runtime.organizationId}`;
}

function targetBounds(): Electron.Rectangle {
  const size = mainWindow?.getContentSize() ?? [1_280, 820];
  const width = size[0] ?? 1_280;
  const height = size[1] ?? 820;
  return {
    x: 0,
    y: TOP_BAR_HEIGHT,
    width,
    height: Math.max(120, height - TOP_BAR_HEIGHT - CONTROL_PANEL_HEIGHT[controlPanelMode]),
  };
}

function assertControlSender(event: Electron.IpcMainInvokeEvent): void {
  const frame = event.senderFrame;
  if (
    !mainWindow ||
    event.sender !== mainWindow.webContents ||
    frame !== mainWindow.webContents.mainFrame ||
    !isControlRendererUrl(frame.url, process.env.VOIDR_CAPTURE_DEV_SERVER_URL)
  ) {
    throw new Error('IPC sender is not the Voidr control renderer.');
  }
}

function registerIpc(): void {
  ipcMain.handle('capture:status', (event) => {
    assertControlSender(event);
    return webCapture?.status;
  });
  ipcMain.handle('capture:annotation-status', (event) => {
    assertControlSender(event);
    return webCapture?.annotationPendingCount() ?? 0;
  });
  ipcMain.handle('capture:pending-launch', (event) => {
    assertControlSender(event);
    return pendingLaunch ?? null;
  });
  ipcMain.handle('capture:accept-launch', async (event, input) => {
    assertControlSender(event);
    const parsed = acceptLaunchSchema.parse(input);
    const key = `${parsed.launch.loopId}:${parsed.launch.cycleId}`;
    if (launchAcceptanceFlight) {
      if (launchAcceptanceKey === key) return launchAcceptanceFlight;
      throw new Error('Outro teste já está sendo preparado. Aguarde a abertura terminar.');
    }
    const current = webCapture?.status;
    if (
      current &&
      ['recording', 'stopping', 'sealed', 'attaching', 'processing', 'recoverable_error'].includes(
        current.stage,
      )
    ) {
      const sameCycle = current.context?.scenarioId === parsed.launch.loopId &&
        current.context?.cycleId === parsed.launch.cycleId;
      throw new Error(
        sameCycle
          ? 'Este teste já está em andamento. Continue a captura atual.'
          : 'Conclua o teste atual antes de abrir outro convite.',
      );
    }
    launchAcceptanceKey = key;
    const flight = (async () => {
      const client = new VoidrServiceClient(parsed.runtime);
      const remoteToken = parsed.runtime.localAdapter
        ? undefined
        : await loopParticipantAuth.accessToken(
            parsed.launch.access,
            parsed.launch.access === 'organization'
              ? parsed.launch.organizationId
              : undefined,
          );
      await client.claimDesktopLaunch(
        parsed.launch,
        {
          appVersion: app.getVersion(),
          appPlatform: process.platform as 'darwin' | 'win32' | 'linux',
          appArch: process.arch,
        },
        remoteToken,
      );
      activeCaptureAttempt = {
        client,
        launch: parsed.launch,
        ...(remoteToken ? { remoteAccessToken: remoteToken } : {}),
        tail: Promise.resolve(),
      };
      const handoff = await client.resolveDesktopLaunch(
        parsed.launch,
        remoteToken,
      );
      const { recordingUrl, recordingExpiresAt: _recordingExpiresAt, ...resolution } = handoff;
      let status = webCapture?.status;
      if (handoff.surface === 'web') {
        status = await webCapture!.prepare({
          recordingUrl,
          runtime: parsed.runtime,
        });
        if (status.stage === 'ready') status = await webCapture!.start();
      }
      if (
        pendingLaunch?.loopId === parsed.launch.loopId &&
        pendingLaunch.cycleId === parsed.launch.cycleId
      ) {
        pendingLaunch = undefined;
      }
      return { resolution, status };
    })();
    launchAcceptanceFlight = flight;
    try {
      return await flight;
    } finally {
      if (launchAcceptanceFlight === flight) {
        launchAcceptanceFlight = undefined;
        launchAcceptanceKey = undefined;
      }
    }
  });
  ipcMain.handle('capture:prepare-web', async (event, input) => {
    assertControlSender(event);
    return webCapture!.prepare(prepareWebInputSchema.parse(input));
  });
  ipcMain.handle('capture:start-web', async (event) => {
    assertControlSender(event);
    return webCapture!.start();
  });
  ipcMain.handle('capture:stop-web', async (event) => {
    assertControlSender(event);
    return webCapture!.stop();
  });
  ipcMain.handle('capture:reset', async (event) => {
    assertControlSender(event);
    await webCapture!.disposeTarget();
    return webCapture!.status;
  });
  ipcMain.handle('capture:annotate', async (event, input) => {
    assertControlSender(event);
    return webCapture!.annotate(annotationInputSchema.parse(input));
  });
  ipcMain.handle('capture:select-element', async (event) => {
    assertControlSender(event);
    return withNativeSelectionEscape(() => webCapture!.selectElement());
  });
  ipcMain.handle('capture:select-region', async (event) => {
    assertControlSender(event);
    return withNativeSelectionEscape(() => webCapture!.selectRegion());
  });
  ipcMain.handle('capture:select-voice-region', async (event, input) => {
    assertControlSender(event);
    const selectionId = voiceSelectionIdSchema.parse(input);
    return withNativeSelectionEscape(() => webCapture!.selectVoiceRegion(selectionId));
  });
  ipcMain.handle('capture:clear-voice-region', async (event) => {
    assertControlSender(event);
    await webCapture!.clearVoiceRegion();
  });
  ipcMain.handle('capture:clear-selection', async (event) => {
    assertControlSender(event);
    await webCapture!.clearSelection();
  });
  ipcMain.handle('capture:cancel-selection', async (event) => {
    assertControlSender(event);
    await webCapture!.cancelSelection();
  });
  ipcMain.handle('capture:voice-segment', async (event, input) => {
    assertControlSender(event);
    return webCapture!.voiceSegment(voiceInputSchema.parse(input));
  });
  ipcMain.handle('capture:set-control-panel', (event, input) => {
    assertControlSender(event);
    controlPanelMode = controlPanelModeSchema.parse(input);
    return webCapture?.resize();
  });
  if (isAutomation) {
    ipcMain.handle('capture:automation-target-input', (event, input) => {
      assertControlSender(event);
      webCapture!.sendInputForAutomation(
        automationTargetInputSchema.parse(input) as Electron.MouseInputEvent | Electron.KeyboardInputEvent,
      );
    });
    ipcMain.handle('capture:automation-select-region', async (event, input) => {
      assertControlSender(event);
      await webCapture!.completeRegionSelectionForAutomation(automationRegionSchema.parse(input));
    });
    ipcMain.handle('capture:automation-voice-draft', (event, input) => {
      assertControlSender(event);
      const draft = automationVoiceDraftSchema.parse(input);
      mainWindow!.webContents.send('capture:automation-voice-draft-received', draft);
    });
  }
  ipcMain.handle('capture:doctor', async (event, runtime) => {
    assertControlSender(event);
    const parsed = localRuntimeConfigSchema.parse(runtime);
    const client = new VoidrServiceClient(parsed);
    const [services, android] = await Promise.all([client.doctor(), doctorAndroid()]);
    return { services, android };
  });
  ipcMain.handle('workspace:list-loops', async (event, runtime) => {
    assertControlSender(event);
    const workspace = await createWorkspaceSession(runtime, loopParticipantAuth);
    return workspace.client.listLoops(workspace.accessToken);
  });
  ipcMain.handle('workspace:pending-link', (event) => {
    assertControlSender(event);
    const link = pendingWorkspaceLink ?? null;
    pendingWorkspaceLink = undefined;
    return link;
  });
  ipcMain.handle('workspace:session', async (event, runtimeInput) => {
    assertControlSender(event);
    const runtime = localRuntimeConfigSchema.parse(runtimeInput);
    workspacePlatformLoopsUrl(runtime);
    const key = workspaceIdentityKey(runtime);
    const cachedIdentity = workspaceIdentities.get(key);
    if (cachedIdentity) return cachedIdentity;
    if (runtime.organizationId === PENDING_CAPTURE_ORGANIZATION_ID) return null;
    if (runtime.localAdapter) {
      const identity = await connectWorkspaceSession(runtime, loopParticipantAuth);
      workspaceIdentities.set(key, identity);
      return identity;
    }
    const accessToken = loopParticipantAuth.cachedAccessToken(
      'organization',
      runtime.organizationId,
    );
    if (!accessToken) return null;
    const identity = await new VoidrServiceClient(runtime).workspaceIdentity(accessToken);
    if (identity.organizationId !== runtime.organizationId) return null;
    workspaceIdentities.set(key, identity);
    return identity;
  });
  ipcMain.handle('workspace:connect', async (event, runtimeInput) => {
    assertControlSender(event);
    const runtime = localRuntimeConfigSchema.parse(runtimeInput);
    const identity = await connectWorkspaceSession(runtime, loopParticipantAuth);
    workspaceIdentities.set(workspaceIdentityKey(runtime), identity);
    return identity;
  });
  ipcMain.handle('workspace:disconnect', (event, runtimeInput) => {
    assertControlSender(event);
    const runtime = localRuntimeConfigSchema.parse(runtimeInput);
    workspacePlatformLoopsUrl(runtime);
    workspaceIdentities.delete(workspaceIdentityKey(runtime));
    if (!runtime.localAdapter) {
      loopParticipantAuth.clear('organization', runtime.organizationId);
    }
  });
  ipcMain.handle('workspace:list-cycles', async (event, input) => {
    assertControlSender(event);
    const parsed = workspaceLoopInputSchema.parse(input);
    const workspace = await createWorkspaceSession(parsed.runtime, loopParticipantAuth);
    return workspace.client.listLoopCycles(parsed.loopId, workspace.accessToken);
  });
  ipcMain.handle('workspace:get-cycle', async (event, input) => {
    assertControlSender(event);
    const parsed = workspaceCycleInputSchema.parse(input);
    const workspace = await createWorkspaceSession(parsed.runtime, loopParticipantAuth);
    return workspace.client.getLoopCycle(
      parsed.loopId,
      parsed.cycleId,
      workspace.accessToken,
    );
  });
  ipcMain.handle('workspace:start-cycle', async (event, input) => {
    assertControlSender(event);
    const parsed = workspaceLoopInputSchema.parse(input);
    const workspace = await createWorkspaceSession(parsed.runtime, loopParticipantAuth);
    return workspace.client.prepareLoopCycle(parsed.loopId, workspace.accessToken);
  });
  ipcMain.handle('workspace:open-platform', async (event, runtime) => {
    assertControlSender(event);
    await shell.openExternal(workspacePlatformLoopsUrl(runtime));
  });
  ipcMain.handle('mobile:devices', async (event) => {
    assertControlSender(event);
    return doctorAndroid();
  });
  ipcMain.handle('mobile:launch', async (event, input) => {
    assertControlSender(event);
    return launchAndroid(androidLaunchInputSchema.parse(input));
  });
  ipcMain.handle('mobile:discover-sessions', async (event, serial) => {
    assertControlSender(event);
    return discoverAndroidSessions(z.string().min(1).max(200).parse(serial));
  });
  ipcMain.handle('mobile:verification-status', async (event, input) => {
    assertControlSender(event);
    const parsed = verificationIdInputSchema.parse(input);
    return new VoidrServiceClient(parsed.runtime).getVerificationStatus(parsed.verificationId);
  });
  ipcMain.handle('mobile:list-verifications', async (event, runtime) => {
    assertControlSender(event);
    return new VoidrServiceClient(localRuntimeConfigSchema.parse(runtime)).listLocalVerifications();
  });
  ipcMain.handle('mobile:attach-session', async (event, input) => {
    assertControlSender(event);
    const parsed = mobileAttachInputSchema.parse(input);
    return new VoidrServiceClient(parsed.runtime).attachMobileSession(parsed);
  });
  ipcMain.handle('capture:open-cycle', async (event, input) => {
    assertControlSender(event);
    const parsed = openCycleSchema.parse(input);
    await shell.openExternal(buildLoopCodeHandoffUrl(parsed));
  });
}

function hardenSession(targetSession: Electron.Session): void {
  targetSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const isControlRenderer = Boolean(mainWindow && webContents === mainWindow.webContents);
    const isControlOrigin = isControlRendererUrl(
      'requestingUrl' in details && typeof details.requestingUrl === 'string'
        ? details.requestingUrl
        : webContents.getURL(),
      process.env.VOIDR_CAPTURE_DEV_SERVER_URL,
    );
    const mediaTypes =
      permission === 'media' && 'mediaTypes' in details
        ? (details.mediaTypes as Array<'audio' | 'video'> | undefined)
        : undefined;
    const isAudioOnly =
      permission === 'media' && (!mediaTypes || (mediaTypes.includes('audio') && !mediaTypes.includes('video')));
    callback(isControlRenderer && isControlOrigin && isAudioOnly);
  });
  targetSession.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
    return Boolean(
      mainWindow &&
      webContents === mainWindow.webContents &&
      permission === 'media' &&
      isControlRendererUrl(requestingOrigin, process.env.VOIDR_CAPTURE_DEV_SERVER_URL),
    );
  });
}

function registerControlProtocol(): void {
  const rendererRoot = path.resolve(directory, '../renderer');
  protocol.handle(CONTROL_SCHEME, (request) => {
    const asset = resolveControlAsset(rendererRoot, request.url);
    if (!asset) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(asset).toString());
  });
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1_340,
    height: 860,
    minWidth: 980,
    minHeight: 680,
    show: false,
    title: 'Voidr Capture',
    backgroundColor: '#050607',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(directory, 'control.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      webviewTag: false,
      spellcheck: false,
      devTools: isDevelopment || isAutomation,
    },
  });
  const ledger = new CaptureLedger(app.getPath('userData'));
  const annotationOutbox = new AnnotationOutbox(app.getPath('userData'), {
    encrypt(value) {
      if (!durableEncryptionAvailable()) {
        throw new Error('O armazenamento seguro do sistema ainda não está disponível. Tente salvar novamente.');
      }
      return safeStorage.encryptString(value);
    },
    decrypt(value) {
      if (!durableEncryptionAvailable()) {
        throw new Error('O armazenamento seguro do sistema ainda não está disponível.');
      }
      return safeStorage.decryptString(value);
    },
  });
  webCapture = new WebCaptureController(
    mainWindow,
    ledger,
    annotationOutbox,
    (status) => {
      reportCaptureAttempt(status);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('capture:status-changed', status);
      }
    },
    targetBounds,
    () => {
      if (controlPanelMode === 'annotation' && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('capture:target-pointer-down');
      }
    },
    (selection) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('capture:selection-invalidated', selection);
      }
    },
    (selection) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('capture:selection-cancelled', selection);
      }
    },
  );
  mainWindow.on('resize', () => webCapture?.resize());
  mainWindow.on('close', (event) => {
    if (appIsQuitting || !shouldKeepCaptureAliveOnClose()) return;
    event.preventDefault();
    mainWindow?.hide();
  });
  mainWindow.on('closed', () => {
    void webCapture?.disposeTarget();
    mainWindow = undefined;
    webCapture = undefined;
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowed = isControlRendererUrl(url, process.env.VOIDR_CAPTURE_DEV_SERVER_URL);
    if (!allowed) event.preventDefault();
  });
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (webCapture?.selectionActive && isKeyDownInput(input) && isEscapeInput(input)) {
      event.preventDefault();
      void webCapture.cancelSelection();
    }
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.webContents.on('did-finish-load', () => {
    publishPendingLaunch();
    publishPendingWorkspaceLink();
  });
  if (isDevelopment) {
    await mainWindow.loadURL(process.env.VOIDR_CAPTURE_DEV_SERVER_URL!);
  } else {
    await mainWindow.loadURL(`${CONTROL_ORIGIN}/index.html`);
  }
  void webCapture?.recoverPendingAnnotations();
}

function registerProtocol(): void {
  // On macOS Electron's development binary has the generic
  // `com.github.electron` bundle identifier. Registering it as the handler
  // makes LaunchServices open Electron's welcome page instead of this app.
  // The local MCP bridge can launch the source checkout explicitly during
  // development; only the packaged Voidr bundle may own `voidr://` on macOS.
  if (!app.isPackaged) {
    if (process.platform !== 'darwin' && process.argv[1]) {
      app.setAsDefaultProtocolClient('voidr', process.execPath, [path.resolve(process.argv[1])]);
    }
    return;
  }
  app.setAsDefaultProtocolClient('voidr');
}

const lock = app.requestSingleInstanceLock();
if (!lock) {
  app.quit();
} else {
  const initialProtocolUrl = protocolUrlFromArgv(process.argv);
  if (initialProtocolUrl) receiveProtocolUrl(initialProtocolUrl);
  app.on('open-url', (event, url) => {
    event.preventDefault();
    receiveProtocolUrl(url);
  });
  app.on('second-instance', (_event, argv) => {
    const url = protocolUrlFromArgv(argv);
    if (url) receiveProtocolUrl(url);
    else scheduleMainWindow();
  });
  app.on('session-created', hardenSession);
  app.whenReady().then(async () => {
    registerProtocol();
    registerControlProtocol();
    hardenSession(session.defaultSession);
    registerIpc();
    await ensureMainWindow();
    app.on('activate', () => {
      scheduleMainWindow();
    });
  });
  app.on('before-quit', () => {
    appIsQuitting = true;
    if (selectionEscapeRegistered) {
      globalShortcut.unregister('Escape');
      selectionEscapeRegistered = false;
    }
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
