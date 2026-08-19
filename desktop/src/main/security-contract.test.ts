import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const mainSource = readFileSync(fileURLToPath(new URL('./index.ts', import.meta.url)), 'utf8');
const captureSource = readFileSync(fileURLToPath(new URL('./web-capture-controller.ts', import.meta.url)), 'utf8');
const preloadSource = readFileSync(fileURLToPath(new URL('../preload/control.ts', import.meta.url)), 'utf8');
const htmlSource = readFileSync(fileURLToPath(new URL('../renderer/index.html', import.meta.url)), 'utf8');
const forgeSource = readFileSync(fileURLToPath(new URL('../../forge.config.cjs', import.meta.url)), 'utf8');

describe('Electron security contract', () => {
  it('serves the control renderer from a constrained secure protocol', () => {
    expect(mainSource).toContain('protocol.registerSchemesAsPrivileged');
    expect(mainSource).toContain('registerControlProtocol()');
    expect(mainSource).toContain('app.enableSandbox()');
    expect(mainSource).toContain("removeSwitch('remote-debugging-port')");
    expect(mainSource).not.toContain('mainWindow.loadFile(');
  });

  it('keeps the production CSP self-contained and script-strict', () => {
    expect(htmlSource).toContain("default-src 'none'");
    expect(htmlSource).toContain("script-src 'self'");
    expect(htmlSource).toContain("object-src 'none'");
    expect(htmlSource).not.toContain('googleapis.com');
    expect(htmlSource).not.toContain("script-src 'unsafe-inline'");
  });

  it('denies privileged escape hatches and validates status IPC at runtime', () => {
    expect(mainSource).toContain('frame !== mainWindow.webContents.mainFrame');
    expect(mainSource).toContain("setWindowOpenHandler(() => ({ action: 'deny' }))");
    expect(preloadSource).toContain('captureStatusSchema.parse');
    expect(preloadSource).not.toContain('ipcRenderer.send(');
  });

  it('recreates and foregrounds the control window when a protocol launch arrives', () => {
    expect(mainSource).toContain('let mainWindowCreation: Promise<void> | undefined');
    expect(mainSource).toContain('mainWindowCreation = createWindow().finally');
    expect(mainSource).toContain('app.focus({ steal: true })');
    expect(mainSource).toContain('mainWindow.moveTop()');
    expect(mainSource).toMatch(/function receiveProtocolUrl[\s\S]*?scheduleMainWindow\(\)/);
    expect(mainSource).toContain("app.on('open-url'");
  });

  it('serializes launch acceptance and lets the main process protect active drafts', () => {
    expect(mainSource).toContain('let launchAcceptanceFlight: Promise<unknown> | undefined');
    expect(mainSource).toContain('if (launchAcceptanceFlight)');
    expect(mainSource).toContain('Conclua o teste atual antes de abrir outro convite.');
  });

  it('never registers the generic Electron bundle as the macOS protocol owner', () => {
    expect(mainSource).toContain('if (!app.isPackaged)');
    expect(mainSource).toContain("process.platform !== 'darwin'");
    expect(mainSource).toMatch(
      /if \(!app\.isPackaged\)[\s\S]*?return;[\s\S]*?app\.setAsDefaultProtocolClient\('voidr'\)/,
    );
  });

  it('isolates remote state by organization and rejects redirectable collector code', () => {
    expect(captureSource).toContain('`${organizationId}\\0${applicationId}`');
    expect(captureSource).toContain("redirect: 'error'");
    expect(captureSource).toContain('Content-Type inesperado');
  });

  it('locks the packaged runtime with every V1 fuse explicitly configured', () => {
    for (const fuse of [
      'RunAsNode',
      'EnableCookieEncryption',
      'EnableNodeOptionsEnvironmentVariable',
      'EnableNodeCliInspectArguments',
      'EnableEmbeddedAsarIntegrityValidation',
      'OnlyLoadAppFromAsar',
      'LoadBrowserProcessSpecificV8Snapshot',
      'GrantFileProtocolExtraPrivileges',
      'WasmTrapHandlers',
    ]) {
      expect(forgeSource).toContain(`FuseV1Options.${fuse}`);
    }
    expect(forgeSource).toContain('strictlyRequireAllFuses: true');
    expect(forgeSource).toContain('[FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false');
    expect(forgeSource).toContain('postPackage: async');
    expect(forgeSource).toContain("'--deep'");
  });

  it('declares a narrow, user-facing microphone purpose on macOS', () => {
    expect(forgeSource).toContain('NSMicrophoneUsageDescription');
    expect(forgeSource).toContain('somente quando você grava uma nota de voz');
  });

  it('resizes the native target instead of relying on renderer z-index', () => {
    expect(mainSource).toContain("'annotation-composer'");
    expect(mainSource).toContain("ipcMain.handle('capture:set-control-panel'");
    expect(mainSource).toContain('CONTROL_PANEL_HEIGHT[controlPanelMode]');
    expect(mainSource).toContain("'voice'");
    expect(mainSource).toContain('webCapture?.resize()');
  });

  it('retries voice segments with a stable id and increments local evidence once', () => {
    expect(mainSource).toContain('segmentId: z.string().uuid()');
    expect(captureSource).toContain('`desktop-voice-${input.segmentId}`');
    expect(captureSource).toContain('#acknowledgedVoiceSegmentIds');
    expect(captureSource).toContain('!this.#acknowledgedVoiceSegmentIds.has(input.segmentId)');
    expect(preloadSource).toContain('segmentId: string');
    expect(preloadSource).toContain('expectsVisual: boolean');
    expect(captureSource).toContain('input.expectsVisual !== Boolean(selectedVisual)');
    expect(captureSource).toContain('error instanceof VoidrApiError');
  });

  it('binds an optional region to voice without leaking image bytes into the segment', () => {
    expect(mainSource).toContain("ipcMain.handle('capture:select-voice-region'");
    expect(mainSource).toContain("ipcMain.handle('capture:clear-voice-region'");
    expect(preloadSource).toContain("ipcRenderer.invoke('capture:select-voice-region', selectionId)");
    expect(captureSource).toContain('async selectVoiceRegion(selectionId: number)');
    expect(captureSource).toContain('#selectedVoiceVisual');
    expect(captureSource).toContain('#voiceVisualSnapshots');
    expect(captureSource).toContain('#voiceVisualUploads');
    expect(captureSource).toContain('visual = await this.#voiceVisualContext(');
    expect(captureSource).toContain('...(visual ? { visual } : {})');
    expect(captureSource).toContain('screenshotRef');
    expect(captureSource).toContain('cropRef');
  });

  it('keeps element and region selection ephemeral until a note is explicitly saved', () => {
    expect(mainSource).toContain("ipcMain.handle('capture:select-element'");
    expect(mainSource).toContain("ipcMain.handle('capture:select-region'");
    expect(mainSource).toContain("ipcMain.handle('capture:clear-selection'");
    expect(captureSource).toContain('this.#selectedElement = await this.#selectElement()');
    expect(captureSource).toContain('this.#selectedRegion = await this.#selectRegion()');
    expect(captureSource).toContain('Selecione um elemento antes de salvar a anotação.');
    expect(captureSource).toContain('Selecione uma região antes de salvar a anotação.');
    expect(captureSource).toContain("if (annotation.kind === 'element') this.#selectedElement = undefined");
    expect(captureSource).toContain("if (annotation.kind === 'region') this.#selectedRegion = undefined");
    expect(captureSource).toContain("kind: 'crop'");
  });

  it('lets Escape cancel target selection from either focused renderer', () => {
    expect(mainSource).toContain('webCapture?.selectionActive');
    expect(mainSource).toContain('isEscapeInput(input)');
    expect(captureSource).toContain('get selectionActive(): boolean');
    expect(captureSource).toContain("input.key === 'Esc'");
    expect(captureSource).toContain('void this.cancelSelection()');
    expect(mainSource).toContain('void webCapture.cancelSelection()');
    expect(mainSource).toContain("globalShortcut.register('Escape'");
    expect(mainSource).toContain("globalShortcut.unregister('Escape'");
    expect(mainSource).toContain('withNativeSelectionEscape');
    expect(mainSource).toContain("ipcMain.handle('capture:cancel-selection'");
    expect(captureSource).toContain('ELEMENT_SELECTION_WORLD');
    expect(captureSource).toContain('Promise.allSettled(cancellations)');
    expect(captureSource).toContain('#cancelSelectionFlight');
    expect(captureSource).toContain('data-voidr-verification-overlay');
    expect(captureSource).toContain("hint.textContent = 'Clique em um elemento · Esc para cancelar'");
    expect(captureSource).toContain("cancel.textContent = 'Cancelar'");
    expect(captureSource).toContain("input.key === '\\u001b'");
    expect(captureSource).not.toContain("mode: 'searchForNode'");
    expect(preloadSource).toContain("ipcRenderer.on('capture:selection-cancelled'");
    expect(preloadSource).toContain("ipcRenderer.invoke('capture:cancel-selection'");
  });

  it('keeps native-input smoke hooks unavailable outside the isolated E2E runtime', () => {
    expect(mainSource).toMatch(/if \(isAutomation\)[\s\S]*?capture:automation-target-input/);
    expect(preloadSource).toContain("process.env.VOIDR_CAPTURE_E2E === '1'");
    expect(preloadSource).toContain('...automationCaptureApi');
    expect(mainSource).toContain('capture:automation-voice-draft');
    expect(preloadSource).toContain('injectVoiceDraftForTest');
  });

  it('invalidates an ephemeral target when the captured page navigates', () => {
    expect(captureSource).toContain("view.webContents.on('did-start-navigation'");
    expect(captureSource).toContain('this.emitSelectionInvalidated(selectionEvent)');
    expect(preloadSource).toContain("ipcRenderer.on('capture:selection-invalidated'");
  });

  it('keeps an active capture alive when the window is closed and reopened', () => {
    expect(mainSource).toContain('shouldKeepCaptureAliveOnClose()');
    expect(mainSource).toContain('event.preventDefault()');
    expect(mainSource).toContain('mainWindow?.hide()');
    expect(mainSource).toContain("app.on('before-quit'");
  });

  it('captures initial, live, redirected and failed network activity without raw secrets', () => {
    expect(captureSource).toContain("performance.getEntriesByType('resource')");
    expect(captureSource).toContain("method === 'Network.requestWillBeSent'");
    expect(captureSource).toContain('parameters.redirectResponse');
    expect(captureSource).toContain("method === 'Network.loadingFinished'");
    expect(captureSource).toContain("method === 'Network.loadingFailed'");
    expect(captureSource).toContain('captureResources: false');
    expect(captureSource).toContain('captureResourcesMaxPerSession: 200');
    expect(captureSource).toContain('VoidrCollector?.captureNetwork?.');
    expect(captureSource).toContain("method === 'Runtime.consoleAPICalled'");
    expect(captureSource).toContain('VoidrCollector?.captureException?.');
    expect(captureSource).toContain('captureException?.(value.message,value.context)');
    expect(captureSource).not.toContain('const captured=new Error(value.message)');
    expect(captureSource).not.toContain("'voidr.desktop.request'");
    expect(captureSource).not.toContain('request.headers');
    expect(captureSource).not.toContain('request.postData');
    expect(captureSource).not.toContain('Network.getResponseBody');
  });

  it('never leaves finalization on an unbounded promise or abandoned processing state', () => {
    expect(captureSource).toContain('COLLECTOR_STOP_TIMEOUT_MS = 25_000');
    expect(captureSource).toContain('COLLECTOR_EVENT_WRITE_TIMEOUT_MS = 3_000');
    expect(captureSource).toContain('CDP_NETWORK_SETTLE_TIMEOUT_MS = 250');
    expect(captureSource).toContain('this.#settlePendingNetworkRequests()');
    expect(captureSource).toContain('drainKnownCdpNetworkResponses(this.#requestMeta)');
    expect(captureSource).toContain('this.#flushCollectorEventWrites()');
    expect(captureSource).toContain('await withTimeout(');
    expect(captureSource).toContain('#observeCycleReadiness');
    expect(captureSource).toContain("'WEB_PROCESSING_TIMEOUT'");
    expect(captureSource).toContain('resumedInBackground: true');
  });

  it('bounds target loading and retries once without deleting the user session', () => {
    expect(captureSource).toContain('TARGET_LOAD_TIMEOUT_MS = 15_000');
    expect(captureSource).toContain('await this.#loadTargetUrl(');
    expect(captureSource).toContain('this.#view.webContents.session.clearCache()');
    expect(captureSource).toContain("type: 'web.load-retry'");
    expect(captureSource).not.toContain("clearStorageData({ storages: ['cookies']");
    expect(captureSource.indexOf('await this.#loadTargetUrl(')).toBeLessThan(
      captureSource.indexOf('this.window.contentView.addChildView(this.#view)'),
    );
  });
});
