import { secretRedactor, maskSecretFields, redactTrace, credentialEvidence } from "./runtime-secrets.js";
import { mkdir, writeFile, rm, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { resolve } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page, type Video } from "playwright-core";
import { actionLabel, buildActions, describeAction, executeAction, type Action, type Interaction } from "./actions.js";
import { settledObservation, type Observation } from "./browser.js";
import { validateConfig, type JourneyConfig } from "./config.js";
import { createDecider } from "./decide.js";
import { extractValues } from "./values.js";
import { selectorReferences } from "./control-references.js";
import { TargetBlockedError } from "./target.js";
import { RunTiming, type TimingSpan } from "./timing.js";
import { StepRecovery, type RecoveryFailure } from "./recovery.js";
import { verifyAssertion, type AssertionResult } from "./assertions.js";
import { paintInteraction } from "./visuals.js";

export type EngineEvent = {
  type: "started" | "observation" | "interaction" | "step_started" | "action" | "step_done" | "finalizing" | "finished" | "timing" | "recovery" | "assertion" | "intervention";
  message?: string; stepIndex?: number; confidence?: number;
  screenshot?: string; url?: string; result?: RunResult;
  interaction?: Interaction; executed?: boolean;
  timing?: TimingSpan;
  assertion?: AssertionResult;
};
export type RunResult = {
  status: string; reason: string; output: string; completedSteps: number;
  totalSteps: number; actions: number; decisions: number; durationMs: number;
  inputTokens: number; outputTokens: number; verification: "text" | "model";
  timings: ReturnType<RunTiming["snapshot"]>;
  assertions: AssertionResult[];
  artifacts: { trace?: string; videos: string[]; errors: string[] };
};
type EngineOptions = { secrets?: Record<string, string>; onIntervention?: (page: () => Page) => Promise<void>; config: JourneyConfig; outputRoot: string; signal?: AbortSignal; visual?: boolean;
  evidenceSecrets?: Record<string, string>; traceExcludeOrigins?: string[];
  captureSession?: { setup: (context: BrowserContext) => Promise<void>; ready: (page: Page) => Promise<void>; finish: (output: string) => Promise<void> };
  onEvent?: (event: EngineEvent) => void; decide?: ReturnType<typeof createDecider> };
type Runtime = {
  page: Page; options: EngineOptions; decide: ReturnType<typeof createDecider>;
  stepIndex: number; history: string[]; records: Record<string, unknown>[]; actions: number;
  inputTokens: number; outputTokens: number; last?: Observation; screenshot?: Buffer;
  lastAction?: { label: string; value: string; previousText: string };
  interactions: unknown[];
  assertions: AssertionResult[];
  artifacts: RunResult["artifacts"];
  timing: RunTiming;
  recovery: StepRecovery;
  recoveries: (RecoveryFailure & { stepIndex: number; attempt: number })[];
  lifecycle: { event: string; timestamp: string; stepIndex: number }[];
};
const MIN_CONFIDENCE = 0.5;

async function capture(runtime: Runtime) {
  assertPageOpen(runtime.page);
  if (runtime.options.captureSession) await withDeadline("Inicializar Collector", 15_000, () => runtime.options.captureSession!.ready(runtime.page));
  runtime.last = await settledObservation(runtime.page, runtime.options.signal, runtime.timing.measure,
    selectorReferences(runtime.options.config.steps[runtime.stepIndex] ?? ""));
  await captureFrame(runtime);
  return runtime.last;
}

async function captureFrame(runtime: Runtime) {
  runtime.screenshot = await runtime.timing.measure("capture", "Capturar tela para observação", () => runtime.page.screenshot({ type: "png", timeout: 3_000 }));
  runtime.options.onEvent?.({ type: "observation", stepIndex: runtime.stepIndex,
    screenshot: `data:image/png;base64,${runtime.screenshot.toString("base64")}`, url: runtime.page.url() });
}

