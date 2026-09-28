import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { chromium } from 'playwright-core';
import { captureViewport } from '../src/screenshot.ts';
import { paintInteraction } from '../src/visuals.ts';

const held = [];
const server = createServer((req, res) => {
  if (req.url === '/hanging.woff2') { held.push(res); return; }
  res.setHeader('Content-Type', 'text/html');
  res.end('<style>@font-face{font-family:Hanging;src:url(/hanging.woff2)}body{font-family:Hanging}#panel{width:200px;height:100px;background:red}</style><div id="panel">Actual rendered state</div>');
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.fonts.status === 'loading');
  const captures = [];
  const screenshot = await captureViewport(page, { type: 'png', timeout: 150, onCapture: info => captures.push(info) });
  assert.equal(screenshot.subarray(1, 4).toString(), 'PNG');
  assert.ok(screenshot.length > 500);
  assert.deepEqual(captures, [{ method: 'chromium-compositor', fontsPending: true }]);
  assert.equal(await page.locator('#panel').innerText(), 'Actual rendered state');
  assert.equal(await page.evaluate(() => document.fonts.status), 'loading', 'Capture must not alter font loading or the application');
  await page.evaluate(() => document.body.remove());
  await paintInteraction(page, { kind: 'click', phase: 'settled', label: 'Navigating', viewport: { width: 1280, height: 720 } });
  for (const message of ['page closed', 'Timeout 150ms exceeded: compositor unavailable']) {
    await assert.rejects(captureViewport({ screenshot: async () => { throw Error(message); } }, { type: 'png' }), new RegExp(message));
  }
  console.log('OK: actual Chromium screenshot with stalled font, recorded fallback, unchanged DOM and unrelated errors preserved.');
} finally {
  for (const response of held) response.destroy();
  await browser.close(); server.close(); await once(server, 'close');
}
