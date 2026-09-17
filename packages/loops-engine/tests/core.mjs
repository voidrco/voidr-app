import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { validateConfig, parseSteps } from "../src/config.ts";
import { extractValues } from "../src/values.ts";
import { observe } from "../src/browser.ts";
import { buildActions, executeAction } from "../src/actions.ts";

assert.deepEqual(parseSteps("1. Abrir\n2) Preencher\n- Salvar"), ["Abrir", "Preencher", "Salvar"]);
assert.throws(() => validateConfig({ url: "file:///tmp/a", steps: ["Abrir"] }));
assert.throws(() => validateConfig({ url: "https://example.com", steps: [] }));
assert.deepEqual(validateConfig({ url: "https://example.com", steps: "Abrir" }).expected, []);
assert.ok(extractValues('Preencha com "Cliente teste"').includes("Cliente teste"));
assert.ok(extractValues("Preencha com 200 mil").includes("200000"));
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.setContent('<ul><li>Primeiro<input type="checkbox" aria-label="Toggle" style="opacity:0"></li><li>Segundo<input type="checkbox" aria-label="Toggle"></li></ul><input type="password" value="secret"><button hidden>Oculto</button><button>Desembolsar via PIX</button><input aria-label="Nome"><iframe srcdoc="<label>Empresa<input></label>"></iframe>');
  const observation = await observe(page);
  assert.equal(observation.controls.filter(c => c.type === "checkbox").length, 2);
  assert.equal(observation.controls.some(c => c.type === "password" || c.name === "Oculto"), false);
  assert.equal(observation.controls.some(c => c.name === "Empresa" && c.frame > 0), true);
  const actions = buildActions(observation, ["Valor teste"]);
  assert.equal(actions.some(a => a.control.name.includes("PIX")), false);
  const second = actions.find(a => a.kind === "check" && a.control.context === "Segundo");
  assert.ok(second);
  assert.equal(await executeAction({ page, observation, action: second }), true);
  assert.equal(await executeAction({ page, observation, action: second }), false);
  const fresh = await observe(page);
  const fill = buildActions(fresh, ["Valor teste"]).find(a => a.control.name === "Empresa");
  assert.equal(await executeAction({ page, observation: fresh, action: fill }), true);
  assert.equal(await page.frames()[1].getByLabel("Empresa").inputValue(), "Valor teste");
  console.log("OK: configuração genérica, valores, frames, checkboxes estilizados, contexto e estado desatualizado.");
} finally { await browser.close(); }
