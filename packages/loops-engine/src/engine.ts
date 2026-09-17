import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { resolve } from "node:path";
import { chromium, type Page } from "playwright-core";
import { actionLabel, buildActions, describeAction, executeAction, type Action, type Interaction } from "./actions.js";
import { settledObservation, type Observation } from "./browser.js";
import { validateConfig, type JourneyConfig } from "./config.js";
import { createDecider } from "./decide.js";
import { extractValues } from "./values.js";
import { TargetBlockedError } from "./target.js";
import { RunTiming, type TimingSpan } from "./timing.js";
import { StepRecovery, type RecoveryFailure } from "./recovery.js";

export type EngineEvent = {
  type: "started" | "observation" | "interaction" | "step_started" | "action" | "step_done" | "finished" | "timing" | "recovery";
  message?: string; stepIndex?: number; confidence?: number;
  screenshot?: string; url?: string; result?: RunResult;
  interaction?: Interaction; executed?: boolean;
  timing?: TimingSpan;
};
export type RunResult = {
  status: string; reason: string; output: string; completedSteps: number;
  totalSteps: number; actions: number; decisions: number; durationMs: number;
  inputTokens: number; outputTokens: number; verification: "text" | "model";
  timings: ReturnType<RunTiming["snapshot"]>;
};
type EngineOptions = { config: JourneyConfig; outputRoot: string; signal?: AbortSignal; visual?: boolean;
  onEvent?: (event: EngineEvent) => void; decide?: ReturnType<typeof createDecider> };
type Runtime = {
  page: Page; options: EngineOptions; decide: ReturnType<typeof createDecider>;
  stepIndex: number; history: string[]; records: Record<string, unknown>[]; actions: number;
  inputTokens: number; outputTokens: number; last?: Observation; screenshot?: Buffer;
  lastAction?: { label: string; value: string; previousText: string };
  interactions: unknown[];
  timing: RunTiming;
  recovery: StepRecovery;
  recoveries: (RecoveryFailure & { stepIndex: number; attempt: number })[];
};
const MIN_CONFIDENCE = 0.5;

async function capture(runtime: Runtime) {
  runtime.last = await settledObservation(runtime.page, runtime.options.signal, runtime.timing.measure);
  runtime.screenshot = await runtime.timing.measure("capture", "Capturar tela para observação", () => runtime.page.screenshot({ type: "png", timeout: 3_000 }));
  runtime.options.onEvent?.({ type: "observation", stepIndex: runtime.stepIndex,
    screenshot: `data:image/png;base64,${runtime.screenshot.toString("base64")}`, url: runtime.last.url });
  return runtime.last;
}

async function selectNext(runtime: Runtime, observation: Observation) {
  const { options, stepIndex } = runtime;
  const actions = runtime.recovery.candidates(buildActions(observation, extractValues(options.config.steps[stepIndex]!)), observation);
  const decision = await runtime.decide({ steps: options.config.steps, stepIndex, observation,
    actions, history: actionEvidence(runtime, observation), failures: runtime.recovery.failures,
    signal: options.signal, measure: runtime.timing.measure });
  runtime.inputTokens += decision.usage.input_tokens;
  runtime.outputTokens += decision.usage.output_tokens;
  const action = actions.find((candidate) => candidate.id === decision.answer.choice);
  runtime.records.push({ stepIndex, observation, decision, candidates: actions.map(candidate => ({ id: candidate.id, action: describeAction(candidate) })),
    failures: [...runtime.recovery.failures], action: action ? describeAction(action) : decision.answer.choice });
  options.signal?.throwIfAborted();
  return { action, decision };
}

function actionEvidence(runtime: Runtime, observation: Observation) {
  if (!runtime.lastAction) return runtime.history;
  const before = new Set(runtime.lastAction.previousText.split("\n"));
  const added = observation.text.split("\n").filter((line) => line.trim() && !before.has(line)).slice(0, 30);
  return [...runtime.history.slice(0, -1), `Browser interaction completed: ${runtime.lastAction.label}. This does not prove the step succeeded. Input value before action: ${JSON.stringify(runtime.lastAction.value)}. Observed new text after the action: ${JSON.stringify(added)}.`];
}

