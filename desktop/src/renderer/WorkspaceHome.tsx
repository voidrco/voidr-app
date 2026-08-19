import { useEffect, useMemo, useState } from "react";
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
  Search,
  Smartphone,
  Terminal,
} from "lucide-react";
import type {
  DesktopLoopCycleDetail,
  DesktopLoopCycleSummary,
  DesktopLoopEvidenceItem,
  DesktopLoopEvidenceKind,
  DesktopLoopSummary,
  LocalRuntimeConfig,
} from "@voidr/capture-contracts";
import { Badge, Button } from "@voidr/capture-design-system";
import { loadWorkspaceCycleDetail } from "./workspace-cycle-recovery";

type WorkspaceHomeProps = {
  runtime: LocalRuntimeConfig;
  busy: boolean;
  onStartLoop: (loopId: string) => Promise<void>;
  onOpenCycle: (loopId: string, cycleId: string) => void;
};

const statusCopy: Record<
  string,
  { label: string; tone: "neutral" | "success" | "warning" | "error" }
> = {
  waiting_for_tests: { label: "Aguardando pessoas", tone: "neutral" },
  collecting: { label: "Equipe testando", tone: "warning" },
  ready_to_review: { label: "Feedback para revisar", tone: "success" },
  ready_to_resolve: { label: "Pronto para resolver", tone: "success" },
  recording: { label: "Em teste", tone: "warning" },
  processing: { label: "Organizando evidências", tone: "neutral" },
  ready: { label: "Pronto para revisar", tone: "success" },
  decision_required: { label: "Pronto para revisar", tone: "success" },
  fix_proposed: { label: "Correção proposta", tone: "warning" },
  awaiting_retest: { label: "Aguardando reteste", tone: "warning" },
  confirmed: { label: "Validado", tone: "success" },
  attention: { label: "Precisa de atenção", tone: "error" },
};

function copyForStatus(status: string) {
  return (
    statusCopy[status] ?? {
      label: status
        .replaceAll("_", " ")
        .replace(/^./, (value) => value.toUpperCase()),
      tone: "neutral" as const,
    }
  );
}

function relativeTime(value: string | null): string {
  if (!value) return "sem atividade recente";
  const delta = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(delta) || delta < 0) return "agora";
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return "agora";
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `há ${hours} h`;
  const days = Math.floor(hours / 24);
  return `há ${days} d`;
}

function duration(value: number): string {
  if (!value) return "—";
  const seconds = Math.round(value / 1_000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function ApplicationIcon({
  type,
}: {
  type: DesktopLoopSummary["applicationType"];
}) {
  if (type === "MOBILE") return <Smartphone size={15} />;
  if (type === "API") return <Braces size={15} />;
  return <Globe2 size={15} />;
}

function ParticipantIdentity({ cycle }: { cycle: DesktopLoopCycleSummary }) {
  const name = cycle.participant ?? "Participante não registrado";
  const initial = name.trim().charAt(0).toLocaleUpperCase() || "?";
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
              event.currentTarget.style.display = "none";
            }}
          />
        )}
      </span>
      <span>
        {cycle.participantRole ? `${name} · ${cycle.participantRole}` : name}
      </span>
    </span>
  );
}

function LoopParticipantStack({ loop }: { loop: DesktopLoopSummary }) {
  const visible = loop.participants.slice(0, 5);
  const hidden = Math.max(0, loop.participantCount - visible.length);
  if (visible.length === 0) return null;
  return (
    <span
      className="workspace-people-stack"
      role="img"
      aria-label={`Participantes: ${visible.map((participant) => participant.name).join(", ")}`}
    >
      {visible.map((participant) => (
        <span key={participant.id} title={participant.name}>
          {participant.name.trim().charAt(0).toLocaleUpperCase("pt-BR") || "?"}
          {participant.picture && (
            <img
              src={participant.picture}
              alt=""
              referrerPolicy="no-referrer"
              onError={(event) => {
                event.currentTarget.style.display = "none";
              }}
            />
          )}
        </span>
      ))}
      {hidden > 0 && <span aria-hidden="true">+{hidden}</span>}
    </span>
  );
}

function EvidenceIcon({ kind }: { kind: DesktopLoopEvidenceKind }) {
  if (kind === "replay") return <MonitorPlay size={14} />;
  if (kind === "annotation") return <MessageSquare size={14} />;
  if (kind === "screenshot") return <Image size={14} />;
  if (kind === "network") return <Network size={14} />;
  if (kind === "console") return <Terminal size={14} />;
  if (kind === "transcript") return <FileText size={14} />;
  return <Activity size={14} />;
}

