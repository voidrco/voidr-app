import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';

const directory = dirname(fileURLToPath(import.meta.url));
const desktopDirectory = resolve(directory, '..');
const screenshotPath = process.env.VOIDR_HOME_AUDIT_SCREENSHOT ?? '/tmp/voidr-desktop-home.png';
const debuggingPort = Number(process.env.VOIDR_HOME_AUDIT_PORT ?? 9341);
const electronBinary = createRequire(import.meta.url)('electron');

const delay = (milliseconds) =>
  new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

async function waitFor(operation, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await operation();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(200);
  }
  throw lastError ?? new Error('A Home não ficou pronta para a auditoria.');
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

  async call(method, params = {}) {
    await this.ready;
    const id = this.nextId++;
    return new Promise((resolvePromise, reject) => {
      this.pending.set(id, { resolve: resolvePromise, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.call('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? 'Falha no renderer.');
    }
    return result.result?.value;
  }

  close() {
    this.socket.close();
  }
}

const child = spawn(
  electronBinary,
  [`--remote-debugging-port=${debuggingPort}`, desktopDirectory],
  {
    cwd: desktopDirectory,
    env: { ...process.env, VOIDR_CAPTURE_E2E: '1', CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
    stdio: 'ignore',
  },
);

let client;
try {
  const target = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${debuggingPort}/json/list`);
    const targets = await response.json();
    return targets.find((entry) => entry.type === 'page' && entry.title === 'Voidr Capture');
  });
  client = new DevToolsClient(target.webSocketDebuggerUrl);
  const audit = await waitFor(async () => {
    const value = await client.evaluate(`(()=>{
      const home=document.querySelector('.workspace-home');
      const rows=[...document.querySelectorAll('.workspace-loop-row')];
      const selected=document.querySelector('.workspace-loop-row.active');
      const cycleRows=[...document.querySelectorAll('.workspace-cycle-row')];
      const evidenceRows=[...document.querySelectorAll('.workspace-evidence-list article')];
      if(!home||!selected||!cycleRows.length) return null;
      const rect=home.getBoundingClientRect();
      const labels=[...document.querySelectorAll('button')]
        .map((element)=>element.textContent?.trim())
        .filter(Boolean);
      return {
        viewport:{width:innerWidth,height:innerHeight},
        home:{width:Math.round(rect.width),height:Math.round(rect.height)},
        loops:rows.length,
        cycles:cycleRows.length,
        evidence:evidenceRows.length,
        selectedLoop:selected.textContent?.replace(/\\s+/g,' ').trim(),
        actions:labels.filter((label)=>['Iniciar meu ciclo','Revisar na Web','Atualizar'].includes(label)),
        horizontalOverflow:document.documentElement.scrollWidth>document.documentElement.clientWidth,
        internalCopy:/\\b(?:VAP|Mongo|ClickHouse|object storage|signed URL|harnessDelivery)\\b/i.test(document.body.innerText),
      };
    })()`);
    return value?.evidence ? value : undefined;
  });
  const screenshot = await client.call('Page.captureScreenshot', { format: 'png' });
  await writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'));
  if (audit.horizontalOverflow) throw new Error('A Home criou overflow horizontal global.');
  if (audit.internalCopy) throw new Error('A Home expôs copy interna de implementação.');
  if (!audit.actions.includes('Iniciar meu ciclo')) throw new Error('A ação primária não está visível.');
  process.stdout.write(`${JSON.stringify({ ok: true, screenshotPath, ...audit }, null, 2)}\n`);
} finally {
  client?.close();
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolvePromise) => child.once('exit', resolvePromise)),
    delay(2_000),
  ]);
}
