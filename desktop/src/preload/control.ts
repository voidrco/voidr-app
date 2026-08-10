import { contextBridge, ipcRenderer } from 'electron';
import { z } from 'zod';
import type {
  AndroidDevice,
  CaptureStatus,
  DesktopCaptureLaunch,
  DesktopCaptureResolution,
  LocalRuntimeConfig,
  MobileAttachInput,
  PrepareWebInput,
} from '@voidr/capture-contracts';
import {
  captureStatusSchema,
  desktopCaptureLaunchSchema,
  desktopCaptureResolutionSchema,
} from '@voidr/capture-contracts';

type Unsubscribe = () => void;

const invokeStatus = (channel: string, input?: unknown): Promise<CaptureStatus> =>
  ipcRenderer.invoke(channel, ...(input === undefined ? [] : [input])).then((value) =>
    captureStatusSchema.parse(value),
  );

const launchAcceptanceSchema = z.object({
  resolution: desktopCaptureResolutionSchema,
  status: captureStatusSchema.optional(),
});

export interface CaptureLaunchAcceptance {
  resolution: DesktopCaptureResolution;
  status?: CaptureStatus;
}

const api = {
  capture: {
    status: (): Promise<CaptureStatus> => invokeStatus('capture:status'),
    pendingLaunch: (): Promise<DesktopCaptureLaunch | null> =>
      ipcRenderer.invoke('capture:pending-launch').then((value) =>
        value == null ? null : desktopCaptureLaunchSchema.parse(value),
      ),
    acceptLaunch: (
      launch: DesktopCaptureLaunch,
      runtime: LocalRuntimeConfig,
    ): Promise<CaptureLaunchAcceptance> =>
      ipcRenderer
        .invoke('capture:accept-launch', { launch, runtime })
        .then((value) => launchAcceptanceSchema.parse(value)),
    prepareWeb: (input: PrepareWebInput): Promise<CaptureStatus> =>
      invokeStatus('capture:prepare-web', input),
    startWeb: (): Promise<CaptureStatus> => invokeStatus('capture:start-web'),
    stopWeb: (): Promise<CaptureStatus> => invokeStatus('capture:stop-web'),
    reset: (): Promise<CaptureStatus> => invokeStatus('capture:reset'),
    annotate: (input: { kind: 'element' | 'screen'; note: string }) =>
      ipcRenderer.invoke('capture:annotate', input),
    voiceSegment: (input: {
      startedAtMs: number;
      endedAtMs: number;
      pcmBase64: string;
      language?: string;
    }): Promise<{ transcript: string }> => ipcRenderer.invoke('capture:voice-segment', input),
    onStatus: (callback: (status: CaptureStatus) => void): Unsubscribe => {
      const listener = (_event: Electron.IpcRendererEvent, status: CaptureStatus) => {
        const parsed = captureStatusSchema.safeParse(status);
        if (parsed.success) callback(parsed.data);
      };
      ipcRenderer.on('capture:status-changed', listener);
      return () => ipcRenderer.removeListener('capture:status-changed', listener);
    },
    onLaunch: (callback: (launch: DesktopCaptureLaunch) => void): Unsubscribe => {
      const listener = (_event: Electron.IpcRendererEvent, value: unknown) => {
        const parsed = desktopCaptureLaunchSchema.safeParse(value);
        if (parsed.success) callback(parsed.data);
      };
      ipcRenderer.on('capture:launch-received', listener);
      return () => ipcRenderer.removeListener('capture:launch-received', listener);
    },
  },
  doctor: (runtime: LocalRuntimeConfig) => ipcRenderer.invoke('capture:doctor', runtime),
  mobile: {
    devices: (): Promise<{ available: boolean; devices: AndroidDevice[]; message: string; version?: string }> =>
      ipcRenderer.invoke('mobile:devices'),
    launch: (input: { serial: string; packageName: string }) =>
      ipcRenderer.invoke('mobile:launch', input),
    discoverSessions: (serial: string): Promise<string[]> =>
      ipcRenderer.invoke('mobile:discover-sessions', serial),
    verificationStatus: (runtime: LocalRuntimeConfig, verificationId: string) =>
      ipcRenderer.invoke('mobile:verification-status', { runtime, verificationId }),
    listVerifications: (runtime: LocalRuntimeConfig) =>
      ipcRenderer.invoke('mobile:list-verifications', runtime),
    attachSession: (input: MobileAttachInput) => ipcRenderer.invoke('mobile:attach-session', input),
  },
  openCycle: (input: {
    platformUrl: string;
    loopId: string;
    cycleId: string;
  }): Promise<void> => ipcRenderer.invoke('capture:open-cycle', input),
};

contextBridge.exposeInMainWorld('voidrCapture', api);

export type VoidrCaptureBridge = typeof api;
