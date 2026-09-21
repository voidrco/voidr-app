import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright-core";

const desktop = fileURLToPath(new URL("..", import.meta.url));
const profile = await mkdtemp(path.join(tmpdir(), "voidr-loops-smoke-"));
const output = path.join(desktop, "../runs/loops-smoke");
await mkdir(output, { recursive: true });
assert.ok(
  process.env.VOIDR_LOOPS_ENV_FILE,
  "Set VOIDR_LOOPS_ENV_FILE to an existing TypeSafe .env",
);
const application = await electron.launch({
  args: [desktop],
  env: {
    ...process.env,
    VOIDR_CAPTURE_DEV_USER_DATA_DIR: profile,
    VOIDR_CAPTURE_E2E: "1",
  },
});
try {
  const page = await application.firstWindow();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page
    .getByRole("button", { name: "Jornadas com IA", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Executar jornada", exact: true })
    .waitFor();
  assert.equal(
    await page.locator("#url").inputValue(),
    "https://automationexercise.com/products",
  );
  await page
    .getByRole("button", { name: "Executar jornada", exact: true })
    .click();
  await page.evaluate(async () => {
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      const state = await window.voidrCapture.journeys.status();
      if (state.result || state.error) return;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error("Journey timeout");
  });
  const state = await page.evaluate(() =>
    window.voidrCapture.journeys.status(),
  );
  await page.screenshot({ path: path.join(output, "desktop.png") });
  console.log(
    JSON.stringify({
      status: state.result?.status,
      reason: state.result?.reason || state.error,
      completedSteps: state.completedSteps,
      actions: state.result?.actions,
      durationMs: state.result?.durationMs,
      output: state.result?.output,
      errors,
      screenshot: path.join(output, "desktop.png"),
    }),
  );
  assert.equal(state.result?.status, "completed");
  assert.equal(state.completedSteps, 8);
  assert.equal(state.result.assertions.length, 2);
  assert.ok(state.result.assertions.every(assertion => assertion.status === 'passed'));
  assert.ok((await stat(state.result.artifacts.videos[0])).size > 1000);
  assert.deepEqual(state.result.artifacts.errors, []);
  assert.equal(await page.locator('#verification').count(), 0);
  assert.equal(await page.locator('.step-assertion').count(), 2);
  await page.locator('.step-assertion').first().click();
  await page.locator('#agent-overlay[data-kind=assert][data-phase=passed]').waitFor();
  await page.screenshot({ path: path.join(output, 'assertion.png') });
  assert.ok(
    state.timings.some((span) => span.category === "jev" && span.selfMs > 0),
  );
  assert.equal(await page.locator("#agent-overlay").count(), 1);
  const preview = await page.locator('.preview-surface').boundingBox();
  const activity = await page.locator('#console-body').boundingBox();
  assert.ok(preview.height > 300, 'Preview must retain the original large viewport');
  assert.ok(activity.height <= 150, 'Activity must retain the original compact panel');
  assert.deepEqual(errors, []);
  const saved = JSON.parse(
    await readFile(path.join(state.result.output, "result.json"), "utf8"),
  );
  assert.equal(saved.completedSteps, 8);
  await page.reload();
  await page
    .getByRole("button", { name: "Jornadas com IA", exact: true })
    .click();
  await page.locator("#result-title").waitFor();
  await page.getByRole('button', { name: 'Latências', exact: true }).click();
  await page.locator('#latency-step').selectOption('all');
  assert.equal(await page.locator('.latency-category').count(), 6);
  await page.screenshot({ path: path.join(output, 'latencies.png') });
  await page.getByRole('button', { name: 'Expandir navegador', exact: true }).click();
  await page.locator('#workspace[data-focus=true]').waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Loops', exact: true }).click();
  await page.getByRole('button', { name: 'Jornadas com IA', exact: true }).click();
  await page.locator('#result-title').waitFor();
  assert.equal(await page.locator('.step-assertion').count(), 2);
  assert.equal(await page.locator("#agent-overlay").count(), 1);
} finally {
  await application.close();
}
