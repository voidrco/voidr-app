import type { ElementHandle, Page } from "playwright-core";
import { CONTROL_SELECTOR, observe, type Control, type Observation } from "./browser.js";
import { prepareTarget, targetStillReady, type PreparedTarget } from "./target.js";
import { unmeasured, type Measure } from "./timing.js";

type ActionKind = "click" | "fill" | "select" | "check" | "uncheck" | "enter";
export type Action = { id: string; kind: ActionKind; control: Control; value?: string };
export type Interaction = {
  phase: "target" | "acting" | "typing" | "settled";
  kind: ActionKind; label: string;
  target?: { x: number; y: number; width: number; height: number };
  point?: { x: number; y: number };
  viewport: { width: number; height: number };
};
type Execution = {
  page: Page; observation: Observation; action: Action; signal?: AbortSignal;
  onInteraction?: (interaction: Interaction) => Promise<void>;
  measure?: Measure;
};
const FORBIDDEN = /desembols|\bpix\b|transferir|efetuar pagamento|pay now|place order|confirm purchase/i;

function fillValues(control: Control, values: string[]) {
  return values.filter((value) => {
    if (value === control.value) return false;
    if (!["number", "range"].includes(control.type)) return true;
    const number = Number(value);
    return Number.isFinite(number) && (!control.min || number >= Number(control.min))
      && (!control.max || number <= Number(control.max));
  });
}

function controlActions(control: Control, values: string[]): Omit<Action, "id">[] {
  if (FORBIDDEN.test(control.name)) return [];
  if (control.tag === "select") {
    return control.options.filter((option) => !option.disabled && option.value !== control.value)
      .map((option) => ({ kind: "select", control, value: option.value }));
  }
  if (control.type === "checkbox") return [{ kind: control.checked ? "uncheck" : "check", control }];
  if (control.type === "radio") return control.checked ? [] : [{ kind: "check", control }];
  if ((["input", "textarea"].includes(control.tag) || control.editable) && !["submit", "button", "reset"].includes(control.type)) {
    const fills: Omit<Action, "id">[] = fillValues(control, values).map((value) => ({ kind: "fill", control, value }));
    return control.tag === "input" && control.value ? [...fills, { kind: "enter", control }] : fills;
  }
  return [{ kind: "click", control }];
}

export function buildActions(observation: Observation, values: string[]) {
  return observation.controls
    .filter((control) => control.availability !== "blocked_by_modal")
    .filter((control) => !control.href || /^https?:/.test(control.href))
    .flatMap((control) => controlActions(control, values))
    .slice(0, 500).map((action, index) => ({ ...action, id: `a${index}` }));
}

export function describeAction(action: Action) {
  const selected = action.control.options.find((option) => option.value === action.value);
  const value = selected?.label ?? action.value;
  const context = action.control.context ? ` within ${JSON.stringify(action.control.context)}` : "";
  return `${action.kind} ${JSON.stringify(action.control.name)}${context}${value === undefined ? "" : ` = ${JSON.stringify(value)}`}`;
}

export function actionLabel(action: Action) {
  const verbs = { click: "Clicar em", fill: "Preencher", select: "Selecionar em", check: "Marcar", uncheck: "Desmarcar", enter: "Pressionar Enter em" };
  const value = action.control.options.find((option) => option.value === action.value)?.label ?? action.value;
  return `${verbs[action.kind]} “${action.control.name}”${value === undefined ? "" : `: ${value}`}`;
}

async function fillControl(target: ElementHandle, deps: Execution) {
  const { action } = deps;
  if (action.control.type !== "range") return fillText(target, deps);
  const increments = Math.round((Number(action.value) - Number(action.control.min || 0)) / Number(action.control.step || 1));
  if (!Number.isFinite(increments) || increments < 0 || increments > 1_000) throw new Error("Valor de slider não suportado.");
  await target.press("Home");
  for (let index = 0; index < increments; index += 1) await target.press("ArrowRight");
}

