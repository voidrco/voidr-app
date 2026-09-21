import path from "node:path";
import { redactText } from "@voidr/capture-contracts";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import {
  app,
  dialog,
  ipcMain,
  shell,
  utilityProcess,
  type BrowserWindow,
  type UtilityProcess,
} from "electron";
import { example } from "@voidr/loops-engine";
import {
  applyJourneyEvent,
  journeyConfigSchema,
  journeyEventSchema,
  journeyInputSchema,
  type JourneyState,
  type JourneyEvent,
} from "../shared/journeys";

export class LoopsController {
  onManagedStop?: () => Promise<unknown>;
  private reserved = false;
  private managed?: { resolve: (state: JourneyState) => void; onEvent: (event: JourneyEvent) => void };
  private worker?: UtilityProcess;
  private stopTimer?: ReturnType<typeof setTimeout>;
  private envFile?: string;
  private state: JourneyState = {
    revision: 0,
    running: false,
    stopping: false,
    configured: false,
    config: { ...example, headed: false, maxActions: 60 },
    example: { ...example, headed: false, maxActions: 60 },
    stepIndex: 0,
    completedSteps: 0,
    events: [],
    timings: [],
  };

  constructor(
    private deps: {
      window: () => BrowserWindow | undefined;
      assertSender: (event: Electron.IpcMainInvokeEvent) => void;
      captureBusy: () => boolean;
      directory: string;
    },
  ) {}

  get running() {
    return this.reserved || this.state.running || Boolean(this.worker);
  }
  reserve() {
    if (this.running || this.deps.captureBusy()) throw new Error('Já existe uma captura ou jornada em execução.');
    if (!this.state.configured) throw new Error('Configure o acesso do Voidr AI em Voidr AI.');
    this.reserved = true;
  }

  release() { this.reserved = false; }

  showStandalone() {
    if (this.running) throw new Error('Aguarde a execução terminar.');
    this.state = { ...this.state, managed: false, managedRunId: undefined, finalizing: false, result: undefined, error: undefined, events: [], timings: [] };
    return this.publish();
  }

  resume() { if (this.state.intervening && !this.state.stopping) this.worker?.postMessage({ type: 'resume' }); }

  private input(input: unknown) {
    if (!this.state.running || !this.state.intervening || this.state.stopping) throw new Error('O navegador não está aguardando sua interação.');
    this.worker?.postMessage({ type: 'input', input: journeyInputSchema.parse(input) });
  }

  async executePlanned(input: { runId: string; config: unknown; secrets: Record<string, string>; collector?: import('./ai-collector-worker').AiCollectorInput; outputRoot: string; onEvent: (event: JourneyEvent) => void }) {
    if (!this.reserved || this.worker) throw new Error('O executor não está disponível.');
    const completed = new Promise<JourneyState>(resolve => { this.managed = { resolve, onEvent: input.onEvent }; });
    await this.start(input.config, input);
    if (!this.worker && this.managed) { this.managed.resolve(this.state); this.managed = undefined; }
    return completed;
  }

  private get root() {
    return path.join(app.getPath("userData"), "loops");
  }
  private publish() {
    this.state.revision += 1;
    const window = this.deps.window();
    if (window && !window.isDestroyed())
      window.webContents.send("journeys:changed", this.state);
    return this.state;
  }

  private async readConnection(root: string) {
    try {
      const connection = JSON.parse(
        await readFile(path.join(root, "connection.json"), "utf8"),
      );
      if (
        typeof connection.envFile === "string" &&
        path.isAbsolute(connection.envFile)
      )
        return connection.envFile as string;
    } catch {}
  }

  async initialize() {
    this.envFile = await this.readConnection(this.root);
    if (!this.envFile && !app.isPackaged && process.env.VOIDR_CAPTURE_DEV_SERVER_URL
      && !process.env.VOIDR_CAPTURE_DEV_USER_DATA_DIR) {
      this.envFile = await this.readConnection(
        path.join(app.getPath("appData"), "Voidr Capture", "loops"),
      );
    }
    if (!app.isPackaged && process.env.VOIDR_LOOPS_ENV_FILE)
      this.envFile = process.env.VOIDR_LOOPS_ENV_FILE;
    this.state.configured = await this.credentials().then(
      () => true,
      () => false,
    );
    this.register();
  }

  private async credentials() {
    const env = this.envFile
      ? parseEnv(await readFile(this.envFile, "utf8"))
      : process.env;
    const key = env.TYPESAFE_API_KEY?.trim();
    if (!key)
      throw new Error("Selecione um arquivo de acesso válido.");
    return {
      TYPESAFE_API_KEY: key,
      TYPESAFE_DEFAULT_MODEL: env.TYPESAFE_DEFAULT_MODEL || "jev-latest",
    };
  }

