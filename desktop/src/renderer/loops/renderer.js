import { JourneyTimeline, parseJourney } from "./timeline.js";
import { AgentPreview } from "./agent-preview.js";
import { LatencyView } from "./latency.js";
import { restoreDraft } from "./draft.js";

export function mountJourney(root, api, onRunning, onBack) {
const $ = (id) => root.getElementById(id);
const ui = { configured: false, running: false, started: 0, timer: null, events: 0, steps: [], example: null, disposed: false, initialized: false, previous: null, pending: null };
const labels = { completed: "Concluída", blocked: "Bloqueada", uncertain: "Precisa de revisão", unsure: "Precisa de revisão", cancelled: "Interrompida", error: "Falha na execução", stalled: "Sem progresso", step_limit: "Limite atingido", assertion_failed: "Verificação falhou" };
const latency = new LatencyView({ panel: $("latency-panel"), activity: $("console-body"), button: $("toggle-latency"),
  select: $("latency-step"), total: $("latency-total"), current: $("latency-current"), overhead: $("latency-overhead"),
  breakdown: $("latency-breakdown"), rows: $("latency-rows") });
const timeline = new JourneyTimeline({ list: $("timeline"), template: $("step-template"), count: $("step-count"), editor: $("steps-editor"), toggle: $("edit-steps") });
const preview = new AgentPreview({ image: $("screenshot"), empty: $("empty-preview"), url: $("page-url"),
  overlay: $("agent-overlay"), target: $("agent-target"), cursor: $("agent-cursor"), ripple: $("agent-ripple"),
  caption: $("agent-caption"), phase: $("agent-phase"), label: $("agent-label"), status: $("agent-state"),
  size: $("viewport-size"), scaleLabel: $("preview-scale") });

function showError(error) {
  if (ui.disposed) return;
  $("error").textContent = error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, "") : String(error);
  $("error").hidden = false;
}

function updateConnection(ready) {
  ui.configured = ready;
  $("connection").textContent = ready ? "TypeSafe configurado" : "Configurar conexão";
  $("connection").dataset.ready = String(ready);
  $("start").disabled = !ready || ui.running;
}

function setRunning(running) {
  ui.running = running; onRunning(running); $("back").disabled = running;
  ["url", "steps", "expected", "headed", "example", "connection", "edit-steps"].forEach((id) => { $(id).disabled = running; });
  $("start").disabled = running || !ui.configured;
  $("stop").disabled = !running;
  $("focus-stop").disabled = !running;
  $("start").lastChild.textContent = running ? " Em execução…" : " Executar jornada";
  if (!running) clearInterval(ui.timer);
}

function setStatus(text, state) {
  $("status").textContent = text;
  $("status").dataset.state = state;
  $("workspace-state").textContent = text;
}

function readForm() {
  return { url: $("url").value.trim(), steps: parseJourney($("steps").value), expected: parseJourney($("expected").value), headed: $("headed").checked, maxActions: 60 };
}

function updateStepCount() {
  const steps = parseJourney($("steps").value);
  timeline.render(steps); latency.reset(steps);
}

function saveDraft() {
  localStorage.setItem("voidr-loops-draft", JSON.stringify(readForm()));
  updateStepCount();
}
function fillForm(data) {
  $("url").value = data.url ?? "";
  $("steps").value = Array.isArray(data.steps) ? data.steps.join("\n") : data.steps ?? "";
  $("expected").value = Array.isArray(data.expected) ? data.expected.join("\n") : data.expected ?? "";
  $("headed").checked = data.headed === true;
  updateStepCount();
  timeline.showEditor(!parseJourney($("steps").value).length);
}

function toggleFocus() {
  const focused = $("workspace").dataset.focus !== "true";
  $("workspace").dataset.focus = String(focused);
  $("focus").setAttribute("aria-pressed", String(focused));
  const label = focused ? "Restaurar painéis" : "Expandir navegador";
  $("focus").setAttribute("aria-label", label);
  $("focus").title = focused ? `${label} (Esc)` : label;
  if (!focused) requestAnimationFrame(() => timeline.revealActive());
}

