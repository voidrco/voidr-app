import { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertCircle,
  Braces,
  ChevronRight,
  Clock3,
  ExternalLink,
  FileText,
  Globe2,
  Image,
  Loader2,
  MessageSquare,
  MonitorPlay,
  Network,
  Play,
  RefreshCw,
  Search,
  Smartphone,
  Terminal,
} from 'lucide-react';
import type {
  DesktopLoopCycleDetail,
  DesktopLoopCycleSummary,
  DesktopLoopEvidenceItem,
  DesktopLoopEvidenceKind,
  DesktopLoopSummary,
  LocalRuntimeConfig,
} from '@voidr/capture-contracts';
import { Badge, Button, StatusDot } from '@voidr/capture-design-system';
import { loadWorkspaceCycleDetail } from './workspace-cycle-recovery';

type WorkspaceHomeProps = {
  runtime: LocalRuntimeConfig;
  busy: boolean;
  onStartLoop: (loopId: string) => Promise<void>;
  onOpenCycle: (loopId: string, cycleId: string) => void;
};

type EvidenceFilter = 'highlights' | 'all' | 'issues';

const statusCopy: Record<string, { label: string; tone: 'neutral' | 'success' | 'warning' | 'error' }> = {
  recording: { label: 'Em teste', tone: 'warning' },
  processing: { label: 'Processando', tone: 'neutral' },
  ready: { label: 'Pronto para revisar', tone: 'success' },
  decision_required: { label: 'Pronto para revisar', tone: 'success' },
  fix_proposed: { label: 'Correção proposta', tone: 'warning' },
  awaiting_retest: { label: 'Aguardando reteste', tone: 'warning' },
  confirmed: { label: 'Validado', tone: 'success' },
  attention: { label: 'Precisa de atenção', tone: 'error' },
};

function copyForStatus(status: string) {
  return statusCopy[status] ?? {
    label: status.replaceAll('_', ' ').replace(/^./, (value) => value.toUpperCase()),
    tone: 'neutral' as const,
  };
}

function relativeTime(value: string | null): string {
  if (!value) return 'sem atividade recente';
  const delta = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(delta) || delta < 0) return 'agora';
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return 'agora';
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `há ${hours} h`;
  const days = Math.floor(hours / 24);
  return `há ${days} d`;
}

