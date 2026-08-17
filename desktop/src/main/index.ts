import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, ipcMain, net, protocol, session, shell } from 'electron';
import { z } from 'zod';
import {
  androidLaunchInputSchema,
  desktopCaptureLaunchSchema,
  isTrustedWebUrl,
  localRuntimeConfigSchema,
  mobileAttachInputSchema,
  prepareWebInputSchema,
  type DesktopCaptureLaunch,
} from '@voidr/capture-contracts';
import { annotationInputSchema } from '@voidr/capture-contracts';
import {
  discoverAndroidSessions,
  doctorAndroid,
  launchAndroid,
} from './android-adapter';
import { CaptureLedger } from './ledger';
import { CONTROL_ORIGIN, CONTROL_SCHEME, isControlRendererUrl, resolveControlAsset } from './app-protocol';
import { VoidrServiceClient } from './service-client';
import { WebCaptureController } from './web-capture-controller';
import { parseDesktopCaptureLaunch } from './deep-link';

const directory = __dirname;
const isDevelopment = Boolean(process.env.VOIDR_CAPTURE_DEV_SERVER_URL);
const isAutomation = !app.isPackaged && process.env.VOIDR_CAPTURE_E2E === '1';
const TOP_BAR_HEIGHT = 58;
const CAPTURE_DOCK_HEIGHT = 94;
const controlPanelModeSchema = z.enum([
  'default',
  'annotation',
  'annotation-composer',
  'evidence',
  'finalizing',
]);
type ControlPanelMode = z.infer<typeof controlPanelModeSchema>;
const CONTROL_PANEL_HEIGHT: Record<ControlPanelMode, number> = {
  default: CAPTURE_DOCK_HEIGHT,
  annotation: 196,
  'annotation-composer': 286,
  evidence: 270,
  finalizing: 174,
};

let mainWindow: BrowserWindow | undefined;
let webCapture: WebCaptureController | undefined;
let pendingLaunch: DesktopCaptureLaunch | undefined;
let mainWindowCreation: Promise<void> | undefined;
let controlPanelMode: ControlPanelMode = 'default';

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

const openCycleSchema = z.object({
  platformUrl: z.string().url(),
  loopId: z.string().trim().min(1).max(200),
  cycleId: z.string().uuid(),
});
const verificationIdInputSchema = z.object({
  runtime: localRuntimeConfigSchema,
  verificationId: z.string().uuid(),
});
const voiceInputSchema = z.object({
  startedAtMs: z.number().int().nonnegative(),
  endedAtMs: z.number().int().positive(),
  pcmBase64: z.string().min(428).max(5_200_000),
  language: z.string().min(2).max(16).optional(),
});
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

function protocolUrlFromArgv(argv: readonly string[]): string | undefined {
  return argv.find((value) => value.startsWith('voidr://'));
}

function publishPendingLaunch(): void {
  if (pendingLaunch && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('capture:launch-received', pendingLaunch);
  }
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
  revealMainWindow();
}

function scheduleMainWindow(): void {
  void ensureMainWindow().catch(() => {
    // Keep the descriptor pending so a later activate/open-url can retry safely.
  });
}

function receiveProtocolUrl(value: string): void {
  try {
    pendingLaunch = parseDesktopCaptureLaunch(value);
    publishPendingLaunch();
    scheduleMainWindow();
  } catch {
    // Untrusted protocol input fails closed and never reaches a renderer.
  }
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
  ipcMain.handle('capture:pending-launch', (event) => {
    assertControlSender(event);
    return pendingLaunch ?? null;
  });
  ipcMain.handle('capture:accept-launch', async (event, input) => {
    assertControlSender(event);
    const parsed = acceptLaunchSchema.parse(input);
    const client = new VoidrServiceClient(parsed.runtime);
    const handoff = await client.resolveDesktopLaunch(parsed.launch);
    const { recordingUrl, recordingExpiresAt: _recordingExpiresAt, ...resolution } = handoff;
    let status = webCapture?.status;
    if (handoff.surface === 'web') {
      status = await webCapture!.prepare({ recordingUrl, runtime: parsed.runtime });
      if (status.stage === 'ready') status = await webCapture!.start();
    }
    if (
      pendingLaunch?.loopId === parsed.launch.loopId &&
      pendingLaunch.cycleId === parsed.launch.cycleId
    ) {
      pendingLaunch = undefined;
    }
    return { resolution, status };
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
    return webCapture!.selectElement();
  });
  ipcMain.handle('capture:clear-element-selection', async (event) => {
    assertControlSender(event);
    await webCapture!.clearElementSelection();
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
  ipcMain.handle('capture:doctor', async (event, runtime) => {
    assertControlSender(event);
    const parsed = localRuntimeConfigSchema.parse(runtime);
    const client = new VoidrServiceClient(parsed);
    const [services, android] = await Promise.all([client.doctor(), doctorAndroid()]);
    return { services, android };
  });
  ipcMain.handle('workspace:list-loops', async (event, runtime) => {
    assertControlSender(event);
    return new VoidrServiceClient(localRuntimeConfigSchema.parse(runtime)).listLoops();
  });
  ipcMain.handle('workspace:list-cycles', async (event, input) => {
    assertControlSender(event);
    const parsed = workspaceLoopInputSchema.parse(input);
    return new VoidrServiceClient(parsed.runtime).listLoopCycles(parsed.loopId);
  });
  ipcMain.handle('workspace:get-cycle', async (event, input) => {
    assertControlSender(event);
    const parsed = workspaceCycleInputSchema.parse(input);
    return new VoidrServiceClient(parsed.runtime).getLoopCycle(parsed.loopId, parsed.cycleId);
  });
  ipcMain.handle('workspace:start-cycle', async (event, input) => {
    assertControlSender(event);
    const parsed = workspaceLoopInputSchema.parse(input);
    return new VoidrServiceClient(parsed.runtime).prepareLoopCycle(parsed.loopId);
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
    const base = new URL(parsed.platformUrl);
    if (!isTrustedWebUrl(base.toString()) || base.username || base.password) {
      throw new Error('Platform URL inválida.');
    }
    const destination = new URL(
      `/loops/${encodeURIComponent(parsed.loopId)}/cycles/${encodeURIComponent(parsed.cycleId)}`,
      base,
    );
    await shell.openExternal(destination.toString());
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
      permission === 'media' &&
      (!mediaTypes || (mediaTypes.includes('audio') && !mediaTypes.includes('video')));
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
  webCapture = new WebCaptureController(
    mainWindow,
    ledger,
    (status) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('capture:status-changed', status);
      }
    },
    targetBounds,
  );
  mainWindow.on('resize', () => webCapture?.resize());
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
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.webContents.on('did-finish-load', publishPendingLaunch);
  if (isDevelopment) {
    await mainWindow.loadURL(process.env.VOIDR_CAPTURE_DEV_SERVER_URL!);
  } else {
    await mainWindow.loadURL(`${CONTROL_ORIGIN}/index.html`);
  }
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
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