function addEvent(event) {
  if (!ui.events) $("activity").replaceChildren();
  ui.events += 1;
  $("event-count").textContent = String(ui.events);
  const row = document.createElement("div"); row.className = "event"; row.dataset.type = event.type;
  const time = document.createElement("span"); time.className = "event-time";
  time.textContent = `${((Date.now() - ui.started) / 1000).toFixed(1)}s`;
  const marker = document.createElement("span"); marker.className = "event-marker";
  marker.textContent = event.type === "step_done" ? "✓" : String((event.stepIndex ?? 0) + 1);
  const body = document.createElement("div"); const text = document.createElement("p"); text.textContent = event.message;
  const meta = document.createElement("small"); meta.textContent = event.type === "step_done" ? "Resultado verificado"
    : event.type === "recovery" ? "Recuperação automática" : "Ação executada";
  body.append(text, meta); row.append(time, marker, body); $("activity").append(row);
  $("activity").scrollTop = $("activity").scrollHeight;
}

function finish(result) {
  latency.finish(result.timings);
  const success = result.status === "completed";
  setStatus(labels[result.status] ?? result.status, success ? "completed" : "error");
  $("result").hidden = false; $("result").dataset.state = success ? "completed" : "error";
  $("result-title").textContent = labels[result.status] ?? result.status;
  $("result-description").textContent = result.reason;
  $("result-meta").textContent = `${result.actions} ações · ${(result.durationMs / 1000).toFixed(1)} s · ${result.completedSteps}/${result.totalSteps} passos`;
  $("progress").textContent = `${result.completedSteps} de ${result.totalSteps} passos`;
  $("output").disabled = !result.output;
  $("elapsed").textContent = `${(result.durationMs / 1000).toFixed(1)} s`;
  timeline.finish(result); preview.clear(success ? "Jornada concluída" : labels[result.status] ?? "Execução encerrada", true);
  clearInterval(ui.timer);
}

function onEvent(event) {
  if (event.type === "timing") latency.receive(event.timing);
  if (event.type === "step_started") { timeline.activate(event.stepIndex); latency.step(event.stepIndex); preview.clear("Analisando a página"); }
  if (event.type === "observation") {
    preview.receive(event);
    $("progress").textContent = `Passo ${Math.min(event.stepIndex + 1, ui.steps.length)} de ${ui.steps.length}`;
  }
  if (event.type === "interaction") {
    preview.receive(event);
    timeline.activate(event.stepIndex, event.interaction.phase === "settled" ? "Conferindo o resultado" : event.interaction.label);
  }
  if (event.type === "recovery") {
    addEvent(event); preview.clear("Buscando uma alternativa"); timeline.activate(event.stepIndex, event.message);
  }
  if (event.type === "action" || event.type === "step_done") {
    addEvent(event);
    if (event.type === "step_done") timeline.complete(event.stepIndex);
    else if (!event.executed) { preview.clear(); timeline.activate(event.stepIndex, event.message); }
  }
  if (event.type === "finished") finish(event.result);
  if (event.type === "fatal") {
    latency.finish();
    showError(event.message); setStatus("Falha na execução", "error"); preview.clear("Falha na execução", true);
    timeline.finish({ status: "error", completedSteps: $("timeline").querySelectorAll('[data-state="completed"]').length, reason: event.message });
  }
  if (event.type === "idle") setRunning(false);
}

async function start(event) {
  event.preventDefault();
  $("error").hidden = true;
  ui.steps = parseJourney($("steps").value);
  ui.started = Date.now(); ui.events = 0; ui.previous = null;
  $("activity").replaceChildren(); $("result").hidden = true; $("output").disabled = true;
  $("event-count").textContent = "0"; $("elapsed").textContent = "0 s";
  $("page-url").textContent = $("url").value.trim(); $("progress").textContent = "Abrindo…";
  $("preview-scale").textContent = "Ajustar à área";
  $("screenshot").hidden = true; $("empty-preview").hidden = false;
  setRunning(true); setStatus("Executando", "running"); saveDraft();
  timeline.showEditor(false); timeline.activate(0, "Abrindo o navegador"); preview.clear("Abrindo o navegador");
  ui.timer = setInterval(() => { $("elapsed").textContent = `${Math.floor((Date.now() - ui.started) / 1000)} s`; }, 500);
  try { await api.start(readForm()); } catch (error) {
    latency.finish();
    setRunning(false); setStatus("Revise a jornada", "error"); showError(error); preview.clear("Revise a jornada");
    timeline.finish({ status: "error", completedSteps: 0, reason: $("error").textContent });
  }
}