  private async configure() {
    if (this.running) throw new Error("Aguarde a jornada terminar.");
    const result = await dialog.showOpenDialog(this.deps.window()!, {
      title: "Selecionar arquivo de acesso",
      properties: ["openFile", "showHiddenFiles"],
    });
    if (result.canceled || !result.filePaths[0]) return this.state;
    const previous = this.envFile;
    this.envFile = result.filePaths[0];
    try {
      await this.credentials();
    } catch {
      this.envFile = previous;
      throw new Error("Este arquivo não contém um acesso válido. Selecione outro arquivo.");
    }
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await writeFile(
      path.join(this.root, "connection.json"),
      JSON.stringify({ envFile: this.envFile }),
      { mode: 0o600 },
    );
    this.state.configured = true;
    return this.publish();
  }

  private async start(input: unknown, planned?: { runId: string; secrets: Record<string, string>; collector?: import('./ai-collector-worker').AiCollectorInput; outputRoot: string }) {
    if ((!planned && this.running) || this.deps.captureBusy())
      throw new Error("Já existe uma captura ou jornada em execução.");
    const config = journeyConfigSchema.parse(input);
    this.state = {
      managed: Boolean(planned),
      managedRunId: planned?.runId,
      revision: this.state.revision,
      running: true,
      stopping: false,
      finalizing: false,
      configured: this.state.configured,
      config,
      example: this.state.example,
      stepIndex: 0,
      completedSteps: 0,
      events: [],
      timings: [],
    };
    this.publish();
    try {
      const credentials = await this.credentials();
      if (this.state.stopping) throw new Error("Execução cancelada.");
      const env: NodeJS.ProcessEnv = { ...process.env, ...credentials };
      if (app.isPackaged)
        env.PLAYWRIGHT_BROWSERS_PATH = path.join(
          process.resourcesPath,
          ".loops-browsers",
        );
      this.worker = utilityProcess.fork(
        path.join(this.deps.directory, "loops-worker.cjs"),
        [],
        { env, serviceName: "Voidr Loops", stdio: "ignore" },
      );
      this.worker.on("message", (value) => this.receive(value));
      this.worker.once("exit", () => this.exited());
      this.worker.postMessage({
        type: "start",
        config,
        outputRoot: planned?.outputRoot ?? path.join(this.root, "runs"),
        secrets: planned?.secrets,
        collector: planned?.collector,
      });
    } catch {
      clearTimeout(this.stopTimer);
      this.receive({
        type: "fatal",
        message:
          "Não foi possível iniciar. Confira seu acesso e tente novamente.",
      });
    }
    return this.state;
  }

  private receive(value: unknown) {
    const parsed = journeyEventSchema.safeParse(value);
    if (!parsed.success) return;
    const event = {
      ...parsed.data,
      message: parsed.data.message
        ? redactText(parsed.data.message)
        : undefined,
    };
    this.managed?.onEvent(event);
    this.state = applyJourneyEvent(this.state, event);
    this.publish();
  }

  private exited() {
    clearTimeout(this.stopTimer);
    this.worker = undefined;
    if (this.state.running)
      this.receive({
        type: "fatal",
        message: this.state.stopping
          ? "Execução interrompida. As evidências parciais podem estar incompletas."
          : "O processo da jornada encerrou inesperadamente.",
      });
    this.managed?.resolve(this.state);
    this.managed = undefined;
    this.publish();
  }

  stop() {
    if (!this.running || this.state.stopping) return this.state;
    this.state.stopping = true;
    this.worker?.postMessage({ type: "stop" });
    const worker = this.worker;
    this.stopTimer = setTimeout(() => worker?.kill(), this.reserved ? 90_000 : 15_000);
    return this.publish();
  }

  async shutdown() {
    if (!this.worker) {
      this.stop();
      this.reserved = false;
      this.state.running = false;
      return;
    }
    const stopped = new Promise<void>((resolve) =>
      this.worker!.once("exit", () => resolve()),
    );
    this.stop();
    await stopped;
  }

  private register() {
    const handlers: Record<string, (input?: unknown) => unknown> = {
      status: () => this.state,
      configure: () => this.configure(),
      start: (input) => this.start(input),
      stop: async () => { if (this.reserved) await this.onManagedStop?.(); return this.stop(); },
      input: input => this.input(input),
      resume: () => this.resume(),
      "open-logs": async () => {
        const directory = this.state.result?.output ?? path.join(this.root, "runs");
        await mkdir(directory, {
          recursive: true,
          mode: 0o700,
        });
        const error = await shell.openPath(directory);
        if (error) throw new Error("Não foi possível abrir a pasta de logs.");
      },
    };
    Object.entries(handlers).forEach(([name, handler]) =>
      ipcMain.handle(`journeys:${name}`, (event, input) => {
        this.deps.assertSender(event);
        return handler(input);
      }),
    );
  }
}