function EvidenceRow({ item }: { item: DesktopLoopEvidenceItem }) {
  const fallbackDetail =
    item.kind === "replay"
      ? "Reviva a jornada exatamente como aconteceu."
      : item.kind === "screenshot"
        ? "Imagem registrada durante o teste."
        : null;
  return (
    <article className={`tone-${item.tone}`}>
      <span className="workspace-evidence-icon">
        <EvidenceIcon kind={item.kind} />
      </span>
      <div>
        <strong>{item.title}</strong>
        {(item.detail || fallbackDetail) && (
          <small>{item.detail || fallbackDetail}</small>
        )}
      </div>
      <code>
        {item.atMs == null
          ? item.kind === "replay"
            ? "Completo"
            : "Visão geral"
          : duration(item.atMs)}
      </code>
    </article>
  );
}

function isDistinctMission(mission: string, loopName: string): boolean {
  const normalize = (value: string) =>
    value.trim().toLocaleLowerCase("pt-BR").replace(/\s+/g, " ");
  const normalizedMission = normalize(mission);
  const normalizedLoop = normalize(loopName);
  if (!normalizedMission || normalizedMission === "executar a jornada definida para este loop") {
    return false;
  }
  return !normalizedMission.startsWith(normalizedLoop) && !normalizedLoop.startsWith(normalizedMission);
}

