import type { Frame, Page } from "playwright-core";
import { unmeasured, type Measure } from "./timing.js";
import { readControls } from "./dom.js";
import { frameEvidence, type AssertionEvidence } from "./assertion-evidence.js";

export const CONTROL_SELECTOR = "button, a, input, select, textarea, [role=button], [role=tab], [role=checkbox], [role=option], [contenteditable=true]";

export type Control = {
  index: number; frame: number; tag: string; type: string; name: string;
  domId?: string; selectors?: string[]; matchedSelectors?: string[];
  visibleText?: string; ariaLabel?: string; placeholder?: string; section?: string;
  expanded?: string | null; controlsId?: string; required?: boolean;
  value: string; checked: boolean; href: string; min: string; max: string;
  step: string; editable: boolean; context: string; focused?: boolean; verifiedValue?: string;
  availability?: "ready" | "offscreen" | "obscured" | "blocked_by_modal";
  inModal?: boolean;
  options: { value: string; label: string; disabled: boolean }[];
};
export type Observation = { url: string; title?: string; readyState?: string; text: string; controls: Control[]; evidence?: AssertionEvidence[]; activeModals?: { frame: number; text: string }[] };

async function readFrameControls(frame: Frame, frameIndex: number, selectors: string[]) {
  return frame.locator(CONTROL_SELECTOR).evaluateAll(readControls, { frame: frameIndex, selectors });
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

async function readFrame(frame: Frame, index: number, selectors: string[]) {
  try {
    if (frame.parentFrame() && !await (await frame.frameElement()).isVisible()) return { text: "", controls: [] };
    const [text, state, scope, evidence] = await Promise.all([
      frame.locator("body").innerText({ timeout: 1_500 }), readFrameControls(frame, index, selectors), frameScope(frame), frameEvidence(frame, index),
    ]);
    const controls = state.controls.map(control => scope === "blocked" ? { ...control, availability: "blocked_by_modal" as const }
      : scope === "modal" ? { ...control, inModal: true } : control);
    return { text, ...state, controls, evidence: scope === "blocked" ? [] : evidence };
  } catch {
    return { text: "", controls: [] };
  }
}

export async function observe(page: Page, selectors: string[] = []): Promise<Observation> {
  const [frames, metadata] = await Promise.all([
    Promise.all(page.frames().map((frame, index) => readFrame(frame, index, selectors))),
    page.evaluate(() => ({ title: document.title, readyState: document.readyState })),
  ]);
  return {
    ...metadata,
    url: page.url(), text: frames.map((frame) => frame.text).join("\n").slice(0, 24_000),
    controls: frames.flatMap((frame) => frame.controls).sort((a, b) => Number(Boolean(b.inModal)) - Number(Boolean(a.inModal))
      || Number(Boolean(b.matchedSelectors?.length)) - Number(Boolean(a.matchedSelectors?.length))).slice(0, 150),
    evidence: frames.flatMap(frame => "evidence" in frame ? frame.evidence : []).slice(0, 120),
    activeModals: frames.flatMap(frame => "activeModal" in frame && frame.activeModal ? [frame.activeModal] : []),
  };
}

export async function settledObservation(page: Page, signal?: AbortSignal, measure: Measure = unmeasured, selectors: string[] = []) {
  const read = () => measure("playwright", "Ler DOM e controles", () => observe(page, selectors));
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
