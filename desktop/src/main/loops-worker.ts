import { runEngine, safeError, secretRedactor, validateConfig } from "@voidr/loops-engine";
import { AiCollectorWorker, type AiCollectorInput } from './ai-collector-worker';
import { JourneyIntervention } from './journey-intervention';

type Port = {
  on: (event: string, listener: (event: { data: unknown }) => void) => void;
  postMessage: (data: unknown) => void;
};
const port = (process as unknown as { parentPort: Port }).parentPort;
const state = { intervention: undefined as JourneyIntervention | undefined, controller: new AbortController(), started: false };
port.on("message", async ({ data }) => {
  const message = data as {
    type: string;
    config?: unknown;
    outputRoot: string;
    secrets?: Record<string, string>;
    collector?: AiCollectorInput;
    input?: unknown;
  };
  if (message.type === "resume") return state.intervention?.resume();
  if (message.type === "input") return state.intervention?.input(message.input);
  if (message.type === "stop") return state.controller.abort();
  if (message.type !== "start" || state.started) return;
  state.started = true;
  const secrets = { ...message.secrets };
  state.intervention = new JourneyIntervention({ signal: state.controller.signal, secrets, emit: event => port.postMessage(secretRedactor(secrets).redact(event)) });
  try {
    await runEngine({
      config: { ...validateConfig(message.config), headed: false },
      outputRoot: message.outputRoot,
      signal: state.controller.signal,
      visual: true,
      secrets,
      captureSession: message.collector ? new AiCollectorWorker(message.collector, secrets) : undefined,
      evidenceSecrets: message.collector ? { COLLECTOR_KEY: String(message.collector.options.apiKey) } : undefined,
      traceExcludeOrigins: message.collector ? [new URL(message.collector.collectorUrl).origin] : undefined,
      onIntervention: page => state.intervention!.wait(page),
      onEvent: (event) => port.postMessage(event),
    });
  } catch (error) {
    port.postMessage({ type: "fatal", message: safeError(error) });
  }
  process.exit(0);
});
