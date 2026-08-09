import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, ipcMain, net, protocol, session, shell } from 'electron';
import { z } from 'zod';
import {
  androidLaunchInputSchema,
  isTrustedWebUrl,
  localRuntimeConfigSchema,
  mobileAttachInputSchema,
  prepareWebInputSchema,
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

const directory = __dirname;
const isDevelopment = Boolean(process.env.VOIDR_CAPTURE_DEV_SERVER_URL);
const isAutomation = !app.isPackaged && process.env.VOIDR_CAPTURE_E2E === '1';
const TOP_BAR_HEIGHT = 58;
const CAPTURE_DOCK_HEIGHT = 94;

let mainWindow: BrowserWindow | undefined;
let webCapture: WebCaptureController | undefined;

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

function targetBounds(): Electron.Rectangle {
  const size = mainWindow?.getContentSize() ?? [1_280, 820];
  const width = size[0] ?? 1_280;
  const height = size[1] ?? 820;
  return {
    x: 0,
    y: TOP_BAR_HEIGHT,
    width,
    height: Math.max(120, height - TOP_BAR_HEIGHT - CAPTURE_DOCK_HEIGHT),
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
  ipcMain.handle('capture:voice-segment', async (event, input) => {
    assertControlSender(event);
    return webCapture!.voiceSegment(voiceInputSchema.parse(input));
  });
  ipcMain.handle('capture:doctor', async (event, runtime) => {
    assertControlSender(event);
    const parsed = localRuntimeConfigSchema.parse(runtime);
    const client = new VoidrServiceClient(parsed);
    const [services, android] = await Promise.all([client.doctor(), doctorAndroid()]);
    return { services, android };
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
  if (isDevelopment) {
    await mainWindow.loadURL(process.env.VOIDR_CAPTURE_DEV_SERVER_URL!);
  } else {
    await mainWindow.loadURL(`${CONTROL_ORIGIN}/index.html`);
  }
}

function registerProtocol(): void {
  if (process.defaultApp && process.argv[1]) {
    app.setAsDefaultProtocolClient('voidr', process.execPath, [path.resolve(process.argv[1])]);
  } else {
    app.setAsDefaultProtocolClient('voidr');
  }
}

const lock = app.requestSingleInstanceLock();
if (!lock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.on('session-created', hardenSession);
  app.whenReady().then(async () => {
    registerProtocol();
    registerControlProtocol();
    hardenSession(session.defaultSession);
    registerIpc();
    await createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) void createWindow();
    });
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
