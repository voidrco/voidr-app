import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runHeadlessAiTest } from './headless-ai-tester';
import type { VoidrServiceClient } from './service-client';

const runtime = { serviceUrl: 'http://127.0.0.1:3000/v1', collectorUrl: 'http://127.0.0.1:3100',
  collectorScriptUrl: 'http://127.0.0.1:3100/script.js', platformUrl: 'http://127.0.0.1:3030',
  localAdapter: true, localDevKey: 'voidr-fixture-only', organizationId: 'org_fixture' };
const runId = 'dadf8741-56c9-48b5-ad47-d8e6124c1f24';
const input = { runtime, loopId: 'loop-fixture', runId };
const directories: string[] = [];
async function fixture(status = 'ready') {
  const root = await mkdtemp(path.join(tmpdir(), 'voidr-headless-test-')); directories.push(root);
  const run = { runId, loopId: input.loopId, status, targetUrl: 'https://example.test', environment: 'hml',
    plan: { journeys: [{ id: 'journey', objective: 'Check actual result', prerequisites: [], data: [], sources: [],
      blockers: ['Test data unavailable'], steps: [{ kind: 'assertion', instruction: 'Verify result', sources: [] }] }], warnings: [] },
    results: [] as unknown[], artifacts: [], sequence: 0 };
  const request = vi.fn(async ({ path: suffix, body }: { path?: string; body?: unknown }) => {
    if (suffix === `/${runId}`) return { ...run };
    if (suffix === `/${runId}/claim`) return {};
    if (suffix === `/${runId}/credentials`) return {};
    if (suffix === `/${runId}/progress`) { Object.assign(run, body); return { ...run }; }
    if (suffix === `/${runId}/cancel`) { run.status = 'cancelled'; return { ...run }; }
    throw new Error(`Unexpected endpoint ${suffix}`);
  });
  const session = vi.fn(async () => ({ client: { aiTesterRequest: request } as unknown as VoidrServiceClient, accessToken: 'fixture-token' }));
  return { root, session, request, run };
}
afterEach(async () => { vi.useRealTimers(); await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

describe('headless AI run lifecycle without Electron', () => {
  it('claims an existing run and preserves a blocked journey without claiming a passed validation', async () => {
    const f = await fixture();
    const final = await runHeadlessAiTest(input, f);
    expect(final).toMatchObject({ busy: false, uploadPending: false, run: { status: 'completed', results: [{ outcome: 'blocked', completedSteps: 0 }] } });
    const paths = f.request.mock.calls.map(([request]) => request.path);
    expect(paths).toContain(`/${runId}/claim`);
    expect(paths).not.toContain(''); // Never requests a new scenario or new run.
    const [scope] = await readdir(f.root);
    const saved = await readFile(path.join(f.root, scope!, runId, 'manifest.json'), 'utf8');
    expect(JSON.parse(saved).run.results[0].outcome).toBe('blocked');
    expect(saved).not.toContain('fixture-token');
  });

  it('does not rerun a terminal execution', async () => {
    const f = await fixture('completed');
    const final = await runHeadlessAiTest(input, f);
    expect(final.run?.status).toBe('completed');
    expect(f.request.mock.calls.map(([request]) => request.path)).toEqual([`/${runId}`]);
  });

  it('does not obtain credentials or execute when the server denies the claim', async () => {
    const f = await fixture();
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async request => {
      if (request.path?.endsWith('/claim')) throw new Error('Executor already claimed');
      return original(request);
    });
    const final = await runHeadlessAiTest(input, f);
    expect(final).toMatchObject({ busy: false, uploadPending: true, run: { status: 'interrupted', results: [] } });
    expect(f.request.mock.calls.some(([request]) => request.path?.endsWith('/credentials'))).toBe(false);
    expect(f.request.mock.calls.some(([request]) => request.path?.endsWith('/progress'))).toBe(false);
  });

  it('rejects an absent run ID and an already cancelled job before authentication', async () => {
    const f = await fixture();
    await expect(runHeadlessAiTest({ ...input, runId: '' }, f)).rejects.toThrow();
    const controller = new AbortController(); controller.abort();
    await expect(runHeadlessAiTest(input, { ...f, signal: controller.signal })).rejects.toThrow();
    expect(f.session).not.toHaveBeenCalled();
  });

  it('forwards cancellation while waiting for a plan and preserves the journal', async () => {
    const f = await fixture('planning');
    const controller = new AbortController();
    const final = await runHeadlessAiTest(input, { ...f, signal: controller.signal,
      publish: state => { if (state.busy && state.run?.status === 'planning') controller.abort(); } });
    expect(final).toMatchObject({ busy: false, run: { status: 'cancelled' } });
    expect(f.request.mock.calls.some(([request]) => request.path?.endsWith('/cancel'))).toBe(true);
    expect(f.request.mock.calls.some(([request]) => request.path?.endsWith('/claim'))).toBe(false);
  });

  it('refuses a second worker for the same local journal and releases ownership afterwards', async () => {
    const f = await fixture('planning');
    const controller = new AbortController();
    let ready!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    const pending = runHeadlessAiTest(input, { ...f, signal: controller.signal,
      publish: state => { if (state.busy && state.run) ready(); } });
    await started;
    await expect(runHeadlessAiTest(input, f)).rejects.toThrow('executor local');
    controller.abort(); await pending;
    const again = await runHeadlessAiTest(input, f);
    expect(again.run?.status).toBe('cancelled');
  });

  it('retries persisted evidence without requesting credentials or running the browser again', async () => {
    const f = await fixture();
    await runHeadlessAiTest(input, f);
    f.request.mockClear();
    const retried = await runHeadlessAiTest(input, { ...f, mode: 'retry-evidence' });
    expect(retried.uploadPending).toBe(false);
    expect(f.request.mock.calls.map(([request]) => request.path)).toEqual([`/${runId}`]);
  });

  it('cancels planning when its bounded execution time expires', async () => {
    const f = await fixture('planning');
    const final = await runHeadlessAiTest(input, { ...f, timeoutMs: 1000 });
    expect(final.run?.status).toBe('cancelled');
    expect(f.request.mock.calls.some(([request]) => request.path?.endsWith('/cancel'))).toBe(true);
  });
});
