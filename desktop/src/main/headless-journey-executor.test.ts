import { describe, expect, it, vi } from 'vitest';
import type { runEngine } from '@voidr/loops-engine';
import { HeadlessJourneyExecutor } from './headless-journey-executor';

const config = { url: 'http://127.0.0.1:8000', steps: ['Verify result'], stepKinds: ['assertion'], expected: [], headed: true, maxActions: 5 };
const result = { status: 'completed', reason: 'Verified', output: '/tmp/result', completedSteps: 1, totalSteps: 1,
  actions: 0, decisions: 1, durationMs: 5, inputTokens: 1, outputTokens: 1, verification: 'model' as const, assertions: [],
  timings: { spans: [], durationMs: 5, unmeasuredMs: 0 }, artifacts: { videos: ['/tmp/result/video.webm'], errors: [] } };
const input = () => ({ runId: 'run', config, secrets: { PASSWORD: 'private-fixture-password' }, outputRoot: '/tmp/result', onEvent: vi.fn() });

describe('headless Loops execution boundary', () => {
  it('preserves the real engine result, token counts and video, forcing headless mode', async () => {
    const engine = vi.fn<typeof runEngine>().mockResolvedValue(result);
    const executor = new HeadlessJourneyExecutor(engine);
    executor.reserve();
    const state = await executor.executePlanned(input());
    expect(engine.mock.calls[0]![0]).toMatchObject({ config: { headed: false }, visual: true });
    expect(state).toMatchObject({ running: false, result });
    executor.release();
    expect(executor.running).toBe(false);
  });

  it('does not run without a reservation or after cancellation before start', async () => {
    const engine = vi.fn<typeof runEngine>();
    const executor = new HeadlessJourneyExecutor(engine);
    await expect(executor.executePlanned(input())).rejects.toThrow('disponível');
    executor.reserve(); executor.stop();
    expect(await executor.executePlanned(input())).toMatchObject({ running: false, error: expect.stringContaining('cancelada') });
    expect(engine).not.toHaveBeenCalled();
    executor.release();
  });

  it('keeps ownership until cancellation has finalized evidence', async () => {
    let finish!: (value: typeof result) => void;
    const engine = vi.fn<typeof runEngine>(() => new Promise(resolve => { finish = resolve; }));
    const executor = new HeadlessJourneyExecutor(engine);
    executor.reserve();
    const pending = executor.executePlanned(input());
    expect(() => executor.reserve()).toThrow();
    expect(() => executor.release()).toThrow('evidências');
    await expect(executor.executePlanned(input())).rejects.toThrow();
    executor.stop();
    expect(engine.mock.calls[0]![0].signal!.aborted).toBe(true);
    finish({ ...result, status: 'cancelled' });
    expect((await pending).result?.status).toBe('cancelled');
    executor.release();
  });

  it('redacts events, results and errors without swallowing a failed validation', async () => {
    const item = input();
    const engine = vi.fn<typeof runEngine>(async options => {
      options.onEvent?.({ type: 'observation', message: item.secrets.PASSWORD });
      return { ...result, status: 'assertion_failed', reason: item.secrets.PASSWORD };
    });
    const executor = new HeadlessJourneyExecutor(engine); executor.reserve();
    const state = await executor.executePlanned(item);
    expect(state.result?.status).toBe('assertion_failed');
    expect(JSON.stringify([state, item.onEvent.mock.calls])).not.toContain(item.secrets.PASSWORD);
    executor.release(); executor.reserve();
    engine.mockRejectedValueOnce(new Error(item.secrets.PASSWORD));
    const failed = await executor.executePlanned(item);
    expect(failed.result).toBeUndefined();
    expect(failed.error).toBeTruthy();
    expect(JSON.stringify(failed)).not.toContain(item.secrets.PASSWORD);
  });

  it('reuses Collector capture and excludes its credential and origin from evidence', async () => {
    const engine = vi.fn<typeof runEngine>().mockResolvedValue(result);
    const executor = new HeadlessJourneyExecutor(engine); executor.reserve();
    await executor.executePlanned({ ...input(), collector: { scriptUrl: 'http://localhost/recorder.js', collectorUrl: 'http://localhost:3100', options: { apiKey: 'collector-secret' } } });
    const options = engine.mock.calls[0]![0];
    expect(options.captureSession).toBeDefined();
    expect(options.evidenceSecrets).toEqual({ COLLECTOR_KEY: 'collector-secret' });
    expect(options.traceExcludeOrigins).toEqual(['http://localhost:3100']);
    await expect(options.onIntervention!(() => undefined as never)).rejects.toThrow('intervenção humana');
  });

  it('rejects credentialed URLs before engine execution', async () => {
    const engine = vi.fn<typeof runEngine>();
    const executor = new HeadlessJourneyExecutor(engine); executor.reserve();
    await expect(executor.executePlanned({ ...input(), config: { ...config, url: 'https://user:password@example.test' } })).rejects.toThrow('credenciais');
    expect(engine).not.toHaveBeenCalled();
    executor.release();
  });
});
