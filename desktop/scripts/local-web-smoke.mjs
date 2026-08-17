import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const desktopDirectory = resolve(directory, '..');
const require = createRequire(import.meta.url);
const electronBinary = require('electron');
const debuggingPort = Number(process.env.VOIDR_CAPTURE_SMOKE_PORT ?? 9333);
const fixtureName = process.env.VOIDR_CAPTURE_SMOKE_FIXTURE ?? 'checkout-retry';
if (!['checkout-retry', 'itau-agro'].includes(fixtureName)) {
  throw new Error(`Fixture de smoke desconhecida: ${fixtureName}`);
}
const serviceUrl = process.env.VOIDR_SERVICE_URL ?? 'http://127.0.0.1:3000/v1';
const localKey = process.env.VERIFICATION_LOCAL_DEV_KEY ?? 'voidr-verification-local';
const organizationId =
  process.env.VERIFICATION_LOCAL_ORGANIZATION_ID ?? 'org_verification_local';
const clickhouseUrl = process.env.CLICKHOUSE_URL ?? 'http://127.0.0.1:8123';
const clickhouseUser = process.env.CLICKHOUSE_USER ?? 'voidr';
const clickhousePassword = process.env.CLICKHOUSE_PASSWORD ?? 'voidr_local';
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

async function storedNetworkCount(sessionId) {
  const url = new URL(clickhouseUrl);
  url.searchParams.set('database', 'voidr_sessions');
  url.searchParams.set(
    'query',
    "SELECT count() AS total FROM sessionEvents WHERE organizationId={org:String} AND sessionId={sid:String} AND type='network' FORMAT JSONEachRow",
  );
  url.searchParams.set('param_org', organizationId);
  url.searchParams.set('param_sid', sessionId);
  const response = await fetch(url, {
    headers: {
      Authorization: `Basic ${Buffer.from(`${clickhouseUser}:${clickhousePassword}`).toString('base64')}`,
    },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`ClickHouse respondeu HTTP ${response.status}.`);
  const row = await response.json();
  return Number(row.total ?? 0);
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
  // Keep the automated Electron instance isolated from the installed app.
  // Chromium's single-instance lock is scoped by userData, so sharing it
  // makes a smoke run steal (or lose) the real user's voidr:// handoff.
  const smokeUserDataDirectory = await mkdtemp(
    resolve(tmpdir(), 'voidr-capture-web-smoke-'),
  );
  const fixture = await requestJson(`${serviceUrl}/loop-test-dev/scenarios/fixtures/${fixtureName}`, {
    method: 'POST',
    headers,
  });
  const prepared = await requestJson(`${serviceUrl}/loop-test-dev/scenarios/prepare`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: `Voidr Capture desktop smoke · ${fixtureName}`,
      applicationId: fixture.applicationId,
      environmentSlug: fixture.environmentSlug,
      targetUrl: fixture.targetUrl,
      featureUnderTest: 'Capturar uma interação Web e produzir evidência durável pelo desktop',
    }),
  });
  const launchUrl = prepared.recording?.launchUrl;
  if (typeof launchUrl !== 'string') throw new Error('Prepare não emitiu launchUrl.');

  const child = spawn(
    electronBinary,
    [
      `--remote-debugging-port=${debuggingPort}`,
      `--user-data-dir=${smokeUserDataDirectory}`,
      desktopDirectory,
      launchUrl,
    ],
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
  let target;
  try {
    const controlTarget = await waitFor('Control renderer', async () => {
      const targets = await listTargets();
      return targets.find((entry) => entry.type === 'page' && entry.title === 'Voidr Capture');
    });
    control = new DevToolsClient(controlTarget.webSocketDebuggerUrl);
    const startResult = await control.evaluate(`(async()=>{
      const deadline=Date.now()+20000;
      while(Date.now()<deadline){
        const status=await window.voidrCapture.capture.status();
        if(status?.stage==='recording') return status;
        if(status?.stage==='recoverable_error'||status?.stage==='terminal_error') throw new Error(status.message||status.errorCode||'Handoff falhou.');
        await new Promise((resolve)=>setTimeout(resolve,200));
      }
      throw new Error('Voidr Capture não consumiu o deep link em 20s.');
    })()`);
    if (startResult?.stage !== 'recording') throw new Error('O host não entrou em recording.');

    const targetEntry = await waitFor('Aplicação capturada', async () => {
      const targets = await listTargets();
      const expectedOrigin = new URL(fixture.targetUrl).origin;
      return targets.find(
        (entry) =>
          entry.type === 'page' &&
          entry.id !== controlTarget.id &&
          typeof entry.url === 'string' &&
          entry.url.startsWith(expectedOrigin),
      );
    });
    if (!targetEntry.webSocketDebuggerUrl) throw new Error('Target Web sem DevTools endpoint.');
    target = new DevToolsClient(targetEntry.webSocketDebuggerUrl);
    const defaultBounds = await control.evaluate(
      `window.voidrCapture.capture.setControlPanel('default')`,
    );
    const defaultTargetHeight = defaultBounds?.height;
    if (!Number.isFinite(defaultTargetHeight)) throw new Error('O host não informou os bounds do target.');

    const requestStatus = await waitFor('Captura de requests', async () => {
      const value = await control.evaluate('window.voidrCapture.capture.status()');
      return value?.evidence?.requests > 0 ? value : undefined;
    });
    if (!requestStatus.recentSignals?.some((signal) => signal.category === 'requests')) {
      throw new Error('A contagem de requests não trouxe contexto inspecionável.');
    }

    await waitFor('Ação de nota', async () => {
      const ready = await control.evaluate(`Boolean(
        [...document.querySelectorAll('.dock-actions button')]
          .find((item)=>item.textContent?.trim()==='Nota')
      )`);
      return ready || undefined;
    });
    await control.evaluate(`(()=>{
      const button=[...document.querySelectorAll('.dock-actions button')].find((item)=>item.textContent?.trim()==='Nota');
      if(!button) throw new Error('Ação Nota não encontrada.');
      button.click();
      return true;
    })()`);
    const noteBounds = await control.evaluate(
      `window.voidrCapture.capture.setControlPanel('annotation')`,
    );
    const noteTargetHeight = await waitFor('Área nativa reservada para nota', async () => {
      const rendererReady = await control.evaluate(
        `document.querySelector('.capture-shell')?.classList.contains('capture-shell-note')`,
      );
      const panelTop = await control.evaluate(
        `document.querySelector('.dock-note')?.getBoundingClientRect().top`,
      );
      const targetBottom = Number(noteBounds?.y ?? 0) + Number(noteBounds?.height ?? 0);
      return rendererReady && noteBounds?.height <= defaultTargetHeight - 60 && panelTop >= targetBottom
        ? noteBounds.height
        : undefined;
    });

    const notesBeforeScreen = Number((await control.evaluate(
      'window.voidrCapture.capture.status()',
    ))?.evidence?.notes ?? 0);
    await control.evaluate(`(()=>{
      const screen=[...document.querySelectorAll('.annotation-action')]
        .find((item)=>item.textContent?.includes('Tela'));
      if(!screen) throw new Error('Ação de nota na tela não encontrada.');
      screen.click();
      return true;
    })()`);
    await waitFor('Composer da nota na tela', async () => {
      const state = await control.evaluate(`(()=>({
        title:document.querySelector('.dock-note-composer')?.textContent||'',
        saveDisabled:document.querySelector('.annotation-composer-actions button')?.disabled,
      }))()`);
      return state?.title.includes('O que deve ser investigado?') && state.saveDisabled === true
        ? state
        : undefined;
    });
    const composerBounds = await control.evaluate(
      `window.voidrCapture.capture.setControlPanel('annotation-composer')`,
    );
    const composerTargetHeight = await waitFor('Área nativa reservada para o composer', async () => {
      const rendererReady = await control.evaluate(
        `document.querySelector('.capture-shell')?.classList.contains('capture-shell-note-composer')`,
      );
      const panelTop = await control.evaluate(
        `document.querySelector('.dock-note-composer')?.getBoundingClientRect().top`,
      );
      const targetBottom = Number(composerBounds?.y ?? 0) + Number(composerBounds?.height ?? 0);
      return rendererReady && composerBounds?.height <= defaultTargetHeight - 150 && panelTop >= targetBottom
        ? composerBounds.height
        : undefined;
    });
    const notesWithoutScreenNote = Number((await control.evaluate(
      'window.voidrCapture.capture.status()',
    ))?.evidence?.notes ?? 0);
    if (notesWithoutScreenNote !== notesBeforeScreen) {
      throw new Error('Abrir a nota na tela persistiu evidência antes da confirmação.');
    }
    await control.evaluate(`(()=>{
      const textarea=document.querySelector('.dock-note-composer textarea');
      if(!textarea) throw new Error('Campo da anotação de tela ausente.');
      const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')?.set;
      setter.call(textarea,'Após o retry, o estado carregando permanece indefinidamente.');
      textarea.dispatchEvent(new Event('input',{bubbles:true}));
      return true;
    })()`);
    await waitFor('Salvar anotação na tela habilitado', async () => {
      const enabled = await control.evaluate(
        `document.querySelector('.annotation-composer-actions button')?.disabled===false`,
      );
      return enabled || undefined;
    });
    await control.evaluate(`document.querySelector('.annotation-composer-actions button').click()`);
    await waitFor('Persistência da nota', async () => {
      const value = await control.evaluate('window.voidrCapture.capture.status()');
      return value?.evidence?.notes === notesBeforeScreen + 1 ? value : undefined;
    }, 30_000);

    const restoredAfterNoteBounds = await control.evaluate(
      `window.voidrCapture.capture.setControlPanel('default')`,
    );
    const restoredAfterNote = restoredAfterNoteBounds?.height;
    if (restoredAfterNote !== defaultTargetHeight) {
      throw new Error('O target não restaurou os bounds depois da nota.');
    }
    await control.evaluate(`(()=>{
      const button=[...document.querySelectorAll('.dock-actions button')]
        .find((item)=>item.textContent?.trim()==='Nota');
      if(!button) throw new Error('Ação Nota não encontrada para selecionar elemento.');
      button.click();
      return true;
    })()`);
    await waitFor('Ação de nota em elemento', async () => {
      const ready = await control.evaluate(`Boolean(
        [...document.querySelectorAll('.annotation-action')]
          .find((item)=>item.textContent?.includes('Elemento'))
      )`);
      return ready || undefined;
    });
    await control.evaluate(`(()=>{
      const button=[...document.querySelectorAll('.annotation-action')]
        .find((item)=>item.textContent?.includes('Elemento'));
      if(!button) throw new Error('Nota em elemento não está disponível.');
      button.click();
      return true;
    })()`);
    await waitFor('Modo de seleção de elemento', async () => {
      const active = await control.evaluate(
        `document.querySelector('.annotation-notice')?.textContent?.includes('Selecione um elemento')`,
      );
      return active || undefined;
    });
    const point = await target.evaluate(`(()=>{
      const element=document.querySelector('button,input,[role="button"]')||document.body;
      const rect=element.getBoundingClientRect();
      return {x:rect.left+Math.max(1,Math.min(rect.width/2,24)),y:rect.top+Math.max(1,Math.min(rect.height/2,18))};
    })()`);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await target.call('Input.dispatchMouseEvent', {
        type,
        x: point.x,
        y: point.y,
        ...(type === 'mouseMoved' ? {} : { button: 'left', clickCount: 1 }),
      });
    }
    await waitFor('Composer após selecionar elemento', async () => {
      const title = await control.evaluate(`document.querySelector('.dock-note-composer')?.textContent`);
      return title?.includes('Nota em elemento') && title.includes('O que deve ser investigado?')
        ? title
        : undefined;
    });
    const notesAfterSelection = Number((await control.evaluate(
      'window.voidrCapture.capture.status()',
    ))?.evidence?.notes ?? 0);
    if (notesAfterSelection !== notesBeforeScreen + 1) {
      throw new Error('Selecionar um elemento criou evidência sem uma nota confirmada.');
    }
    await control.evaluate(`(()=>{
      const textarea=document.querySelector('.dock-note-composer textarea');
      if(!textarea) throw new Error('Campo da anotação em elemento ausente.');
      const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')?.set;
      setter.call(textarea,'Esperado: habilitar o CTA. Observado: continua bloqueado.');
      textarea.dispatchEvent(new Event('input',{bubbles:true}));
      return true;
    })()`);
    await waitFor('Salvar anotação em elemento habilitado', async () => {
      const enabled = await control.evaluate(
        `document.querySelector('.annotation-composer-actions button')?.disabled===false`,
      );
      return enabled || undefined;
    });
    await control.evaluate(`document.querySelector('.annotation-composer-actions button').click()`);
    await waitFor('Persistência da nota em elemento', async () => {
      const value = await control.evaluate('window.voidrCapture.capture.status()');
      return value?.evidence?.notes === notesBeforeScreen + 2 ? value : undefined;
    }, 30_000);
    await control.evaluate(`(()=>{
      const button=document.querySelector('button[title="Ver requisições"]');
      if(!button) throw new Error('Detalhes de requisições não encontrados.');
      button.click();
      return true;
    })()`);
    const evidenceBounds = await control.evaluate(
      `window.voidrCapture.capture.setControlPanel('evidence')`,
    );
    const evidenceTargetHeight = await waitFor('Área nativa reservada para evidências', async () => {
      const rendererReady = await control.evaluate(
        `document.querySelector('.capture-shell')?.classList.contains('capture-shell-evidence')`,
      );
      const detailVisible = await control.evaluate(
        `Boolean(document.querySelector('.dock-evidence-list article'))`,
      );
      const panelTop = await control.evaluate(
        `document.querySelector('.dock-evidence')?.getBoundingClientRect().top`,
      );
      const targetBottom = Number(evidenceBounds?.y ?? 0) + Number(evidenceBounds?.height ?? 0);
      if (
        !rendererReady ||
        !detailVisible ||
        evidenceBounds?.height > defaultTargetHeight - 140 ||
        panelTop < targetBottom
      ) {
        throw new Error(
          JSON.stringify({ rendererReady, detailVisible, panelTop, defaultTargetHeight, evidenceBounds }),
        );
      }
      return evidenceBounds.height;
    });
    await control.evaluate(`(()=>{
      const button=[...document.querySelectorAll('.dock-evidence button')].find((item)=>item.textContent?.trim()==='Fechar');
      if(!button) throw new Error('Ação Fechar não encontrada.');
      button.click();
      return true;
    })()`);
    const restoredAfterEvidence = await control.evaluate(
      `window.voidrCapture.capture.setControlPanel('default')`,
    );
    if (restoredAfterEvidence?.height !== defaultTargetHeight) {
      throw new Error('O target não restaurou os bounds depois das evidências.');
    }

    await control.evaluate(`(()=>{
      globalThis.__voidrSmokeStop = window.voidrCapture.capture.stopWeb();
      return true;
    })()`);
    const finalizationFeedback = await waitFor('Feedback de finalização', async () => {
      const value = await control.evaluate(`(()=>{
        const steps=[...document.querySelectorAll('.finalization-step')];
        if(steps.length!==4) return null;
        return steps.map((step)=>({
          title:step.querySelector('strong')?.textContent?.trim(),
          active:step.classList.contains('active'),
          done:step.classList.contains('done'),
        }));
      })()`);
      return value?.some((step) => step.active) ? value : undefined;
    });
    const finalStatus = await control.evaluate('globalThis.__voidrSmokeStop', 75_000);
    if (!['processing', 'ready_for_review'].includes(finalStatus?.stage)) {
      throw new Error(`Finalização terminou em ${finalStatus?.stage ?? 'estado desconhecido'}.`);
    }
    const persistedNetworkRequests = await waitFor('Requests canônicos no ClickHouse', async () => {
      const count = await storedNetworkCount(finalStatus.sessionId);
      return count > 0 ? count : undefined;
    });
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
          persistedNetworkRequests,
          finalizationFeedback,
          nativeTargetLayout: {
            defaultHeight: defaultTargetHeight,
            noteHeight: noteTargetHeight,
            composerHeight: composerTargetHeight,
            evidenceHeight: evidenceTargetHeight,
            restoredHeight: restoredAfterNote,
          },
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    control?.close();
    target?.close();
    child.kill('SIGTERM');
    await Promise.race([
      new Promise((resolvePromise) => child.once('exit', resolvePromise)),
      delay(2_000),
    ]);
    if (child.exitCode === null) child.kill('SIGKILL');
    await rm(smokeUserDataDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`Voidr Capture smoke falhou: ${error.message}\n`);
  process.exitCode = 1;
});
