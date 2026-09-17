const categories = {
  jev: { name: "Jev · API", color: "#b9a2e8" },
  page: { name: "Página · espera", color: "#ddb881" },
  playwright: { name: "Playwright", color: "#9dc8e8" },
  capture: { name: "Capturas", color: "#82bca5" },
  pacing: { name: "Pausas visuais", color: "#cf9fae" },
  engine: { name: "Engine", color: "#8b969f" },
};
const duration = ms => ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
const spanDuration = (span, now) => span.durationMs ?? Math.max(0, now - span.startMs);

function exclusiveSpans(spans, now) {
  const children = new Map();
  spans.forEach(span => {
    if (span.parentId !== undefined) children.set(span.parentId, (children.get(span.parentId) ?? 0) + spanDuration(span, now));
  });
  return spans.map(span => ({ ...span, selfMs: span.selfMs ?? Math.max(0, spanDuration(span, now) - (children.get(span.id) ?? 0)) }));
}

function aggregate(spans) {
  const groups = new Map();
  spans.forEach(span => {
    const key = `${span.category}:${span.label}`;
    const previous = groups.get(key) ?? { ...span, calls: 0, total: 0, running: false };
    groups.set(key, { ...previous, calls: previous.calls + 1, total: previous.total + span.selfMs, running: previous.running || span.status === "running" });
  });
  return [...groups.values()].sort((a, b) => b.total - a.total);
}

export class LatencyView {
  state = { spans: new Map(), origin: null, timer: null, stepIndex: null, finished: null };
  constructor(elements) { this.elements = elements; }

  reset(steps) {
    clearInterval(this.state.timer);
    Object.assign(this.state, { spans: new Map(), origin: null, timer: null, stepIndex: null, finished: null });
    this.elements.select.replaceChildren(...[
      ["current", "Passo atual"], ["all", "Execução inteira"], ["setup", "Preparação e encerramento"],
      ...steps.map((_, index) => [String(index), `Passo ${index + 1}`]),
    ].map(([value, text]) => new Option(text, value)));
    this.render();
  }

  receive(span) {
    if (this.state.origin === null) {
      this.state.origin = performance.now() - span.startMs;
      this.state.timer = setInterval(() => this.render(), 150);
    }
    this.state.spans.set(span.id, span);
    this.render();
  }

  step(index) {
    this.state.stepIndex = index;
    const option = this.elements.select.querySelector('[value="current"]');
    if (option) option.textContent = `Passo atual (${index + 1})`;
    this.render();
  }

  finish(timings) {
    clearInterval(this.state.timer);
    const durationMs = this.state.origin === null ? 0 : performance.now() - this.state.origin;
    this.state.finished = timings ?? { durationMs };
    if (timings) this.state.spans = new Map(timings.spans.map(span => [span.id, span]));
    this.render();
  }

  show(stepIndex) {
    this.elements.panel.hidden = false; this.elements.activity.hidden = true;
    this.elements.button.setAttribute("aria-pressed", "true");
    if (stepIndex !== undefined) this.elements.select.value = String(stepIndex);
    this.render();
  }

  hide() {
    this.elements.panel.hidden = true; this.elements.activity.hidden = false;
    this.elements.button.setAttribute("aria-pressed", "false");
  }

  selected(spans) {
    const value = this.elements.select.value;
    if (value === "all") return spans;
    const index = value === "current" ? this.state.stepIndex : value === "setup" ? null : Number(value);
    return spans.filter(span => span.stepIndex === index);
  }

  render() {
    if (!this.elements.select.options.length) return;
    const now = this.state.finished?.durationMs ?? (this.state.origin === null ? 0 : performance.now() - this.state.origin);
    const spans = exclusiveSpans([...this.state.spans.values()], now);
    const selected = this.selected(spans), total = selected.reduce((sum, span) => sum + span.selfMs, 0);
    const active = spans.filter(span => span.status === "running").at(-1);
    this.elements.current.textContent = active ? `${categories[active.category].name}: ${active.label} · ${duration(spanDuration(active, now))}` : this.state.finished ? "Execução encerrada" : "Aguardando medições";
    this.elements.total.textContent = `${duration(total)} medidos`;
    const unmeasured = this.state.finished?.unmeasuredMs;
    this.elements.overhead.textContent = this.elements.select.value === "all" && unmeasured !== undefined ? `${duration(unmeasured)} fora das medições` : "Tempos exclusivos, sem somar operações dentro de outras duas vezes.";
    if (this.elements.panel.hidden) return;
    this.renderBreakdown(selected, total);
    this.renderOperations(aggregate(selected));
  }

  renderBreakdown(spans, total) {
    this.elements.breakdown.replaceChildren(...Object.entries(categories).map(([key, category]) => {
      const value = spans.filter(span => span.category === key).reduce((sum, span) => sum + span.selfMs, 0);
      const row = document.createElement("div"); row.className = "latency-category"; row.dataset.category = key;
      const title = document.createElement("span"); title.textContent = category.name;
      const time = document.createElement("strong"); time.textContent = duration(value);
      const track = document.createElement("div"); track.className = "latency-track";
      const bar = document.createElement("span"); bar.style.width = `${total ? value / total * 100 : 0}%`; bar.style.background = category.color;
      track.append(bar); row.append(title, time, track); return row;
    }));
  }

  renderOperations(operations) {
    this.elements.rows.replaceChildren(...operations.map(operation => {
      const row = document.createElement("tr"); row.dataset.running = String(operation.running);
      const label = document.createElement("td"); label.textContent = operation.label;
      label.title = `${categories[operation.category].name} · Tempo próprio; suboperações aparecem separadamente.`;
      const calls = document.createElement("td"); calls.textContent = String(operation.calls);
      const time = document.createElement("td"); time.textContent = `${duration(operation.total)}${operation.running ? " …" : ""}`;
      row.append(label, calls, time); return row;
    }));
  }
}
