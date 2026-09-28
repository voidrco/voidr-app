import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { runHeadlessAiWorker } from './headless-ai-worker';
import type { runHeadlessAiTest } from './headless-ai-tester';
import type { VoidrServiceClient } from './service-client';
import { VoidrApiError } from './service-client';
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

it('recovers pending evidence without stopping the worker or repeating browser execution', async () => {
  const f = await fixture();
  const execute = vi.fn<typeof runHeadlessAiTest>()
    .mockImplementationOnce(async () => { f.pending.mockResolvedValue([]); return { busy: false, uploadPending: true }; })
    .mockImplementationOnce(async () => { f.stop.abort(); return { busy: false, uploadPending: false }; });
  // Even a stale server read of ready must not replay after a local upload failure.
  await runHeadlessAiWorker({ ...f, pollIntervalMs: 500 }, execute);
  expect(execute.mock.calls.map(([, options]) => options.mode)).toEqual(['execute', 'retry-evidence']);
});

it('continues another queued run while preserving an incomplete recording', async () => {
  const f = await fixture(); const second = { ...ref, runId: '0b7ba45c-2b4e-4e98-9367-ff5cd7dd9535' };
  f.pending.mockResolvedValue([ref, second]);
  f.read.mockImplementation(async input => ({ ...(input.path?.includes(second.runId) ? second : ref), status: 'ready',targetUrl:'http://127.0.0.1:8000',environment:'hml' }));
  const execute = vi.fn<typeof runHeadlessAiTest>().mockResolvedValueOnce({busy:false,uploadPending:true})
    .mockImplementationOnce(async()=>{f.stop.abort();return {busy:false,uploadPending:false}});
  await runHeadlessAiWorker(f,execute);
  expect(execute.mock.calls.map(([input])=>input.runId)).toEqual([ref.runId,second.runId]);
  const [scope]=await readdir(f.root);
  const saved=JSON.parse(await readFile(path.join(f.root,scope,'dispatch',ref.runId+'.json'),'utf8'));
  expect(saved).toMatchObject({state:'pending',uploadPending:true,recoveryAttempts:0});
});

it('bounds Collector recovery, preserves an attention record, and does not kill the queue', async () => {
  const { AiCapturePendingError } = await import('./ai-collector-session');
  const f=await fixture();let time=Date.now();const now=vi.spyOn(Date,'now').mockImplementation(()=>time);
  f.read.mockResolvedValue({...ref,status:'completed',targetUrl:'http://127.0.0.1:8000',environment:'hml'});
  const execute=vi.fn<typeof runHeadlessAiTest>().mockRejectedValue(new AiCapturePendingError());
  const publish=vi.fn(state=>{time+=120000;if(state.error?.includes('esgotada'))f.stop.abort()});
  try { await runHeadlessAiWorker({...f,publish,pollIntervalMs:500},execute); } finally {now.mockRestore()}
  expect(execute).toHaveBeenCalledTimes(3);
  expect(execute.mock.calls.every(([,opts])=>opts.mode==='retry-evidence')).toBe(true);
  const [scope]=await readdir(f.root);
  const saved=JSON.parse(await readFile(path.join(f.root,scope,'dispatch',ref.runId+'.json'),'utf8'));
  expect(saved).toMatchObject({state:'needs_attention',uploadPending:true,recoveryAttempts:3});
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

it.each(['queue', 'run'])('recovers a transient %s read without duplicating the browser run', async where => {
  const f = await fixture();
  const read = where === 'queue' ? f.pending : f.read;
  read.mockRejectedValueOnce(new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }));
  const execute = vi.fn<typeof runHeadlessAiTest>(async () => { f.stop.abort(); return { busy: false, uploadPending: false }; });
  await runHeadlessAiWorker({ ...f, pollIntervalMs: 500 }, execute);
  expect(read).toHaveBeenCalledTimes(2);
  expect(execute).toHaveBeenCalledTimes(1);
});

it.each([401, 403])('does not retry HTTP %s or change the actor', async status => {
  const f = await fixture(); f.pending.mockRejectedValue(new VoidrApiError('denied', status));
  const execute = vi.fn<typeof runHeadlessAiTest>();
  await expect(runHeadlessAiWorker({ ...f, pollIntervalMs: 500 }, execute)).rejects.toThrow('denied');
  expect(f.pending).toHaveBeenCalledTimes(1); expect(execute).not.toHaveBeenCalled();
});

it('bounds repeated unavailability and releases the worker lock', async () => {
  const f = await fixture(); f.pending.mockRejectedValue(new VoidrApiError('unavailable', 503));
  const execute = vi.fn<typeof runHeadlessAiTest>(async () => { f.stop.abort(); return { busy: false, uploadPending: false }; });
  await expect(runHeadlessAiWorker({ ...f, pollIntervalMs: 500 }, execute)).rejects.toThrow('unavailable');
  expect(f.pending).toHaveBeenCalledTimes(4); expect(execute).not.toHaveBeenCalled();
  f.pending.mockResolvedValue([ref]);
  await runHeadlessAiWorker(f, execute);
  expect(execute).toHaveBeenCalledTimes(1);
});

it('never retries an uncertain browser execution', async () => {
  const f = await fixture();
  const execute = vi.fn<typeof runHeadlessAiTest>().mockRejectedValue(new VoidrApiError('ack lost', 503));
  await expect(runHeadlessAiWorker(f, execute)).rejects.toThrow('ack lost');
  expect(execute).toHaveBeenCalledTimes(1);
});
