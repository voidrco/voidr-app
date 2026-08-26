import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  ArrowLeft,
  Braces,
  Camera,
  CheckCircle2,
  Check,
  ExternalLink,
  Globe2,
  Link2,
  ListChecks,
  Loader2,
  Maximize2,
  MessageSquare,
  Mic,
  Monitor,
  MousePointer2,
  Network,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Settings2,
  Smartphone,
  Square,
  Terminal,
  Wrench,
  X,
} from 'lucide-react';
import {
  redactText,
  type AndroidDevice,
  type CaptureStatus,
  type CapturedSignal,
  type CapturedSignalCategory,
  type DesktopCaptureLaunch,
  type DesktopCaptureResolution,
  type LocalRuntimeConfig,
} from '@voidr/capture-contracts';
import { Badge, Button, Panel, StatusDot, Tabs, Toast, VoidrBrand, VoidrMark } from '@voidr/capture-design-system';
import { finalizationStages, stageCopy } from '@voidr/capture-presentation';
import {
  abortAudioCapture,
  audioDraftFromPcmBase64,
  disposeAudioDraft,
  startAudioCapture,
  stopAudioCapture,
  type ActiveAudioCapture,
  type AudioDraft,
} from './audio';
import {
  annotationFlowReducer,
  annotationIsActive,
  annotationKind,
  initialAnnotationFlow,
  type AnnotationFlowEvent,
  type AnnotationKind,
} from './annotation-flow';
import { cycleParticipantLabel } from './cycle-identity';
import {
  initialVoiceFlow,
  initialVoiceVisualFlow,
  MAX_VOICE_DURATION_MS,
  MIN_VOICE_DURATION_MS,
  voiceFlowReducer,
  voiceHasPendingWork,
  voiceVisualFlowReducer,
  voiceVisualHasSelection,
  voiceVisualMatchesSelection,
  voiceVisualSelectionId,
  type VoiceFlow,
  type VoiceFlowEvent,
  type VoiceDraftMeta,
  type VoiceVisualFlow,
  type VoiceVisualFlowEvent,
} from './voice-flow';
import { defaultRuntime, runtimeForDeployment } from './channels';
import { WorkspaceHome } from './WorkspaceHome';

const idleStatus: CaptureStatus = {
  stage: 'idle',
  elapsedMs: 0,
  evidence: { pages: 0, clicks: 0, requests: 0, errors: 0, notes: 0, voiceNotes: 0 },
};

type DoctorResult = Awaited<ReturnType<typeof window.voidrCapture.doctor>>;
type MobileVerification = Record<string, unknown>;
type Notice = { tone: 'success' | 'warning' | 'error' | 'info'; title: string; message?: string };
type AnnotationNotice = Notice & { kind?: AnnotationKind; active: boolean };

function elapsed(value: number): string {
  const seconds = Math.floor(value / 1_000);
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function inputValue(event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>): string {
  return event.currentTarget.value;
}

function safeError(error: unknown): string {
  return error instanceof Error ? redactText(error.message) : 'A operação não pôde ser concluída.';
}

function launchErrorMessage(error: unknown): string {
  const message = safeError(error);
  if (/not found|não encontrad|identifier/i.test(message)) {
    return 'Este convite não está mais disponível. O Loop pode ter sido excluído; inicie um novo teste pela plataforma.';
  }
  if (/must belong to an organization|pertencer a uma organização/i.test(message)) {
    return 'Sua conta precisa ser confirmada na organização deste Loop. Abra o convite novamente e conclua o login do Google.';
  }
  return message;
}

function microphoneError(error: unknown): string {
  const name = error instanceof DOMException ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Libere o microfone para o Voidr Capture nos Ajustes do Sistema e tente novamente.';
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return 'Nenhum microfone foi encontrado. Conecte um dispositivo e tente novamente.';
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return 'O microfone está ocupado ou indisponível. Feche outros apps que possam estar usando-o.';
  }
  return safeError(error);
}

function voiceSendErrorMessage(rawMessage: string): string {
  if (/área|contexto visual|selecione-a novamente/i.test(rawMessage)) return rawMessage;
  if (/no transcribable speech|sem fala|fala reconhecível/i.test(rawMessage)) {
    return 'Não identificamos fala nessa gravação. Ouça o preview ou grave novamente.';
  }
  if (/timeout|timed out|aborted|excedeu|demorando/i.test(rawMessage)) {
    return 'A transcrição demorou mais que o esperado. Sua gravação continua aqui; tente novamente.';
  }
  if (/fetch|network|temporarily unavailable|indisponível|conexão/i.test(rawMessage)) {
    return 'Não foi possível enviar agora. Sua gravação continua aqui; tente novamente.';
  }
  return 'Não foi possível adicionar a voz. Sua gravação continua aqui; tente novamente.';
}

