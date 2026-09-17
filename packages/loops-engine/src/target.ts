import type { ElementHandle, Page } from "playwright-core";
import { unmeasured, type Measure } from "./timing.js";

type Point = { x: number; y: number };
type Box = Point & { width: number; height: number };
export type PreparedTarget = { box: Box; point: Point; position: Point; viewport: { width: number; height: number } };
type TargetOptions = { target: ElementHandle; page: Page; signal?: AbortSignal; measure?: Measure };
export class TargetBlockedError extends Error {}

async function centerTarget(target: ElementHandle, alignment: "center" | "start" | "end") {
  await target.evaluate((node, block) => (node as Element).scrollIntoView({ block, inline: "center", behavior: "instant" }), alignment);
  const state = { frame: await target.ownerFrame() };
  while (state.frame?.parentFrame()) {
    const element = await state.frame.frameElement();
    try {
      await element.evaluate((node) => (node as Element).scrollIntoView({ block: "center", inline: "center", behavior: "instant" }));
    } finally { await element.dispose(); }
    state.frame = state.frame.parentFrame();
  }
}

async function receivesPoint(target: ElementHandle, point: Point) {
  const box = await target.boundingBox();
  if (!box || box.width <= 0 || box.height <= 0) return false;
  return target.evaluate((node, fraction) => {
    const element = node as Element, rect = element.getBoundingClientRect();
    const x = rect.left + rect.width * fraction.x, y = rect.top + rect.height * fraction.y;
    const state = { hit: element.ownerDocument.elementFromPoint(x, y) };
    while (state.hit?.shadowRoot) {
      const next = state.hit.shadowRoot.elementFromPoint(x, y);
      if (!next || next === state.hit) break;
      state.hit = next;
    }
    return state.hit === element || Boolean(state.hit && element.contains(state.hit));
  }, { x: (point.x - box.x) / box.width, y: (point.y - box.y) / box.height });
}

async function receivesThroughFrames(target: ElementHandle, point: Point) {
  if (!await receivesPoint(target, point)) return false;
  const state = { frame: await target.ownerFrame() };
  while (state.frame?.parentFrame()) {
    const element = await state.frame.frameElement();
    try { if (!await receivesPoint(element, point)) return false; }
    finally { await element.dispose(); }
    state.frame = state.frame.parentFrame();
  }
  return true;
}

function candidatePoints(box: Box, viewport: PreparedTarget["viewport"]) {
  const left = Math.max(12, box.x + 2), top = Math.max(12, box.y + 2);
  const right = Math.min(viewport.width - 12, box.x + box.width - 2);
  const bottom = Math.min(viewport.height - 12, box.y + box.height - 2);
  if (right <= left || bottom <= top) return [];
  return ([[.5, .5], [.25, .25], [.75, .25], [.25, .75], [.75, .75]] as const)
    .map(([x, y]) => ({ x: left + (right - left) * x, y: top + (bottom - top) * y }));
}

async function findPreparedTarget({ target, page }: TargetOptions): Promise<PreparedTarget | null> {
  const box = await target.boundingBox(), viewport = page.viewportSize() ?? { width: 1280, height: 900 };
  if (!box) return null;
  for (const point of candidatePoints(box, viewport)) {
    if (!await receivesThroughFrames(target, point)) continue;
    const position = await target.evaluate((node, fraction) => {
      const element = node as HTMLElement;
      const rect = element.getBoundingClientRect();
      return { x: (element.offsetWidth ?? rect.width) * fraction.x - (element.clientLeft ?? 0),
        y: (element.offsetHeight ?? rect.height) * fraction.y - (element.clientTop ?? 0) };
    }, { x: (point.x - box.x) / box.width, y: (point.y - box.y) / box.height });
    return { box, point, position, viewport };
  }
  return null;
}

export async function prepareTarget(options: TargetOptions): Promise<PreparedTarget> {
  for (const alignment of ["center", "start", "end"] as const) {
    options.signal?.throwIfAborted();
    await centerTarget(options.target, alignment);
    await (options.measure ?? unmeasured)("page", "Estabilizar após rolagem (100 ms)", () => options.page.waitForTimeout(100));
    const prepared = await findPreparedTarget(options);
    if (prepared) return prepared;
  }
  const blocker = await options.target.evaluate(node => {
    const element = node as Element, box = element.getBoundingClientRect();
    const hit = element.ownerDocument.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return hit ? `${hit.tagName} ${hit.getAttribute("role") ?? ""} ${(hit.textContent ?? "").trim().slice(0, 150)}` : "fora da área visível";
  }).catch(() => "alvo removido");
  throw new TargetBlockedError(`Alvo encoberto ou inacessível após reposicionamento (${blocker}). A interação não foi executada.`);
}

export async function targetStillReady(target: ElementHandle, prepared: PreparedTarget) {
  try {
    const box = await target.boundingBox();
    return Boolean(box && Object.keys(box).every(key => Math.abs(box[key as keyof Box] - prepared.box[key as keyof Box]) < 1)
      && await receivesThroughFrames(target, prepared.point));
  } catch { return false; }
}
