import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  Braces,
  Camera,
  CheckCircle2,
  Check,
  ExternalLink,
  Globe2,
  Link2,
  ListChecks,
  Loader2,
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
import { startAudioCapture, stopAudioCapture, type ActiveAudioCapture } from './audio';
import { cycleParticipantLabel } from './cycle-identity';
import { WorkspaceHome } from './WorkspaceHome';

const defaultRuntime: LocalRuntimeConfig = {
  serviceUrl: 'http://127.0.0.1:3000/v1',
  collectorUrl: 'http://localhost:3100',
  collectorScriptUrl: 'http://localhost:8889/dist/recorder.min.js',
  platformUrl: 'http://localhost:3030',
  localAdapter: true,
  localDevKey: 'voidr-verification-local',
  organizationId: 'org_verification_local',
};

const idleStatus: CaptureStatus = {
  stage: 'idle',
  elapsedMs: 0,
  evidence: { pages: 0, clicks: 0, requests: 0, errors: 0, notes: 0, voiceNotes: 0 },
};

type DoctorResult = Awaited<ReturnType<typeof window.voidrCapture.doctor>>;
type MobileVerification = Record<string, unknown>;
type Notice = { tone: 'success' | 'warning' | 'error' | 'info'; title: string; message?: string };
type AnnotationNotice = Notice & { kind: 'element' | 'screen'; active: boolean };

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

