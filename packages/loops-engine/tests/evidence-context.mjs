import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { observe } from '../src/browser.ts';
import { verifyAssertion } from '../src/assertions.ts';
import { verifyAssertionEvidence } from '../src/evidence-verification.ts';
import { unmeasured } from '../src/timing.ts';

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.setContent('<title>Accounts</title><h1>Account area</h1><button>Sign out</button><input name="search">');
  const body = (await observe(page)).evidence.find(region => region.context?.scope === 'document');
  assert.ok(body);
  assert.equal(body.context.title, 'Accounts');
  assert.equal(body.context.url, page.url());
  assert.equal(body.context.controls.some(control => control.type === 'password'), false);
  const request = { page, stepIndex: 0, instruction: 'Verify the login form is not visible', evidence: body,
    probability: 1, confidence: 1, predicate: 'semantic' };
  const passed = await verifyAssertion(request);
  assert.equal(passed.status, 'passed');
  // A password input has no innerText and its value is intentionally excluded.
  // It used to evade snapshot equality, allowing stale absence evidence to pass.
  await page.evaluate(() => {
    const input = document.createElement('input'); input.type = 'password'; input.name = 'password'; input.value = 'never-export-this'; document.body.append(input);
  });
  const stale = await verifyAssertion(request);
  assert.equal(stale.status, 'unverified');
  const login = (await observe(page)).evidence.find(region => region.context?.scope === 'document');
  assert.equal(login.context.controls.some(control => control.type === 'password'), true);
  assert.equal(JSON.stringify(login).includes('never-export-this'), false);

  await page.setContent('<input type="password" name="password" value="never-export-this">');
  const passwordOnly = (await observe(page)).evidence.find(region => region.context?.scope === 'document');
  assert.ok(passwordOnly, 'A password-only document must not disappear from absence evidence');
  assert.equal(passwordOnly.context.controls[0].type, 'password');
  assert.equal(JSON.stringify(passwordOnly).includes('never-export-this'), false);

  await page.setContent('<title>Blue Top 3</title><table><tr><td>Blue Top</td><td>13</td></tr><tr><td>Other product</td><td>3</td></tr></table><button>Sign out</button>');
  const observation = await observe(page);
  const wrongRow = observation.evidence.find(region => region.text === 'Blue Top 13');
  let selected;
  await verifyAssertionEvidence({ client: { systemOne: async request => {
    selected = request.state.selectedEvidence;
    return { model: 'fixture', answers: { sufficient: { noul: 1 }, satisfied: { noul: 0 } }, usage: { input_tokens: 1, output_tokens: 1 } };
  } }, instruction: 'Verify "Blue Top" quantity 3', previousSteps: [], evidence: wrongRow,
  regions: observation.evidence, measure: unmeasured });
  assert.equal(selected.context.scope, 'region');
  assert.equal(selected.context.controls.some(control => control.name === 'Sign out'), false);
  assert.equal(selected.text, 'Blue Top 13');
  const failed = await verifyAssertion({ ...request, instruction: 'Verify "Blue Top" quantity 3', evidence: wrongRow, predicate: 'contains' });
  assert.equal(failed.status, 'failed', 'Unrelated document title/other row must not satisfy exact business values');

  await page.setContent('<h1>Account</h1><iframe srcdoc="<input type=password>"></iframe>' + '<p>Repeated</p>'.repeat(130));
  const framed = await observe(page);
  const root = framed.evidence.find(region => region.frame === 0 && region.context?.scope === 'document');
  assert.equal(root.context.embeddedDocuments, 1);
  assert.equal(root.context.controls.some(control => control.type === 'password'), false, 'A parent body does not claim to observe frame contents');
  console.log('OK: region scope, private password structure, stale form detection, business-row isolation and embedded-frame coverage.');
} finally { await browser.close(); }
