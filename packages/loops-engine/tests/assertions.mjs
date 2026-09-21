import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright-core';
import { observe } from '../src/browser.ts';
import { verifyAssertion } from '../src/assertions.ts';
import { runEngine } from '../src/engine.ts';

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.setContent('<div style="height:1500px"></div><table><tr><td>Blue Top</td><td>Quantidade</td><td id="quantity">3</td></tr></table><div style="height:600px"></div>');
  const evidence = (await observe(page)).evidence.find(item => item.text === 'Blue Top Quantidade 3');
  assert.ok(evidence);
  const events = [];
  const options = { page, stepIndex: 0, instruction: 'Confirme que "Blue Top" aparece com quantidade 3.', evidence, confidence: 1, probability: 1, predicate: 'contains', onInteraction: async (interaction, screenshot) => events.push({ interaction, screenshot }) };
  const passed = await verifyAssertion(options);
  assert.equal(passed.status, 'passed');
  assert.ok(events.some(event => event.interaction.phase === 'scrolling' && event.screenshot));
  assert.ok(events.some(event => event.interaction.phase === 'checking'));
  assert.ok(passed.screenshot);
  assert.equal(passed.actual.text, 'Blue Top Quantidade 3');
  assert.ok((await observe(page)).text.includes('Blue Top'));
  assert.ok(!(await observe(page)).text.includes('Assert confirmado'));
  const stale = await verifyAssertion({ ...options, onInteraction: async event => {
    if (event.phase === 'checking') await page.locator('#quantity').evaluate(node => { node.textContent = '13'; });
  } });
  assert.equal(stale.status, 'unverified');
  const changed = (await observe(page)).evidence.find(item => item.text === 'Blue Top Quantidade 13');
  const wrongValue = await verifyAssertion({ ...options, evidence: changed });
  assert.equal(wrongValue.status, 'failed', '13 must not satisfy 3 even if model claims success');
  const disproved = await verifyAssertion({ ...options, evidence: changed, probability: 0.1, predicate: 'semantic' });
  assert.equal(disproved.status, 'failed');
  console.log('OK: assert com evidência real, scroll com frames, mudança de DOM e quantidade incorreta.');
} finally { await browser.close(); }

const server = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<h1>Cart is empty!</h1><button onclick="document.body.textContent=\'Blue Top 3\'">Add product</button>'); });
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const config = { url: `http://127.0.0.1:${server.address().port}`, steps: ['Confirme que o carrinho está vazio.'], expected: [], headed: false, maxActions: 3 };
try {
  const result = await runEngine({ config, outputRoot: 'runs/assertion-tests', visual: true, decide: async ({ observation }) => ({
    answer: { choice: 'step_done', confidence: 1 }, usage: { input_tokens: 0, output_tokens: 0 },
    assertion: { required: true, evidence: observation.evidence.find(item => item.text === 'Cart is empty!'), confidence: 1, probability: 1, predicate: 'semantic' },
  }) });
  assert.equal(result.status, 'completed');
  assert.equal(result.assertions.length, 1);
  assert.equal(result.assertions[0].status, 'passed');
  assert.ok((await stat(result.artifacts.videos[0])).size > 1000);
  const trace = execFileSync('unzip', ['-p', result.artifacts.trace, 'trace.trace'], { encoding: 'utf8', maxBuffer: 10_000_000 });
  assert.ok(trace.includes('ASSERT:'));
  const saved = JSON.parse(await readFile(`${result.output}/result.json`, 'utf8'));
  assert.equal(saved.assertions[0].actual.text, 'Cart is empty!');
  const failed = await runEngine({ config: { ...config, steps: ['Confirme que "Blue Top" aparece com quantidade 3.'] },
    outputRoot: 'runs/assertion-tests', decide: async ({ observation, actions }) => ({
      answer: { choice: actions[0].id, confidence: 1 }, usage: { input_tokens: 0, output_tokens: 0 },
      assertion: { required: true, readOnly: true, evidence: observation.evidence.find(item => item.text === 'Cart is empty!'), confidence: 1, probability: 0.1, predicate: 'contains' },
    }) });
  assert.equal(failed.status, 'assertion_failed');
  assert.equal(failed.actions, 0, 'An assertion cannot change the application to make itself pass');
  const controller = new AbortController();
  const cancelled = await runEngine({ config, outputRoot: 'runs/assertion-tests', signal: controller.signal,
    decide: async () => { controller.abort(); throw new Error('cancel'); } });
  assert.equal(cancelled.status, 'cancelled');
  assert.ok(cancelled.artifacts.trace);
  assert.ok((await stat(cancelled.artifacts.videos[0])).size > 1000);
  assert.deepEqual(cancelled.artifacts.errors, []);
  console.log('OK: trace com grupo de assert e vídeo finalizados, inclusive ao interromper.');
} finally { server.close(); await once(server, 'close'); }
