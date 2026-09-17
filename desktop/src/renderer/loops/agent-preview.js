const phases = { target: "Localizando alvo", acting: "Interagindo", typing: "Digitando", settled: "Conferindo resultado" };
const verbs = { click: "Clicando", fill: "Preenchendo", select: "Selecionando", check: "Marcando", uncheck: "Desmarcando", enter: "Pressionando Enter" };

export class AgentPreview {
  state = { interaction: null, sequence: 0, point: null, terminal: false };

  constructor(elements) { this.elements = elements; }

  async showFrame(event) {
    if (!event.screenshot) return;
    const sequence = ++this.state.sequence;
    const loaded = new Image(); loaded.src = event.screenshot;
    try { await loaded.decode(); } catch { return; }
    if (sequence !== this.state.sequence) return;
    this.elements.image.src = loaded.src;
    this.elements.image.hidden = false; this.elements.empty.hidden = true;
    this.elements.url.textContent = event.url;
    this.state.interaction = this.state.terminal ? null : event.interaction ?? null;
    this.renderInteraction(); this.resize();
  }

  receive(event) {
    if (event.screenshot) return this.showFrame(event);
    this.state.interaction = event.interaction ?? null;
    this.renderInteraction();
  }

  resize() {
    const { image, overlay, size, scaleLabel } = this.elements;
    if (image.hidden || !image.naturalWidth) return;
    const { width, height } = image.parentElement.getBoundingClientRect();
    const scale = Math.min(1, width / image.naturalWidth, height / image.naturalHeight);
    const w = image.naturalWidth * scale, h = image.naturalHeight * scale;
    Object.assign(overlay.style, { width: `${w}px`, height: `${h}px`, left: `${(width - w) / 2}px`, top: `${(height - h) / 2}px` });
    overlay.setAttribute("viewBox", `0 0 ${image.naturalWidth} ${image.naturalHeight}`);
    if (!this.state.point) this.moveCursor({ point: { x: image.naturalWidth / 2, y: image.naturalHeight / 2 } });
    overlay.removeAttribute("hidden");
    size.textContent = `${image.naturalWidth} × ${image.naturalHeight}`;
    scaleLabel.textContent = `${Math.round(scale * 100)}% · Ajustado`;
  }

  renderInteraction() {
    const interaction = this.state.interaction;
    const { overlay, target, caption, phase, label, status } = this.elements;
    overlay.toggleAttribute("hidden", this.elements.image.hidden);
    target.toggleAttribute("hidden", !interaction?.target);
    caption.hidden = !interaction || interaction.phase === "settled";
    if (!interaction) return;
    phase.textContent = interaction.phase === "acting" ? verbs[interaction.kind] : phases[interaction.phase];
    label.textContent = interaction.label;
    status.textContent = phases[interaction.phase];
    overlay.dataset.phase = interaction.phase;
    if (!interaction.target || !interaction.point) return;
    Object.entries(interaction.target).forEach(([key, value]) => target.setAttribute(key, String(value)));
    this.moveCursor(interaction);
    if (interaction.phase === "acting") this.pulse(interaction.point);
  }

  moveCursor(interaction) {
    const { cursor } = this.elements;
    const point = interaction.point;
    const previous = this.state.point ?? { x: Math.max(0, point.x - 90), y: Math.max(0, point.y - 70) };
    const transform = value => `translate(${value.x}px, ${value.y}px)`;
    cursor.style.transform = transform(point);
    if (interaction.phase === "target" && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
      cursor.animate([{ transform: transform(previous) }, { transform: transform(point) }], { duration: 380, easing: "cubic-bezier(.22,.7,.3,1)" });
    }
    this.state.point = point;
  }

  pulse(point) {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const { ripple } = this.elements;
    ripple.setAttribute("cx", String(point.x)); ripple.setAttribute("cy", String(point.y));
    ripple.animate([{ r: "7px", opacity: .9, strokeWidth: "3px" }, { r: "32px", opacity: 0, strokeWidth: "1px" }], { duration: 650, easing: "ease-out" });
  }

  clear(status = "Observando a página", terminal = false) {
    if (!terminal) this.state.sequence += 1;
    this.state.terminal = terminal; this.state.interaction = null;
    this.elements.caption.hidden = true;
    this.elements.ripple.getAnimations().forEach(animation => animation.cancel());
    this.renderInteraction();
    this.elements.status.textContent = status;
  }
}
