import { aiScenarioSchema, aiRunSchema, aiStateSchema, type AiRequest, type AiState } from "../shared/ai-tester";
import { aiLaunchEventSchema, pendingAiLaunchesSchema, type AiLaunchEvent } from '../shared/ai-launch';
import { loopApplicationSchema, loopEnvironmentSchema, createdLoopSchema, type CreateLoopInput } from '../shared/loop-creation';
import { journeyStateSchema, type JourneyConfig, type JourneyState, type JourneyInput } from '../shared/journeys';
import { contextBridge, ipcRenderer } from 'electron';
import { z } from 'zod';
import { updateStateSchema, type UpdateState } from '../shared/update';
import type {
  AndroidDevice,
  CaptureStatus,
  DesktopCaptureLaunch,
  DesktopCaptureResolution,
  DesktopLoopCycleDetail,
  DesktopLoopCycleSummary,
  DesktopLoopSummary,
  DesktopWorkspaceIdentity,
  DesktopWorkspaceLink,
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
  desktopWorkspaceIdentitySchema,
  desktopWorkspaceLinkSchema,
} from '@voidr/capture-contracts';

type Unsubscribe = () => void;
type SelectionEvent = {
  owner: 'annotation' | 'voice';
  selectionId?: number;
  previousSelectionId?: number;
};
type AnnotationSyncEvent = {
  state: 'queued' | 'synced' | 'pending';
  localId: string;
  pendingCount: number;
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
  aiTester: {
    pendingLaunches: (runtime: LocalRuntimeConfig): Promise<Array<{ loopId: string; runId: string }>> => ipcRenderer.invoke('ai-tester:pending-launches', runtime)
      .then(value => pendingAiLaunchesSchema.parse(value)),
    watchLaunches: (runtime: LocalRuntimeConfig, callback: (event: AiLaunchEvent) => void): Unsubscribe => {
      const subscriptionId = crypto.randomUUID();
      const state = { active: true };
      const listener = (_event: Electron.IpcRendererEvent, value: unknown) => {
        const parsed = z.object({ subscriptionId: z.string(), event: aiLaunchEventSchema }).safeParse(value);
        if (state.active && parsed.success && parsed.data.subscriptionId === subscriptionId) callback(parsed.data.event);
      };
      ipcRenderer.on('ai-tester:launch-event', listener);
      void ipcRenderer.invoke('ai-tester:subscribe-launches', { subscriptionId, runtime }).catch(() => {
        if (state.active) callback({ type: 'disconnected' });
      });
      return () => {
        state.active = false;
        ipcRenderer.removeListener('ai-tester:launch-event', listener);
        void ipcRenderer.invoke('ai-tester:unsubscribe-launches', subscriptionId).catch(() => undefined);
      };
    },
    clear: (): Promise<AiState> => ipcRenderer.invoke("ai-tester:clear").then(value => aiStateSchema.parse(value)),
    status: (): Promise<AiState> => ipcRenderer.invoke('ai-tester:status').then(value => aiStateSchema.parse(value)),
    start: (input: AiRequest): Promise<AiState> => ipcRenderer.invoke('ai-tester:start', input).then(value => aiStateSchema.parse(value)),
    view: (input: AiRequest): Promise<AiState> => ipcRenderer.invoke('ai-tester:view', input).then(value => aiStateSchema.parse(value)),
    scenarios: (input: AiRequest) => ipcRenderer.invoke('ai-tester:scenarios', input).then(value => z.array(aiScenarioSchema).parse(value)),
    preparation: (input: AiRequest) => ipcRenderer.invoke('ai-tester:preparation', input).then(value => aiRunSchema.nullable().parse(value)),
    list: (input: AiRequest) => ipcRenderer.invoke('ai-tester:list', input).then(value => z.array(aiRunSchema).parse(value)),
    retry: (input: AiRequest): Promise<AiState> => ipcRenderer.invoke('ai-tester:retry', input).then(value => aiStateSchema.parse(value)),
    cancel: (): Promise<AiState> => ipcRenderer.invoke('ai-tester:cancel').then(value => aiStateSchema.parse(value)),
    resume: (): Promise<AiState> => ipcRenderer.invoke('ai-tester:resume').then(value => aiStateSchema.parse(value)),
    artifact: (input: AiRequest & { artifactId: string }): Promise<void> => ipcRenderer.invoke('ai-tester:artifact', input),
    onChange: (callback: (state: AiState) => void): Unsubscribe => {
      const listener = (_event: Electron.IpcRendererEvent, value: unknown) => {
        const parsed = aiStateSchema.safeParse(value); if (parsed.success) callback(parsed.data);
      };
      ipcRenderer.on('ai-tester:changed', listener);
      return () => ipcRenderer.removeListener('ai-tester:changed', listener);
    },
  },
  journeys: {
    input: (input: JourneyInput): Promise<void> => ipcRenderer.invoke('journeys:input', input),
    resume: (): Promise<void> => ipcRenderer.invoke('journeys:resume'),
    status: (): Promise<JourneyState> => ipcRenderer.invoke("journeys:status").then(value => journeyStateSchema.parse(value)),
    configure: (): Promise<JourneyState> => ipcRenderer.invoke("journeys:configure").then(value => journeyStateSchema.parse(value)),
    start: (config: JourneyConfig): Promise<JourneyState> => ipcRenderer.invoke("journeys:start", config).then(value => journeyStateSchema.parse(value)),
    stop: (): Promise<JourneyState> => ipcRenderer.invoke("journeys:stop").then(value => journeyStateSchema.parse(value)),
    openLogs: (): Promise<void> => ipcRenderer.invoke("journeys:open-logs"),
    onChange: (callback: (state: JourneyState) => void): Unsubscribe => {
      const listener = (_event: Electron.IpcRendererEvent, value: unknown) => {
        const parsed = journeyStateSchema.safeParse(value);
        if (parsed.success) callback(parsed.data);
      };
      ipcRenderer.on("journeys:changed", listener);
      return () => ipcRenderer.removeListener("journeys:changed", listener);
    },
  },
  updates: {
    status: (): Promise<UpdateState> => ipcRenderer.invoke('updates:status').then((value) => updateStateSchema.parse(value)),
    check: (): Promise<UpdateState> => ipcRenderer.invoke('updates:check').then((value) => updateStateSchema.parse(value)),
    restart: (): Promise<UpdateState> => ipcRenderer.invoke('updates:restart').then((value) => updateStateSchema.parse(value)),
    openDownload: (): Promise<void> => ipcRenderer.invoke('updates:open-download'),
    onChange: (callback: (state: UpdateState) => void): Unsubscribe => {
      const listener = (_event: Electron.IpcRendererEvent, value: unknown) => {
        const parsed = updateStateSchema.safeParse(value);
        if (parsed.success) callback(parsed.data);
      };
      ipcRenderer.on('updates:changed', listener);
      return () => ipcRenderer.removeListener('updates:changed', listener);
    },
  },
  capture: {
    protocolError: (): Promise<string | null> => ipcRenderer.invoke('capture:protocol-error').then((value) => z.string().max(500).nullable().parse(value)),
    onProtocolError: (callback: (message: string | null) => void): Unsubscribe => {
      const listener = (_event: Electron.IpcRendererEvent, value: unknown) => {
        const parsed = z.string().max(500).nullable().safeParse(value);
        if (parsed.success) callback(parsed.data);
      };
      ipcRenderer.on('capture:protocol-error', listener);
      return () => ipcRenderer.removeListener('capture:protocol-error', listener);
    },
    status: (): Promise<CaptureStatus> => invokeStatus('capture:status'),
    annotationStatus: (): Promise<{ pendingCount: number }> =>
      ipcRenderer.invoke('capture:annotation-status').then((value) => ({
        pendingCount: z.number().int().nonnegative().parse(value),
      })),
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
    onAnnotationSync: (callback: (input: AnnotationSyncEvent) => void): Unsubscribe => {
      const listener = (_event: Electron.IpcRendererEvent, input: AnnotationSyncEvent) => callback(input);
      ipcRenderer.on('capture:annotation-sync', listener);
      return () => ipcRenderer.removeListener('capture:annotation-sync', listener);
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
  installUpdate: (runtime: LocalRuntimeConfig) => ipcRenderer.invoke('capture:install-update', runtime),
  workspace: {
    applications: (runtime: LocalRuntimeConfig) => ipcRenderer.invoke('workspace:applications', runtime).then(value => z.array(loopApplicationSchema).parse(value)),
    environments: (runtime: LocalRuntimeConfig, applicationId: string) => ipcRenderer.invoke('workspace:environments', { runtime, applicationId }).then(value => z.array(loopEnvironmentSchema).parse(value)),
    createLoop: (runtime: LocalRuntimeConfig, input: CreateLoopInput) => ipcRenderer.invoke('workspace:create-loop', { runtime, input }).then(value => createdLoopSchema.parse(value)),
    openEnvironments: (runtime: LocalRuntimeConfig, applicationId: string): Promise<void> => ipcRenderer.invoke('workspace:open-environments', { runtime, applicationId }),
    pendingLink: (): Promise<DesktopWorkspaceLink | null> =>
      ipcRenderer.invoke('workspace:pending-link').then((value) =>
        value == null ? null : desktopWorkspaceLinkSchema.parse(value),
      ),
    session: (runtime: LocalRuntimeConfig): Promise<DesktopWorkspaceIdentity | null> =>
      ipcRenderer.invoke('workspace:session', runtime).then((value) =>
        value == null ? null : desktopWorkspaceIdentitySchema.parse(value),
      ),
    connect: (runtime: LocalRuntimeConfig): Promise<DesktopWorkspaceIdentity> =>
      ipcRenderer
        .invoke('workspace:connect', runtime)
        .then((value) => desktopWorkspaceIdentitySchema.parse(value)),
    disconnect: (runtime: LocalRuntimeConfig): Promise<void> =>
      ipcRenderer.invoke('workspace:disconnect', runtime),
    onLink: (callback: (link: DesktopWorkspaceLink) => void): Unsubscribe => {
      const listener = (_event: Electron.IpcRendererEvent, value: unknown) => {
        const parsed = desktopWorkspaceLinkSchema.safeParse(value);
        if (parsed.success) callback(parsed.data);
      };
      ipcRenderer.on('workspace:link-received', listener);
      return () => ipcRenderer.removeListener('workspace:link-received', listener);
    },
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