function App() {
  const [status, setStatus] = useState<CaptureStatus>(idleStatus);
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
  const [noteOpen, setNoteOpen] = useState(false);
  const [annotationKind, setAnnotationKind] = useState<'element' | 'screen'>();
  const [evidenceOpen, setEvidenceOpen] = useState<CapturedSignalCategory>();
  const [note, setNote] = useState('');
  const [annotationNotice, setAnnotationNotice] = useState<AnnotationNotice>();
  const [audio, setAudio] = useState<ActiveAudioCapture>();
  const [audioStartedAt, setAudioStartedAt] = useState(0);
  const [transcript, setTranscript] = useState('');
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

  const copy = stageCopy[status.stage];
  const activeCapture = ['ready', 'recording', 'stopping', 'sealed', 'attaching', 'processing', 'ready_for_review', 'recoverable_error'].includes(status.stage) && status.platform === 'web';
  const recording = status.stage === 'recording';
  const finalizing = ['stopping', 'sealed', 'attaching', 'processing'].includes(status.stage);
  const cycleParticipant = status.context?.participant ?? launchResolution?.participant;
  const cycleStartedAt = status.context?.cycleStartedAt ?? launchResolution?.cycleStartedAt;
  const participantLabel = cycleParticipantLabel(cycleParticipant, cycleStartedAt);
  const agentName = status.context?.harnessName;
  const harnessDeliveryState = status.context?.harnessDeliveryState;
  const controlPanelMode = noteOpen && recording
    ? annotationKind
      ? 'annotation-composer'
      : 'annotation'
    : evidenceOpen && recording
      ? 'evidence'
      : finalizing
        ? 'finalizing'
        : 'default';
  const dockDetail = feedback?.message
    ?? (status.stage === 'ready_for_review' && agentName && harnessDeliveryState === 'acknowledged'
      ? `${agentName} recebeu o contexto citado e retomou o trabalho.`
      : status.stage === 'ready_for_review' && agentName && harnessDeliveryState === 'failed'
        ? `A captura está pronta, mas o retorno ao ${agentName} precisa ser tentado novamente.`
        : status.stage === 'ready_for_review' && agentName
          ? `A captura está pronta. Aguardando o ${agentName} confirmar o contexto.`
      : status.message ?? copy.detail);

  const acceptLaunch = useCallback(async (launch: DesktopCaptureLaunch) => {
    const key = `${launch.loopId}:${launch.cycleId}`;
    if (acceptingLaunch.current === key) return;
    const launchRuntime = runtime.localAdapter && runtime.organizationId !== launch.organizationId
      ? { ...runtime, organizationId: launch.organizationId }
      : runtime;
    acceptingLaunch.current = key;
    setBusy(true);
    setFeedback({
      tone: 'info',
      title: 'Preparando seu ciclo',
      message: 'Confirmando aplicação, ambiente e permissões com a Voidr.',
    });
    try {
      const accepted = await window.voidrCapture.capture.acceptLaunch(launch, launchRuntime);
      if (launchRuntime !== runtime) setRuntime(launchRuntime);
      setLaunchResolution(accepted.resolution);
      if (accepted.status) setStatus(accepted.status);
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
        title: accepted.status?.stage === 'recording' ? 'Ciclo em andamento' : 'Ciclo preparado',
        message:
          accepted.resolution.surface === 'web'
            ? accepted.status?.stage === 'recording'
              ? 'A captura começou automaticamente e o tempo já está contando.'
              : 'A aplicação está pronta para capturar.'
            : accepted.resolution.surface === 'mobile'
              ? 'Conecte o device e execute a jornada no app.'
              : 'Revise o endpoint antes de iniciar o proxy local.',
      });
    } catch (error) {
      setFeedback({
        tone: 'error',
        title: 'Não foi possível abrir o ciclo',
        message: safeError(error),
      });
    } finally {
      acceptingLaunch.current = undefined;
      setBusy(false);
    }
  }, [runtime]);

  useEffect(() => {
    const unsubscribe = window.voidrCapture.capture.onStatus(setStatus);
    void window.voidrCapture.capture.status().then((value) => value && setStatus(value));
    return unsubscribe;
  }, []);

  useEffect(() => () => {
    if (annotationNoticeTimer.current) window.clearTimeout(annotationNoticeTimer.current);
  }, []);

  useEffect(() => {
    const unsubscribe = window.voidrCapture.capture.onLaunch((launch) => void acceptLaunch(launch));
    void window.voidrCapture.capture.pendingLaunch().then((launch) => {
      if (launch) void acceptLaunch(launch);
    });
    return unsubscribe;
  }, [acceptLaunch]);

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
    setNoteOpen(false);
    setAnnotationKind(undefined);
    setNote('');
    setEvidenceOpen(undefined);
  }, [recording]);

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
        title: 'Não foi possível iniciar o ciclo',
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

  const beginAnnotation = async (kind: 'element' | 'screen') => {
    if (busy) return;
    if (annotationNoticeTimer.current) window.clearTimeout(annotationNoticeTimer.current);
    setEvidenceOpen(undefined);
    setNote('');
    if (kind === 'screen') {
      await window.voidrCapture.capture.clearElementSelection();
      setAnnotationKind('screen');
      setNoteOpen(true);
      setAnnotationNotice(undefined);
      return;
    }

    setBusy(true);
    setNoteOpen(false);
    setAnnotationKind(undefined);
    setAnnotationNotice({
      tone: 'info',
      kind,
      active: true,
      title: 'Selecione um elemento',
      message: 'Clique na aplicação · Esc para cancelar',
    });
    try {
      await window.voidrCapture.capture.setControlPanel('default');
      await window.voidrCapture.capture.selectElement();
      setAnnotationNotice(undefined);
      setAnnotationKind('element');
      setNoteOpen(true);
      await window.voidrCapture.capture.setControlPanel('annotation-composer');
    } catch (error) {
      const message = safeError(error);
      if (message.includes('seleção foi cancelada')) {
        setAnnotationNotice(undefined);
      } else {
        setAnnotationNotice({
          tone: 'error',
          kind,
          active: false,
          title: 'Não foi possível selecionar o elemento',
          message,
        });
        annotationNoticeTimer.current = window.setTimeout(() => setAnnotationNotice(undefined), 6_000);
      }
    } finally {
      setBusy(false);
    }
  };

  const cancelAnnotation = async () => {
    setNoteOpen(false);
    setAnnotationKind(undefined);
    setNote('');
    setAnnotationNotice(undefined);
    await window.voidrCapture.capture.clearElementSelection();
    await window.voidrCapture.capture.setControlPanel('default');
  };

  const saveAnnotation = async () => {
    if (busy || !annotationKind || !note.trim()) return;
    if (annotationNoticeTimer.current) window.clearTimeout(annotationNoticeTimer.current);
    const kind = annotationKind;
    const suppliedNote = note.trim();
    setBusy(true);
    setNoteOpen(false);
    setAnnotationNotice({
      tone: 'info',
      kind,
      active: true,
      title: 'Salvando anotação',
    });
    try {
      await window.voidrCapture.capture.setControlPanel('default');
      await window.voidrCapture.capture.annotate({ kind, note: suppliedNote });
      setAnnotationKind(undefined);
      setNote('');
      setAnnotationNotice({
        tone: 'success',
        kind,
        active: false,
        title: 'Anotação salva',
        message: 'A nota e a captura foram adicionadas ao ciclo.',
      });
      annotationNoticeTimer.current = window.setTimeout(() => setAnnotationNotice(undefined), 2_200);
    } catch (error) {
      setNoteOpen(true);
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
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!noteOpen || !annotationKind) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      void cancelAnnotation();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [noteOpen, annotationKind]);

  const toggleVoice = () =>
    run(async () => {
      if (!audio) {
        const capture = await startAudioCapture();
        setAudio(capture);
        setAudioStartedAt(status.elapsedMs);
        setFeedback({ tone: 'info', title: 'Ouvindo', message: 'Clique novamente em Voz para salvar e transcrever.' });
        return;
      }
      const stoppedAt = Math.max(audioStartedAt + 1, status.elapsedMs);
      const pcmBase64 = await stopAudioCapture(audio);
      setAudio(undefined);
      const result = await window.voidrCapture.capture.voiceSegment({
        startedAtMs: audioStartedAt,
        endedAtMs: stoppedAt,
        pcmBase64,
        language: 'pt-BR',
      });
      setTranscript(result.transcript);
      setFeedback(result.transcript
        ? { tone: 'success', title: 'Nota de voz salva', message: 'A transcrição foi vinculada à captura.' }
        : { tone: 'warning', title: 'Áudio salvo sem transcrição', message: 'A gravação de voz continua disponível nas evidências.' });
    });

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
      setFeedback({ tone: 'info', title: 'Verificações atualizadas', message: `${mobile.length || values.length} ciclo(s) disponível(is).` });
    });

  const attachMobile = () =>
    run(async () => {
      if (!verificationId || !sessionId) throw new Error('Informe o Cycle e a Session nativa.');
      const current = (await window.voidrCapture.mobile.verificationStatus(runtime, verificationId)) as Record<string, unknown>;
      const lifecycleVersion = Number(current.lifecycleVersion);
      if (!Number.isInteger(lifecycleVersion) || lifecycleVersion < 0) throw new Error('O Cycle não retornou lifecycleVersion.');
      await window.voidrCapture.mobile.attachSession({ verificationId, sessionId, lifecycleVersion, runtime });
      const loopId = String(current.loopId ?? current.scenarioId ?? '');
      const cycleId = String(current.cycleId ?? verificationId);
      if (loopId) setMobileContext({ loopId, cycleId });
      setFeedback({ tone: 'success', title: 'Evidências enviadas', message: 'A Voidr está consolidando frames, gestos, rede e logs.' });
    });

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
    <div className={`capture-shell${activeCapture ? ' capture-shell-active' : ''}${finalizing ? ' capture-shell-finalizing' : ''}${noteOpen && recording ? ' capture-shell-note' : ''}${noteOpen && annotationKind && recording ? ' capture-shell-note-composer' : ''}${evidenceOpen && recording ? ' capture-shell-evidence' : ''}`}>
      <header className="capture-topbar">
        <VoidrBrand />
        <div className="capture-topbar-context">
          {status.context ? (
            <>
              <span className="capture-context-name">{status.context.scenarioName}</span>
              <code>{status.context.cycleNumber ? `Cycle #${status.context.cycleNumber}` : status.context.cycleId.slice(0, 8)}</code>
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
                  <span>Primeiros passos</span>
                  <Badge tone="neutral">1 de 3</Badge>
                </div>
                <strong>Desktop conectado</strong>
                <p>Selecione um Loop e inicie seu ciclo. A Voidr organiza as evidências automaticamente.</p>
                <span className="capture-setup-progress"><i /></span>
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
              <h1>Comece uma verificação</h1>
              <p>Capture a jornada, marque evidências e entregue contexto completo para análise.</p>
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
                    <label><span>Verificação</span><select value={verificationId} onChange={(event) => setVerificationId(event.currentTarget.value)}><option value="">Selecione a verificação</option>{mobileLoops.map((item) => { const id = String(item.verificationId ?? item.id ?? ''); return <option key={id} value={id}>{String(item.mission ?? item.name ?? 'Verificação mobile')} · {id.slice(0, 8)}</option>; })}</select></label>
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
              subtitle="O Voidr Capture vincula requests e traces diretamente ao Cycle, sem criar replay visual falso."
            >
              <div className="capture-form">
                <label>Endpoint da verificação</label>
                <input
                  value={launchResolution?.surface === 'api' ? launchResolution.targetUrl : ''}
                  readOnly
                  placeholder="Abra um Cycle de API pelo Voidr ou pelo harness"
                />
                <div className="capture-trust-row">
                  <span><Check size={12} /> Headers sensíveis redigidos</span>
                  <span><Check size={12} /> Bodies persistidos por referência</span>
                </div>
                <Button variant="primary" size="lg" icon={<Network size={14} />} disabled>
                  Proxy local em preparação
                </Button>
                <p className="capture-inline-note">
                  O Cycle já foi entregue ao app. A interceptação HTTP/HTTPS permanece indisponível até o adapter de proxy e a gestão de CA passarem pelo gate de segurança.
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
                <div aria-label={`Ciclo de ${participantLabel}`}>
                  <strong title={participantLabel}>{participantLabel}</strong>
                  <span>
                    {status.context?.cycleNumber ? `Cycle #${status.context.cycleNumber} · ` : ''}
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
                  onClick={() => {
                    const next = evidenceOpen === key ? undefined : key;
                    setNoteOpen(false);
                    setAnnotationKind(undefined);
                    setNote('');
                    void window.voidrCapture.capture.clearElementSelection();
                    setEvidenceOpen(next);
                    void window.voidrCapture.capture.setControlPanel(next ? 'evidence' : 'default');
                  }}
                >
                  <Icon size={12} /><b>{status.evidence[key]}</b>
                </button>
              ))}
            </div>
          )}
          <div className="dock-actions">
            {status.stage === 'ready' && <Button size="sm" variant="primary" icon={<Play size={13} />} disabled={busy} onClick={() => run(async () => { await window.voidrCapture.capture.startWeb(); })}>Iniciar captura</Button>}
            {recording && <Button size="sm" variant={noteOpen ? 'primary' : 'secondary'} icon={<MessageSquare size={13} />} disabled={busy} onClick={() => { if (noteOpen) { void cancelAnnotation(); return; } setEvidenceOpen(undefined); setAnnotationKind(undefined); setNote(''); setNoteOpen(true); void window.voidrCapture.capture.setControlPanel('annotation'); }}>Nota</Button>}
            {recording && <Button size="sm" variant={audio ? 'danger' : 'secondary'} icon={audio ? <Square size={12} /> : <Mic size={13} />} disabled={busy} onClick={toggleVoice}>{audio ? 'Enviar voz' : 'Voz'}</Button>}
            {recording && <Button size="sm" variant="primary" icon={<Square size={12} />} disabled={busy} onClick={() => run(async () => { await window.voidrCapture.capture.stopWeb(); })}>Finalizar</Button>}
            {status.stage === 'recoverable_error' && <Button size="sm" variant="primary" icon={<RefreshCw size={13} />} disabled={busy} onClick={() => run(async () => { await window.voidrCapture.capture.stopWeb(); })}>Tentar novamente</Button>}
            {['processing', 'ready_for_review'].includes(status.stage) && status.context && <Button size="sm" variant="primary" icon={<ExternalLink size={13} />} onClick={() => void window.voidrCapture.openCycle({ platformUrl: runtime.platformUrl, loopId: status.context!.scenarioId, cycleId: status.context!.cycleId })}>Revisar na Voidr</Button>}
            {status.stage === 'ready_for_review' && <Button size="sm" variant="ghost" icon={<RotateCcw size={13} />} onClick={() => run(async () => { await window.voidrCapture.capture.reset(); })}>Nova captura</Button>}
          </div>
          {noteOpen && recording && (
            <section className={`dock-note${annotationKind ? ' dock-note-composer' : ''}`} role="dialog" aria-modal="true" aria-labelledby="annotation-title">
              {annotationKind ? (
                <>
                  <header>
                    <div>
                      <span className="annotation-kicker">{annotationKind === 'element' ? 'Nota em elemento' : 'Nota na tela'}</span>
                      <strong id="annotation-title">O que deve ser investigado?</strong>
                    </div>
                    <button type="button" aria-label="Cancelar anotação" onClick={() => void cancelAnnotation()}><X size={13} /></button>
                  </header>
                  <textarea
                    autoFocus
                    maxLength={1000}
                    value={note}
                    onChange={(event) => setNote(inputValue(event))}
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
                    <button type="button" className="annotation-action" disabled={busy} onClick={() => void beginAnnotation('screen')}>
                      <Camera size={14} />
                      <span><strong>Tela</strong><small>Capture o viewport atual</small></span>
                    </button>
                  </div>
                </>
              )}
            </section>
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
          {transcript && <div className="dock-transcript"><Mic size={12} /><span>{transcript}</span></div>}
        </footer>
      )}

      {feedback && !activeCapture && <Toast {...feedback} onClose={() => setFeedback(undefined)} />}
    </div>
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
