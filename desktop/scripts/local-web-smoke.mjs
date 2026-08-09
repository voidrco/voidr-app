import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const desktopDirectory = resolve(directory, '..');
const require = createRequire(import.meta.url);
const electronBinary = require('electron');
const debuggingPort = Number(process.env.VOIDR_CAPTURE_SMOKE_PORT ?? 9333);
const serviceUrl = process.env.VOIDR_SERVICE_URL ?? 'http://127.0.0.1:3000/v1';
const localKey = process.env.VERIFICATION_LOCAL_DEV_KEY ?? 'voidr-verification-local';
const organizationId =
  process.env.VERIFICATION_LOCAL_ORGANIZATION_ID ?? 'org_verification_local';
const runtime = {
  serviceUrl,
  collectorUrl: process.env.VOIDR_COLLECTOR_URL ?? 'http://localhost:3100',
  collectorScriptUrl:
    process.env.VOIDR_COLLECTOR_SCRIPT_URL ?? 'http://localhost:8889/dist/recorder.min.js',
  platformUrl: process.env.VOIDR_PLATFORM_URL ?? 'http://localhost:3030',
  localAdapter: true,
  localDevKey: localKey,
  organizationId,
};

const headers = {
  'Content-Type': 'application/json',
  'x-voidr-dev-key': localKey,
  'x-voidr-organization-id': organizationId,
};

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function requestJson(url, init = {}) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success === false) {
    throw new Error(body.message ?? `Local API respondeu HTTP ${response.status}`);
  }
  return body.data ?? body;
}

async function waitFor(description, operation, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await operation();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw new Error(`${description} não ficou pronto.${lastError ? ` ${lastError.message}` : ''}`);
}

async function listTargets() {
  const response = await fetch(`http://127.0.0.1:${debuggingPort}/json/list`, {
    signal: AbortSignal.timeout(2_000),
  });
  if (!response.ok) return [];
  return response.json();
}

class DevToolsClient {
  constructor(url) {
    this.nextId = 1;
    this.pending = new Map();
    this.socket = new WebSocket(url);
    this.ready = new Promise((resolvePromise, reject) => {
      this.socket.addEventListener('open', resolvePromise, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }

  async call(method, params = {}, timeoutMs = 75_000) {
    await this.ready;
    const id = this.nextId++;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} excedeu ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolvePromise(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression, timeoutMs) {
    const result = await this.call(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      timeoutMs,
    );
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? 'Falha no renderer');
    }
    return result.result?.value;
  }

  close() {
    this.socket.close();
  }
}

async function main() {
  const fixture = await requestJson(`${serviceUrl}/loop-test-dev/scenarios/fixtures/checkout-retry`, {
    method: 'POST',
    headers,
  });
  const prepared = await requestJson(`${serviceUrl}/loop-test-dev/scenarios/prepare`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: 'Voidr Capture desktop smoke',
      applicationId: fixture.applicationId,
      environmentSlug: fixture.environmentSlug,
      targetUrl: fixture.targetUrl,
      featureUnderTest: 'Capturar uma interação Web e produzir evidência durável pelo desktop',
    }),
  });
  const recordingUrl = prepared.recording?.url;
  if (typeof recordingUrl !== 'string') throw new Error('Prepare não emitiu recording.url.');

  const child = spawn(
    electronBinary,
    [`--remote-debugging-port=${debuggingPort}`, desktopDirectory],
    {
      cwd: desktopDirectory,
      env: {
        ...process.env,
        CSC_IDENTITY_AUTO_DISCOVERY: 'false',
        VOIDR_CAPTURE_E2E: '1',
      },
      stdio: 'ignore',
    },
  );
  let control;
  try {
    const controlTarget = await waitFor('Control renderer', async () => {
      const targets = await listTargets();
      return targets.find((entry) => entry.type === 'page' && entry.title === 'Voidr Capture');
    });
    control = new DevToolsClient(controlTarget.webSocketDebuggerUrl);
    const startResult = await control.evaluate(`(async()=>{
      const runtime=${JSON.stringify(runtime)};
      await window.voidrCapture.capture.prepareWeb({recordingUrl:${JSON.stringify(recordingUrl)},runtime});
      return window.voidrCapture.capture.startWeb();
    })()`);
    if (startResult?.stage !== 'recording') throw new Error('O host não entrou em recording.');

    await delay(1_200);
    await control.evaluate(
      `window.voidrCapture.capture.annotate({kind:'screen',note:'Smoke desktop: estado após a interação principal'})`,
      30_000,
    );
    const finalStatus = await control.evaluate('window.voidrCapture.capture.stopWeb()', 75_000);
    if (!['processing', 'ready_for_review'].includes(finalStatus?.stage)) {
      throw new Error(`Finalização terminou em ${finalStatus?.stage ?? 'estado desconhecido'}.`);
    }
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          loopId: finalStatus.context?.scenarioId,
          cycleId: finalStatus.context?.cycleId,
          verificationId: finalStatus.context?.verificationId,
          sessionId: finalStatus.sessionId,
          stage: finalStatus.stage,
          evidence: finalStatus.evidence,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    control?.close();
    child.kill('SIGTERM');
    await Promise.race([
      new Promise((resolvePromise) => child.once('exit', resolvePromise)),
      delay(2_000),
    ]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
}

main().catch((error) => {
  process.stderr.write(`Voidr Capture smoke falhou: ${error.message}\n`);
  process.exitCode = 1;
});