$("journey-form").addEventListener("submit", start);
$("journey-form").addEventListener("input", saveDraft);
$("screenshot").addEventListener("load", () => preview.resize());
const previewObserver = new ResizeObserver(() => preview.resize());
previewObserver.observe($("screenshot").parentElement);
const timelineObserver = new ResizeObserver(() => timeline.revealActive());
timelineObserver.observe($("timeline"));
$("edit-steps").addEventListener("click", () => {
  if (!parseJourney($("steps").value).length) return $("steps").focus();
  timeline.showEditor(!timeline.state.editing);
  if (timeline.state.editing) $("steps").focus();
});
$("focus").addEventListener("click", toggleFocus);
$("toggle-latency").addEventListener("click", () => {
  if ($("latency-panel").hidden) { latency.show(); $("toggle-activity").setAttribute("aria-expanded", "false"); }
  else { latency.hide(); $("toggle-activity").setAttribute("aria-expanded", "true"); }
});
$("latency-step").addEventListener("change", () => latency.render());
$("timeline").addEventListener("click", (event) => {
  const button = event.target.closest(".step-timings");
  if (!button) return;
  latency.show(Number(button.closest(".step").dataset.index));
  $("toggle-activity").setAttribute("aria-expanded", "false");
});
$("toggle-activity").addEventListener("click", () => {
  if (!$("latency-panel").hidden) { latency.hide(); $("toggle-activity").setAttribute("aria-expanded", "true"); return; }
  const expanded = $("toggle-activity").getAttribute("aria-expanded") !== "true";
  $("toggle-activity").setAttribute("aria-expanded", String(expanded));
  $("console-body").hidden = !expanded;
});
root.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && $("workspace").dataset.focus === "true") toggleFocus();
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && !$("start").disabled) {
    event.preventDefault(); $("journey-form").requestSubmit();
  }
});
$("example").addEventListener("click", () => { fillForm(ui.example); saveDraft(); });
async function stopRun() {
  $("stop").disabled = true; $("focus-stop").disabled = true;
  setStatus("Interrompendo…", "running");
  try { await api.stop(); } catch (error) { showError(error); $("stop").disabled = false; $("focus-stop").disabled = false; }
}

$("stop").addEventListener("click", stopRun);
$("focus-stop").addEventListener("click", stopRun);
$("output").addEventListener("click", () => api.openLogs().catch(showError));
$("connection").addEventListener("click", async () => {
  try { updateConnection((await api.configure()).configured); } catch (error) { showError(error); }
});
$("back").addEventListener("click", onBack);

function applyState(next) {
  if (ui.disposed) return;
  if (!ui.initialized) { ui.pending = next; return; }
  const previous = ui.previous;
  if (previous && next.revision <= previous.revision) return;
  ui.previous = next;
  updateConnection(next.configured);
  if (next.running && (!previous?.running || next.stepIndex !== previous.stepIndex)) {
    onEvent({ type: "step_started", stepIndex: next.stepIndex });
    setStatus(next.stopping ? "Interrompendo…" : "Executando", "running");
  }
  next.timings.forEach(span => {
    const prior = previous?.timings.find(item => item.id === span.id);
    if (!prior || prior.status !== span.status || prior.durationMs !== span.durationMs) latency.receive(span);
  });
  next.events.slice(previous?.events.length ?? 0).forEach(onEvent);
  if (next.screenshot && next.screenshot !== previous?.screenshot) {
    onEvent({ type: "observation", stepIndex: next.stepIndex, screenshot: next.screenshot, url: next.url, interaction: next.interaction });
  } else if (next.interaction && JSON.stringify(next.interaction) !== JSON.stringify(previous?.interaction)) onEvent({ type: "interaction", stepIndex: next.stepIndex, interaction: next.interaction });
  if (next.result && next.result !== previous?.result) finish(next.result);
  if (next.error && next.error !== previous?.error) onEvent({ type: "fatal", message: next.error });
  setRunning(next.running);
  if (next.stopping) { $("stop").disabled = true; $("focus-stop").disabled = true; }
}

const unsubscribe = api.onChange(applyState);
api.status().then(status => {
  if (ui.disposed) return;
  const next = ui.pending && ui.pending.revision > status.revision ? ui.pending : status;
  ui.example = next.example; ui.initialized = true;
  fillForm(next.running || next.result ? next.config : restoreDraft(localStorage, ui.example));
  ui.steps = parseJourney($("steps").value);
  ui.started = Date.now() - (next.result?.durationMs ?? next.timings.at(-1)?.startMs ?? 0);
  applyState(next);
  if (next.running) ui.timer = setInterval(() => { $("elapsed").textContent = `${Math.floor((Date.now() - ui.started) / 1000)} s`; }, 500);
}).catch(showError);
return () => {
  ui.disposed = true; unsubscribe(); clearInterval(ui.timer); latency.finish();
  previewObserver.disconnect(); timelineObserver.disconnect(); preview.clear("", true);
};
}
