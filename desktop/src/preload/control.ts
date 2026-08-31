import { contextBridge, ipcRenderer } from 'electron';
import { z } from 'zod';
import type {
  AndroidDevice,
  CaptureStatus,
  DesktopCaptureLaunch,
  DesktopCaptureResolution,
  DesktopLoopCycleDetail,
  DesktopLoopCycleSummary,
  DesktopLoopSummary,
  LocalRuntimeConfig,
  MobileAttachInput,
  PrepareWebInput,
} from '@voidr/capture-contracts';
import {
  captureStatusSchema,
  desktopCaptureLaunchSchema,
  desktopCaptureResolutionSchema,
  desktopLoopCycleDetailSchema,
  desktopLoopCycleSummarySchema,
  desktopLoopSummarySchema,
} from '@voidr/capture-contracts';

type Unsubscribe = () => void;
type SelectionEvent = {
  owner: 'annotation' | 'voice';
  selectionId?: number;
  previousSelectionId?: number;
};

const invokeStatus = (channel: string, input?: unknown): Promise<CaptureStatus> =>
  ipcRenderer.invoke(channel, ...(input === undefined ? [] : [input])).then((value) =>
    captureStatusSchema.parse(value),
  );

const launchAcceptanceSchema = z.object({
  resolution: desktopCaptureResolutionSchema,
  status: captureStatusSchema.optional(),
});

const automationCaptureApi = process.env.VOIDR_CAPTURE_E2E === '1'
  ? {
      sendTargetInputForTest: (input: unknown): Promise<void> =>
        ipcRenderer.invoke('capture:automation-target-input', input),
      selectRegionForTest: (rect: {
        x: number;
        y: number;
        width: number;
        height: number;
      }): Promise<void> => ipcRenderer.invoke('capture:automation-select-region', rect),
      injectVoiceDraftForTest: (input: { pcmBase64: string }): Promise<void> =>
        ipcRenderer.invoke('capture:automation-voice-draft', input),
      onVoiceDraftForTest: (callback: (input: { pcmBase64: string }) => void): Unsubscribe => {
        const listener = (_event: Electron.IpcRendererEvent, input: { pcmBase64: string }) => callback(input);
        ipcRenderer.on('capture:automation-voice-draft-received', listener);
        return () => ipcRenderer.removeListener('capture:automation-voice-draft-received', listener);
      },
    }
  : {};

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
    selectElement: (): Promise<{ selected: true }> =>
      ipcRenderer.invoke('capture:select-element'),
    selectRegion: (): Promise<{ selected: true }> =>
      ipcRenderer.invoke('capture:select-region'),
    selectVoiceRegion: (selectionId: number): Promise<{ selected: true }> =>
      ipcRenderer.invoke('capture:select-voice-region', selectionId),
    clearVoiceRegion: (): Promise<void> =>
      ipcRenderer.invoke('capture:clear-voice-region'),
    clearSelection: (): Promise<void> =>
      ipcRenderer.invoke('capture:clear-selection'),
    cancelSelection: (): Promise<void> =>
      ipcRenderer.invoke('capture:cancel-selection'),
    annotate: (input: { kind: 'element' | 'region' | 'screen'; note: string }) =>
      ipcRenderer.invoke('capture:annotate', input),
    voiceSegment: (input: {
      segmentId: string;
      startedAtMs: number;
      endedAtMs: number;
      pcmBase64: string;
      language?: string;
      expectsVisual: boolean;
      visualSelectionId?: number;
    }): Promise<{ transcript: string; segmentId: string }> => ipcRenderer.invoke('capture:voice-segment', input),
    setControlPanel: (
      mode: 'default' | 'annotation' | 'annotation-composer' | 'evidence' | 'voice' | 'finalizing',
    ): Promise<{ x: number; y: number; width: number; height: number } | undefined> =>
      ipcRenderer.invoke('capture:set-control-panel', mode),
    ...automationCaptureApi,
    onStatus: (callback: (status: CaptureStatus) => void): Unsubscribe => {
      const listener = (_event: Electron.IpcRendererEvent, status: CaptureStatus) => {
        const parsed = captureStatusSchema.safeParse(status);
        if (parsed.success) callback(parsed.data);
      };
      ipcRenderer.on('capture:status-changed', listener);
      return () => ipcRenderer.removeListener('capture:status-changed', listener);
    },
    onTargetPointerDown: (callback: () => void): Unsubscribe => {
      const listener = () => callback();
      ipcRenderer.on('capture:target-pointer-down', listener);
      return () => ipcRenderer.removeListener('capture:target-pointer-down', listener);
    },
    onSelectionInvalidated: (callback: (input: SelectionEvent) => void): Unsubscribe => {
      const listener = (_event: Electron.IpcRendererEvent, input: SelectionEvent) => callback(input);
      ipcRenderer.on('capture:selection-invalidated', listener);
      return () => ipcRenderer.removeListener('capture:selection-invalidated', listener);
    },
    onSelectionCancelled: (callback: (input: SelectionEvent) => void): Unsubscribe => {
      const listener = (_event: Electron.IpcRendererEvent, input: SelectionEvent) => callback(input);
      ipcRenderer.on('capture:selection-cancelled', listener);
      return () => ipcRenderer.removeListener('capture:selection-cancelled', listener);
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
  workspace: {
    openPlatform: (runtime: LocalRuntimeConfig): Promise<void> =>
      ipcRenderer.invoke('workspace:open-platform', runtime),
    listLoops: (runtime: LocalRuntimeConfig): Promise<DesktopLoopSummary[]> =>
      ipcRenderer
        .invoke('workspace:list-loops', runtime)
        .then((value) => z.array(desktopLoopSummarySchema).parse(value)),
    listCycles: (
      runtime: LocalRuntimeConfig,
      loopId: string,
    ): Promise<DesktopLoopCycleSummary[]> =>
      ipcRenderer
        .invoke('workspace:list-cycles', { runtime, loopId })
        .then((value) => z.array(desktopLoopCycleSummarySchema).parse(value)),
    getCycle: (
      runtime: LocalRuntimeConfig,
      loopId: string,
      cycleId: string,
    ): Promise<DesktopLoopCycleDetail> =>
      ipcRenderer
        .invoke('workspace:get-cycle', { runtime, loopId, cycleId })
        .then((value) => desktopLoopCycleDetailSchema.parse(value)),
    startCycle: (runtime: LocalRuntimeConfig, loopId: string): Promise<DesktopCaptureLaunch> =>
      ipcRenderer
        .invoke('workspace:start-cycle', { runtime, loopId })
        .then((value) => desktopCaptureLaunchSchema.parse(value)),
  },
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
    destination?: 'cycle' | 'consolidated';
    agent?: 'codex' | 'cursor' | 'claude_code';
  }): Promise<void> => ipcRenderer.invoke('capture:open-cycle', input),
};

contextBridge.exposeInMainWorld('voidrCapture', api);

export type VoidrCaptureBridge = typeof api;
