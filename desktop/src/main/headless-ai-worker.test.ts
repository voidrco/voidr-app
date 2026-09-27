import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { runHeadlessAiWorker } from './headless-ai-worker';
import type { runHeadlessAiTest } from './headless-ai-tester';
import type { VoidrServiceClient } from './service-client';
const runtime = { serviceUrl: 'http://127.0.0.1:3000/v1', collectorUrl: 'http://127.0.0.1:3100', collectorScriptUrl: 'http://127.0.0.1:3100/script.js', platformUrl: 'http://127.0.0.1:3030', localAdapter: true, localDevKey: 'fixture-only-key', organizationId: 'org' };
const ref = { loopId: 'loop', runId: '0b7ba45c-2b4e-4e98-9367-ff5cd7dd9534' };
const directories: string[] = [];
async function fixture() {
  vi.stubEnv('TYPESAFE_API_KEY', 'test-only-model-key');
  const root = await mkdtemp(path.join(tmpdir(), 'headless-worker-')); directories.push(root);
  const stop = new AbortController();
  const pending = vi.fn().mockResolvedValue([ref]);
  const read = vi.fn().mockResolvedValue({ ...ref, status: 'ready', targetUrl: 'http://127.0.0.1:8000', environment: 'hml' });
  const session = vi.fn(async () => ({ client: { aiTesterPendingLaunches: pending, aiTesterRequest: read } as unknown as VoidrServiceClient, accessToken: 'test-token' }));
  return { root, runtime, actorId: 'actor', signal: stop.signal, session, stop, pending, read };
}
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

it('keeps requests queued when the worker model is not configured', async () => {
  const f = await fixture(); vi.stubEnv('TYPESAFE_API_KEY', '');
  await expect(runHeadlessAiWorker(f)).rejects.toThrow('TYPESAFE_API_KEY');
  expect(f.session).not.toHaveBeenCalled();
});

it('automatically consumes only the authenticated headless queue', async () => {
  const f = await fixture();
  const execute = vi.fn<typeof runHeadlessAiTest>(async () => { f.stop.abort(); return { busy: false, uploadPending: false }; });
  await runHeadlessAiWorker(f, execute);
  expect(f.pending).toHaveBeenCalledWith('test-token', 'headless');
  expect(execute).toHaveBeenCalledWith({ ...ref, runtime }, expect.objectContaining({ mode: 'execute' }));
});

it('recovers pending evidence after restart without repeating browser execution', async () => {
  const f = await fixture();
  const execute = vi.fn<typeof runHeadlessAiTest>().mockResolvedValueOnce({ busy: false, uploadPending: true });
  await expect(runHeadlessAiWorker(f, execute)).rejects.toThrow('Evidências pendentes');
  f.pending.mockResolvedValue([]);
  f.read.mockResolvedValue({ ...ref, status: 'completed', targetUrl: 'http://127.0.0.1:8000', environment: 'hml' });
  execute.mockImplementationOnce(async () => { f.stop.abort(); return { busy: false, uploadPending: false }; });
  await runHeadlessAiWorker(f, execute);
  expect(execute.mock.calls.map(([, options]) => options.mode)).toEqual(['execute', 'retry-evidence']);
});

it('does not run a completed local dispatch again even if listing repeats it', async () => {
  const f = await fixture();
  const execute = vi.fn<typeof runHeadlessAiTest>(async () => { f.stop.abort(); return { busy: false, uploadPending: false }; });
  await runHeadlessAiWorker(f, execute);
  const stop = new AbortController();
  f.pending.mockImplementation(async () => { stop.abort(); return [ref]; });
  await runHeadlessAiWorker({ ...f, signal: stop.signal }, execute);
  expect(execute).toHaveBeenCalledTimes(1);
});

it('stops on denied queue access without executing or changing identity', async () => {
  const f = await fixture(); f.pending.mockRejectedValue(new Error('HTTP 403'));
  const execute = vi.fn<typeof runHeadlessAiTest>();
  await expect(runHeadlessAiWorker(f, execute)).rejects.toThrow('403');
  expect(f.session).toHaveBeenCalledTimes(1); expect(execute).not.toHaveBeenCalled();
});
