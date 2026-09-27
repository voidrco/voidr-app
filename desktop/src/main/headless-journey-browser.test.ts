import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { runEngine } from '@voidr/loops-engine';
import { createDecider } from '../../../packages/loops-engine/src/decide';
import { expect, it, vi } from 'vitest';
import { HeadlessJourneyExecutor } from './headless-journey-executor';

// Opt in: uses a real local browser, but a deterministic decision function, not a model.
it.skipIf(!process.env.VOIDR_TEST_CHROMIUM_EXECUTABLE)('executes the shared engine in Chromium and preserves screenshots, video and partial failures', async () => {
  const launch = chromium.launch.bind(chromium);
  const spy = vi.spyOn(chromium, 'launch').mockImplementation(options => launch({ ...options, executablePath: process.env.VOIDR_TEST_CHROMIUM_EXECUTABLE }));
  const root = await mkdtemp(path.join(tmpdir(), 'voidr-headless-browser-'));
  const server = createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end('<button onclick="document.body.innerHTML=\'<h1>Correction verified</h1>\'">Check correction</button>');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address() as { port: number };
  const answer = (choice: string) => ({ type: 'choice' as const, choice, confidence: 1, probabilities: { [choice]: 1 } });
  let needsHuman = false;
  const executor = new HeadlessJourneyExecutor(options => runEngine({ ...options, decide: async input => {
    const choice = input.observation.text.includes('Correction verified') ? 'step_done'
      : input.actions.find(action => action.control.name === 'Check correction')!.id;
    const client = { systemOne: async () => ({ answers: {
      status: answer(choice === 'step_done' ? 'done' : 'pending'), next: answer(choice),
      satisfied: { type: 'noul', noul: choice === 'step_done' ? 1 : 0 },
      needsHuman: { type: 'noul', noul: needsHuman ? 1 : 0 },
    }, usage: { input_tokens: 0, output_tokens: 0 }, model: 'test-decision-function' }) };
    return createDecider(client as unknown as Parameters<typeof createDecider>[0])(input);
  } }));
  const input = { runId: 'browser-test', config: { url: `http://127.0.0.1:${address.port}`, steps: ['Check correction'], expected: ['Correction verified'], headed: false, maxActions: 4 },
    secrets: {}, outputRoot: root, onEvent: () => undefined };
  try {
    executor.reserve();
    const completed = await executor.executePlanned(input);
    expect(completed.result?.status).toBe('completed');
    expect(completed.result?.actions).toBe(1);
    const output = completed.result!.output;
    expect(JSON.parse(await readFile(path.join(output, 'result.json'), 'utf8')).status).toBe('completed');
    expect((await stat(path.join(output, 'final.png'))).size).toBeGreaterThan(0);
    expect(completed.result!.artifacts!.videos.length).toBeGreaterThan(0);
    expect((await stat(completed.result!.artifacts!.videos[0]!)).size).toBeGreaterThan(0);
    executor.release();
    needsHuman = true; executor.reserve();
    const blocked = await executor.executePlanned(input);
    expect(blocked.result?.status).toBe('error');
    expect(blocked.result?.reason).toContain('intervenção humana');
    expect(blocked.result!.artifacts!.videos.length).toBeGreaterThan(0);
    executor.release();
  } finally {
    server.close(); spy.mockRestore(); await rm(root, { recursive: true, force: true });
  }
}, 30_000);
