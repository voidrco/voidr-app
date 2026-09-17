export function parseJourney(text) {
  return text.split(/\r?\n/).map(line => line.replace(/^\s*(?:\d+[.)]|[-*])\s*/, "").trim()).filter(Boolean);
}

export class JourneyTimeline {
  state = { active: -1, started: new Map(), editing: true };

  constructor(elements) { this.elements = elements; }

  render(steps) {
    const { list, template, count } = this.elements;
    this.state.active = -1; this.state.started.clear();
    count.textContent = `${steps.length} ${steps.length === 1 ? "passo" : "passos"}`;
    list.replaceChildren(...steps.map((instruction, index) => {
      const row = template.content.firstElementChild.cloneNode(true);
      row.dataset.index = String(index);
      row.querySelector(".step-marker").textContent = String(index + 1).padStart(2, "0");
      row.querySelector(".step-instruction").textContent = instruction;
      row.querySelector(".step-timings").setAttribute("aria-label", `Ver tempos do passo ${index + 1}`);
      return row;
    }));
  }

  showEditor(editing) {
    this.state.editing = editing;
    this.elements.editor.hidden = !editing;
    this.elements.list.hidden = editing;
    this.elements.toggle.textContent = editing ? "Ver passos" : "Editar";
    this.elements.toggle.setAttribute("aria-expanded", String(editing));
  }

  activate(index, detail = "Analisando a página") {
    const row = this.elements.list.children[index];
    if (!row || row.dataset.state === "completed") return;
    const changed = this.state.active !== index;
    this.state.active = index;
    if (!this.state.started.has(index)) this.state.started.set(index, performance.now());
    row.dataset.state = "running"; row.setAttribute("aria-current", "step");
    row.querySelector(".step-state").textContent = "Em execução";
    row.querySelector(".step-detail").textContent = detail;
    row.querySelector(".step-detail").hidden = false;
    if (changed) this.reveal(row);
  }

  reveal(row) {
    const list = this.elements.list;
    const bounds = list.getBoundingClientRect(), target = row.getBoundingClientRect();
    if (target.top < bounds.top || target.bottom > bounds.bottom) {
      list.scrollTop += target.top - bounds.top - 18;
    }
  }

  revealActive() {
    const row = this.elements.list.children[this.state.active];
    if (row && !this.elements.list.hidden) this.reveal(row);
  }

  complete(index) {
    const row = this.elements.list.children[index];
    if (!row) return;
    row.dataset.state = "completed"; row.removeAttribute("aria-current");
    row.querySelector(".step-marker").textContent = "✓";
    row.querySelector(".step-state").textContent = "Concluído";
    row.querySelector(".step-detail").hidden = true;
    const started = this.state.started.get(index);
    row.querySelector(".step-duration").textContent = started === undefined ? "" : `${((performance.now() - started) / 1000).toFixed(1)} s`;
  }

  finish(result) {
    Array.from(this.elements.list.children).forEach((row, index) => {
      row.removeAttribute("aria-current");
      if (index < result.completedSteps) {
        if (row.dataset.state !== "completed") this.complete(index);
        return;
      }
      row.dataset.state = index === result.completedSteps ? (result.status === "cancelled" ? "cancelled" : "error") : "pending";
      row.querySelector(".step-state").textContent = index === result.completedSteps ? (result.status === "cancelled" ? "Interrompido" : "Precisa de revisão") : "Não executado";
      row.querySelector(".step-detail").hidden = index !== result.completedSteps;
      if (index === result.completedSteps) row.querySelector(".step-detail").textContent = result.reason;
    });
  }
}
