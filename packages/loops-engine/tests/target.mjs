import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { observe } from "../src/browser.ts";
import { buildActions, executeAction } from "../src/actions.ts";
import { TargetBlockedError } from "../src/target.ts";

const footer = '<footer style="position:fixed;bottom:0;left:0;width:100%;height:120px;background:black;z-index:100">Footer</footer>';
const button = '<button onclick="this.dataset.clicked=String(Number(this.dataset.clicked||0)+1)" style="width:160px;height:48px;border:8px solid">Alvo</button>';

async function act(page, onInteraction) {
  const observation = await observe(page);
  const action = buildActions(observation, []).find(candidate => candidate.control.name === "Alvo");
  assert.ok(action);
  return executeAction({ page, observation, action, onInteraction });
}

async function checkVisibleTarget(page, html) {
  await page.setContent(html);
  const interactions = [];
  assert.equal(await act(page, async event => { interactions.push(event); }), true);
  const target = interactions.find(event => event.phase === "target");
  const acting = interactions.find(event => event.phase === "acting");
  assert.ok(target.point.y > 50 && target.point.y < 780, JSON.stringify(target));
  assert.deepEqual(target.point, acting.point);
  const frame = page.frames().find(frame => frame !== page.mainFrame()) ?? page.mainFrame();
  assert.equal(await frame.getByRole("button", { name: "Alvo" }).getAttribute("data-clicked"), "1");
}

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await checkVisibleTarget(page, `<div style="height:1900px;padding-top:840px">${button}</div>${footer}`);
  await checkVisibleTarget(page, `<div style="position:absolute;top:450px;height:300px;width:600px;overflow:auto"><div style="height:1700px;padding-top:1200px">${button}</div></div>${footer}`);
  const contents = `<div style="height:1700px;padding-top:1100px">${button}</div>`;
  await checkVisibleTarget(page, `<div style="height:2500px;padding-top:1300px"><iframe style="width:600px;height:300px" srcdoc="${contents.replaceAll('"', '&quot;')}"></iframe></div>${footer}`);
  await page.setContent(`${button}<div style="position:fixed;inset:0;z-index:100;background:black"></div>`);
  await assert.rejects(act(page), TargetBlockedError);
  assert.equal(await page.getByRole("button").getAttribute("data-clicked"), null);
  await page.setContent(button);
  assert.equal(await act(page, async event => {
    if (event.phase === "target") await page.getByRole("button").evaluate(node => { node.style.marginLeft = "220px"; });
  }), false);
  assert.equal(await page.getByRole("button").getAttribute("data-clicked"), null);
  console.log("OK: footer fixo, scroll interno, iframe, bloqueio real e alvo que muda antes do clique.");
} finally { await browser.close(); }
