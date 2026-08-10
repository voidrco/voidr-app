import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  Braces,
  Camera,
  CheckCircle2,
  Check,
  ExternalLink,
  Globe2,
  Link2,
  Loader2,
  MessageSquare,
  Mic,
  Monitor,
  MousePointer2,
  Network,
  Play,
  RefreshCw,
  RotateCcw,
  Settings2,
  Smartphone,
  Square,
  Terminal,
  Wrench,
} from 'lucide-react';
import {
  redactText,
  type AndroidDevice,
  type CaptureStatus,
  type DesktopCaptureLaunch,
  type DesktopCaptureResolution,
  type LocalRuntimeConfig,
} from '@voidr/capture-contracts';
import { Badge, Button, Panel, StatusDot, Tabs, Toast, VoidrBrand, VoidrMark } from '@voidr/capture-design-system';
import { finalizationStages, stageCopy } from '@voidr/capture-presentation';
import { startAudioCapture, stopAudioCapture, type ActiveAudioCapture } from './audio';

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
  const [note, setNote] = useState('');
  const [annotationKind, setAnnotationKind] = useState<'element' | 'screen'>('element');
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
  const acceptingLaunch = useRef<string | undefined>(undefined);

  const copy = stageCopy[status.stage];
  const activeCapture = ['ready', 'recording', 'stopping', 'sealed', 'attaching', 'processing', 'ready_for_review', 'recoverable_error'].includes(status.stage) && status.platform === 'web';
  const recording = status.stage === 'recording';
  const finalizing = ['stopping', 'sealed', 'attaching', 'processing'].includes(status.stage);
  const agentName = status.context?.harnessName;
  const harnessDeliveryState = status.context?.harnessDeliveryState;
  const dockDetail = feedback?.message
    ?? (status.stage === 'ready_for_review' && agentName && harnessDeliveryState === 'acknowledged'
      ? `${agentName} recebeu o contexto citado e retomou o trabalho.`
      : status.stage === 'ready_for_review' && agentName && harnessDeliveryState === 'failed'
        ? `A captura está pronta, mas o retorno ao ${agentName} precisa ser tentado novamente.`
        : status.stage === 'ready_for_review' && agentName
          ? `A captura está pronta. Aguardando o ${agentName} confirmar o contexto.`
      : status.message ?? copy.detail);

  useEffect(() => {
    const unsubscribe = window.voidrCapture.capture.onStatus(setStatus);
    void window.voidrCapture.capture.status().then((value) => value && setStatus(value));
    return unsubscribe;
  }, []);

  useEffect(() => {
    const accept = async (launch: DesktopCaptureLaunch) => {
      const key = `${launch.loopId}:${launch.cycleId}`;
      if (acceptingLaunch.current === key) return;
      acceptingLaunch.current = key;
      setBusy(true);
      setFeedback({
        tone: 'info',
        title: 'Recebendo a missão',
        message: 'Confirmando aplicação, ambiente e permissões com a Voidr.',
      });
      try {
        const accepted = await window.voidrCapture.capture.acceptLaunch(launch, runtime);
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
          title: 'Missão preparada',
          message:
            accepted.resolution.surface === 'web'
              ? 'Revise a aplicação e clique em Iniciar captura.'
              : accepted.resolution.surface === 'mobile'
                ? 'Conecte o device e execute a jornada no app.'
                : 'Revise o endpoint antes de iniciar o proxy local.',
        });
      } catch (error) {
        setFeedback({
          tone: 'error',
          title: 'Não foi possível abrir a missão',
          message: safeError(error),
        });
      } finally {
        acceptingLaunch.current = undefined;
        setBusy(false);
      }
    };
    const unsubscribe = window.voidrCapture.capture.onLaunch((launch) => void accept(launch));
    void window.voidrCapture.capture.pendingLaunch().then((launch) => {
      if (launch) void accept(launch);
    });
    return unsubscribe;
  }, [runtime]);

  useEffect(() => {
    const { localDevKey: _ephemeralSecret, ...persistableRuntime } = runtime;
    localStorage.setItem('voidr.capture.runtime', JSON.stringify(persistableRuntime));
  }, [runtime]);

  useEffect(() => {
    if (!recording) return;
    const timer = window.setInterval(() => setStatus((current) => ({ ...current, elapsedMs: current.elapsedMs + 500 })), 500);
    return () => window.clearInterval(timer);
  }, [recording]);

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

  const prepareAndStart = () =>
    run(async () => {
      if (!recordingUrl.trim()) throw new Error('Cole o link da verificação.');
      await window.voidrCapture.capture.prepareWeb({ recordingUrl: recordingUrl.trim(), runtime });
      await window.voidrCapture.capture.startWeb();
    });

  const annotate = () =>
    run(async () => {
      if (!note.trim()) throw new Error('Escreva a observação que deve acompanhar a evidência.');
      setFeedback({
        tone: 'info',
        title: annotationKind === 'element' ? 'Selecione o elemento' : 'Capturando a tela',
        message: annotationKind === 'element' ? 'Clique no ponto que precisa de atenção.' : 'A imagem será vinculada ao instante atual.',
      });
      await window.voidrCapture.capture.annotate({ kind: annotationKind, note: note.trim() });
      setNote('');
      setNoteOpen(false);
      setFeedback({ tone: 'success', title: 'Evidência salva', message: 'Nota e imagem foram vinculadas ao momento da captura.' });
    });

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
      { key: 'requests', label: 'Requests', icon: Network },
      { key: 'errors', label: 'Erros', icon: Terminal },
      { key: 'notes', label: 'Notas', icon: MessageSquare },
      { key: 'voiceNotes', label: 'Voz', icon: Mic },
    ] as const,
    [],
  );

  return (
    <div className={`capture-shell${activeCapture ? ' capture-shell-active' : ''}${finalizing ? ' capture-shell-finalizing' : ''}`}>
      <header className="capture-topbar">
        <VoidrBrand />
        <div className="capture-topbar-context">
          {status.context ? (
            <>
              <span className="capture-context-name">{status.context.scenarioName}</span>
              <code>{status.context.cycleNumber ? `Cycle #${status.context.cycleNumber}` : status.context.cycleId.slice(0, 8)}</code>
            </>
          ) : (
            <span className="capture-context-name">Captura local</span>
          )}
        </div>
        <div className="capture-topbar-status" role="status">
          <StatusDot live={recording} />
          <span>{copy.title}</span>
          {recording && <code>{elapsed(status.elapsedMs)}</code>}
        </div>
      </header>

      {!activeCapture && (
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

      {activeCapture && (
        <footer className="capture-dock">
          <div className="dock-state">
            {finalizing ? <VoidrMark size={30} active /> : <StatusDot live={recording} />}
            <div><strong>{copy.title}</strong><span>{dockDetail}</span></div>
          </div>
          {recording && (
            <div className="dock-signals" aria-label="Evidências capturadas">
              {evidenceItems.map(({ key, label, icon: Icon }) => <span key={key} title={label}><Icon size={12} /><b>{status.evidence[key]}</b></span>)}
            </div>
          )}
          <div className="dock-actions">
            {status.stage === 'ready' && <Button size="sm" variant="primary" icon={<Play size={13} />} disabled={busy} onClick={() => run(async () => { await window.voidrCapture.capture.startWeb(); })}>Iniciar captura</Button>}
            {recording && <Button size="sm" variant={noteOpen ? 'primary' : 'secondary'} icon={<MessageSquare size={13} />} onClick={() => setNoteOpen((value) => !value)}>Nota</Button>}
            {recording && <Button size="sm" variant={audio ? 'danger' : 'secondary'} icon={audio ? <Square size={12} /> : <Mic size={13} />} disabled={busy} onClick={toggleVoice}>{audio ? 'Enviar voz' : 'Voz'}</Button>}
            {recording && <Button size="sm" variant="primary" icon={<Square size={12} />} disabled={busy} onClick={() => run(async () => { await window.voidrCapture.capture.stopWeb(); })}>Finalizar</Button>}
            {status.stage === 'recoverable_error' && <Button size="sm" variant="primary" icon={<RefreshCw size={13} />} disabled={busy} onClick={() => run(async () => { await window.voidrCapture.capture.stopWeb(); })}>Tentar novamente</Button>}
            {['processing', 'ready_for_review'].includes(status.stage) && status.context && <Button size="sm" variant="primary" icon={<ExternalLink size={13} />} onClick={() => void window.voidrCapture.openCycle({ platformUrl: runtime.platformUrl, loopId: status.context!.scenarioId, cycleId: status.context!.cycleId })}>Revisar na Voidr</Button>}
            {status.stage === 'ready_for_review' && <Button size="sm" variant="ghost" icon={<RotateCcw size={13} />} onClick={() => run(async () => { await window.voidrCapture.capture.reset(); })}>Nova captura</Button>}
          </div>
          {noteOpen && recording && (
            <div className="dock-note">
              <div className="annotation-tabs">
                <button className={annotationKind === 'element' ? 'active' : ''} onClick={() => setAnnotationKind('element')}><MousePointer2 size={12} /> Elemento</button>
                <button className={annotationKind === 'screen' ? 'active' : ''} onClick={() => setAnnotationKind('screen')}><Camera size={12} /> Tela</button>
              </div>
              <input autoFocus value={note} onChange={(event) => setNote(inputValue(event))} placeholder="O que precisa de atenção?" onKeyDown={(event) => { if (event.key === 'Enter') void annotate(); }} />
              <Button size="sm" variant="primary" disabled={busy || !note.trim()} onClick={annotate}>Salvar</Button>
            </div>
          )}
          {finalizing && <FinalizationProgress stage={status.stage} agentName={agentName} />}
          {transcript && <div className="dock-transcript"><Mic size={12} /><span>{transcript}</span></div>}
        </footer>
      )}

      {feedback && !activeCapture && <Toast {...feedback} onClose={() => setFeedback(undefined)} />}
    </div>
  );
}

function FinalizationProgress({ stage, agentName }: { stage: CaptureStatus['stage']; agentName?: string }) {
  const active = stage === 'stopping' ? 0 : stage === 'sealed' ? 2 : stage === 'attaching' ? 3 : 3;
  const labels = finalizationStages.map((label, index) => index === finalizationStages.length - 1 && agentName ? `Preparando retorno ao ${agentName}` : label);
  return (
    <div className="finalization-progress" aria-label="Progresso da finalização">
      {labels.map((label, index) => (
        <span key={label} className={index < active ? 'done' : index === active ? 'active' : ''}>
          {index < active ? <CheckCircle2 size={11} /> : index === active ? <Loader2 className="spin" size={11} /> : <span className="step-dot" />}
          {label}
        </span>
      ))}
    </div>
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