function App() {
  const [status, setStatus] = useState<CaptureStatus>(idleStatus);
  const [statusHydrated, setStatusHydrated] = useState(false);
  const [homeView, setHomeView] = useState<'loops' | 'capture'>('loops');
  const [mode, setMode] = useState<'web' | 'mobile' | 'api'>('web');
  const [runtime, setRuntime] = useState<LocalRuntimeConfig>(() => {
    try {
      return { ...defaultRuntime, ...JSON.parse(localStorage.getItem('voidr.capture.runtime') ?? '{}') };
    } catch {
      return defaultRuntime;
    }
  });
  const [recordingUrl, setRecordingUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Notice>();
  const [doctor, setDoctor] = useState<DoctorResult>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [annotationFlow, setAnnotationFlow] = useState(initialAnnotationFlow);
  const [evidenceOpen, setEvidenceOpen] = useState<CapturedSignalCategory>();
  const [annotationNotice, setAnnotationNotice] = useState<AnnotationNotice>();
  const [voiceFlow, setVoiceFlow] = useState(initialVoiceFlow);
  const [voiceVisualFlow, setVoiceVisualFlow] = useState(initialVoiceVisualFlow);
  const [voiceElapsedMs, setVoiceElapsedMs] = useState(0);
  const [voiceLevel, setVoiceLevel] = useState(0);
  const [voiceGuardMessage, setVoiceGuardMessage] = useState('');
  const [devices, setDevices] = useState<AndroidDevice[]>([]);
  const [selectedDevice, setSelectedDevice] = useState('');
  const [packageName, setPackageName] = useState('co.voidr.replay.demo.itau');
  const [sessionIds, setSessionIds] = useState<string[]>([]);
  const [sessionId, setSessionId] = useState('');
  const [verificationId, setVerificationId] = useState('');
  const [mobileLoops, setMobileLoops] = useState<MobileVerification[]>([]);
  const [mobileContext, setMobileContext] = useState<{ loopId: string; cycleId: string }>();
  const [mobileAppOpened, setMobileAppOpened] = useState(false);
  const [launchResolution, setLaunchResolution] = useState<DesktopCaptureResolution>();
  const [finalizationElapsedMs, setFinalizationElapsedMs] = useState(0);
  const acceptingLaunch = useRef<string | undefined>(undefined);
  const finalizationStartedAt = useRef<number | undefined>(undefined);
  const annotationNoticeTimer = useRef<number | undefined>(undefined);
  const annotationFlowRef = useRef(annotationFlow);
  const annotationAttempt = useRef(0);
  const annotationSaveInFlight = useRef(false);
  const statusRef = useRef(status);
  const voiceFlowRef = useRef(voiceFlow);
  const voiceVisualFlowRef = useRef(voiceVisualFlow);
  const voiceVisualAttempt = useRef(0);
  const voiceCaptureRef = useRef<ActiveAudioCapture | undefined>(undefined);
  const voiceDraftRef = useRef<AudioDraft | undefined>(undefined);
  const voiceRetakeFallbackRef = useRef<{
    draft: AudioDraft;
    meta: VoiceDraftMeta;
  } | undefined>(undefined);
  const voiceAttempt = useRef(0);
  const voiceStopInFlight = useRef(false);
  const voiceSendInFlight = useRef<string | undefined>(undefined);
  const voiceStartedAtWall = useRef(0);
  const stopVoiceRef = useRef<(reason?: 'user' | 'escape' | 'limit' | 'device') => Promise<void>>(
    async () => undefined,
  );

  const copy = stageCopy[status.stage];
  const activeCapture = ['ready', 'recording', 'stopping', 'sealed', 'attaching', 'processing', 'ready_for_review', 'recoverable_error'].includes(status.stage) && status.platform === 'web';
  const recording = status.stage === 'recording';
  const finalizing = ['stopping', 'sealed', 'attaching', 'processing'].includes(status.stage);
  const cycleParticipant = status.context?.participant ?? launchResolution?.participant;
  const cycleStartedAt = status.context?.cycleStartedAt ?? launchResolution?.cycleStartedAt;
  const participantLabel = cycleParticipantLabel(cycleParticipant, cycleStartedAt);
  const agentName = status.context?.harnessName;
  const harnessDeliveryState = status.context?.harnessDeliveryState;
  const currentAnnotationKind = annotationKind(annotationFlow);
  const annotationActive = annotationIsActive(annotationFlow);
  const noteOpen = annotationFlow.phase === 'choosing' || annotationFlow.phase === 'composing';
  const note = annotationFlow.note;
  const voicePanelOpen = voiceFlow.phase !== 'idle';
  const voiceVisualSelecting = voiceVisualFlow.phase === 'selecting';
  const controlPanelMode = finalizing
    ? 'finalizing'
    : recording && voiceVisualSelecting
      ? 'default'
    : recording && voicePanelOpen
      ? 'voice'
    : recording && annotationFlow.phase === 'choosing'
      ? 'annotation'
      : recording && annotationFlow.phase === 'composing'
        ? 'annotation-composer'
        : recording && evidenceOpen
          ? 'evidence'
          : 'default';
  const dockDetail = feedback?.message
    ?? (status.stage === 'ready_for_review' && agentName && harnessDeliveryState === 'acknowledged'
      ? `${agentName} recebeu o contexto citado e retomou o trabalho.`
      : status.stage === 'ready_for_review' && agentName && harnessDeliveryState === 'failed'
        ? `A captura está pronta, mas o retorno ao ${agentName} precisa ser tentado novamente.`
        : status.stage === 'ready_for_review' && agentName
          ? `A captura está pronta. Aguardando o ${agentName} confirmar o contexto.`
      : status.message ?? copy.detail);

  const transitionAnnotation = useCallback((event: AnnotationFlowEvent) => {
    const next = annotationFlowReducer(annotationFlowRef.current, event);
    annotationFlowRef.current = next;
    setAnnotationFlow(next);
    return next;
  }, []);

  const transitionVoice = useCallback((event: VoiceFlowEvent) => {
    const next = voiceFlowReducer(voiceFlowRef.current, event);
    voiceFlowRef.current = next;
    setVoiceFlow(next);
    return next;
  }, []);

  const transitionVoiceVisual = useCallback((event: VoiceVisualFlowEvent) => {
    const next = voiceVisualFlowReducer(voiceVisualFlowRef.current, event);
    voiceVisualFlowRef.current = next;
    setVoiceVisualFlow(next);
    return next;
  }, []);

  const acceptLaunch = useCallback(async (launch: DesktopCaptureLaunch) => {
    const key = `${launch.loopId}:${launch.cycleId}`;
    if (acceptingLaunch.current) {
      setFeedback({
        tone: 'info',
        title: 'Preparando seu teste',
        message: 'Aguarde a abertura atual terminar antes de abrir outro convite.',
      });
      return;
    }
    const current = statusRef.current;
    const captureOwnsLocalState = [
      'recording',
      'stopping',
      'sealed',
      'attaching',
      'processing',
      'recoverable_error',
    ].includes(current.stage);
    if (captureOwnsLocalState && current.context) {
      const sameCycle = current.context.scenarioId === launch.loopId &&
        current.context.cycleId === launch.cycleId;
      setFeedback(sameCycle
        ? {
            tone: 'info',
            title: 'Este teste já está aberto',
            message: 'Continue a captura atual; o tempo e suas evidências foram preservados.',
          }
        : {
            tone: 'warning',
            title: 'Conclua o teste atual primeiro',
            message: 'Finalize a captura em andamento antes de abrir outro teste.',
          });
      return;
    }
    const launchRuntime = runtimeForDeployment(
      launch.deployment,
      runtime,
      launch.organizationId,
      launch.previewSlug,
    );
    acceptingLaunch.current = key;
    setBusy(true);
    setFeedback({
      tone: 'info',
      title: 'Preparando seu teste',
      message: 'Confirmando aplicação, ambiente e permissões com a Voidr.',
    });
    try {
      const accepted = await window.voidrCapture.capture.acceptLaunch(launch, launchRuntime);
      if (launchRuntime !== runtime) setRuntime(launchRuntime);
      setLaunchResolution(accepted.resolution);
      if (accepted.status) {
        statusRef.current = accepted.status;
        setStatus(accepted.status);
      }
      setMode(accepted.resolution.surface);
      if (accepted.resolution.surface === 'mobile') {
        setVerificationId(accepted.resolution.cycleId);
        setMobileContext({
          loopId: accepted.resolution.loopId,
          cycleId: accepted.resolution.cycleId,
        });
        setMobileLoops([
          {
            verificationId: accepted.resolution.cycleId,
            mission: accepted.resolution.mission,
            applicationType: 'MOBILE',
          },
        ]);
      }
      setFeedback({
        tone: 'success',
        title: accepted.status?.stage === 'recording' ? 'Teste em andamento' : 'Teste preparado',
        message:
          accepted.resolution.surface === 'web'
            ? accepted.status?.stage === 'recording'
              ? 'A captura começou automaticamente e o tempo já está contando.'
              : 'A aplicação está pronta para capturar.'
            : accepted.resolution.surface === 'mobile'
              ? 'Conecte o device e execute a jornada no app.'
              : 'Revise o endpoint antes de iniciar a captura.',
      });
    } catch (error) {
      setFeedback({
        tone: 'error',
        title: 'Não foi possível abrir o teste',
        message: launchErrorMessage(error),
      });
    } finally {
      acceptingLaunch.current = undefined;
      setBusy(false);
    }
  }, [runtime]);

  useEffect(() => {
    const applyStatus = (value: CaptureStatus) => {
      statusRef.current = value;
      setStatus(value);
    };
    const unsubscribe = window.voidrCapture.capture.onStatus(applyStatus);
    void window.voidrCapture.capture.status()
      .then((value) => value && applyStatus(value))
      .finally(() => setStatusHydrated(true));
    return unsubscribe;
  }, []);

  useEffect(() => () => {
    if (annotationNoticeTimer.current) window.clearTimeout(annotationNoticeTimer.current);
  }, []);

  useEffect(() => {
    if (!statusHydrated) return;
    const unsubscribe = window.voidrCapture.capture.onLaunch((launch) => void acceptLaunch(launch));
    void window.voidrCapture.capture.pendingLaunch().then((launch) => {
      if (launch) void acceptLaunch(launch);
    });
    return unsubscribe;
  }, [acceptLaunch, statusHydrated]);

  useEffect(() => {
    const { localDevKey: _ephemeralSecret, ...persistableRuntime } = runtime;
    localStorage.setItem('voidr.capture.runtime', JSON.stringify(persistableRuntime));
  }, [runtime]);

  useEffect(() => {
    if (!recording) return;
    const timer = window.setInterval(() => setStatus((current) => ({ ...current, elapsedMs: current.elapsedMs + 500 })), 500);
    return () => window.clearInterval(timer);
  }, [recording]);

  useEffect(() => {
    void window.voidrCapture.capture.setControlPanel(controlPanelMode).catch(() => undefined);
  }, [controlPanelMode]);

  useEffect(() => {
    if (recording) return;
    annotationAttempt.current += 1;
    annotationSaveInFlight.current = false;
    transitionAnnotation({ type: 'RECORDING_ENDED' });
    setAnnotationNotice(undefined);
    setEvidenceOpen(undefined);
    void window.voidrCapture.capture.clearSelection().catch(() => undefined);
    const capture = voiceCaptureRef.current;
    voiceCaptureRef.current = undefined;
    if (capture) void abortAudioCapture(capture);
    disposeAudioDraft(voiceDraftRef.current);
    voiceDraftRef.current = undefined;
    disposeAudioDraft(voiceRetakeFallbackRef.current?.draft);
    voiceRetakeFallbackRef.current = undefined;
    voiceAttempt.current += 1;
    voiceVisualAttempt.current += 1;
    voiceSendInFlight.current = undefined;
    transitionVoice({ type: 'CYCLE_ENDED' });
    transitionVoiceVisual({ type: 'CYCLE_ENDED' });
  }, [recording, transitionAnnotation, transitionVoice, transitionVoiceVisual]);

  useEffect(() => {
    if (!finalizing) {
      finalizationStartedAt.current = undefined;
      setFinalizationElapsedMs(0);
      return;
    }
    finalizationStartedAt.current ??= Date.now();
    const update = () => {
      setFinalizationElapsedMs(Date.now() - (finalizationStartedAt.current ?? Date.now()));
    };
    update();
    const timer = window.setInterval(update, 1_000);
    return () => window.clearInterval(timer);
  }, [finalizing]);

  const run = async (operation: () => Promise<void>) => {
    setBusy(true);
    setFeedback(undefined);
    try {
      await operation();
    } catch (error) {
      setFeedback({ tone: 'error', title: 'Não foi possível concluir', message: safeError(error) });
    } finally {
      setBusy(false);
    }
  };

  const startWorkspaceLoop = async (loopId: string) => {
    setBusy(true);
    setFeedback(undefined);
    try {
      const launch = await window.voidrCapture.workspace.startCycle(runtime, loopId);
      await acceptLaunch(launch);
    } catch (error) {
      setFeedback({
        tone: 'error',
        title: 'Não foi possível iniciar o teste',
        message: safeError(error),
      });
    } finally {
      setBusy(false);
    }
  };

  const prepareAndStart = () =>
    run(async () => {
      if (!recordingUrl.trim()) throw new Error('Cole o link da verificação.');
      await window.voidrCapture.capture.prepareWeb({ recordingUrl: recordingUrl.trim(), runtime });
      await window.voidrCapture.capture.startWeb();
    });

  const beginAnnotation = async (kind: AnnotationKind) => {
    if (busy || ['selecting', 'saving'].includes(annotationFlowRef.current.phase)) return;
    if (annotationNoticeTimer.current) window.clearTimeout(annotationNoticeTimer.current);
    setEvidenceOpen(undefined);
    const attempt = ++annotationAttempt.current;
    if (kind === 'screen') {
      await window.voidrCapture.capture.clearSelection();
      transitionAnnotation({ type: 'CHOOSE', kind, attempt });
      setAnnotationNotice(undefined);
      return;
    }

    transitionAnnotation({ type: 'CHOOSE', kind, attempt });
    setAnnotationNotice({
      tone: 'info',
      kind,
      active: true,
      title: kind === 'element' ? 'Selecione um elemento' : 'Selecione uma região',
      message: kind === 'element'
        ? 'Clique na aplicação · Esc para cancelar'
        : 'Arraste sobre uma área · Esc para cancelar',
    });
    try {
      await window.voidrCapture.capture.setControlPanel('default');
      if (kind === 'element') await window.voidrCapture.capture.selectElement();
      else await window.voidrCapture.capture.selectRegion();
      if (annotationAttempt.current !== attempt) {
        await window.voidrCapture.capture.clearSelection();
        return;
      }
      transitionAnnotation({ type: 'SELECTION_SUCCEEDED', kind, attempt });
      setAnnotationNotice(undefined);
      await window.voidrCapture.capture.setControlPanel('annotation-composer');
    } catch (error) {
      if (annotationAttempt.current !== attempt) return;
      const message = safeError(error);
      transitionAnnotation({ type: 'SELECTION_CANCELLED', attempt });
      if (message.includes('seleção foi cancelada')) {
        setAnnotationNotice(undefined);
      } else {
        setAnnotationNotice({
          tone: 'error',
          kind,
          active: false,
          title: kind === 'element'
            ? 'Não foi possível selecionar o elemento'
            : 'Não foi possível selecionar a região',
          message,
        });
        annotationNoticeTimer.current = window.setTimeout(() => setAnnotationNotice(undefined), 6_000);
      }
      await window.voidrCapture.capture.setControlPanel('annotation');
    }
  };

  const cancelAnnotation = useCallback(async (destination: 'closed' | 'choosing' = 'closed') => {
    if (annotationFlowRef.current.phase === 'saving') return;
    const wasSelecting = annotationFlowRef.current.phase === 'selecting';
    annotationAttempt.current += 1;
    if (annotationNoticeTimer.current) window.clearTimeout(annotationNoticeTimer.current);
    transitionAnnotation({ type: destination === 'choosing' ? 'BACK' : 'CLOSE' });
    setAnnotationNotice(undefined);
    if (wasSelecting) await window.voidrCapture.capture.cancelSelection();
    else await window.voidrCapture.capture.clearSelection();
    await window.voidrCapture.capture.setControlPanel(
      destination === 'choosing' ? 'annotation' : 'default',
    );
  }, [transitionAnnotation]);

  const saveAnnotation = async () => {
    const flow = annotationFlowRef.current;
    if (
      busy ||
      annotationSaveInFlight.current ||
      flow.phase !== 'composing' ||
      !flow.note.trim()
    ) return;
    if (annotationNoticeTimer.current) window.clearTimeout(annotationNoticeTimer.current);
    const kind = flow.kind;
    const suppliedNote = flow.note.trim();
    annotationSaveInFlight.current = true;
    transitionAnnotation({ type: 'SAVE_STARTED' });
    setBusy(true);
    setAnnotationNotice({
      tone: 'info',
      kind,
      active: true,
      title: 'Salvando anotação',
    });
    try {
      await window.voidrCapture.capture.setControlPanel('default');
      await window.voidrCapture.capture.annotate({ kind, note: suppliedNote });
      transitionAnnotation({ type: 'SAVE_SUCCEEDED' });
      setAnnotationNotice({
        tone: 'success',
        kind,
        active: false,
        title: 'Anotação salva',
        message: 'A nota e a captura foram adicionadas ao teste.',
      });
      annotationNoticeTimer.current = window.setTimeout(() => setAnnotationNotice(undefined), 2_200);
    } catch (error) {
      transitionAnnotation({ type: 'SAVE_FAILED' });
      setAnnotationNotice({
        tone: 'error',
        kind,
        active: false,
        title: 'Não foi possível salvar a anotação',
        message: safeError(error),
      });
      await window.voidrCapture.capture.setControlPanel('annotation-composer');
      annotationNoticeTimer.current = window.setTimeout(() => setAnnotationNotice(undefined), 6_000);
    } finally {
      annotationSaveInFlight.current = false;
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!annotationActive) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' && event.key !== 'Esc') return;
      if (annotationFlowRef.current.phase === 'saving') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void cancelAnnotation(
        annotationFlowRef.current.phase === 'choosing' ? 'closed' : 'choosing',
      );
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [annotationActive, cancelAnnotation]);

  useEffect(() => {
    if (annotationFlow.phase !== 'choosing') return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest('.dock-note,[data-annotation-trigger]')) return;
      if (annotationFlowRef.current.note.trim()) return;
      void cancelAnnotation('closed');
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [annotationFlow.phase, cancelAnnotation]);

  useEffect(() => window.voidrCapture.capture.onTargetPointerDown(() => {
    if (
      annotationFlowRef.current.phase === 'choosing' &&
      !annotationFlowRef.current.note.trim()
    ) void cancelAnnotation('closed');
  }), [cancelAnnotation]);

  const selectVoiceRegion = useCallback(async () => {
    const voice = voiceFlowRef.current;
    if (
      (voice.phase !== 'reviewing' && voice.phase !== 'error') ||
      !voiceDraftRef.current ||
      voiceVisualFlowRef.current.phase === 'selecting'
    ) return;
    const attempt = ++voiceVisualAttempt.current;
    transitionVoiceVisual({ type: 'SELECT_REQUESTED', attempt });
    setVoiceGuardMessage('');
    try {
      await window.voidrCapture.capture.setControlPanel('default');
      await window.voidrCapture.capture.selectVoiceRegion(attempt);
      if (voiceVisualAttempt.current !== attempt) return;
      transitionVoiceVisual({ type: 'SELECT_SUCCEEDED', attempt });
      await window.voidrCapture.capture.setControlPanel('voice');
    } catch (error) {
      if (voiceVisualAttempt.current !== attempt) return;
      const message = safeError(error);
      if (message.includes('seleção foi cancelada')) {
        transitionVoiceVisual({ type: 'SELECT_CANCELLED', attempt });
      } else {
        transitionVoiceVisual({ type: 'SELECT_FAILED', attempt, error: message });
        setVoiceGuardMessage(message);
      }
      await window.voidrCapture.capture.setControlPanel('voice');
    }
  }, [transitionVoiceVisual]);

  const clearVoiceRegion = useCallback(async () => {
    voiceVisualAttempt.current += 1;
    transitionVoiceVisual({ type: 'CLEAR' });
    setVoiceGuardMessage('');
    await window.voidrCapture.capture.clearVoiceRegion();
  }, [transitionVoiceVisual]);

  useEffect(() => window.voidrCapture.capture.onSelectionInvalidated((selection) => {
    if (selection.owner === 'voice') {
      if (
        !voiceVisualMatchesSelection(voiceVisualFlowRef.current, selection.selectionId) &&
        !voiceVisualMatchesSelection(
          voiceVisualFlowRef.current,
          selection.previousSelectionId,
        ) &&
        selection.selectionId !== voiceVisualAttempt.current
      ) return;
      const voice = voiceFlowRef.current;
      if (voice.phase === 'sending' || (voice.phase === 'error' && voice.sendAttempted)) {
        return;
      }
      if (voice.phase !== 'reviewing' && voice.phase !== 'error') return;
      const message = 'A página mudou. Selecione a área novamente. Sua gravação foi preservada.';
      voiceVisualAttempt.current += 1;
      transitionVoiceVisual({ type: 'SELECTION_INVALIDATED', error: message });
      setVoiceGuardMessage(message);
      void window.voidrCapture.capture.setControlPanel('voice');
      return;
    }
    const flow = annotationFlowRef.current;
    if (flow.phase !== 'composing' || flow.kind === 'screen') return;
    annotationAttempt.current += 1;
    transitionAnnotation({ type: 'BACK' });
    setAnnotationNotice({
      tone: 'warning',
      kind: flow.kind,
      active: false,
      title: 'A página mudou',
      message: 'Escolha o elemento ou a região novamente. Seu texto foi preservado.',
    });
    void window.voidrCapture.capture.setControlPanel('annotation');
  }), [transitionAnnotation, transitionVoiceVisual]);

  useEffect(() => window.voidrCapture.capture.onSelectionCancelled((selection) => {
    if (selection.owner === 'voice') {
      const visual = voiceVisualFlowRef.current;
      if (
        visual.phase !== 'selecting' ||
        visual.attempt !== selection.selectionId ||
        !voiceVisualMatchesSelection(visual, selection.selectionId)
      ) return;
      voiceVisualAttempt.current += 1;
      transitionVoiceVisual({ type: 'SELECT_CANCELLED', attempt: visual.attempt });
      setVoiceGuardMessage('');
      void window.voidrCapture.capture.setControlPanel('voice');
      return;
    }
    const flow = annotationFlowRef.current;
    if (flow.phase !== 'selecting') return;
    annotationAttempt.current += 1;
    transitionAnnotation({ type: 'SELECTION_CANCELLED', attempt: flow.attempt });
    setAnnotationNotice(undefined);
    void window.voidrCapture.capture.setControlPanel('annotation');
  }), [transitionAnnotation, transitionVoiceVisual]);

  const disposeVoiceDraft = useCallback(() => {
    disposeAudioDraft(voiceDraftRef.current);
    voiceDraftRef.current = undefined;
  }, []);

  const restoreVoiceRetakeFallback = useCallback((error: string): boolean => {
    const fallback = voiceRetakeFallbackRef.current;
    if (!fallback) return false;
    disposeAudioDraft(voiceDraftRef.current);
    voiceDraftRef.current = fallback.draft;
    voiceRetakeFallbackRef.current = undefined;
    transitionVoice({ type: 'RESTORE_DRAFT', draft: fallback.meta, error });
    return true;
  }, [transitionVoice]);

  const cancelVoiceRequest = useCallback(() => {
    const flow = voiceFlowRef.current;
    if (flow.phase !== 'requesting') return;
    voiceAttempt.current += 1;
    const restored = restoreVoiceRetakeFallback('A gravação anterior foi preservada.');
    if (!restored) {
      transitionVoice({ type: 'REQUEST_CANCELLED', attempt: flow.attempt });
    }
    if (!restored && voiceVisualFlowRef.current.phase !== 'none') void clearVoiceRegion();
  }, [clearVoiceRegion, transitionVoice]);

  const discardVoice = useCallback(async () => {
    const flow = voiceFlowRef.current;
    if (flow.phase === 'requesting') {
      cancelVoiceRequest();
      return;
    }
    if (flow.phase === 'recording') {
      await stopVoiceRef.current('user');
      return;
    }
    disposeVoiceDraft();
    disposeAudioDraft(voiceRetakeFallbackRef.current?.draft);
    voiceRetakeFallbackRef.current = undefined;
    setVoiceGuardMessage('');
    setFeedback(undefined);
    setVoiceElapsedMs(0);
    setVoiceLevel(0);
    await clearVoiceRegion();
    transitionVoice({ type: 'DISCARD' });
  }, [cancelVoiceRequest, clearVoiceRegion, disposeVoiceDraft, transitionVoice]);

  const startVoice = useCallback(async () => {
    const current = voiceFlowRef.current;
    if (!['idle', 'success', 'unavailable'].includes(current.phase)) return;
    disposeVoiceDraft();
    setVoiceGuardMessage('');
    setVoiceElapsedMs(0);
    setVoiceLevel(0);
    const attempt = ++voiceAttempt.current;
    transitionVoice({ type: 'START_REQUESTED', attempt });
    try {
      const capture = await startAudioCapture({
        onLevel: setVoiceLevel,
        onEnded: () => void stopVoiceRef.current('device'),
      });
      if (
        voiceAttempt.current !== attempt ||
        voiceFlowRef.current.phase !== 'requesting' ||
        voiceFlowRef.current.attempt !== attempt
      ) {
        await abortAudioCapture(capture);
        return;
      }
      voiceCaptureRef.current = capture;
      voiceStartedAtWall.current = Date.now();
      transitionVoice({
        type: 'START_SUCCEEDED',
        attempt,
        startedAtMs: statusRef.current.elapsedMs,
      });
    } catch (error) {
      if (voiceAttempt.current !== attempt) return;
      const message = microphoneError(error);
      if (!restoreVoiceRetakeFallback(
        `${message} A gravação anterior foi preservada.`,
      )) {
        transitionVoice({ type: 'START_FAILED', attempt, error: message });
      }
    }
  }, [disposeVoiceDraft, restoreVoiceRetakeFallback, transitionVoice]);

  const stopVoice = useCallback(async (
    _reason: 'user' | 'escape' | 'limit' | 'device' = 'user',
  ) => {
    const flow = voiceFlowRef.current;
    const capture = voiceCaptureRef.current;
    if (flow.phase !== 'recording' || !capture || voiceStopInFlight.current) return;
    voiceStopInFlight.current = true;
    voiceCaptureRef.current = undefined;
    transitionVoice({ type: 'STOP_REQUESTED' });
    setVoiceGuardMessage('');
    try {
      const draft = await stopAudioCapture(capture);
      const canSend = draft.durationMs >= MIN_VOICE_DURATION_MS;
      if (!canSend && voiceRetakeFallbackRef.current) {
        disposeAudioDraft(draft);
        restoreVoiceRetakeFallback(
          'A nova gravação ficou curta demais; mantivemos a anterior para você não perder nada.',
        );
        return;
      }
      disposeVoiceDraft();
      disposeAudioDraft(voiceRetakeFallbackRef.current?.draft);
      voiceRetakeFallbackRef.current = undefined;
      voiceDraftRef.current = draft;
      transitionVoice({
        type: 'DRAFT_READY',
        draft: {
          id: crypto.randomUUID(),
          startedAtMs: flow.startedAtMs,
          durationMs: draft.durationMs,
          canSend,
        },
        ...(!canSend
          ? { warning: 'A gravação ficou curta demais. Ouça se quiser e grave novamente.' }
          : {}),
      });
    } catch (error) {
      const message = safeError(error);
      if (!restoreVoiceRetakeFallback(
        `${message} A gravação anterior foi preservada.`,
      )) {
        transitionVoice({ type: 'STOP_FAILED', error: message });
      }
    } finally {
      voiceStopInFlight.current = false;
      setVoiceLevel(0);
    }
  }, [disposeVoiceDraft, restoreVoiceRetakeFallback, transitionVoice]);
  stopVoiceRef.current = stopVoice;

  const retakeVoice = useCallback(async () => {
    const flow = voiceFlowRef.current;
    if (flow.phase === 'sending' || (flow.phase === 'error' && flow.sendAttempted)) {
      setVoiceGuardMessage(
        'Confirme a tentativa atual antes de gravar outra; ela pode já ter sido adicionada.',
      );
      return;
    }
    const draft = voiceDraftRef.current;
    if (
      !draft ||
      (flow.phase !== 'reviewing' && flow.phase !== 'error')
    ) return;
    voiceDraftRef.current = undefined;
    voiceRetakeFallbackRef.current = {
      draft,
      meta: {
        id: flow.id,
        startedAtMs: flow.startedAtMs,
        durationMs: flow.durationMs,
        canSend: flow.canSend,
      },
    };
    transitionVoice({ type: 'DISCARD' });
    await startVoice();
  }, [startVoice, transitionVoice]);

  const sendVoice = useCallback(async () => {
    const flow = voiceFlowRef.current;
    const draft = voiceDraftRef.current;
    if (flow.phase !== 'reviewing' && flow.phase !== 'error') return;
    if (!flow.canSend || !draft || voiceSendInFlight.current) return;
    const segmentId = flow.id;
    const visualSelectionId = voiceVisualSelectionId(voiceVisualFlowRef.current);
    voiceSendInFlight.current = segmentId;
    setVoiceGuardMessage('');
    transitionVoice({ type: 'SEND_REQUESTED' });
    try {
      const result = await window.voidrCapture.capture.voiceSegment({
        segmentId: flow.id,
        startedAtMs: flow.startedAtMs,
        endedAtMs: flow.startedAtMs + flow.durationMs,
        pcmBase64: draft.pcmBase64,
        language: 'pt-BR',
        expectsVisual: visualSelectionId !== undefined,
        ...(visualSelectionId !== undefined ? { visualSelectionId } : {}),
      });
      if (
        voiceSendInFlight.current === segmentId &&
        voiceFlowRef.current.phase === 'sending' &&
        voiceFlowRef.current.id === segmentId
      ) {
        transitionVoice({ type: 'SEND_SUCCEEDED', id: segmentId, transcript: result.transcript });
        transitionVoiceVisual({ type: 'CLEAR' });
        disposeVoiceDraft();
      }
    } catch (error) {
      if (voiceSendInFlight.current === segmentId) {
        const rawMessage = safeError(error);
        const visualUnavailable = rawMessage.includes('[VOICE_VISUAL_UNAVAILABLE]');
        const definitiveFailure = rawMessage.includes('[VOICE_SEND_DEFINITIVE]');
        const message = voiceSendErrorMessage(
          rawMessage
            .replace('[VOICE_VISUAL_UNAVAILABLE]', '')
            .replace('[VOICE_SEND_DEFINITIVE]', '')
            .trim(),
        );
        transitionVoice({
          type: 'SEND_FAILED',
          id: segmentId,
          error: message,
          sendAttempted: !visualUnavailable && !definitiveFailure,
        });
        if (visualUnavailable) {
          transitionVoiceVisual({ type: 'SELECTION_INVALIDATED', error: message });
          setVoiceGuardMessage(message);
        }
      }
    } finally {
      if (voiceSendInFlight.current === segmentId) voiceSendInFlight.current = undefined;
    }
  }, [disposeVoiceDraft, transitionVoice, transitionVoiceVisual]);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    if (voiceFlow.phase !== 'recording') return;
    const update = () => {
      const value = Math.min(MAX_VOICE_DURATION_MS, Date.now() - voiceStartedAtWall.current);
      setVoiceElapsedMs(value);
      if (value >= MAX_VOICE_DURATION_MS - 750) void stopVoiceRef.current('limit');
    };
    update();
    const timer = window.setInterval(update, 100);
    return () => window.clearInterval(timer);
  }, [voiceFlow.phase]);

  useEffect(() => {
    if (!voicePanelOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (voiceFlowRef.current.phase === 'requesting') {
        event.preventDefault();
        event.stopImmediatePropagation();
        cancelVoiceRequest();
      } else if (voiceFlowRef.current.phase === 'recording') {
        event.preventDefault();
        event.stopImmediatePropagation();
        void stopVoiceRef.current('escape');
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [cancelVoiceRequest, voicePanelOpen]);

  useEffect(() => () => {
    const capture = voiceCaptureRef.current;
    voiceCaptureRef.current = undefined;
    if (capture) void abortAudioCapture(capture);
    disposeVoiceDraft();
  }, [disposeVoiceDraft]);

  useEffect(() => {
    const automationCapture = window.voidrCapture.capture as typeof window.voidrCapture.capture & {
      onVoiceDraftForTest?: (callback: (input: { pcmBase64: string }) => void) => () => void;
    };
    if (!automationCapture.onVoiceDraftForTest) return;
    return automationCapture.onVoiceDraftForTest(({ pcmBase64 }) => {
      if (statusRef.current.stage !== 'recording' || voiceHasPendingWork(voiceFlowRef.current)) return;
      disposeVoiceDraft();
      const draft = audioDraftFromPcmBase64(pcmBase64);
      voiceDraftRef.current = draft;
      const attempt = ++voiceAttempt.current;
      transitionVoice({ type: 'START_REQUESTED', attempt });
      transitionVoice({
        type: 'START_SUCCEEDED',
        attempt,
        startedAtMs: statusRef.current.elapsedMs,
      });
      transitionVoice({ type: 'STOP_REQUESTED' });
      transitionVoice({
        type: 'DRAFT_READY',
        draft: {
          id: crypto.randomUUID(),
          startedAtMs: statusRef.current.elapsedMs,
          durationMs: draft.durationMs,
          canSend: draft.durationMs >= MIN_VOICE_DURATION_MS,
        },
      });
    });
  }, [disposeVoiceDraft, transitionVoice]);

  const refreshDevices = () =>
    run(async () => {
      const result = await window.voidrCapture.mobile.devices();
      setDevices(result.devices);
      if (!selectedDevice && result.devices[0]?.serial) setSelectedDevice(result.devices[0].serial);
      setFeedback({ tone: result.devices.length ? 'success' : 'warning', title: result.devices.length ? 'Device conectado' : 'Nenhum device encontrado', message: result.message });
    });

  const discoverSessions = () =>
    run(async () => {
      if (!selectedDevice) throw new Error('Selecione um device Android.');
      const found = await window.voidrCapture.mobile.discoverSessions(selectedDevice);
      setSessionIds(found);
      if (found[0]) setSessionId(found[0]);
      setFeedback(found.length
        ? { tone: 'success', title: 'Captura mobile encontrada', message: `${found.length} captura(s) pronta(s) para envio.` }
        : { tone: 'warning', title: 'Ainda não há captura finalizada', message: 'Conclua o fluxo no app e tente novamente.' });
    });

  const loadMobileLoops = () =>
    run(async () => {
      const values = (await window.voidrCapture.mobile.listVerifications(runtime)) as MobileVerification[];
      const mobile = values.filter((item) => String(item.applicationType ?? item.platform ?? '').toUpperCase() === 'MOBILE');
      setMobileLoops(mobile.length ? mobile : values);
      const count = mobile.length || values.length;
      setFeedback({ tone: 'info', title: 'Testes atualizados', message: `${count} ${count === 1 ? 'teste disponível' : 'testes disponíveis'}.` });
    });

  const attachMobile = () =>
    run(async () => {
      if (!verificationId || !sessionId) throw new Error('Selecione o teste e a captura do app.');
      const current = (await window.voidrCapture.mobile.verificationStatus(runtime, verificationId)) as Record<string, unknown>;
      const lifecycleVersion = Number(current.lifecycleVersion);
      if (!Number.isInteger(lifecycleVersion) || lifecycleVersion < 0) throw new Error('Não foi possível preparar este teste. Atualize e tente novamente.');
      await window.voidrCapture.mobile.attachSession({ verificationId, sessionId, lifecycleVersion, runtime });
      const loopId = String(current.loopId ?? current.scenarioId ?? '');
      const cycleId = String(current.cycleId ?? verificationId);
      if (loopId) setMobileContext({ loopId, cycleId });
      setFeedback({ tone: 'success', title: 'Evidências enviadas', message: 'A Voidr está organizando o que foi capturado.' });
    });

  const protectAnnotationDraft = (destination: string): boolean => {
    const flow = annotationFlowRef.current;
    if (!flow.note.trim()) return false;
    setAnnotationNotice({
      tone: 'warning',
      kind: 'kind' in flow ? flow.kind : undefined,
      active: false,
      title: 'Você tem uma nota não salva',
      message: `Salve ou descarte a nota antes de ${destination}.`,
    });
    return true;
  };

  const protectVoicePending = (destination: string): boolean => {
    const flow = voiceFlowRef.current;
    if (!voiceHasPendingWork(flow)) return false;
    const recordingMessage = ['requesting', 'recording', 'stopping'].includes(flow.phase);
    const message = recordingMessage
      ? `Pare a gravação e revise antes de ${destination}.`
      : `Envie ou descarte a gravação antes de ${destination}.`;
    setVoiceGuardMessage(message);
    setFeedback({
      tone: 'warning',
      title: 'Conclua sua nota de voz',
      message,
    });
    return true;
  };

  const toggleEvidence = async (key: CapturedSignalCategory) => {
    const next = evidenceOpen === key ? undefined : key;
    if (next && protectAnnotationDraft('abrir as evidências')) return;
    if (next && protectVoicePending('abrir as evidências')) return;
    if (next && voicePanelOpen) await discardVoice();
    await cancelAnnotation('closed');
    setEvidenceOpen(next);
    await window.voidrCapture.capture.setControlPanel(next ? 'evidence' : 'default');
  };

  const toggleVoiceWithAnnotationCleanup = async () => {
    const flow = voiceFlowRef.current;
    if (flow.phase === 'recording') {
      await stopVoice('user');
      return;
    }
    if (!['idle', 'success', 'unavailable'].includes(flow.phase)) return;
    if (protectAnnotationDraft('gravar uma nota de voz')) return;
    await cancelAnnotation('closed');
    if (voiceVisualFlowRef.current.phase !== 'none') await clearVoiceRegion();
    setEvidenceOpen(undefined);
    setFeedback(undefined);
    await startVoice();
  };

  const finalizeCapture = async () => {
    if (protectAnnotationDraft('finalizar o teste')) return;
    if (protectVoicePending('finalizar o teste')) return;
    await run(async () => {
      await cancelAnnotation('closed');
      const completed = await window.voidrCapture.capture.stopWeb();
      if (
        ['processing', 'ready_for_review'].includes(completed.stage) &&
        completed.context?.scenarioId &&
        completed.context?.cycleId
      ) {
        try {
          await window.voidrCapture.openCycle({
            platformUrl: runtime.platformUrl,
            loopId: completed.context.scenarioId,
            cycleId: completed.context.cycleId,
            destination: 'consolidated',
            agent: 'codex',
          });
        } catch {
          setFeedback({
            tone: 'warning',
            title: 'Captura concluída',
            message: 'As evidências foram salvas, mas a plataforma não abriu automaticamente. Use “Consolidar e resolver” para continuar.',
          });
        }
      }
    });
  };

  const toggleAnnotationPanel = async () => {
    if (annotationActive) {
      await cancelAnnotation(annotationFlowRef.current.phase === 'choosing' ? 'closed' : 'choosing');
      return;
    }
    if (protectVoicePending('adicionar uma nota')) return;
    if (voicePanelOpen) await discardVoice();
    setEvidenceOpen(undefined);
    setAnnotationNotice(undefined);
    transitionAnnotation({ type: 'OPEN' });
    await window.voidrCapture.capture.setControlPanel('annotation');
  };

  const evidenceItems = useMemo(
    () => [
      { key: 'pages', label: 'Páginas', icon: Globe2 },
      { key: 'clicks', label: 'Cliques', icon: MousePointer2 },
      { key: 'requests', label: 'Requisições', icon: Network },
      { key: 'errors', label: 'Erros', icon: Terminal },
      { key: 'notes', label: 'Notas', icon: MessageSquare },
      { key: 'voiceNotes', label: 'Voz', icon: Mic },
    ] as const,
    [],
  );

  return (
    <div className={`capture-shell${activeCapture ? ' capture-shell-active' : ''}${finalizing ? ' capture-shell-finalizing' : ''}${voicePanelOpen && recording && !voiceVisualSelecting ? ' capture-shell-voice' : ''}${noteOpen && recording ? ' capture-shell-note' : ''}${annotationFlow.phase === 'composing' && recording ? ' capture-shell-note-composer' : ''}${evidenceOpen && recording ? ' capture-shell-evidence' : ''}`}>
      <header className="capture-topbar">
        <VoidrBrand />
        <div className="capture-topbar-context">
          {status.context ? (
            <>
              <span className="capture-context-name">{status.context.scenarioName}</span>
              <code>{status.context.cycleNumber ? `Teste #${status.context.cycleNumber}` : status.context.cycleId.slice(0, 8)}</code>
            </>
          ) : (
            <span className="capture-context-name">
              {homeView === 'loops' ? 'Workspace local' : 'Captura local'}
            </span>
          )}
        </div>
        <div className="capture-topbar-status" role="status">
          <StatusDot live={recording} />
          <span>{!activeCapture && homeView === 'loops' ? 'Conectado' : copy.title}</span>
          {recording && <code>{elapsed(status.elapsedMs)}</code>}
        </div>
      </header>

      {!activeCapture && (
        <div className="capture-idle-layout">
          <aside className="capture-sidebar" aria-label="Navegação principal">
            <nav>
              <button
                type="button"
                className={homeView === 'loops' ? 'active' : ''}
                onClick={() => setHomeView('loops')}
              >
                <ListChecks size={15} />
                <span>Loops</span>
              </button>
              <button
                type="button"
                className={homeView === 'capture' ? 'active' : ''}
                onClick={() => setHomeView('capture')}
              >
                <Plus size={15} />
                <span>Nova captura</span>
              </button>
            </nav>
            <div className="capture-sidebar-footer">
              <div className="capture-first-steps">
                <div>
                  <span>Nesta tela</span>
                  <Badge tone="neutral">Loops</Badge>
                </div>
                <strong>Revise por pessoa</strong>
                <p>Escolha um teste para ver feedback, replay e sinais técnicos.</p>
              </div>
              <button type="button" onClick={() => { setHomeView('capture'); setSettingsOpen(true); }}>
                <Settings2 size={14} />
                <span>Configurações</span>
              </button>
            </div>
          </aside>

          {homeView === 'loops' ? (
            <WorkspaceHome
              runtime={runtime}
              busy={busy}
              onStartLoop={startWorkspaceLoop}
              onOpenCycle={(loopId, cycleId) => void window.voidrCapture.openCycle({
                platformUrl: runtime.platformUrl,
                loopId,
                cycleId,
              })}
            />
          ) : (
          <main className="capture-home">
          <section className="capture-intro">
            <div>
              <span className="capture-eyebrow">Voidr Capture</span>
              <h1>Inicie um teste</h1>
              <p>Abra o ambiente, registre o que encontrar e envie tudo para o Loop.</p>
            </div>
            <Badge tone="neutral">Local</Badge>
          </section>

          <Tabs
            ariaLabel="Plataforma da captura"
            value={mode}
            onChange={setMode}
            tabs={[
              { value: 'web', label: 'Web', icon: <Monitor size={14} /> },
              { value: 'mobile', label: 'Android', icon: <Smartphone size={14} /> },
              { value: 'api', label: 'API', icon: <Braces size={14} /> },
            ]}
          />

          {mode === 'web' ? (
            <Panel className="capture-primary-panel" title="Capture uma aplicação Web" subtitle="Use um link emitido pela Voidr ou pelo agente conectado ao seu fluxo.">
              <div className="capture-form">
                <label htmlFor="recording-url">Link da verificação</label>
                <textarea id="recording-url" value={recordingUrl} onChange={(event) => setRecordingUrl(inputValue(event))} placeholder="Cole o link seguro aqui…" rows={2} spellCheck={false} />
                <div className="capture-trust-row">
                  <span><Check size={12} /> Credenciais removidas antes de abrir</span>
                  <span><Check size={12} /> Replay salvo na Voidr</span>
                </div>
                <Button variant="primary" size="lg" icon={busy ? <Loader2 className="spin" size={14} /> : <Play size={14} />} disabled={busy || !recordingUrl.trim()} onClick={prepareAndStart}>Iniciar captura</Button>
              </div>
            </Panel>
          ) : mode === 'mobile' ? (
            <Panel className="capture-primary-panel mobile-flow" title="Capture um app Android" subtitle="Conecte o device, execute a jornada e envie a captura para a verificação.">
              <div className={`mobile-step${selectedDevice ? ' complete' : ' active'}`}>
                <StepNumber number={1} complete={Boolean(selectedDevice)} />
                <div className="mobile-step-content">
                  <div className="mobile-step-heading"><div><strong>Conecte um device</strong><span>Use um device físico ou emulador disponível neste computador.</span></div><Button size="sm" variant="ghost" icon={<RefreshCw size={13} />} onClick={refreshDevices} disabled={busy}>Buscar devices</Button></div>
                  <select aria-label="Device Android" value={selectedDevice} onChange={(event) => { setSelectedDevice(event.currentTarget.value); setMobileAppOpened(false); }}>
                    <option value="">Selecione um device</option>
                    {devices.map((device) => <option key={device.serial} value={device.serial}>{device.model ?? device.serial} · {device.state}</option>)}
                  </select>
                </div>
              </div>
              <div className={`mobile-step${mobileAppOpened ? ' complete' : selectedDevice ? ' active' : ''}`}>
                <StepNumber number={2} complete={mobileAppOpened} />
                <div className="mobile-step-content">
                  <div className="mobile-step-heading"><div><strong>Abra o app</strong><span>Execute a jornada normalmente e finalize a captura dentro do app.</span></div></div>
                  <div className="mobile-inline-action">
                    <label><span>Identificador do app</span><input value={packageName} onChange={(event) => setPackageName(inputValue(event))} placeholder="com.empresa.app" /></label>
                    <Button icon={<Play size={13} />} disabled={!selectedDevice || !packageName.trim() || busy} onClick={() => run(async () => { await window.voidrCapture.mobile.launch({ serial: selectedDevice, packageName }); setMobileAppOpened(true); setFeedback({ tone: 'info', title: 'App aberto', message: 'Execute a jornada e finalize a captura dentro do app.' }); })}>Abrir app</Button>
                  </div>
                </div>
              </div>
              <div className={`mobile-step${sessionId && verificationId ? ' complete' : mobileAppOpened ? ' active' : ''}`}>
                <StepNumber number={3} complete={Boolean(sessionId && verificationId)} />
                <div className="mobile-step-content">
                  <div className="mobile-step-heading"><div><strong>Envie as evidências</strong><span>Selecione a captura finalizada e a verificação que receberá o contexto.</span></div><div className="button-row"><Button size="sm" variant="ghost" icon={<Activity size={13} />} disabled={!selectedDevice || busy} onClick={discoverSessions}>Buscar capturas</Button><Button size="sm" variant="ghost" icon={<RefreshCw size={13} />} onClick={loadMobileLoops} disabled={busy}>Atualizar verificações</Button></div></div>
                  <div className="mobile-select-grid">
                    <label><span>Captura do app</span><select value={sessionId} onChange={(event) => setSessionId(event.currentTarget.value)}><option value="">Selecione a captura</option>{sessionIds.map((id) => <option key={id} value={id}>{id}</option>)}</select></label>
                    <label><span>Teste do Loop</span><select value={verificationId} onChange={(event) => setVerificationId(event.currentTarget.value)}><option value="">Selecione o teste</option>{mobileLoops.map((item) => { const id = String(item.verificationId ?? item.id ?? ''); return <option key={id} value={id}>{String(item.mission ?? item.name ?? 'Teste mobile')} · {id.slice(0, 8)}</option>; })}</select></label>
                  </div>
                  <div className="mobile-step-actions">
                    <Button variant="primary" icon={busy ? <Loader2 className="spin" size={14} /> : <Link2 size={14} />} disabled={busy || !verificationId || !sessionId} onClick={attachMobile}>Enviar para a Voidr</Button>
                    {mobileContext && <Button variant="ghost" icon={<ExternalLink size={13} />} onClick={() => void window.voidrCapture.openCycle({ platformUrl: runtime.platformUrl, ...mobileContext })}>Revisar na Voidr</Button>}
                  </div>
                </div>
              </div>
            </Panel>
          ) : (
            <Panel
              className="capture-primary-panel"
              title="Capture uma API"
              subtitle="Abra um teste de API pela Voidr para receber o endpoint aqui."
            >
              <div className="capture-form">
                <label>Endpoint da verificação</label>
                <input
                  value={launchResolution?.surface === 'api' ? launchResolution.targetUrl : ''}
                  readOnly
                  placeholder="Abra um teste de API na Voidr"
                />
                <div className="capture-trust-row">
                  <span><Check size={12} /> Headers sensíveis redigidos</span>
                  <span><Check size={12} /> Bodies persistidos por referência</span>
                </div>
                <Button variant="primary" size="lg" icon={<Network size={14} />} disabled>
                  Captura de API em breve
                </Button>
                <p className="capture-inline-note">
                  A captura de API ainda não está disponível nesta versão do app.
                </p>
              </div>
            </Panel>
          )}

          <section className="capture-utility-row">
            <button onClick={() => run(async () => setDoctor(await window.voidrCapture.doctor(runtime)))} disabled={busy}><Wrench size={13} /> Verificar ambiente</button>
            <button onClick={() => setSettingsOpen((value) => !value)}><Settings2 size={13} /> Configuração avançada</button>
          </section>
          {doctor && <DoctorPanel result={doctor} />}
          {settingsOpen && <RuntimeSettings runtime={runtime} onChange={setRuntime} />}
          </main>
          )}
        </div>
      )}

      {activeCapture && (
        <footer className="capture-dock">
          <div className="dock-state">
            {finalizing ? <VoidrMark size={30} active /> : <StatusDot live={recording} />}
            {recording && annotationNotice ? (
              <div className={`annotation-notice tone-${annotationNotice.tone}`} aria-live="polite">
                <strong>
                  {annotationNotice.active && <Loader2 className="spin" size={12} />}
                  {!annotationNotice.active && annotationNotice.tone === 'success' && <Check size={12} />}
                  {annotationNotice.title}
                </strong>
                {annotationNotice.message && <span>{annotationNotice.message}</span>}
              </div>
            ) : recording && cycleParticipant && participantLabel ? (
              <>
                <span className="capture-participant-avatar" aria-hidden="true">
                  {cycleParticipant.name.trim().charAt(0).toLocaleUpperCase()}
                  {cycleParticipant.picture && (
                    <img
                      src={cycleParticipant.picture}
                      alt=""
                      referrerPolicy="no-referrer"
                      onError={(event) => {
                        event.currentTarget.style.display = 'none';
                      }}
                    />
                  )}
                </span>
                <div aria-label={`Teste de ${participantLabel}`}>
                  <strong title={participantLabel}>{participantLabel}</strong>
                  <span>
                    {status.context?.cycleNumber ? `Teste #${status.context.cycleNumber} · ` : ''}
                    {status.context?.scenarioName}
                  </span>
                </div>
              </>
            ) : (
              <div><strong>{copy.title}</strong><span>{dockDetail}</span></div>
            )}
          </div>
          {recording && (
            <div className="dock-signals" aria-label="Evidências capturadas">
              {evidenceItems.map(({ key, label, icon: Icon }) => (
                <button
                  key={key}
                  type="button"
                  title={`Ver ${label.toLowerCase()}`}
                  className={evidenceOpen === key ? 'active' : ''}
                  aria-expanded={evidenceOpen === key}
                  onClick={() => void toggleEvidence(key)}
                >
                  <Icon size={12} /><b>{status.evidence[key]}</b>
                </button>
              ))}
            </div>
          )}
          <div className="dock-actions">
            {status.stage === 'ready' && <Button size="sm" variant="primary" icon={<Play size={13} />} disabled={busy} onClick={() => run(async () => { await window.voidrCapture.capture.startWeb(); })}>Iniciar captura</Button>}
            {recording && <Button data-annotation-trigger size="sm" variant={annotationFlow.phase === 'selecting' ? 'secondary' : annotationActive ? 'primary' : 'secondary'} icon={annotationFlow.phase === 'selecting' ? <X size={13} /> : <MessageSquare size={13} />} disabled={busy} onClick={() => void toggleAnnotationPanel()}>{annotationFlow.phase === 'selecting' ? 'Cancelar seleção' : 'Nota'}</Button>}
            {recording && <Button size="sm" variant={voiceFlow.phase === 'recording' ? 'danger' : 'secondary'} icon={voiceFlow.phase === 'recording' ? <Square size={12} /> : <Mic size={13} />} disabled={busy || ['requesting', 'stopping', 'sending'].includes(voiceFlow.phase)} onClick={() => void toggleVoiceWithAnnotationCleanup()}>{voiceFlow.phase === 'recording' ? 'Parar' : 'Voz'}</Button>}
            {recording && <Button size="sm" variant="primary" icon={<Square size={12} />} disabled={busy} onClick={() => void finalizeCapture()}>Finalizar</Button>}
            {status.stage === 'recoverable_error' && <Button size="sm" variant="primary" icon={<RefreshCw size={13} />} disabled={busy} onClick={() => run(async () => { await window.voidrCapture.capture.stopWeb(); })}>Tentar novamente</Button>}
            {['processing', 'ready_for_review'].includes(status.stage) && status.context && <Button size="sm" variant="primary" icon={<ExternalLink size={13} />} onClick={() => void window.voidrCapture.openCycle({ platformUrl: runtime.platformUrl, loopId: status.context!.scenarioId, cycleId: status.context!.cycleId, destination: 'consolidated', agent: 'codex' })}>Consolidar e resolver</Button>}
            {status.stage === 'ready_for_review' && <Button size="sm" variant="ghost" icon={<RotateCcw size={13} />} onClick={() => run(async () => { await window.voidrCapture.capture.reset(); })}>Nova captura</Button>}
          </div>
          {noteOpen && recording && (
            <section className={`dock-note${annotationFlow.phase === 'composing' ? ' dock-note-composer' : ''}`} role="dialog" aria-modal="false" aria-labelledby="annotation-title">
              {annotationFlow.phase === 'composing' && currentAnnotationKind ? (
                <>
                  <header>
                    <div>
                      <span className="annotation-kicker">
                        {currentAnnotationKind === 'element'
                          ? 'Nota em elemento'
                          : currentAnnotationKind === 'region'
                            ? 'Nota em região'
                            : 'Nota na tela'}
                      </span>
                      <strong id="annotation-title">O que deve ser investigado?</strong>
                    </div>
                    <div className="annotation-header-actions">
                      <button type="button" aria-label="Voltar para os tipos de nota" title="Voltar" onClick={() => void cancelAnnotation('choosing')}><ArrowLeft size={13} /></button>
                      <button type="button" aria-label="Descartar anotação" title="Descartar" onClick={() => void cancelAnnotation('closed')}><X size={13} /></button>
                    </div>
                  </header>
                  <textarea
                    autoFocus
                    maxLength={1000}
                    value={note}
                    onChange={(event) => transitionAnnotation({ type: 'CHANGE_NOTE', note: inputValue(event) })}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && !event.shiftKey && note.trim()) {
                        event.preventDefault();
                        void saveAnnotation();
                      }
                    }}
                    placeholder="Ex.: depois do retry, o botão continua desabilitado"
                  />
                  <div className="annotation-composer-actions">
                    <span>Inclua esperado × observado quando ajudar · Enter salva</span>
                    <Button size="sm" variant="primary" disabled={busy || !note.trim()} onClick={() => void saveAnnotation()}>
                      Salvar anotação
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <header>
                    <div>
                      <span className="annotation-kicker">Adicionar nota</span>
                      <strong id="annotation-title">Onde está o problema?</strong>
                    </div>
                    <button type="button" aria-label="Fechar" onClick={() => void cancelAnnotation()}><X size={13} /></button>
                  </header>
                  <div className="annotation-capture-row">
                    <button type="button" className="annotation-action" disabled={busy} onClick={() => void beginAnnotation('element')}>
                      <MousePointer2 size={14} />
                      <span><strong>Elemento</strong><small>Selecione algo na tela</small></span>
                    </button>
                    <button type="button" className="annotation-action" disabled={busy} onClick={() => void beginAnnotation('region')}>
                      <Maximize2 size={14} />
                      <span><strong>Região</strong><small>Arraste sobre uma área</small></span>
                    </button>
                    <button type="button" className="annotation-action" disabled={busy} onClick={() => void beginAnnotation('screen')}>
                      <Camera size={14} />
                      <span><strong>Tela</strong><small>Capture o viewport atual</small></span>
                    </button>
                  </div>
                </>
              )}
            </section>
          )}
          {voicePanelOpen && recording && !voiceVisualSelecting && (
            <VoicePanel
              flow={voiceFlow}
              visualFlow={voiceVisualFlow}
              previewUrl={voiceDraftRef.current?.previewUrl}
              elapsedMs={voiceElapsedMs}
              level={voiceLevel}
              notice={voiceGuardMessage}
              onCancelRequest={cancelVoiceRequest}
              onStop={() => void stopVoice('user')}
              onRetake={() => void retakeVoice()}
              onSelectRegion={() => void selectVoiceRegion()}
              onClearRegion={() => void clearVoiceRegion()}
              onDiscard={() => void discardVoice()}
              onSend={() => void sendVoice()}
              onClose={() => void discardVoice()}
            />
          )}
          {evidenceOpen && recording && (
            <EvidenceInspector
              category={evidenceOpen}
              label={evidenceItems.find((item) => item.key === evidenceOpen)?.label ?? 'Evidências'}
              signals={(status.recentSignals ?? []).filter((signal) => signal.category === evidenceOpen)}
              total={status.evidence[evidenceOpen]}
              onClose={() => { setEvidenceOpen(undefined); void window.voidrCapture.capture.setControlPanel('default'); }}
            />
          )}
          {finalizing && <FinalizationProgress stage={status.stage} agentName={agentName} elapsedMs={finalizationElapsedMs} />}
        </footer>
      )}

      {feedback && !activeCapture && <Toast {...feedback} onClose={() => setFeedback(undefined)} />}
    </div>
  );
}

