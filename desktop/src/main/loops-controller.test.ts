import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LoopsController } from "./loops-controller";

const mock = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, input?: unknown) => unknown>(),
  root: "",
  fork: vi.fn(),
  send: vi.fn(),
  sender: vi.fn(),
  showOpenDialog: vi.fn(),
  busy: false,
}));
vi.mock("electron", () => ({
  app: { isPackaged: false, getPath: () => mock.root },
  ipcMain: {
    handle: (
      name: string,
      handler: (event: unknown, input?: unknown) => unknown,
    ) => mock.handlers.set(name, handler),
  },
  utilityProcess: { fork: (...args: unknown[]) => mock.fork(...args) },
  shell: { openPath: vi.fn() },
  dialog: { showOpenDialog: (...args: unknown[]) => mock.showOpenDialog(...args) },
}));

const config = {
  url: "https://example.com",
  steps: ["Abra o carrinho."],
  expected: [],
  headed: false,
  maxActions: 10,
};
const invoke = (name: string, input?: unknown) =>
  mock.handlers.get(`journeys:${name}`)!({}, input) as Promise<unknown>;
async function fixture() {
  mock.root = await mkdtemp(path.join(tmpdir(), "loops-controller-"));
  const envFile = path.join(mock.root, ".env");
  await writeFile(envFile, "TYPESAFE_API_KEY=fake-test-key");
  vi.stubEnv("VOIDR_LOOPS_ENV_FILE", envFile);
  const worker = Object.assign(new EventEmitter(), {
    postMessage: vi.fn(),
    kill: vi.fn(),
  });
  mock.fork.mockReturnValue(worker);
  const controller = new LoopsController({
    window: () =>
      ({ isDestroyed: () => false, webContents: { send: mock.send } }) as never,
    assertSender: mock.sender,
    captureBusy: () => mock.busy,
    directory: "/app/dist/main",
  });
  await controller.initialize();
  return { controller, worker };
}
async function unconfiguredFixture() {
  mock.root = await mkdtemp(path.join(tmpdir(), "loops-controller-"));
  vi.stubEnv("VOIDR_LOOPS_ENV_FILE", "");
  vi.stubEnv("TYPESAFE_API_KEY", "");
  const controller = new LoopsController({
    window: () =>
      ({ isDestroyed: () => false, webContents: { send: mock.send } }) as never,
    assertSender: mock.sender,
    captureBusy: () => mock.busy,
    directory: "/app/dist/main",
  });
  await controller.initialize();
  return controller;
}
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  mock.busy = false;
  if (mock.root) await rm(mock.root, { recursive: true, force: true });
});