function duration(value: number): string {
  if (!value) return '—';
  const seconds = Math.round(value / 1_000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function ApplicationIcon({ type }: { type: DesktopLoopSummary['applicationType'] }) {
  if (type === 'MOBILE') return <Smartphone size={15} />;
  if (type === 'API') return <Braces size={15} />;
  return <Globe2 size={15} />;
}

function ParticipantIdentity({ cycle }: { cycle: DesktopLoopCycleSummary }) {
  const name = cycle.participant ?? 'Participante não registrado';
  const initial = name.trim().charAt(0).toLocaleUpperCase() || '?';
  return (
    <span className="workspace-participant">
      <span className="workspace-participant-avatar" aria-hidden="true">
        {initial}
        {cycle.participantAvatarUrl && (
          <img
            src={cycle.participantAvatarUrl}
            alt=""
            referrerPolicy="no-referrer"
            onError={(event) => {
              event.currentTarget.style.display = 'none';
            }}
          />
        )}
      </span>
      <span>{cycle.participantRole ? `${name} · ${cycle.participantRole}` : name}</span>
    </span>
  );
}

function EvidenceIcon({ kind }: { kind: DesktopLoopEvidenceKind }) {
  if (kind === 'replay') return <MonitorPlay size={14} />;
  if (kind === 'annotation') return <MessageSquare size={14} />;
  if (kind === 'screenshot') return <Image size={14} />;
  if (kind === 'network') return <Network size={14} />;
  if (kind === 'console') return <Terminal size={14} />;
  if (kind === 'transcript') return <FileText size={14} />;
  return <Activity size={14} />;
}

function filterEvidence(item: DesktopLoopEvidenceItem, filter: EvidenceFilter): boolean {
  if (filter === 'highlights') {
    return (
      ['replay', 'annotation', 'transcript', 'screenshot'].includes(item.kind) ||
      item.tone === 'error'
    );
  }
  if (filter === 'issues') return item.tone === 'error' || ['console', 'network'].includes(item.kind);
  return true;
}

export function WorkspaceHome({ runtime, busy, onStartLoop, onOpenCycle }: WorkspaceHomeProps) {
  const [loops, setLoops] = useState<DesktopLoopSummary[]>([]);
  const [cycles, setCycles] = useState<DesktopLoopCycleSummary[]>([]);
  const [detail, setDetail] = useState<DesktopLoopCycleDetail>();
  const [selectedLoopId, setSelectedLoopId] = useState('');
  const [selectedCycleId, setSelectedCycleId] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<EvidenceFilter>('highlights');
  const [loading, setLoading] = useState(true);
  const [loadingCycles, setLoadingCycles] = useState(false);
  const [error, setError] = useState('');
  const [refreshVersion, setRefreshVersion] = useState(0);

  useEffect(() => {
    let active = true;
    const load = async (quiet = false) => {
      if (!quiet) setLoading(true);
      try {
        const values = await window.voidrCapture.workspace.listLoops(runtime);
        if (!active) return;
        setLoops(values);
        setSelectedLoopId((current) =>
          values.some((item) => item.id === current) ? current : (values[0]?.id ?? ''),
        );
        setError('');
      } catch {
        if (!active) return;
        setError('Não foi possível carregar seus Loops. Verifique a conexão e tente novamente.');
      } finally {
        if (active && !quiet) setLoading(false);
      }
    };
    void load();
    const timer = window.setInterval(() => void load(true), 15_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [runtime, refreshVersion]);

  useEffect(() => {
    if (!selectedLoopId) {
      setCycles([]);
      setSelectedCycleId('');
      return;
    }
    let active = true;
    setLoadingCycles(true);
    void window.voidrCapture.workspace
      .listCycles(runtime, selectedLoopId)
      .then((values) => {
        if (!active) return;
        setCycles(values);
        setSelectedCycleId((current) =>
          values.some((item) => item.id === current) ? current : (values[0]?.id ?? ''),
        );
      })
      .catch(() => {
        if (active) setError('Não foi possível atualizar os ciclos deste Loop.');
      })
      .finally(() => {
        if (active) setLoadingCycles(false);
      });
    return () => {
      active = false;
    };
  }, [runtime, selectedLoopId, refreshVersion]);

  useEffect(() => {
    if (!selectedLoopId || !selectedCycleId) {
      setDetail(undefined);
      return;
    }
    let active = true;
    setDetail(undefined);
    void loadWorkspaceCycleDetail({
      cycleId: selectedCycleId,
      getCycle: () =>
        window.voidrCapture.workspace.getCycle(runtime, selectedLoopId, selectedCycleId),
      listCycles: () => window.voidrCapture.workspace.listCycles(runtime, selectedLoopId),
    }).then((result) => {
      if (!active) return;
      if ('cycles' in result && result.cycles) setCycles(result.cycles);
      if (result.state === 'loaded') {
        setDetail(result.detail);
        setError('');
        return;
      }
      if (result.state === 'selection_changed') {
        setSelectedCycleId(result.selectedCycleId);
        setError('');
        return;
      }
      setError(
        result.state === 'temporarily_unavailable'
          ? 'As evidências deste ciclo ainda estão sendo sincronizadas. Tente atualizar em instantes.'
          : 'Não foi possível carregar as evidências deste ciclo. Tente novamente.',
      );
    });
    return () => {
      active = false;
    };
  }, [runtime, selectedLoopId, selectedCycleId, refreshVersion]);

  const visibleLoops = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase('pt-BR');
    if (!normalized) return loops;
    return loops.filter((loop) =>
      `${loop.name} ${loop.environment} ${loop.applicationType}`.toLocaleLowerCase('pt-BR').includes(normalized),
    );
  }, [loops, query]);
  const selectedLoop = loops.find((item) => item.id === selectedLoopId);
  const selectedCycle = cycles.find((item) => item.id === selectedCycleId);
  const evidence = (detail?.evidence ?? []).filter((item) => filterEvidence(item, filter));

  return (
    <main className="workspace-home">
      <header className="workspace-heading">
        <div>
          <span className="capture-eyebrow">Workspace de testes</span>
          <h1>Loops</h1>
          <p>Acompanhe os ciclos da equipe e retome um teste sem perder contexto.</p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          icon={<RefreshCw size={13} />}
          onClick={() => setRefreshVersion((value) => value + 1)}
          disabled={loading}
        >
          Atualizar
        </Button>
      </header>

      {error && (
        <div className="workspace-error" role="alert">
          <AlertCircle size={15} />
          <span>{error}</span>
          <button type="button" onClick={() => setRefreshVersion((value) => value + 1)}>Tentar novamente</button>
        </div>
      )}

      <section className="workspace-surface">
        <aside className="workspace-loop-pane" aria-label="Loops disponíveis">
          <div className="workspace-search">
            <Search size={14} />
            <input
              aria-label="Buscar Loops"
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder="Buscar Loops"
            />
          </div>
          <div className="workspace-pane-label">
            <span>{visibleLoops.length} {visibleLoops.length === 1 ? 'Loop' : 'Loops'}</span>
            <span>Atividade</span>
          </div>
          <div className="workspace-loop-list">
            {loading ? (
              <div className="workspace-loading"><Loader2 className="spin" size={16} /> Carregando Loops…</div>
            ) : visibleLoops.length ? (
              visibleLoops.map((loop) => {
                const status = copyForStatus(loop.latestCycle?.status ?? loop.status);
                return (
                  <button
                    key={loop.id}
                    type="button"
                    className={`workspace-loop-row${selectedLoopId === loop.id ? ' active' : ''}`}
                    onClick={() => setSelectedLoopId(loop.id)}
                  >
                    <span className="workspace-app-icon"><ApplicationIcon type={loop.applicationType} /></span>
                    <span className="workspace-loop-copy">
                      <strong>{loop.name}</strong>
                      <small>{loop.environment} · {loop.cycleCount} {loop.cycleCount === 1 ? 'ciclo' : 'ciclos'}</small>
                    </span>
                    <span className="workspace-loop-state">
                      <StatusDot live={status.tone === 'warning'} />
                      <small>{relativeTime(loop.updatedAt)}</small>
                    </span>
                    <ChevronRight size={13} />
                  </button>
                );
              })
            ) : (
              <div className="workspace-empty">
                <Globe2 size={18} />
                <strong>{loops.length ? 'Nenhum Loop encontrado' : 'Seu primeiro Loop aparece aqui'}</strong>
                <span>{loops.length ? 'Tente buscar por outro nome ou ambiente.' : 'Crie um Loop na interface Web e volte para iniciar o teste.'}</span>
              </div>
            )}
          </div>
        </aside>

        <section className="workspace-detail">
          {selectedLoop ? (
            <>
              <header className="workspace-detail-header">
                <div className="workspace-detail-title">
                  <span className="workspace-app-icon"><ApplicationIcon type={selectedLoop.applicationType} /></span>
                  <div>
                    <h2>{selectedLoop.name}</h2>
                    <span>{selectedLoop.environment} · {selectedLoop.applicationType === 'WEB' ? 'Aplicação Web' : selectedLoop.applicationType}</span>
                  </div>
                </div>
                <div className="workspace-detail-actions">
                  {selectedCycle && (
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<ExternalLink size={13} />}
                      onClick={() => onOpenCycle(selectedLoop.id, selectedCycle.id)}
                    >
                      Revisar na Web
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="primary"
                    icon={busy ? <Loader2 className="spin" size={13} /> : <Play size={13} />}
                    onClick={() => void onStartLoop(selectedLoop.id)}
                    disabled={busy}
                  >
                    Iniciar meu ciclo
                  </Button>
                </div>
              </header>

              <div className="workspace-detail-body">
                <aside className="workspace-cycle-pane" aria-label="Ciclos do Loop">
                  <div className="workspace-section-heading">
                    <span>Ciclos</span>
                    <Badge tone="neutral">{cycles.length}</Badge>
                  </div>
                  <div className="workspace-cycle-list">
                    {loadingCycles ? (
                      <div className="workspace-loading"><Loader2 className="spin" size={14} /> Carregando…</div>
                    ) : cycles.length ? cycles.map((cycle) => {
                      const status = copyForStatus(cycle.status);
                      return (
                        <button
                          key={cycle.id}
                          type="button"
                          className={`workspace-cycle-row${cycle.id === selectedCycleId ? ' active' : ''}`}
                          onClick={() => setSelectedCycleId(cycle.id)}
                        >
                          <span className="workspace-cycle-number">{cycle.number}</span>
                          <span>
                            <strong>Ciclo {cycle.number}</strong>
                            <small className="workspace-participant-line"><ParticipantIdentity cycle={cycle} /></small>
                            <small>{relativeTime(cycle.updatedAt)}</small>
                          </span>
                          <Badge tone={status.tone}>{status.label}</Badge>
                        </button>
                      );
                    }) : (
                      <div className="workspace-empty compact"><Clock3 size={16} /><span>Nenhum ciclo iniciado.</span></div>
                    )}
                  </div>
                </aside>

                <section className="workspace-evidence-pane">
                  {selectedCycle ? (
                    <>
                      <div className="workspace-mission">
                        <span>Missão do ciclo</span>
                        <strong>{selectedCycle.mission}</strong>
                        <div>
                          <ParticipantIdentity cycle={selectedCycle} />
                          <span><Clock3 size={12} /> {detail ? duration(detail.durationMs) : 'carregando'}</span>
                        </div>
                      </div>

                      <div className="workspace-metrics" aria-label="Resumo de evidências">
                        <div><strong>{detail?.replayAvailable ? 'Disponível' : '—'}</strong><span>Replay</span></div>
                        <div><strong>{detail?.counts.annotations ?? '—'}</strong><span>Notas</span></div>
                        <div><strong>{detail?.counts.failedRequests ?? '—'}</strong><span>Falhas de rede</span></div>
                        <div><strong>{detail?.counts.consoleErrors ?? '—'}</strong><span>Erros de console</span></div>
                      </div>

                      <div className="workspace-evidence-header">
                        <div>
                          <span>Evidências</span>
                          <Badge tone={detail?.evidence.length ? 'success' : 'neutral'}>{detail?.evidence.length ?? 0}</Badge>
                        </div>
                        <div className="workspace-evidence-filters" role="group" aria-label="Filtrar evidências">
                          {([
                            ['highlights', 'Destaques'],
                            ['all', 'Tudo'],
                            ['issues', 'Falhas'],
                          ] as const).map(([value, label]) => (
                            <button key={value} type="button" className={filter === value ? 'active' : ''} onClick={() => setFilter(value)}>{label}</button>
                          ))}
                        </div>
                      </div>

                      <div className="workspace-evidence-list">
                        {!detail ? (
                          <div className="workspace-loading"><Loader2 className="spin" size={15} /> Consolidando evidências…</div>
                        ) : evidence.length ? evidence.map((item) => (
                          <article key={item.id} className={`tone-${item.tone}`}>
                            <span className="workspace-evidence-icon"><EvidenceIcon kind={item.kind} /></span>
                            <div>
                              <strong>{item.title}</strong>
                              {item.detail && <small>{item.detail}</small>}
                            </div>
                            <code>{item.atMs == null ? 'GERAL' : duration(item.atMs)}</code>
                          </article>
                        )) : (
                          <div className="workspace-empty">
                            <Activity size={18} />
                            <strong>{detail.evidence.length ? 'Nenhuma evidência neste filtro' : 'Evidências ainda não disponíveis'}</strong>
                            <span>{detail.evidence.length ? 'Escolha outro filtro para ver o contexto capturado.' : 'Inicie um ciclo e execute a jornada para alimentar esta timeline.'}</span>
                          </div>
                        )}
                      </div>
                    </>
                  ) : (
                    <div className="workspace-empty centered">
                      <Play size={20} />
                      <strong>Inicie o primeiro ciclo</strong>
                      <span>As evidências e os participantes ficarão organizados aqui.</span>
                      <Button size="sm" variant="primary" onClick={() => void onStartLoop(selectedLoop.id)} disabled={busy}>Iniciar meu ciclo</Button>
                    </div>
                  )}
                </section>
              </div>
            </>
          ) : (
            <div className="workspace-empty centered">
              <Globe2 size={20} />
              <strong>Selecione um Loop</strong>
              <span>O histórico de ciclos e evidências aparece aqui.</span>
            </div>
          )}
        </section>
      </section>
    </main>
  );
}