function VoicePanel({
  flow,
  visualFlow,
  previewUrl,
  elapsedMs,
  level,
  notice,
  onCancelRequest,
  onStop,
  onRetake,
  onSelectRegion,
  onClearRegion,
  onDiscard,
  onSend,
  onClose,
}: {
  flow: VoiceFlow;
  visualFlow: VoiceVisualFlow;
  previewUrl?: string;
  elapsedMs: number;
  level: number;
  notice: string;
  onCancelRequest: () => void;
  onStop: () => void;
  onRetake: () => void;
  onSelectRegion: () => void;
  onClearRegion: () => void;
  onDiscard: () => void;
  onSend: () => void;
  onClose: () => void;
}) {
  const draftFlow = ['reviewing', 'sending', 'error'].includes(flow.phase)
    ? flow as Extract<VoiceFlow, { phase: 'reviewing' | 'sending' | 'error' }>
    : undefined;
  const hasVisual = voiceVisualHasSelection(visualFlow);
  const visualLocked = flow.phase === 'sending' || (
    flow.phase === 'error' && flow.sendAttempted
  );
  return (
    <section className={`dock-voice phase-${flow.phase}`} role="dialog" aria-modal="false" aria-labelledby="voice-title">
      {flow.phase === 'requesting' && (
        <>
          <div className="voice-state-icon"><Loader2 className="spin" size={16} /></div>
          <div className="voice-copy">
            <span>Nota de voz</span>
            <strong id="voice-title">Preparando o microfone…</strong>
            <small>Se o sistema pedir acesso, escolha Permitir.</small>
          </div>
          <Button size="sm" variant="ghost" onClick={onCancelRequest}>Cancelar</Button>
        </>
      )}
      {flow.phase === 'recording' && (
        <>
          <div className="voice-live-dot" aria-hidden="true" />
          <div className="voice-copy">
            <span>Nota de voz</span>
            <strong id="voice-title">Gravando</strong>
            <small>Explique o que aconteceu. Depois, você poderá selecionar uma área.</small>
          </div>
          <div className="voice-meter" aria-label="Nível do microfone">
            <i style={{ width: `${Math.max(3, Math.round(level * 100))}%` }} />
          </div>
          <code>{elapsed(elapsedMs)} / 02:00</code>
          <Button size="sm" variant="danger" icon={<Square size={11} />} onClick={onStop}>Parar</Button>
          <small className="voice-shortcut">Esc também para</small>
        </>
      )}
      {flow.phase === 'stopping' && (
        <>
          <div className="voice-state-icon"><Loader2 className="spin" size={16} /></div>
          <div className="voice-copy">
            <span>Nota de voz</span>
            <strong id="voice-title">Preparando para revisar…</strong>
            <small>Sua gravação continua somente neste computador.</small>
          </div>
        </>
      )}
      {draftFlow && (
        <>
          <header>
            <div>
              <span>Nota de voz · {elapsed(draftFlow.durationMs)}</span>
              <strong id="voice-title">
                {flow.phase === 'sending'
                  ? 'Adicionando ao teste…'
                  : flow.phase === 'error'
                    ? draftFlow.canSend ? 'Não foi possível adicionar' : 'Grave um pouco mais'
                    : 'Ouça antes de adicionar'}
              </strong>
            </div>
            <button type="button" aria-label="Descartar gravação" title="Descartar" disabled={flow.phase === 'sending'} onClick={onDiscard}><X size={13} /></button>
          </header>
          {previewUrl && <audio controls preload="metadata" src={previewUrl} aria-label="Revisar nota de voz" />}
          <div className={`voice-visual-context${hasVisual ? ' selected' : ''}`}>
            <span className="voice-visual-icon" aria-hidden="true">
              {hasVisual ? <Check size={13} /> : <Maximize2 size={13} />}
            </span>
            <div>
              <strong>{hasVisual ? 'Área selecionada' : 'Área da tela (opcional)'}</strong>
              <small>
                {hasVisual
                  ? visualLocked
                    ? 'O mesmo recorte será reutilizado na nova tentativa.'
                    : visualFlow.phase === 'error'
                    ? 'A seleção anterior foi preservada.'
                    : 'O recorte será enviado junto com esta voz.'
                  : visualLocked
                    ? 'O reenvio repetirá o comentário sem uma área.'
                    : 'Mostre exatamente onde este comentário se aplica.'}
              </small>
            </div>
            <Button
              size="sm"
              variant="secondary"
              disabled={visualLocked || !draftFlow.canSend}
              onClick={onSelectRegion}
            >
              {visualLocked
                ? hasVisual ? 'Vinculada' : 'Sem área'
                : hasVisual
                  ? 'Alterar'
                  : visualFlow.phase === 'error' ? 'Tentar novamente' : 'Selecionar área'}
            </Button>
            {hasVisual && (
              <button
                type="button"
                className="voice-visual-remove"
                aria-label="Remover área selecionada"
                title="Remover área"
                disabled={visualLocked}
                onClick={onClearRegion}
              >
                <X size={12} />
              </button>
            )}
          </div>
          {flow.phase === 'error' && <p role="alert">{flow.error}</p>}
          {notice && flow.phase !== 'error' && <p className="voice-guard" role="status">{notice}</p>}
          <div className="voice-review-actions">
            <Button
              size="sm"
              variant="secondary"
              disabled={flow.phase === 'sending' || (flow.phase === 'error' && flow.sendAttempted)}
              onClick={onRetake}
            >
              Gravar novamente
            </Button>
            <span>
              {flow.phase === 'error' && flow.sendAttempted
                ? 'Confirme esta tentativa antes de gravar outra.'
                : 'Só será enviada quando você confirmar.'}
            </span>
            {draftFlow.canSend && (
              <Button
                size="sm"
                variant="primary"
                icon={flow.phase === 'sending' ? <Loader2 className="spin" size={12} /> : <Mic size={12} />}
                disabled={flow.phase === 'sending'}
                onClick={onSend}
              >
                {flow.phase === 'error' ? 'Tentar novamente' : 'Adicionar ao teste'}
              </Button>
            )}
          </div>
        </>
      )}
      {flow.phase === 'unavailable' && (
        <>
          <div className="voice-state-icon tone-error"><Mic size={16} /></div>
          <div className="voice-copy">
            <span>Nota de voz</span>
            <strong id="voice-title">Microfone indisponível</strong>
            <small role="alert">{flow.error}</small>
          </div>
          <Button size="sm" variant="ghost" onClick={onClose}>Fechar</Button>
          <Button size="sm" variant="primary" onClick={onRetake}>Tentar novamente</Button>
        </>
      )}
      {flow.phase === 'success' && (
        <>
          <div className="voice-state-icon tone-success"><CheckCircle2 size={16} /></div>
          <div className="voice-copy voice-success-copy">
            <span>Nota de voz adicionada</span>
            <strong id="voice-title">“{flow.transcript}”</strong>
            <small>A transcrição já faz parte das evidências deste teste.</small>
          </div>
          <Button size="sm" variant="ghost" onClick={onClose}>Fechar</Button>
          <Button size="sm" variant="secondary" onClick={onRetake}>Gravar outra</Button>
        </>
      )}
    </section>
  );
}