describe("journey process boundary", () => {
  it.each([
    { profile: "", configured: true },
    { profile: "/isolated-test-profile", configured: false },
  ])("restores the installed connection only for default dev ($profile)", async ({ profile, configured }) => {
    const { controller } = await fixture();
    const connection = path.join(mock.root, "Voidr Capture", "loops");
    await mkdir(connection, { recursive: true });
    await writeFile(path.join(connection, "connection.json"), JSON.stringify({ envFile: path.join(mock.root, ".env") }));
    vi.stubEnv("VOIDR_LOOPS_ENV_FILE", "");
    vi.stubEnv("TYPESAFE_API_KEY", "");
    vi.stubEnv("VOIDR_CAPTURE_DEV_SERVER_URL", "http://127.0.0.1:4173");
    vi.stubEnv("VOIDR_CAPTURE_DEV_USER_DATA_DIR", profile);
    await controller.initialize();
    expect(await invoke("status")).toMatchObject({ configured });
    expect(JSON.stringify(await invoke("status"))).not.toContain("fake-test-key");
  });

  it("keeps the dev connection instead of replacing it with the installed connection", async () => {
    const { controller, worker } = await fixture();
    const connection = path.join(mock.root, "loops");
    const envFile = path.join(mock.root, ".env.dev");
    await mkdir(connection, { recursive: true });
    await writeFile(envFile, "TYPESAFE_API_KEY=dev-test-key");
    await writeFile(path.join(connection, "connection.json"), JSON.stringify({ envFile }));
    vi.stubEnv("VOIDR_LOOPS_ENV_FILE", "");
    vi.stubEnv("VOIDR_CAPTURE_DEV_SERVER_URL", "http://127.0.0.1:4173");
    await controller.initialize();
    await invoke("start", config);
    expect(mock.fork).toHaveBeenCalledWith(expect.any(String), [], expect.objectContaining({
      env: expect.objectContaining({ TYPESAFE_API_KEY: "dev-test-key" }),
    }));
    worker.emit("exit", 0);
  });

  it("validates sender and config before spawning a worker", async () => {
    await fixture();
    mock.sender.mockImplementationOnce(() => {
      throw new Error("untrusted");
    });
    expect(() => invoke("start", config)).toThrow("untrusted");
    await expect(
      invoke("start", { ...config, url: "file:///tmp/a" }),
    ).rejects.toThrow();
    expect(mock.fork).not.toHaveBeenCalled();
  });
  it("reserves one execution while credentials are loading and keeps keys outside renderer state", async () => {
    const { worker } = await fixture();
    const first = invoke("start", config);
    await expect(invoke("start", config)).rejects.toThrow("Já existe");
    await first;
    expect(mock.fork).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(await invoke("status"))).not.toContain(
      "fake-test-key",
    );
    expect(JSON.stringify(mock.send.mock.calls)).not.toContain("fake-test-key");
    expect(worker.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "start", config }),
    );
    worker.emit("exit", 0);
  });
  it("cancels before worker spawn without keeping quit pending", async () => {
    const { controller } = await fixture();
    const starting = invoke("start", config);
    await controller.shutdown();
    expect(controller.running).toBe(false);
    await starting;
    expect(mock.fork).not.toHaveBeenCalled();
  });
  it("does not start over an active capture", async () => {
    await fixture();
    mock.busy = true;
    await expect(invoke("start", config)).rejects.toThrow("Já existe");
    expect(mock.fork).not.toHaveBeenCalled();
  });
  it("asks for access on the first managed execution and keeps the reservation", async () => {
    const controller = await unconfiguredFixture();
    const accessFile = path.join(mock.root, ".env.first-run");
    await writeFile(accessFile, "TYPESAFE_API_KEY=first-run-key");
    mock.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [accessFile] });

    await controller.reserve();

    expect(mock.showOpenDialog).toHaveBeenCalledOnce();
    expect(controller.running).toBe(true);
    expect(await invoke("status")).toMatchObject({ configured: true });
    controller.release();
  });
  it("does not reserve the executor when first-run access is cancelled", async () => {
    const controller = await unconfiguredFixture();
    mock.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });

    await expect(controller.reserve()).rejects.toThrow("Configure o acesso");

    expect(controller.running).toBe(false);
  });
  it("escalates a hung cancellation once and reports incomplete evidence", async () => {
    const { worker, controller } = await fixture();
    await invoke("start", config);
    vi.useFakeTimers();
    await invoke("stop");
    await invoke("stop");
    expect(
      worker.postMessage.mock.calls.filter(
        ([message]) => message.type === "stop",
      ),
    ).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(worker.kill).toHaveBeenCalledTimes(1);
    worker.emit("exit", 1);
    expect(controller.running).toBe(false);
    expect(await invoke("status")).toMatchObject({
      running: false,
      stopping: false,
      error: expect.stringContaining("incompletas"),
    });
  });
  it("retains preview and timing state after the worker exits", async () => {
    const { worker } = await fixture();
    await invoke("start", config);
    worker.emit("message", {
      type: "observation",
      screenshot: "data:image/png;base64,abc",
    });
    worker.emit("message", { type: "step_done", stepIndex: 0 });
    worker.emit("message", { type: "fatal", message: "Test failure" });
    worker.emit("exit", 0);
    expect(await invoke("status")).toMatchObject({
      running: false,
      completedSteps: 1,
      screenshot: "data:image/png;base64,abc",
      error: "Test failure",
    });
  });
});
