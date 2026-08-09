import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const mainSource = readFileSync(fileURLToPath(new URL('./index.ts', import.meta.url)), 'utf8');
const captureSource = readFileSync(
  fileURLToPath(new URL('./web-capture-controller.ts', import.meta.url)),
  'utf8',
);
const preloadSource = readFileSync(
  fileURLToPath(new URL('../preload/control.ts', import.meta.url)),
  'utf8',
);
const htmlSource = readFileSync(
  fileURLToPath(new URL('../renderer/index.html', import.meta.url)),
  'utf8',
);
const forgeSource = readFileSync(
  fileURLToPath(new URL('../../forge.config.cjs', import.meta.url)),
  'utf8',
);

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
});