function recover(runtime: Runtime, failure: RecoveryFailure, observation: Observation, action?: Action) {
  const retry = runtime.recovery.fail(failure, observation, action);
  const attempt = runtime.recovery.failures.length;
  runtime.recoveries.push({ ...runtime.recovery.failures.at(-1)!, stepIndex: runtime.stepIndex, attempt });
  runtime.options.onEvent?.({ type: "recovery", stepIndex: runtime.stepIndex,
    message: retry ? `Recuperação ${attempt}/3: ${failure.reason} Observando novamente para buscar outra ação.` : `Recuperações esgotadas: ${failure.reason}` });
  return retry ? null : { status: failure.kind === "blocked" ? "blocked" : "uncertain",
    reason: `Não foi possível concluir o passo após 3 recuperações. ${failure.reason}` };
}

function completeStep(runtime: Runtime, confidence: number) {
  runtime.options.onEvent?.({ type: "step_done", stepIndex: runtime.stepIndex, confidence, message: runtime.options.config.steps[runtime.stepIndex] });
  Object.assign(runtime, { stepIndex: runtime.stepIndex + 1, history: [], lastAction: undefined, recovery: new StepRecovery() });
  return null;
}

async function advance(runtime: Runtime) {
  runtime.timing.step(runtime.stepIndex);
  runtime.options.onEvent?.({ type: "step_started", stepIndex: runtime.stepIndex });
  const observation = await capture(runtime);
  const { action, decision } = await selectNext(runtime, observation);
  const { choice: selected, confidence } = decision.answer;
  if ((confidence < MIN_CONFIDENCE || decision.requiresVerification) && !decision.actionVerified) {
    return recover(runtime, { kind: "uncertain", reason: "A ação proposta não teve confiança suficiente.", outcome: "not_executed" }, observation, action);
  }
  if (selected === "step_done") return completeStep(runtime, confidence);
  if (selected === "blocked") return { status: "blocked", reason: "Este passo encontrou uma rejeição ou exige dados não fornecidos. Consulte as evidências." };
  if (!action) return recover(runtime, { kind: "no_action", reason: "Não foi encontrada uma ação válida para concluir o objetivo.", outcome: "not_executed" }, observation);
  return performNext({ runtime, observation, action, confidence });
}

async function performNext({ runtime, observation, action, confidence }: { runtime: Runtime; observation: Observation; action: Action; confidence: number }) {
  runtime.options.signal?.throwIfAborted();
  try {
    const executed = await executeAction({ page: runtime.page, observation, action, signal: runtime.options.signal, measure: runtime.timing.measure,
      onInteraction: runtime.options.visual ? (interaction) => showInteraction(runtime, interaction) : undefined });
    runtime.records.at(-1)!.execution = executed ? "interaction_completed" : "not_executed";
    if (!executed) return recover(runtime, { kind: "stale", reason: "O alvo mudou antes da interação.", outcome: "not_executed" }, observation, action);
    runtime.history.push(describeAction(action));
    runtime.actions += 1;
    runtime.recovery.executed(action, observation);
    runtime.lastAction = { label: actionLabel(action), value: action.control.value, previousText: observation.text };
    runtime.options.onEvent?.({ type: "action", stepIndex: runtime.stepIndex, confidence, executed: true, message: actionLabel(action) });
    return null;
  } catch (error) {
    runtime.options.signal?.throwIfAborted();
    if (runtime.page.isClosed()) throw error;
    const blocked = error instanceof TargetBlockedError;
    const failure: RecoveryFailure = { kind: blocked ? "blocked" : "unconfirmed", reason: safeError(error), outcome: blocked ? "not_executed" : "unknown" };
    runtime.records.at(-1)!.execution = failure;
    return recover(runtime, failure, observation, action);
  }
}

async function showInteraction(runtime: Runtime, interaction: Interaction) {
  runtime.options.signal?.throwIfAborted();
  const screenshot = interaction.phase === "acting" ? undefined
    : `data:image/jpeg;base64,${(await runtime.timing.measure("capture", "Capturar interação do agente", () => runtime.page.screenshot({ type: "jpeg", quality: 80, timeout: 3_000 }))).toString("base64")}`;
  runtime.interactions.push({ stepIndex: runtime.stepIndex, ...interaction, timestamp: new Date().toISOString() });
  runtime.options.onEvent?.({ type: "interaction", stepIndex: runtime.stepIndex, interaction, screenshot, url: runtime.page.url() });
  const duration = interaction.phase === "target" ? 420 : interaction.phase === "acting" ? 140 : 0;
  if (duration) await runtime.timing.measure("pacing", `Pausa visual do cursor (${duration} ms)`, () => delay(duration, undefined, { signal: runtime.options.signal }));
}