async function selectNext(runtime: Runtime, observation: Observation) {
  const { options, stepIndex } = runtime;
  const actions = runtime.recovery.candidates(buildActions(observation, extractValues(options.config.steps[stepIndex]!)), observation);
  const redactor = secretRedactor(options.secrets);
  const verifiedObservation = await credentialEvidence(runtime.page, observation, options.secrets);
  const decision = await runtime.decide({ ...redactor.redact({ steps: options.config.steps, stepIndex, observation: verifiedObservation,
    actions, stepKind: options.config.stepKinds?.[stepIndex], history: actionEvidence(runtime, observation), failures: runtime.recovery.failures,
    }), signal: options.signal, measure: runtime.timing.measure });
  if (decision.assertion?.evidence) decision.assertion.evidence = observation.evidence?.find(item => item.id === decision.assertion.evidence?.id);
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
  const after = new Set(observation.text.split("\n"));
  const added = observation.text.split("\n").filter((line) => line.trim() && !before.has(line)).slice(0, 30);
  const removed = runtime.lastAction.previousText.split("\n").filter(line => line.trim() && !after.has(line)).slice(0, 30);
  return [...runtime.history.slice(0, -1), JSON.stringify({ interaction: runtime.lastAction.label, execution: "completed", previousValue: runtime.lastAction.value, addedText: added, removedText: removed })];
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
  assertPageOpen(runtime.page);
  const { choice: selected, confidence } = decision.answer;
  if (decision.needsHuman && runtime.options.onIntervention) {
    runtime.options.onEvent?.({ type: 'intervention', message: 'Conclua a autenticação na prévia do app e clique em Continuar.' });
    await runtime.options.onIntervention(() => runtime.page);
    return null;
  }
  if (decision.assertion?.required && (decision.assertion.readOnly || selected === "step_done" || selected === "unsure" || selected === "blocked")) {
    const assertion = await verifyAssertion({ page: runtime.page, stepIndex: runtime.stepIndex,
      instruction: runtime.options.config.steps[runtime.stepIndex]!, ...decision.assertion,
      signal: runtime.options.signal, measure: runtime.timing.measure,
      onInteraction: runtime.options.visual ? (interaction, screenshot) => showInteraction(runtime, interaction, screenshot) : undefined });
    runtime.assertions = [...runtime.assertions.filter(item => item.stepIndex !== runtime.stepIndex), assertion];
    runtime.records.at(-1)!.assertion = assertion;
    runtime.options.onEvent?.({ type: "assertion", stepIndex: runtime.stepIndex, assertion,
      message: `${assertion.status === "passed" ? "Verificação confirmada" : assertion.status === "unverified" ? "Não foi possível verificar" : "Divergência encontrada"}: ${assertion.instruction}` });
    if (assertion.status === "unverified") {
      const exhausted = recover(runtime, { kind: 'uncertain', reason: assertion.reason, outcome: 'not_executed' }, observation);
      return exhausted ? { ...exhausted, status: 'unverified' } : null;
    }
    if (assertion.status === "failed") return { status: "assertion_failed", reason: assertion.reason };
    return completeStep(runtime, confidence);
  }
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
    const executed = await executeAction({ page: runtime.page, observation, action, secrets: runtime.options.secrets, credentialOrigin: new URL(runtime.options.config.url).origin, signal: runtime.options.signal, measure: runtime.timing.measure,
      onInteraction: runtime.options.visual ? (interaction, screenshot) => showInteraction(runtime, interaction, screenshot) : undefined });
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

async function showInteraction(runtime: Runtime, interaction: Interaction, frame?: string) {
  interaction = secretRedactor(runtime.options.secrets).redact(interaction);
  runtime.options.signal?.throwIfAborted();
  if (interaction.phase !== "scrolling") await paintInteraction(runtime.page, interaction);
  const screenshot = frame ?? (interaction.phase === "acting" ? undefined
    : `data:image/jpeg;base64,${(await runtime.timing.measure("capture", "Capturar interação do agente", () => runtime.page.screenshot({ type: "jpeg", quality: 80, timeout: 3_000 }))).toString("base64")}`);
  runtime.interactions.push({ stepIndex: runtime.stepIndex, ...interaction, timestamp: new Date().toISOString() });
  runtime.options.onEvent?.({ type: "interaction", stepIndex: runtime.stepIndex, interaction, screenshot, url: runtime.page.url() });
  const duration = interaction.phase === "target" ? 420 : interaction.phase === "acting" ? 140 : 0;
  if (duration) await runtime.timing.measure("pacing", `Pausa visual do cursor (${duration} ms)`, () => delay(duration, undefined, { signal: runtime.options.signal }));
}

async function navigate(runtime: Runtime) {
  runtime.options.signal?.throwIfAborted();
  await runtime.timing.measure("page", "Abrir URL até DOM pronto", () => runtime.page.goto(runtime.options.config.url, { waitUntil: "domcontentloaded", timeout: 30_000 }));
  await captureFrame(runtime);
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
    : { status: "completed", reason: runtime.options.config.expected.length ? "Passos concluídos e textos esperados encontrados."
      : `Todos os passos concluídos. ${runtime.assertions.length} assert(s) confirmado(s).` };
}

function createResult(runtime: Runtime, output: string, started: number, terminal: { status: string; reason: string }): RunResult {
  return { ...terminal, output, completedSteps: runtime.stepIndex, totalSteps: runtime.options.config.steps.length,
    actions: runtime.actions, decisions: runtime.records.length, durationMs: Math.round(performance.now() - started),
    inputTokens: runtime.inputTokens, outputTokens: runtime.outputTokens,
    verification: runtime.options.config.expected.length ? "text" : "model", timings: runtime.timing.snapshot(),
    assertions: runtime.assertions, artifacts: runtime.artifacts };
}

async function saveResult(runtime: Runtime, result: RunResult) {
  const temporary = resolve(result.output, "result.json.tmp");
  await writeFile(temporary, JSON.stringify(secretRedactor(runtime.options.secrets).redact({ ...result,
    config: runtime.options.config, records: runtime.records, recoveries: runtime.recoveries,
    interactions: runtime.interactions, lifecycle: runtime.lifecycle, finalObservation: runtime.last }), null, 2), { mode: 0o600 });
  await rename(temporary, resolve(result.output, "result.json"));
  if (runtime.screenshot) await writeFile(resolve(result.output, "final.png"), runtime.screenshot);
}

function assertPageOpen(page: Page) {
  if (page.isClosed()) throw new Error("O navegador ou a aba foi fechado antes de concluir a jornada.");
}

async function withDeadline<T>(label: string, durationMs: number, work: () => Promise<T>): Promise<T> {
  const timer: { handle?: ReturnType<typeof setTimeout> } = {};
  try {
    return await Promise.race([Promise.resolve().then(work), new Promise<never>((_, reject) => {
      timer.handle = setTimeout(() => reject(new Error(`${label}: limite de ${durationMs / 1000} s excedido.`)), durationMs);
    })]);
  } finally { clearTimeout(timer.handle); }
}

async function closeAfterSetupFailure(browser: Browser, error: unknown): Promise<never> {
  await withDeadline("Encerrar navegador", 5_000, () => browser.close()).catch(() => undefined);
  throw error;
}

async function saveTrace(runtime: Runtime, context: BrowserContext, output: string) {
  const temporary = resolve(output, "trace.pending.zip");
  const trace = resolve(output, "trace.zip");
  await context.tracing.stop({ path: temporary });
  try {
    await redactTrace(temporary, { ...runtime.options.secrets, ...runtime.options.evidenceSecrets }, runtime.options.traceExcludeOrigins);
    await rename(temporary, trace);
  } catch (error) { await rm(temporary, { force: true }); throw error; }
  return trace;
}

async function finalizeEvidence(deps: { runtime: Runtime; context: BrowserContext; browser: Browser; videos: Video[]; output: string }) {
  const { runtime, context, browser, videos, output } = deps;
  const attempt = async <T>(label: string, durationMs: number, work: () => Promise<T>) => {
    try { return await runtime.timing.measure("engine", label, () => withDeadline(label, durationMs, work)); }
    catch (error) { runtime.artifacts.errors.push(safeError(error)); return undefined; }
  };
  if (runtime.options.captureSession) await attempt("Finalizar Collector", 15_000, () => runtime.options.captureSession!.finish(output));
  runtime.artifacts.trace = await attempt("Salvar trace", 10_000, () => saveTrace(runtime, context, output));
  await attempt("Encerrar contexto", 10_000, () => context.close());
  const saved = await attempt("Finalizar vídeos", 10_000, () => Promise.allSettled(videos.map(async (video, index) => {
    const file = resolve(output, "videos", `page-${index + 1}.webm`);
    await withDeadline("Salvar vídeo", 8_000, () => video.saveAs(file));
    return file;
  })));
  saved?.forEach(result => {
    if (result.status === "fulfilled") runtime.artifacts.videos.push(result.value);
    else runtime.artifacts.errors.push(`Vídeo: ${safeError(result.reason)}`);
  });
  await attempt("Encerrar navegador", 5_000, () => browser.close());
}

function trackBrowserLifecycle(runtime: Runtime, context: BrowserContext, browser: Browser, videos: Video[]) {
  const record = (event: string) => runtime.lifecycle.push({ event, timestamp: new Date().toISOString(), stepIndex: runtime.stepIndex });
  const trackPage = (page: Page) => {
    page.once("close", () => {
      record("page_closed");
      const remaining = context.pages().filter(candidate => !candidate.isClosed()).at(-1);
      if (runtime.page === page && remaining) runtime.page = remaining;
    });
    page.once("crash", () => record("page_crashed"));
  };
  trackPage(runtime.page);
  browser.once("disconnected", () => record("browser_disconnected"));
  context.on("page", page => {
    runtime.page = page; trackPage(page); if (page.video()) videos.push(page.video()!);
  });
}

export async function runEngine(options: EngineOptions): Promise<RunResult> {
  const onEvent = options.onEvent;
  const redact = <T>(value: T) => secretRedactor(options.secrets).redact(value);
  options = { ...options, config: validateConfig(options.config), onEvent: event => onEvent?.(redact(event)) };
  const decide = options.decide ?? createDecider();
  const started = performance.now();
  const timing = new RunTiming((span) => options.onEvent?.({ type: "timing", timing: span }));
  const output = resolve(options.outputRoot, `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID().slice(0, 8)}`);
  await mkdir(output, { recursive: true, mode: 0o700 });
  options.signal?.throwIfAborted();
  const browser = await timing.measure("engine", "Iniciar Chromium", () => chromium.launch({ headless: !options.config.headed }));
  const context = await timing.measure("engine", "Criar contexto do navegador", () => browser.newContext({ viewport: { width: 1280, height: 900 },
    recordVideo: { dir: resolve(output, "videos"), size: { width: 1280, height: 900 } } })).catch(error => closeAfterSetupFailure(browser, error));
  await maskSecretFields(context, options.secrets ?? {}).catch(error => closeAfterSetupFailure(browser, error));
  const runtime: Runtime = { page: await timing.measure("engine", "Criar aba", () => context.newPage()).catch(error => closeAfterSetupFailure(browser, error)), options, decide, timing, stepIndex: 0,
    history: [], records: [], interactions: [], assertions: [], artifacts: { videos: [], errors: [] }, actions: 0, inputTokens: 0, outputTokens: 0,
    recovery: new StepRecovery(), recoveries: [], lifecycle: [] };
  const videos: Video[] = [runtime.page.video()!];
  const cancel = () => { if (!options.captureSession) void Promise.all(context.pages().map(page => page.close().catch(() => undefined))); };
  options.signal?.addEventListener("abort", cancel, { once: true });
  context.setDefaultTimeout(8_000);
  trackBrowserLifecycle(runtime, context, browser, videos);
  await timing.measure("engine", "Iniciar gravação de evidências", () => context.tracing.start({ screenshots: true, snapshots: true }))
    .catch(error => { options.signal?.removeEventListener("abort", cancel); return closeAfterSetupFailure(browser, error); });
  options.onEvent?.({ type: "started", message: "Abrindo o navegador…" });
  const state = { terminal: { status: "error", reason: "" } };
  try {
    await options.captureSession?.setup(context);
    state.terminal = await navigate(runtime);
  } catch (error) {
    state.terminal = { status: options.signal?.aborted ? "cancelled" : error instanceof TargetBlockedError ? "blocked" : "error",
      reason: options.signal?.aborted ? "Execução interrompida." : safeError(error) };
    if (!options.signal?.aborted) await capture(runtime).catch(() => undefined);
  } finally {
    timing.step(null);
    runtime.lifecycle.push({ event: "journey_ended", timestamp: new Date().toISOString(), stepIndex: runtime.stepIndex });
    const checkpoint = createResult(runtime, output, started, state.terminal);
    await saveResult(runtime, checkpoint).catch(error => runtime.artifacts.errors.push(`Resultado parcial: ${safeError(error)}`));
    options.onEvent?.({ type: "finalizing", message: "Jornada encerrada. Finalizando evidências.", result: checkpoint });
    try { await finalizeEvidence({ runtime, context, browser, videos, output }); }
    finally { options.signal?.removeEventListener("abort", cancel); }
  }
  const result = redact(createResult(runtime, output, started, state.terminal));
  await saveResult(runtime, result);
  options.onEvent?.({ type: "finished", result });
  return result;
}

export function safeError(error: unknown) {
  const message = error instanceof Error ? error.message : "Erro desconhecido.";
  return message.replace(/apikey_[\w-]+/g, "[credencial]").slice(0, 1_000);
}