export function WorkspaceHome({
  runtime,
  busy,
  onStartLoop,
  onOpenCycle,
}: WorkspaceHomeProps) {
  const [loops, setLoops] = useState<DesktopLoopSummary[]>([]);
  const [cycles, setCycles] = useState<DesktopLoopCycleSummary[]>([]);
  const [detail, setDetail] = useState<DesktopLoopCycleDetail>();
  const [selectedLoopId, setSelectedLoopId] = useState("");
  const [selectedCycleId, setSelectedCycleId] = useState("");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingCycles, setLoadingCycles] = useState(false);
  const [error, setError] = useState("");
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
          values.some((item) => item.id === current)
            ? current
            : (values[0]?.id ?? ""),
        );
        setError("");
      } catch {
        if (!active) return;
        setError(
          "Não foi possível carregar seus Loops. Verifique a conexão e tente novamente.",
        );
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
      setSelectedCycleId("");
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
          values.some((item) => item.id === current)
            ? current
            : (values[0]?.id ?? ""),
        );
      })
      .catch(() => {
        if (active)
          setError("Não foi possível atualizar os testes deste Loop.");
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
        window.voidrCapture.workspace.getCycle(
          runtime,
          selectedLoopId,
          selectedCycleId,
        ),
      listCycles: () =>
        window.voidrCapture.workspace.listCycles(runtime, selectedLoopId),
    }).then((result) => {
      if (!active) return;
      if ("cycles" in result && result.cycles) setCycles(result.cycles);
      if (result.state === "loaded") {
        setDetail(result.detail);
        setError("");
        return;
      }
      if (result.state === "selection_changed") {
        setSelectedCycleId(result.selectedCycleId);
        setError("");
        return;
      }
      setError(
        result.state === "temporarily_unavailable"
          ? "As evidências deste teste ainda estão sendo sincronizadas. Tente atualizar em instantes."
          : "Não foi possível carregar as evidências deste teste. Tente novamente.",
      );
    });
    return () => {
      active = false;
    };
  }, [runtime, selectedLoopId, selectedCycleId, refreshVersion]);

  const visibleLoops = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("pt-BR");
    if (!normalized) return loops;
    return loops.filter((loop) =>
      `${loop.name} ${loop.environment} ${loop.applicationType}`
        .toLocaleLowerCase("pt-BR")
        .includes(normalized),
    );
  }, [loops, query]);
  const selectedLoop = loops.find((item) => item.id === selectedLoopId);
  const selectedCycle = cycles.find((item) => item.id === selectedCycleId);
  const selectedStatus = selectedCycle ? copyForStatus(selectedCycle.status) : null;
  const reviewIsPrimary = Boolean(
    selectedCycle &&
      ["ready", "decision_required", "attention", "fix_proposed", "awaiting_retest"].includes(
        selectedCycle.status,
      ),
  );
  const feedbackEvidence = (detail?.evidence ?? []).filter((item) =>
    ["replay", "annotation", "transcript", "screenshot"].includes(item.kind),
  );
  const technicalEvidence = (detail?.evidence ?? []).filter(
    (item) => !["replay", "annotation", "transcript", "screenshot"].includes(item.kind),
  );

  return (
    <main className="workspace-home">
      {error && (
        <div className="workspace-error" role="alert">
          <AlertCircle size={15} />
          <span>{error}</span>
          <button
            type="button"
            onClick={() => setRefreshVersion((value) => value + 1)}
          >
            Tentar novamente
          </button>
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
            <span>
              {visibleLoops.length}{" "}
              {visibleLoops.length === 1 ? "Loop" : "Loops"}
            </span>
            <span>Atividade</span>
          </div>
          <div className="workspace-loop-list">
            {loading ? (
              <div className="workspace-loading">
                <Loader2 className="spin" size={16} /> Carregando Loops…
              </div>
            ) : visibleLoops.length ? (
              visibleLoops.map((loop) => {
                const status = copyForStatus(loop.workspaceState);
                return (
                  <button
                    key={loop.id}
                    type="button"
                    className={`workspace-loop-row${selectedLoopId === loop.id ? " active" : ""}`}
                    onClick={() => setSelectedLoopId(loop.id)}
                  >
                    <span className="workspace-app-icon">
                      <ApplicationIcon type={loop.applicationType} />
                    </span>
                    <span className="workspace-loop-copy">
                      <strong>{loop.name}</strong>
                      <small>
                        {loop.environment} · {loop.testCount}{" "}
                        {loop.testCount === 1 ? "teste" : "testes"}
                      </small>
                    </span>
                    <span className="workspace-loop-state">
                      <small>{status.label}</small>
                      <small>{relativeTime(loop.updatedAt)}</small>
                    </span>
                    <ChevronRight size={13} />
                  </button>
                );
              })
            ) : (
              <div className="workspace-empty">
                <Globe2 size={18} />
                <strong>
                  {loops.length
                    ? "Nenhum Loop encontrado"
                    : "Seu primeiro Loop aparece aqui"}
                </strong>
                <span>
                  {loops.length
                    ? "Tente buscar por outro nome ou ambiente."
                    : "Crie um Loop na interface Web e volte para iniciar o teste."}
                </span>
              </div>
            )}
          </div>
        </aside>

        <section className="workspace-detail">
          {selectedLoop ? (
            <>
              <header className="workspace-detail-header">
                <div className="workspace-detail-title">
                  <span className="workspace-app-icon">
                    <ApplicationIcon type={selectedLoop.applicationType} />
                  </span>
                  <div>
                    <h2>{selectedLoop.name}</h2>
                    <span>
                      {selectedLoop.environment} ·{" "}
                      {selectedLoop.applicationType === "WEB"
                        ? "Aplicação Web"
                        : selectedLoop.applicationType}
                    </span>
                    <LoopParticipantStack loop={selectedLoop} />
                  </div>
                </div>
                <div className="workspace-detail-actions">
                  {selectedCycle && (
                    <Button
                      size="sm"
                      variant={reviewIsPrimary ? "primary" : "ghost"}
                      icon={<ExternalLink size={13} />}
                      onClick={() =>
                        onOpenCycle(selectedLoop.id, selectedCycle.id)
                      }
                    >
                      {reviewIsPrimary ? "Revisar teste" : "Abrir teste"}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant={reviewIsPrimary ? "secondary" : "primary"}
                    icon={
                      busy ? (
                        <Loader2 className="spin" size={13} />
                      ) : (
                        <Play size={13} />
                      )
                    }
                    onClick={() => void onStartLoop(selectedLoop.id)}
                    disabled={busy}
                  >
                    Fazer meu teste
                  </Button>
                </div>
              </header>

              <div className="workspace-detail-body">
                <aside
                  className="workspace-cycle-pane"
                  aria-label="Testes do Loop"
                >
                  <div className="workspace-section-heading">
                    <span>Testes</span>
                    <Badge tone="neutral">{cycles.length}</Badge>
                  </div>
                  <div className="workspace-cycle-list">
                    {loadingCycles ? (
                      <div className="workspace-loading">
                        <Loader2 className="spin" size={14} /> Carregando…
                      </div>
                    ) : cycles.length ? (
                      cycles.map((cycle) => {
                        const status = copyForStatus(cycle.status);
                        return (
                          <button
                            key={cycle.id}
                            type="button"
                            className={`workspace-cycle-row${cycle.id === selectedCycleId ? " active" : ""}`}
                            onClick={() => setSelectedCycleId(cycle.id)}
                          >
                            <span className="workspace-cycle-number">
                              {cycle.number}
                            </span>
                            <span>
                              <strong>Teste {cycle.number}</strong>
                              <small className="workspace-participant-line">
                                <ParticipantIdentity cycle={cycle} />
                              </small>
                              <small>{relativeTime(cycle.updatedAt)}</small>
                            </span>
                            <Badge tone={status.tone}>{status.label}</Badge>
                          </button>
                        );
                      })
                    ) : (
                      <div className="workspace-empty compact">
                        <Clock3 size={16} />
                        <span>Nenhum teste iniciado.</span>
                      </div>
                    )}
                  </div>
                </aside>

                <section className="workspace-evidence-pane">
                  {selectedCycle ? (
                    <>
                      <div className="workspace-mission">
                        <div className="workspace-review-subject">
                          <span className="workspace-participant-avatar" aria-hidden="true">
                            {(selectedCycle.participant ?? "?").trim().charAt(0).toLocaleUpperCase() || "?"}
                            {selectedCycle.participantAvatarUrl && (
                              <img
                                src={selectedCycle.participantAvatarUrl}
                                alt=""
                                referrerPolicy="no-referrer"
                                onError={(event) => {
                                  event.currentTarget.style.display = "none";
                                }}
                              />
                            )}
                          </span>
                          <div>
                            <strong>{selectedCycle.participant ?? `Teste ${selectedCycle.number}`}</strong>
                            <small>
                              {selectedCycle.participantRole
                                ? `${selectedCycle.participantRole} · `
                                : ""}
                              Teste {selectedCycle.number} · {relativeTime(selectedCycle.updatedAt)}
                            </small>
                          </div>
                          {selectedStatus && (
                            <Badge tone={selectedStatus.tone}>{selectedStatus.label}</Badge>
                          )}
                        </div>
                        {isDistinctMission(selectedCycle.mission, selectedLoop.name) && (
                          <p>
                            <span>Missão</span>
                            {selectedCycle.mission}
                          </p>
                        )}
                        {detail && detail.durationMs > 0 && (
                          <div className="workspace-review-meta">
                            <span>
                              <Clock3 size={12} /> {duration(detail.durationMs)}
                            </span>
                          </div>
                        )}
                      </div>

                      <div className="workspace-evidence-header">
                        <div>
                          <span>Feedback e evidências</span>
                          <Badge
                            tone={
                              feedbackEvidence.length ? "success" : "neutral"
                            }
                          >
                            {feedbackEvidence.length}
                          </Badge>
                        </div>
                      </div>

                      <div className="workspace-evidence-list">
                        {!detail ? (
                          <div className="workspace-loading">
                            <Loader2 className="spin" size={15} /> Consolidando
                            evidências…
                          </div>
                        ) : feedbackEvidence.length ? (
                          feedbackEvidence.map((item) => (
                            <EvidenceRow key={item.id} item={item} />
                          ))
                        ) : (
                          <div className="workspace-empty">
                            <Activity size={18} />
                            <strong>
                              {detail.evidence.length
                                ? "Nenhum feedback registrado"
                                : "Evidências ainda não disponíveis"}
                            </strong>
                            <span>
                              {detail.evidence.length
                                ? "Os sinais técnicos continuam disponíveis abaixo."
                                : "Faça um teste para alimentar esta timeline."}
                            </span>
                          </div>
                        )}
                        {detail && (
                          <details className="workspace-technical-signals">
                            <summary>
                              <span>
                                <Terminal size={13} /> Sinais técnicos
                              </span>
                              <Badge tone={technicalEvidence.some((item) => item.tone === "error") ? "warning" : "neutral"}>
                                {technicalEvidence.length}
                              </Badge>
                            </summary>
                            {technicalEvidence.length ? (
                              <div>
                                {technicalEvidence.map((item) => (
                                  <EvidenceRow key={item.id} item={item} />
                                ))}
                              </div>
                            ) : (
                              <p>Nenhuma falha automática detectada.</p>
                            )}
                          </details>
                        )}
                      </div>
                    </>
                  ) : (
                    <div className="workspace-empty centered">
                      <Play size={20} />
                      <strong>Faça o primeiro teste</strong>
                      <span>
                        As evidências e os participantes ficarão organizados
                        aqui.
                      </span>
                      <Button
                        size="sm"
                        variant="primary"
                        onClick={() => void onStartLoop(selectedLoop.id)}
                        disabled={busy}
                      >
                        Fazer meu teste
                      </Button>
                    </div>
                  )}
                </section>
              </div>
            </>
          ) : (
            <div className="workspace-empty centered">
              <Globe2 size={20} />
              <strong>Selecione um Loop</strong>
              <span>Os testes e as evidências aparecem aqui.</span>
            </div>
          )}
        </section>
      </section>
    </main>
  );
}