async function navigate(runtime: Runtime) {
  runtime.options.signal?.throwIfAborted();
  await runtime.timing.measure("page", "Abrir URL até DOM pronto", () => runtime.page.goto(runtime.options.config.url, { waitUntil: "domcontentloaded", timeout: 30_000 }));
  for (let index = 0; index < runtime.options.config.maxActions; index += 1) {
    runtime.options.signal?.throwIfAborted();
    if (runtime.stepIndex >= runtime.options.config.steps.length) break;
    const terminal = await advance(runtime);
    if (terminal) return terminal;
  }
  runtime.timing.step(null);
  const final = await capture(runtime);
  if (runtime.stepIndex < runtime.options.config.steps.length) return { status: "step_limit", reason: "Limite de decisões atingido." };
  const missing = runtime.options.config.expected.filter((text) => !final.text.includes(text));
  return missing.length ? { status: "assertion_failed", reason: `Textos não encontrados: ${missing.join("; ")}` }
    : { status: "completed", reason: runtime.options.config.expected.length ? "Passos concluídos e textos esperados encontrados." : "Todos os passos foram avaliados como concluídos pelo Jev." };
}

function createResult(runtime: Runtime, output: string, started: number, terminal: { status: string; reason: string }): RunResult {
  return { ...terminal, output, completedSteps: runtime.stepIndex, totalSteps: runtime.options.config.steps.length,
    actions: runtime.actions, decisions: runtime.records.length, durationMs: Math.round(performance.now() - started),
    inputTokens: runtime.inputTokens, outputTokens: runtime.outputTokens,
    verification: runtime.options.config.expected.length ? "text" : "model", timings: runtime.timing.snapshot() };
}

async function saveResult(runtime: Runtime, result: RunResult) {
  await writeFile(resolve(result.output, "result.json"), JSON.stringify({ ...result,
    config: runtime.options.config, records: runtime.records, recoveries: runtime.recoveries,
    interactions: runtime.interactions, finalObservation: runtime.last }, null, 2), { mode: 0o600 });
  if (runtime.screenshot) await writeFile(resolve(result.output, "final.png"), runtime.screenshot);
}

export async function runEngine(options: EngineOptions): Promise<RunResult> {
  options = { ...options, config: validateConfig(options.config) };
  const decide = options.decide ?? createDecider();
  const started = performance.now();
  const timing = new RunTiming((span) => options.onEvent?.({ type: "timing", timing: span }));
  const output = resolve(options.outputRoot, `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID().slice(0, 8)}`);
  await mkdir(output, { recursive: true, mode: 0o700 });
  options.signal?.throwIfAborted();
  const browser = await timing.measure("engine", "Iniciar Chromium", () => chromium.launch({ headless: !options.config.headed }));
  const context = await timing.measure("engine", "Criar contexto do navegador", () => browser.newContext({ viewport: { width: 1280, height: 900 } }));
  const runtime: Runtime = { page: await timing.measure("engine", "Criar aba", () => context.newPage()), options, decide, timing, stepIndex: 0,
    history: [], records: [], interactions: [], actions: 0, inputTokens: 0, outputTokens: 0,
    recovery: new StepRecovery(), recoveries: [] };
  const cancel = () => { void browser.close(); };
  options.signal?.addEventListener("abort", cancel, { once: true });
  context.setDefaultTimeout(8_000);
  context.on("page", (page) => { runtime.page = page; });
  await timing.measure("engine", "Iniciar gravação de evidências", () => context.tracing.start({ screenshots: true, snapshots: true }));
  options.onEvent?.({ type: "started", message: "Abrindo o navegador…" });
  const state = { terminal: { status: "error", reason: "" } };
  try {
    state.terminal = await navigate(runtime);
  } catch (error) {
    state.terminal = { status: options.signal?.aborted ? "cancelled" : error instanceof TargetBlockedError ? "blocked" : "error",
      reason: options.signal?.aborted ? "Execução interrompida." : safeError(error) };
    if (!options.signal?.aborted) await capture(runtime).catch(() => undefined);
  } finally {
    timing.step(null);
    await timing.measure("engine", "Salvar trace", () => context.tracing.stop({ path: resolve(output, "trace.zip") })).catch(() => undefined);
    await timing.measure("engine", "Encerrar navegador", () => browser.close());
    options.signal?.removeEventListener("abort", cancel);
  }
  const result = createResult(runtime, output, started, state.terminal);
  await saveResult(runtime, result);
  options.onEvent?.({ type: "finished", result });
  return result;
}

export function safeError(error: unknown) {
  const message = error instanceof Error ? error.message : "Erro desconhecido.";
  return message.replace(/apikey_[\w-]+/g, "[credencial]").slice(0, 1_000);
}
