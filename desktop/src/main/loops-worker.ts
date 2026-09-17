import { runEngine, safeError, validateConfig } from "@voidr/loops-engine";

type Port = {
  on: (event: string, listener: (event: { data: unknown }) => void) => void;
  postMessage: (data: unknown) => void;
};
const port = (process as unknown as { parentPort: Port }).parentPort;
const state = { controller: new AbortController(), started: false };
port.on("message", async ({ data }) => {
  const message = data as {
    type: string;
    config?: unknown;
    outputRoot: string;
  };
  if (message.type === "stop") return state.controller.abort();
  if (message.type !== "start" || state.started) return;
  state.started = true;
  try {
    await runEngine({
      config: validateConfig(message.config),
      outputRoot: message.outputRoot,
      signal: state.controller.signal,
      visual: true,
      onEvent: (event) => port.postMessage(event),
    });
  } catch (error) {
    port.postMessage({ type: "fatal", message: safeError(error) });
  }
  process.exit(0);
});
