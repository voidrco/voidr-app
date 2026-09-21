import { app, shell } from 'electron';
import { mkdir, readFile, writeFile, rename, stat, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { LocalRuntimeConfig } from '@voidr/capture-contracts';
import { aiScenarioSchema, aiRunSchema, type AiJourney, type AiRequest, type AiResult, type AiRun, type AiState } from '../shared/ai-tester';
import type { JourneyEvent, JourneyState } from '../shared/journeys';
import { LoopsController } from './loops-controller';
import type { VoidrServiceClient } from './service-client';
import { newAiCapture, prepareAiCapture, syncAiCapture, type AiCaptureRecord } from './ai-collector-session';

type Session = { client: VoidrServiceClient; accessToken?: string };
type Api = <T>(path?: string, body?: unknown) => Promise<T>;
type UploadFile = { journeyId: string; name: string; file: string; contentType: string; uploaded?: boolean };
type Journal = { run: AiRun; executorId: string; organizationId: string; serviceUrl: string; files: UploadFile[]; captures?: AiCaptureRecord[]; sequence: number; pending?: Record<string, unknown> };
const terminal = (status: string) => ['completed', 'cancelled', 'interrupted', 'blocked', 'planning_failed'].includes(status);
const runResult = (journey: AiJourney, state: JourneyState): AiResult => ({
  journeyId: journey.id, outcome: state.result?.status === 'completed' ? 'passed'
    : state.result?.status === 'assertion_failed' ? 'divergence' : state.result?.status === 'cancelled' ? 'cancelled' : 'unable_to_verify',
  reason: state.result?.reason || state.error || 'O executor encerrou sem um resultado verificável.',
  completedSteps: state.result?.completedSteps ?? 0, durationMs: state.result?.durationMs ?? 0,
  assertions: (state.result?.assertions ?? []).map(({ stepIndex, status, reason }) => ({ stepIndex, status, reason })),
});
const skipped = (journey: AiJourney, cancelled: boolean): AiResult => ({ journeyId: journey.id,
  outcome: cancelled ? 'cancelled' : 'blocked', reason: cancelled ? 'Execução cancelada antes desta jornada.' : journey.blockers.join('; ').slice(0, 2000),
  completedSteps: 0, durationMs: 0, assertions: [] });

export class AiTesterController {
  private state: AiState = { busy: false, uploadPending: false };
  private current?: { journal: Journal; api: Api; runtime: LocalRuntimeConfig; controller: AbortController };
  private queue: Promise<void> = Promise.resolve();
  private get root() { return path.join(app.getPath('userData'), 'loops', 'ai-tester'); }
  constructor(private readonly deps: { loops: LoopsController; session: (runtime: LocalRuntimeConfig) => Promise<Session>; publish: (state: AiState) => void }) {}
  status() { return this.state; }
  clear() {
    if (this.state.busy) throw new Error('Aguarde a execução terminar.');
    this.deps.loops.showStandalone();
    return this.publish({ run: undefined, error: undefined, uploadPending: false });
  }
  private publish(patch: Partial<AiState>) { this.state = { ...this.state, ...patch }; this.deps.publish(this.state); return this.state; }
  private async api(input: AiRequest): Promise<Api> {
    const session = await this.deps.session(input.runtime);
    return <T>(suffix = '', body?: unknown) => session.client.aiTesterRequest<T>({ loopId: input.loopId, path: suffix, body, accessToken: session.accessToken });
  }
  async scenarios(input: AiRequest) { return z.array(aiScenarioSchema).parse(await (await this.api(input))('/scenarios')); }
  async preparation(input: AiRequest) {
    const response = await (await this.api(input))('/preparation');
    return z.object({ preparation: aiRunSchema.nullable() }).parse(response).preparation;
  }
  async list(input: AiRequest) { return z.array(aiRunSchema).parse(await (await this.api(input))()); }
  async view(input: AiRequest) {
    const runId = z.string().uuid().parse(input.runId);
    const run = aiRunSchema.parse(await (await this.api(input))(`/${runId}`));
    if (this.state.busy) return this.state;
    const journal = await this.readJournal(runId, input.runtime).catch(() => undefined);
    return this.publish({ run: journal?.pending ? journal.run : run, uploadPending: Boolean(journal?.pending || journal?.files.some(file => !file.uploaded) || journal?.captures?.some(capture => !capture.synced) || (journal && ['running', 'awaiting_intervention'].includes(run.status))), error: undefined });
  }
  private async persist(journal: Journal) {
    const directory = path.join(this.root, journal.run.runId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, 'manifest.json');
    await writeFile(`${file}.tmp`, JSON.stringify(journal), { mode: 0o600 });
    await rename(`${file}.tmp`, file);
  }
  private async readJournal(runId: string, runtime: LocalRuntimeConfig): Promise<Journal> {
    const journal = JSON.parse(await readFile(path.join(this.root, runId, 'manifest.json'), 'utf8')) as Journal;
    if (journal.organizationId !== runtime.organizationId || journal.serviceUrl !== runtime.serviceUrl) throw new Error('Workspace diferente do executor original.');
    return journal;
  }
  async start(input: AiRequest) {
    if (this.state.busy && input.runId && input.runId === this.state.run?.runId) return this.state;
    if (this.state.busy) throw new Error('Já existe uma execução de IA em andamento.');
    this.deps.loops.reserve();
    this.publish({ busy: true, error: undefined, run: undefined, uploadPending: false });
    try {
      const api = await this.api(input);
      const run = input.runId ? aiRunSchema.parse(await api(`/${z.string().uuid().parse(input.runId)}`)) : await this.requestRun(input, api);
      if (terminal(run.status)) {
        this.deps.loops.release();
        return this.publish({ busy: false, run });
      }
      const previous = input.runId ? await this.readJournal(input.runId, input.runtime).catch(() => undefined) : undefined;
      const journal: Journal = previous ?? { run, executorId: randomUUID(), files: [], sequence: 0,
        organizationId: input.runtime.organizationId, serviceUrl: input.runtime.serviceUrl };
      journal.run = run;
      await this.persist(journal);
      this.current = { journal, api, runtime: input.runtime, controller: new AbortController() };
      this.publish({ run });
      void this.execute().catch(() => undefined);
      return this.state;
    } catch (error) { this.deps.loops.release(); this.publish({ busy: false, error: 'Não foi possível solicitar o Voidr AI.' }); throw error; }
  }
  private async requestRun(input: AiRequest, api: Api) {
    const id = createHash('sha256').update(`${input.runtime.serviceUrl}/${input.runtime.organizationId}/${input.loopId}`).digest('hex');
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const file = path.join(this.root, `request-${id}.json`);
    const pending = await readFile(file, 'utf8').then(JSON.parse).catch(() => ({ requestId: randomUUID() }));
    await writeFile(file, JSON.stringify(pending), { mode: 0o600 });
    const run = aiRunSchema.parse(await api('', pending));
    await rm(file, { force: true });
    return run;
  }

  private enqueue(operation: () => Promise<void>) {
    this.queue = this.queue.then(operation).catch(() => { this.publish({ uploadPending: true, error: 'Resultados locais preservados. O envio será retomado sem executar novamente.' }); });
    return this.queue;
  }
  private async progress(status: string, event?: JourneyEvent) {
    const current = this.current!;
    const journal = current.journal;
    journal.sequence += 1;
    journal.run = { ...journal.run, status, stepIndex: event?.stepIndex ?? journal.run.stepIndex };
    journal.pending = { executorId: journal.executorId, sequence: journal.sequence, status,
      journeyId: journal.run.journeyId, stepIndex: journal.run.stepIndex, results: journal.run.results };
    await this.persist(journal);
    this.publish({ run: journal.run });
    await current.api(`/${journal.run.runId}/progress`, journal.pending);
    journal.pending = undefined;
    await this.persist(journal);
  }
  private async waitForPlan() {
    const current = this.current!;
    while (current.journal.run.status === 'planning') {
      await delay(2000, undefined, { signal: current.controller.signal });
      current.journal.run = aiRunSchema.parse(await current.api(`/${current.journal.run.runId}`));
      this.publish({ run: current.journal.run });
    }
    await this.persist(current.journal);
  }
  private async execute() {
    const current = this.current!;
    const heartbeat = setInterval(() => { void this.enqueue(async () => {
      const remote = aiRunSchema.parse(await current.api(`/${current.journal.run.runId}`));
      if (remote.cancelRequested) { current.controller.abort(); this.deps.loops.stop(); }
    }); }, 15_000);
    try {
      await this.waitForPlan();
      if (terminal(current.journal.run.status)) return;
      current.controller.signal.throwIfAborted();
      const prefix = `/${current.journal.run.runId}`;
      await current.api(`${prefix}/claim`, { executorId: current.journal.executorId });
      const secrets = z.record(z.string(), z.string()).parse(await current.api(`${prefix}/credentials`, { executorId: current.journal.executorId }));
      for (const journey of current.journal.run.plan!.journeys.filter(item => !current.journal.run.results.some(result => result.journeyId === item.id))) await this.executeJourney(journey, secrets);
      await this.enqueue(() => this.progress(current.controller.signal.aborted ? 'cancelled' : 'completed'));
      await this.upload(current.journal, current.api, current.runtime);
    } catch {
      if (current.journal.run.status === 'planning' && current.controller.signal.aborted) current.journal.run.status = 'cancelled';
      if (current.journal.run.status !== 'planning' && !terminal(current.journal.run.status))
        await this.enqueue(() => this.progress(current.controller.signal.aborted ? 'cancelled' : 'interrupted'));
      await this.persist(current.journal);
      this.publish({ run: current.journal.run, error: 'A execução foi interrompida. Resultados parciais foram preservados.', uploadPending: true });
    } finally {
      clearInterval(heartbeat);
      await this.queue;
      this.current = undefined;
      this.deps.loops.release();
      this.publish({ busy: false });
    }
  }
  private async executeJourney(journey: AiJourney, secrets: Record<string, string>) {
    const { journal, controller } = this.current!;
    journal.run.journeyId = journey.id;
    if (controller.signal.aborted || journey.blockers.length) {
      journal.run.results = [...journal.run.results, skipped(journey, controller.signal.aborted)];
      await this.enqueue(() => this.progress('running'));
      return;
    }
    await this.enqueue(() => this.progress('running'));
    const capture = newAiCapture(journey.id);
    journal.captures = [...journal.captures ?? [], capture];
    await this.persist(journal);
    const prepared = await prepareAiCapture({ runtime: this.current!.runtime, api: this.current!.api, run: journal.run, executorId: journal.executorId, capture });
    await this.persist(journal);
    await prepared.client.verificationIngest(prepared.authorization, 'lifecycle-events', {
      version: 'HIL/1', lifecycleVersion: prepared.authorization.safeContext.lifecycleVersion,
      idempotencyKey: `ai-start:${capture.generation}`, type: 'recording.started', occurredAt: new Date().toISOString(), payload: { host: 'ai-tester', platform: 'web' },
    });
    const state = await this.deps.loops.executePlanned({
      runId: journal.run.runId,
      config: { url: journal.run.targetUrl, steps: journey.steps.map(step => step.instruction), stepKinds: journey.steps.map(step => step.kind), expected: [], headed: false, maxActions: 100 },
      secrets, collector: prepared.collector, outputRoot: path.join(this.root, journal.run.runId, journey.id),
      onEvent: event => { if (['step_started', 'step_done', 'intervention'].includes(event.type))
        void this.enqueue(() => this.progress(event.type === 'intervention' ? 'awaiting_intervention' : 'running', event)); },
    });
    await this.queue;
    journal.run.results = [...journal.run.results, runResult(journey, state)];
    capture.output = state.result?.output;
    if (state.result) journal.files = [...journal.files, ...await this.resultFiles(journey.id, state.result)];
    await this.enqueue(() => this.progress('running'));
  }
  private async resultFiles(journeyId: string, result: NonNullable<JourneyState['result']>): Promise<UploadFile[]> {
    const files = [{ journeyId, name: 'result.json', file: path.join(result.output, 'result.json'), contentType: 'application/json' },
      { journeyId, name: 'final.png', file: path.join(result.output, 'final.png'), contentType: 'image/png' },
      ...(result.artifacts?.trace ? [{ journeyId, name: 'trace.zip', file: result.artifacts.trace, contentType: 'application/zip' }] : []),
      ...(result.artifacts?.videos ?? []).map((file, index) => ({ journeyId, name: `page-${index + 1}.webm`, file, contentType: 'video/webm' }))];
    const existing = await Promise.all(files.map(async file => await stat(file.file).then(() => file, () => undefined)));
    return existing.filter((file): file is UploadFile => Boolean(file));
  }
  private async upload(journal: Journal, api: Api, runtime: LocalRuntimeConfig) {
    for (const file of journal.files.filter(item => !item.uploaded)) {
      const bytes = await readFile(file.file);
      const prefix = `/${journal.run.runId}/artifacts`;
      const contract = await api<{ id: string; uploaded: boolean; upload?: { uploadUrl: string; method?: string; headers?: Record<string, string>; formFields?: Record<string, string> } }>(prefix,
        { executorId: journal.executorId, artifact: { journeyId: file.journeyId, name: file.name, contentType: file.contentType, size: bytes.length } });
      if (!contract.uploaded) await this.sendFile(contract.upload!, file, bytes);
      await api(`${prefix}/${contract.id}/confirm`, { executorId: journal.executorId });
      file.uploaded = true;
      await this.persist(journal);
    }
    const sync = { failed: false };
    for (const capture of journal.captures ?? []) await syncAiCapture({ runtime, api, run: journal.run,
      executorId: journal.executorId, capture, persist: () => this.persist(journal) }).catch(() => { sync.failed = true; });
    if (sync.failed) throw new Error('Há gravações do Collector pendentes. Reenvie as evidências para concluir.');
    if (!journal.pending) journal.run = aiRunSchema.parse(await api(`/${journal.run.runId}`));
    this.publish({ run: journal.run, uploadPending: Boolean(journal.pending), error: undefined });
  }
  private async sendFile(upload: { uploadUrl: string; method?: string; headers?: Record<string, string>; formFields?: Record<string, string> }, file: UploadFile, bytes: Buffer) {
    const blob = new Blob([new Uint8Array(bytes)], { type: file.contentType });
    const form = new FormData();
    Object.entries(upload.formFields ?? {}).forEach(([key, value]) => form.append(key, value));
    form.append('file', blob, file.name);
    const response = await fetch(upload.uploadUrl, { method: upload.method ?? 'PUT', signal: AbortSignal.timeout(120_000),
      headers: upload.method === 'POST' ? upload.headers : { 'Content-Type': file.contentType, ...upload.headers }, body: upload.method === 'POST' ? form : blob });
    if (!response.ok && ![409, 412].includes(response.status)) throw new Error('Falha ao enviar evidência.');
  }
  async retry(input: AiRequest) {
    if (this.state.busy || this.deps.loops.running) throw new Error('Aguarde a execução terminar.');
    const runId = z.string().uuid().parse(input.runId);
    const journal = await this.readJournal(runId, input.runtime);
    const api = await this.api(input);
    this.publish({ busy: true });
    try {
      await this.recoverInterrupted(journal);
      if (journal.pending) { await api(`/${runId}/progress`, journal.pending); journal.pending = undefined; await this.persist(journal); }
      await this.upload(journal, api, input.runtime);
    } finally { this.publish({ busy: false }); }
    return this.state;
  }
  private async recoverInterrupted(journal: Journal) {
    if (terminal(journal.run.status)) return;
    const journeys = journal.run.plan?.journeys ?? [];
    for (const journey of journeys.filter(item => !journal.run.results.some(result => result.journeyId === item.id))) {
      const directory = path.join(this.root, journal.run.runId, journey.id);
      const entries = await readdir(directory).catch(() => []);
      for (const entry of entries) {
        const saved = await readFile(path.join(directory, entry, 'result.json'), 'utf8').then(JSON.parse).catch(() => undefined);
        if (!saved) continue;
        journal.run.results.push(runResult(journey, { result: saved } as JourneyState));
        const capture = journal.captures?.find(item => item.journeyId === journey.id);
        if (capture) capture.output = saved.output;
        journal.files.push(...await this.resultFiles(journey.id, saved));
        break;
      }
    }
    journal.sequence += 1;
    journal.run.status = 'interrupted';
    journal.pending = { executorId: journal.executorId, sequence: journal.sequence, status: 'interrupted', results: journal.run.results };
    await this.persist(journal);
  }
  async cancel() {
    if (!this.current) return this.state;
    this.current.controller.abort();
    this.deps.loops.stop();
    await this.current.api(`/${this.current.journal.run.runId}/cancel`, {});
    return this.state;
  }
  resume() { this.deps.loops.resume(); return this.state; }
  async artifact(input: AiRequest & { artifactId: string }) {
    const result = await (await this.api(input))<{ url: string }>(`/${z.string().uuid().parse(input.runId)}/artifacts/${encodeURIComponent(input.artifactId)}`);
    if (!/^https?:\/\//.test(result.url)) throw new Error('Endereço de evidência inválido.');
    await shell.openExternal(result.url);
  }
}