function EvidenceInspector({
  category,
  label,
  signals,
  total,
  onClose,
}: {
  category: CapturedSignalCategory;
  label: string;
  signals: CapturedSignal[];
  total: number;
  onClose: () => void;
}) {
  return (
    <section className="dock-evidence" role="dialog" aria-label={`Detalhes de ${label.toLowerCase()}`}>
      <header>
        <div>
          <span>Contexto capturado</span>
          <strong>{label}</strong>
        </div>
        <Badge tone={total ? 'success' : 'neutral'}>{total}</Badge>
        <Button size="sm" variant="ghost" icon={<X size={12} />} onClick={onClose}>Fechar</Button>
      </header>
      <div className="dock-evidence-list">
        {signals.length ? signals.map((signal) => (
          <article key={signal.id} className={`tone-${signal.tone}`}>
            <span className="evidence-time">{elapsed(signal.atMs)}</span>
            <div>
              <strong>{signal.title}</strong>
              {signal.detail && <code>{signal.detail}</code>}
            </div>
          </article>
        )) : (
          <div className="dock-evidence-empty">
            <Activity size={16} />
            <div>
              <strong>Nenhum detalhe nesta captura</strong>
              <span>{category === 'requests' ? 'As próximas requisições aparecerão aqui com método, status e duração.' : 'Continue a jornada; a Voidr adicionará os eventos automaticamente.'}</span>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function FinalizationProgress({
  stage,
  agentName,
  elapsedMs,
}: {
  stage: CaptureStatus['stage'];
  agentName?: string;
  elapsedMs: number;
}) {
  const active = stage === 'stopping' ? 0 : stage === 'sealed' ? 1 : stage === 'attaching' ? 2 : 3;
  const delayed = elapsedMs >= 15_000;
  return (
    <section className="finalization-progress" aria-label="Progresso da finalização" aria-live="polite">
      {finalizationStages.map((item, index) => {
        const current = index === active;
        const title = index === 3 && agentName ? `Entregando ao ${agentName}` : item.title;
        const detail = current && delayed
          ? stage === 'processing'
            ? `Captura segura. ${agentName ? `${agentName} ainda está recebendo o contexto.` : 'A revisão continua em segundo plano.'}`
            : 'A operação continua ativa; nenhuma evidência será descartada.'
          : index === 3 && agentName
            ? 'Microcontexto citado e retomada automática.'
            : item.detail;
        return (
          <div key={item.id} className={`finalization-step${index < active ? ' done' : ''}${current ? ' active' : ''}`}>
            <span className="finalization-marker" aria-hidden="true">
              {index < active ? <Check size={12} /> : current ? <Loader2 className="spin" size={12} /> : index + 1}
            </span>
            <div>
              <strong>{title}</strong>
              <small>{detail}</small>
            </div>
            {current && <code>{elapsed(elapsedMs)}</code>}
          </div>
        );
      })}
    </section>
  );
}

function StepNumber({ number, complete }: { number: number; complete: boolean }) {
  return <span className={`mobile-step-number${complete ? ' complete' : ''}`}>{complete ? <Check size={13} /> : number}</span>;
}

function DoctorPanel({ result }: { result: DoctorResult }) {
  return (
    <Panel className="capture-secondary-panel" title="Diagnóstico do ambiente" subtitle="Verifica as conexões locais sem alterar sua captura.">
      <div className="doctor-list">
        {result.services.map((check: { service: string; ok: boolean; latencyMs: number; detail: string }) => <div key={check.service}><StatusDot /><strong>{check.service}</strong><span>{check.ok ? `${check.latencyMs} ms` : check.detail}</span><Badge tone={check.ok ? 'success' : 'error'}>{check.ok ? 'Pronto' : 'Indisponível'}</Badge></div>)}
        <div><StatusDot /><strong>Android</strong><span>{result.android.message}</span><Badge tone={result.android.available ? 'success' : 'warning'}>{result.android.available ? `${result.android.devices.length} device(s)` : 'Ação necessária'}</Badge></div>
      </div>
    </Panel>
  );
}

function RuntimeSettings({ runtime, onChange }: { runtime: LocalRuntimeConfig; onChange: (value: LocalRuntimeConfig) => void }) {
  const field = (key: keyof LocalRuntimeConfig, label: string) => (
    <label>{label}<input type={key === 'localDevKey' ? 'password' : 'text'} value={String(runtime[key])} onChange={(event) => onChange({ ...runtime, [key]: event.currentTarget.value })} /></label>
  );
  return (
    <Panel className="capture-secondary-panel" title="Configuração avançada" subtitle="Essas credenciais ficam isoladas da aplicação capturada.">
      <div className="runtime-grid">
        {field('serviceUrl', 'Service')}{field('collectorUrl', 'Collector')}{field('collectorScriptUrl', 'Collector script')}{field('platformUrl', 'Platform')}{field('organizationId', 'Organização')}{field('localDevKey', 'Dev key')}
      </div>
    </Panel>
  );
}

export default App;
