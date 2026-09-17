import type { Frame, Page } from "playwright-core";
import { unmeasured, type Measure } from "./timing.js";
import { readControls } from "./dom.js";

export const CONTROL_SELECTOR = "button, a, input, select, textarea, [role=button], [role=tab], [role=checkbox], [role=option], [contenteditable=true]";

export type Control = {
  index: number; frame: number; tag: string; type: string; name: string;
  value: string; checked: boolean; href: string; min: string; max: string;
  step: string; editable: boolean; context: string;
  availability?: "ready" | "offscreen" | "obscured" | "blocked_by_modal";
  inModal?: boolean;
  options: { value: string; label: string; disabled: boolean }[];
};
export type Observation = { url: string; text: string; controls: Control[]; activeModals?: { frame: number; text: string }[] };

async function readFrameControls(frame: Frame, frameIndex: number) {
  return frame.locator(CONTROL_SELECTOR).evaluateAll(readControls, frameIndex);
}

async function frameScope(frame: Frame) {
  const state = { frame, inModal: false };
  while (state.frame.parentFrame()) {
    const element = await state.frame.frameElement();
    try {
      const control = (await element.evaluate(readControls, -1)).controls[0];
      if (control?.availability === "blocked_by_modal") return "blocked";
      state.inModal ||= Boolean(control?.inModal);
    } finally { await element.dispose(); }
    state.frame = state.frame.parentFrame()!;
  }
  return state.inModal ? "modal" : "page";
}

async function readFrame(frame: Frame, index: number) {
  try {
    if (frame.parentFrame() && !await (await frame.frameElement()).isVisible()) return { text: "", controls: [] };
    const [text, state, scope] = await Promise.all([
      frame.locator("body").innerText({ timeout: 1_500 }), readFrameControls(frame, index), frameScope(frame),
    ]);
    const controls = state.controls.map(control => scope === "blocked" ? { ...control, availability: "blocked_by_modal" as const }
      : scope === "modal" ? { ...control, inModal: true } : control);
    return { text, ...state, controls };
  } catch {
    return { text: "", controls: [] };
  }
}

export async function observe(page: Page): Promise<Observation> {
  const frames = await Promise.all(page.frames().map(readFrame));
  return {
    url: page.url(), text: frames.map((frame) => frame.text).join("\n").slice(0, 24_000),
    controls: frames.flatMap((frame) => frame.controls).sort((a, b) => Number(Boolean(b.inModal)) - Number(Boolean(a.inModal))).slice(0, 150),
    activeModals: frames.flatMap(frame => "activeModal" in frame && frame.activeModal ? [frame.activeModal] : []),
  };
}

export async function settledObservation(page: Page, signal?: AbortSignal, measure: Measure = unmeasured) {
  const read = () => measure("playwright", "Ler DOM e controles", () => observe(page));
  const state = { previous: "", stable: 0, latest: await read() };
  for (let attempt = 0; attempt < 24; attempt += 1) {
    signal?.throwIfAborted();
    const fingerprint = JSON.stringify(state.latest);
    const busy = /\b(?:consultando|calculando|resolvendo|enviando|carregando|loading|processing|submitting)\b[^\n]*(?:…|\.\.\.)/i.test(state.latest.text);
    state.stable = fingerprint === state.previous && !busy ? state.stable + 1 : 0;
    if (state.stable >= 2) return state.latest;
    state.previous = fingerprint;
    await measure("page", busy ? "Aguardar carregamento visível" : "Confirmar estabilidade (250 ms)", () => page.waitForTimeout(250));
    state.latest = await read();
  }
  return state.latest;
}
