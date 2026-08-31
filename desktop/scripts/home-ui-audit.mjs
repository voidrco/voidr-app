import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const directory = dirname(fileURLToPath(import.meta.url));
const desktopDirectory = resolve(directory, '..');
const screenshotPath = process.env.VOIDR_HOME_AUDIT_SCREENSHOT ?? '/tmp/voidr-desktop-home.png';
const debuggingPort = Number(process.env.VOIDR_HOME_AUDIT_PORT ?? 9341);
const auditMode = process.env.VOIDR_HOME_AUDIT_MODE === 'connect' ? 'connect' : 'workspace';
const electronBinary = createRequire(import.meta.url)('electron');
const auditUserDataDirectory = await mkdtemp(resolve(tmpdir(), 'voidr-home-audit-'));

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
  [
    `--remote-debugging-port=${debuggingPort}`,
    `--user-data-dir=${auditUserDataDirectory}`,
    desktopDirectory,
  ],
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
      const auditMode=${JSON.stringify(auditMode)};
      const home=document.querySelector('.workspace-home');
      const connect=document.querySelector('.workspace-connect');
      const rows=[...document.querySelectorAll('.workspace-loop-row')];
      const selected=document.querySelector('.workspace-loop-row.active');
      const cycleRows=[...document.querySelectorAll('.workspace-cycle-row')];
      const selectedTest=document.querySelector('.workspace-cycle-row.active');
      const evidenceRows=[...document.querySelectorAll('.workspace-evidence-list article')];
      const technical=document.querySelector('.workspace-technical-signals');
      if(!home||(auditMode==='workspace'&&(!selected||!cycleRows.length))) return null;
      const rect=home.getBoundingClientRect();
      const labels=[...document.querySelectorAll('button')]
        .map((element)=>element.textContent?.trim())
        .filter(Boolean);
      return {
        viewport:{width:innerWidth,height:innerHeight},
        home:{width:Math.round(rect.width),height:Math.round(rect.height)},
        connect:Boolean(connect),
        connectTitle:connect?.querySelector('h1')?.textContent?.trim(),
        connectAction:[...document.querySelectorAll('button')]
          .find((element)=>element.textContent?.trim()==='Abrir a Voidr')?.textContent?.trim(),
        loops:rows.length,
        tests:cycleRows.length,
        evidence:evidenceRows.length,
        selectedTest:selectedTest?.textContent?.replace(/\\s+/g,' ').trim(),
        replayVisible:Boolean(
          [...document.querySelectorAll('.workspace-evidence-list article strong')]
            .find((element)=>element.textContent?.trim()==='Replay do teste')
        ),
        selectedLoop:selected?.textContent?.replace(/\\s+/g,' ').trim(),
        actions:labels.filter((label)=>['Fazer meu teste','Abrir teste','Revisar teste'].includes(label)),
        technicalSignalsCollapsed:Boolean(technical&&!technical.hasAttribute('open')),
        duplicateWorkspaceHeading:Boolean(document.querySelector('.workspace-heading')),
        horizontalOverflow:document.documentElement.scrollWidth>document.documentElement.clientWidth,
        internalCopy:/\\b(?:VAP|Mongo|ClickHouse|object storage|signed URL|harnessDelivery|Cycle|Ciclo)\\b/i.test(document.body.innerText),
      };
    })()`);
    return auditMode === 'connect'
      ? value?.connect ? value : undefined
      : value?.tests ? value : undefined;
  });
  const screenshot = await client.call('Page.captureScreenshot', { format: 'png' });
  await writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'));
  if (audit.horizontalOverflow) throw new Error('A Home criou overflow horizontal global.');
  if (auditMode === 'connect') {
    if (audit.connectTitle !== 'Conecte seu workspace' || audit.connectAction !== 'Abrir a Voidr') {
      throw new Error('A primeira abertura não apresentou uma conexão de workspace acionável.');
    }
  } else {
    if (audit.internalCopy) throw new Error('A Home expôs copy interna de implementação.');
    if (audit.selectedTest?.includes('Em teste') && audit.replayVisible) {
      throw new Error('A Home afirmou que existe replay antes da captura terminar.');
    }
    if (audit.duplicateWorkspaceHeading) throw new Error('A Home repetiu o título da área de trabalho.');
    if (!audit.technicalSignalsCollapsed) throw new Error('Sinais técnicos competem com o feedback principal.');
    if (!audit.actions.includes('Fazer meu teste')) throw new Error('A ação primária não está visível.');
  }
  process.stdout.write(`${JSON.stringify({ ok: true, mode: auditMode, screenshotPath, ...audit }, null, 2)}\n`);
} finally {
  client?.close();
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolvePromise) => child.once('exit', resolvePromise)),
    delay(2_000),
  ]);
  await rm(auditUserDataDirectory, { recursive: true, force: true });
}