async function fillText(target: ElementHandle, deps: Execution) {
  const { action, onInteraction } = deps;
  const typeable = ["text", "email", "search", "tel", "url", "textarea", ""].includes(action.control.type) || action.control.editable;
  if (!onInteraction || !typeable || action.value!.length > 200) return target.fill(action.value!);
  await target.fill("");
  const characters = Array.from(action.value!);
  for (let index = 0; index < characters.length; index += 4) {
    deps.signal?.throwIfAborted();
    await (deps.measure ?? unmeasured)("pacing", "Digitação visual (25 ms por tecla)", () => target.type(characters.slice(index, index + 4).join(""), { delay: 25 }));
    await reportInteraction({ target, deps, phase: "typing" });
  }
}

async function reportInteraction({ target, deps, phase, prepared }: {
  target: ElementHandle; deps: Execution; phase: Interaction["phase"]; prepared?: PreparedTarget;
}) {
  if (!deps.onInteraction) return;
  const viewport = deps.page.viewportSize() ?? { width: 1280, height: 900 };
  const box = phase === "settled" ? null : prepared?.box ?? await target.boundingBox();
  const point = prepared?.point ?? (box ? visibleCenter(box, viewport) : undefined);
  await deps.onInteraction({ phase, kind: deps.action.kind, label: actionLabel(deps.action),
    target: box ?? undefined, point, viewport });
}

export function visibleCenter(box: NonNullable<Interaction["target"]>, viewport: Interaction["viewport"]) {
  const left = Math.max(0, box.x), top = Math.max(0, box.y);
  const right = Math.min(viewport.width, box.x + box.width), bottom = Math.min(viewport.height, box.y + box.height);
  return { x: (left + right) / 2, y: (top + bottom) / 2 };
}

async function matchesObservation(deps: Execution) {
  const { page, observation, action } = deps;
  const fresh = await observe(page);
  const current = fresh.controls.find((control) => control.index === action.control.index && control.frame === action.control.frame);
  const stable = (control: Control | undefined) => control && { ...control, availability: undefined };
  return fresh.url === observation.url && current?.availability !== "blocked_by_modal"
    && JSON.stringify(stable(current)) === JSON.stringify(stable(action.control));
}

async function performAction(target: ElementHandle, deps: Execution, prepared: PreparedTarget) {
  const { action } = deps;
  const { position } = prepared;
  if (action.kind === "click") await target.click({ position });
  if (action.kind === "fill") await fillControl(target, deps);
  if (action.kind === "select") await target.selectOption(action.value!);
  if (action.kind === "check") await target.check({ position });
  if (action.kind === "uncheck") await target.uncheck({ position });
  if (action.kind === "enter") await target.press("Enter");
}

export async function executeAction(deps: Execution) {
  const { page, action } = deps;
  const measure = deps.measure ?? unmeasured;
  if (!await measure("playwright", "Revalidar controles", () => matchesObservation(deps))) return false;
  const frame = page.frames()[action.control.frame];
  const target = await frame?.locator(CONTROL_SELECTOR).nth(action.control.index).elementHandle();
  if (!target) return false;
  try {
    if (!await target.isVisible() || !await target.isEnabled()) return false;
    const prepared = await measure("playwright", "Posicionar alvo e verificar obstruções", () => prepareTarget({ target, page, signal: deps.signal, measure }));
    await measure("playwright", "Mover mouse", () => page.mouse.move(prepared.point.x, prepared.point.y, { steps: 12 }));
    await reportInteraction({ target, deps, phase: "target", prepared });
    deps.signal?.throwIfAborted();
    if (!await measure("playwright", "Revalidar alvo após destaque", async () => await matchesObservation(deps) && await targetStillReady(target, prepared))) return false;
    await reportInteraction({ target, deps, phase: "acting", prepared });
    deps.signal?.throwIfAborted();
    if (!await measure("playwright", "Conferir ponto antes de agir", () => targetStillReady(target, prepared))) return false;
    await measure("playwright", actionLabel(action), () => performAction(target, deps, prepared));
    await reportInteraction({ target, deps, phase: "settled" });
    return true;
  } finally {
    await target.dispose();
  }
}
