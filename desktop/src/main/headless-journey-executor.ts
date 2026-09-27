import { runEngine, secretRedactor, validateConfig } from '@voidr/loops-engine';
import { applyJourneyEvent, journeyEventSchema, type JourneyState } from '../shared/journeys';
import { AiCollectorWorker } from './ai-collector-worker';
import type { AiJourneyExecutor, PlannedJourney } from './ai-journey-executor';

/** Uses the same browser engine, Collector and evidence capture as the desktop. */
export class HeadlessJourneyExecutor implements AiJourneyExecutor {
  private reserved = false;
  private controller?: AbortController;
  private stopped = false;

  constructor(private readonly engine: typeof runEngine = runEngine) {}
  get running() { return this.reserved || Boolean(this.controller); }
  reserve() {
    if (this.running) throw new Error('Já existe uma jornada em execução.');
    this.reserved = true;
    this.stopped = false;
  }
  release() {
    if (this.controller) throw new Error('Aguarde o navegador finalizar as evidências.');
    this.reserved = false;
  }
  showStandalone() {
    if (this.running) throw new Error('Aguarde a execução terminar.');
  }
  stop() { this.stopped = true; this.controller?.abort(); }
  resume() { throw new Error('Interação humana requer um executor com interface.'); }

  async executePlanned(input: PlannedJourney): Promise<JourneyState> {
    if (!this.reserved || this.controller) throw new Error('O executor não está disponível.');
    const config = { ...validateConfig(input.config), headed: false };
    const controller = new AbortController();
    this.controller = controller;
    if (this.stopped) controller.abort();
    const secrets = { ...input.secrets };
    let state: JourneyState = { revision: 0, running: true, stopping: false, configured: true,
      config, example: config, managed: true, managedRunId: input.runId,
      stepIndex: 0, completedSteps: 0, events: [], timings: [] };
    const emit = (value: unknown) => {
      const event = journeyEventSchema.parse(secretRedactor(secrets).redact(value));
      state = applyJourneyEvent(state, event);
      input.onEvent(event);
    };
    try {
      controller.signal.throwIfAborted();
      const result = await this.engine({ config, outputRoot: input.outputRoot,
        signal: controller.signal, visual: true, secrets,
        captureSession: input.collector ? new AiCollectorWorker(input.collector, secrets) : undefined,
        evidenceSecrets: input.collector ? { COLLECTOR_KEY: String(input.collector.options.apiKey) } : undefined,
        traceExcludeOrigins: input.collector ? [new URL(input.collector.collectorUrl).origin] : undefined,
        onIntervention: async () => { throw new Error('Validação bloqueada: é necessária intervenção humana em um executor com interface.'); },
        onEvent: emit,
      });
      // The return value is authoritative even if a transport missed the final event.
      state = applyJourneyEvent(state, journeyEventSchema.parse(secretRedactor(secrets).redact({ type: 'finished', result })));
    } catch {
      emit({ type: 'fatal', message: controller.signal.aborted
        ? 'Execução cancelada. Evidências parciais podem estar disponíveis.'
        : 'Não foi possível concluir a jornada. Verifique o acesso do executor e as evidências parciais.' });
    } finally {
      this.controller = undefined;
    }
    return state;
  }
}
