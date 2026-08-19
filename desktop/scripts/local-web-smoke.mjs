import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
const smokeRunId = process.env.VOIDR_CAPTURE_SMOKE_RUN_ID?.trim();
const voiceScreenshotPath = process.env.VOIDR_CAPTURE_VOICE_SCREENSHOT;
const voicePcmPath = process.env.VOIDR_CAPTURE_VOICE_PCM_PATH;
const requireVoiceSuccess = process.env.VOIDR_CAPTURE_REQUIRE_VOICE_SUCCESS === '1';
const passiveFailureUrl = process.env.VOIDR_CAPTURE_PASSIVE_FAILURE_URL;
const passiveExpectedEndpoint = process.env.VOIDR_CAPTURE_PASSIVE_EXPECTED_ENDPOINT;
const passiveSecretProbe = process.env.VOIDR_CAPTURE_PASSIVE_SECRET_PROBE ?? '';
if (!['checkout-retry', 'itau-agro'].includes(fixtureName)) {
  throw new Error(`Fixture de smoke desconhecida: ${fixtureName}`);
}
const serviceUrl = process.env.VOIDR_SERVICE_URL ?? 'http://127.0.0.1:3000/v1';
const localKey = process.env.VERIFICATION_LOCAL_DEV_KEY ?? 'voidr-verification-local';
const organizationId = process.env.VERIFICATION_LOCAL_ORGANIZATION_ID ?? 'org_verification_local';
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
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success === false) {
    throw new Error(body.message ?? `Local API respondeu HTTP ${response.status}`);
  }
  return body.data ?? body;
}

async function requestEvidenceAsset(verificationId, evidenceRef) {
  const response = await fetch(
    `${serviceUrl}/verification-dev/verifications/${encodeURIComponent(verificationId)}/evidence-asset`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ evidenceRef }),
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!response.ok) throw new Error(`Download da evidência respondeu HTTP ${response.status}.`);
  const contentType = response.headers.get('content-type') ?? '';
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!contentType.startsWith('image/jpeg') || bytes.length < 128) {
    throw new Error('A evidência de voz não retornou uma imagem JPEG válida.');
  }
  return { contentType, bytes: bytes.length };
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

async function storedPassiveCounts(sessionId, endpoint, secretProbe) {
  const url = new URL(clickhouseUrl);
  url.searchParams.set('database', 'voidr_sessions');
  url.searchParams.set(
    'query',
    "SELECT countIf(type='network' AND status=500 AND url={endpoint:String}) AS httpFailures, " +
      "countIf(type='console' AND message='ConsoleError registrado no console.') AS consoleErrors, " +
      "countIf(type='network' AND startsWith(url,{endpoint:String}) AND position(url,'?')>0) AS leakedQueryUrls, " +
      "countIf({secret:String}!='' AND position(concat(url,message,stack,statusText),{secret:String})>0) AS leakedSecrets " +
      'FROM sessionEvents WHERE organizationId={org:String} AND sessionId={sid:String} FORMAT JSONEachRow',
  );
  url.searchParams.set('param_org', organizationId);
  url.searchParams.set('param_sid', sessionId);
  url.searchParams.set('param_endpoint', endpoint);
  url.searchParams.set('param_secret', secretProbe);
  const response = await fetch(url, {
    headers: {
      Authorization: `Basic ${Buffer.from(`${clickhouseUser}:${clickhousePassword}`).toString('base64')}`,
    },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`ClickHouse respondeu HTTP ${response.status}.`);
  const row = await response.json();
  return {
    httpFailures: Number(row.httpFailures ?? 0),
    consoleErrors: Number(row.consoleErrors ?? 0),
    leakedQueryUrls: Number(row.leakedQueryUrls ?? 0),
    leakedSecrets: Number(row.leakedSecrets ?? 0),
  };
}

async function exercisePassiveReviewFlow(finalStatus) {
  const scenarioId = finalStatus.context?.scenarioId;
  const verificationId = finalStatus.context?.verificationId;
  if (!scenarioId || !verificationId) {
    throw new Error('A finalização não retornou os IDs necessários para revisar feedback passivo.');
  }
  const cycleUrl =
    `${serviceUrl}/loop-test-dev/scenarios/${encodeURIComponent(scenarioId)}` +
    `/cycles/${encodeURIComponent(verificationId)}`;
  const reviewsUrl = `${serviceUrl}/verification-dev/verifications/${encodeURIComponent(verificationId)}/reviews`;
  const initial = await waitFor(
    'Feedback passivo revisável no report',
    async () => {
      const cycle = await requestJson(cycleUrl, { headers });
      const passive = cycle.report?.passiveFeedback;
      const reviewRefs = [
        ...new Set(
          (passive?.items ?? []).flatMap((item) =>
            Array.isArray(item?.reviewEvidenceRefs) ? item.reviewEvidenceRefs : [],
          ),
        ),
      ];
      return passive?.activeItemIds?.length === 2 && reviewRefs.length === 2
        ? { cycle, passive, reviewRefs }
        : undefined;
    },
    60_000,
  );
  const generation = initial.cycle.generation;
  const reviewVersion = Number(initial.cycle.review?.reviewVersion ?? 0);
  if (typeof generation !== 'string') throw new Error('O Cycle não retornou uma generation válida.');

  const wrongTenant = await fetch(reviewsUrl, {
    method: 'POST',
    headers: {
      ...headers,
      'x-voidr-organization-id': `${organizationId}_isolation_probe`,
    },
    body: JSON.stringify({
      generation,
      reviewVersion,
      idempotencyKey: `passive-smoke-wrong-org-${finalStatus.sessionId}`,
      items: [
        {
          evidenceRef: initial.reviewRefs[0],
          verdict: 'ignore',
          note: 'Esta operação deve ser rejeitada por isolamento de organização.',
          applyToFutureCycles: false,
        },
      ],
    }),
    signal: AbortSignal.timeout(10_000),
  });
  await wrongTenant.arrayBuffer();
  if (wrongTenant.status !== 404) {
    throw new Error(`Uma organização incorreta recebeu HTTP ${wrongTenant.status} na revisão.`);
  }

  const invalid = await fetch(reviewsUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      generation,
      reviewVersion,
      idempotencyKey: `passive-smoke-missing-note-${finalStatus.sessionId}`,
      items: [
        {
          evidenceRef: initial.reviewRefs[0],
          verdict: 'ignore',
          applyToFutureCycles: false,
        },
      ],
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const invalidBody = await invalid.json().catch(() => ({}));
  if (
    invalid.status !== 400 ||
    !String(invalidBody?.error?.message ?? invalidBody?.message ?? '').includes('requires a justification')
  ) {
    throw new Error(`Ignore sem justificativa respondeu HTTP ${invalid.status}.`);
  }
  const unchangedReview = await requestJson(reviewsUrl, { headers });
  if (unchangedReview.reviewVersion !== reviewVersion) {
    throw new Error('Uma revisão inválida alterou o reviewVersion do Cycle.');
  }

  const ignored = await requestJson(reviewsUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      generation,
      reviewVersion,
      idempotencyKey: `passive-smoke-ignore-${finalStatus.sessionId}`,
      items: initial.reviewRefs.map((evidenceRef) => ({
        evidenceRef,
        verdict: 'ignore',
        note: 'Falha injetada exclusivamente pelo smoke E2E de feedback passivo.',
        applyToFutureCycles: false,
      })),
    }),
  });
  const reviewIds = Array.isArray(ignored.reviewIds) ? ignored.reviewIds : [];
  if (
    reviewIds.length !== initial.reviewRefs.length ||
    !ignored.review?.active?.every((entry) => entry?.policy?.compatibility?.applyToFutureCycles === false)
  ) {
    throw new Error('O ignore em lote não preservou o escopo exclusivo do Cycle atual.');
  }

  const ignoredProjection = await waitFor('Feedback passivo ignorado na projeção efetiva', async () => {
    const cycle = await requestJson(cycleUrl, { headers });
    const passive = cycle.report?.passiveFeedback;
    const reportRefs = new Set(cycle.report?.evidenceRefs ?? []);
    const directRefsRemoved = initial.reviewRefs.every((evidenceRef) => !reportRefs.has(evidenceRef));
    return passive?.activeItemIds?.length === 0 && directRefsRemoved ? cycle : undefined;
  });
  const rawContext = await requestJson(
    `${serviceUrl}/verification-dev/verifications/${encodeURIComponent(verificationId)}/context`,
    { headers },
  );
  if (rawContext.counts?.failedRequests !== 1 || rawContext.counts?.consoleErrors !== 1) {
    throw new Error('Ignorar feedback alterou os sinais técnicos brutos do Cycle.');
  }
  const candidate = await requestJson(
    `${serviceUrl}/verification-dev/verifications/${encodeURIComponent(verificationId)}/defect-candidate`,
    { headers },
  );
  const candidateRefs = new Set(candidate.candidate?.evidenceRefs ?? []);
  if (initial.reviewRefs.some((evidenceRef) => candidateRefs.has(evidenceRef))) {
    throw new Error('O candidato de Defect ainda cita uma evidência técnica ignorada.');
  }

  const undone = await requestJson(`${reviewsUrl}/undo`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      generation,
      reviewVersion: ignored.review.reviewVersion,
      idempotencyKey: `passive-smoke-undo-${finalStatus.sessionId}`,
      reviewIds,
      reason: 'Restaurar o estado ativo após validar ignore em lote.',
    }),
  });
  const restored = await waitFor('Feedback passivo restaurado após Undo', async () => {
    const cycle = await requestJson(cycleUrl, { headers });
    const passive = cycle.report?.passiveFeedback;
    return passive?.activeItemIds?.length === 2 ? cycle : undefined;
  });
  return {
    tenantIsolationStatus: wrongTenant.status,
    validationErrorStatus: invalid.status,
    ignoredItems: ignoredProjection.report.passiveFeedback.summary.ignored,
    activeAfterIgnore: ignoredProjection.report.passiveFeedback.activeItemIds.length,
    rawFailedRequests: rawContext.counts.failedRequests,
    rawConsoleErrors: rawContext.counts.consoleErrors,
    candidateIgnoredRefs: initial.reviewRefs.filter((evidenceRef) => candidateRefs.has(evidenceRef)).length,
    reviewIds,
    undoReviewVersion: undone.review.reviewVersion,
    activeAfterUndo: restored.report.passiveFeedback.activeItemIds.length,
  };
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

async function dispatchEscape(client) {
  const input = {
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27,
  };
  await client.call('Input.dispatchKeyEvent', { type: 'keyDown', ...input });
  await client.call('Input.dispatchKeyEvent', { type: 'keyUp', ...input });
}

async function sendTargetInput(control, input) {
  const normalized = input.type.startsWith('mouse')
    ? { ...input, x: Math.round(input.x), y: Math.round(input.y) }
    : input;
  await control.evaluate(`window.voidrCapture.capture.sendTargetInputForTest(
    ${JSON.stringify(normalized)}
  )`);
  await delay(60);
}

async function dispatchTargetEscape(control) {
  await sendTargetInput(control, { type: 'keyDown', keyCode: 'Escape' });
  await sendTargetInput(control, { type: 'keyUp', keyCode: 'Escape' });
}

function deterministicVoicePcmBase64(durationMs = 1_200) {
  const samples = Math.round((16_000 * durationMs) / 1_000);
  const pcm = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) {
    const envelope = Math.min(1, index / 800, (samples - index) / 800);
    const sample = Math.round(Math.sin((index / 16_000) * Math.PI * 2 * 220) * 1_600 * envelope);
    pcm.writeInt16LE(sample, index * 2);
  }
  return pcm.toString('base64');
}

async function main() {
  const smokeStartedAt = Date.now();
  // Keep the automated Electron instance isolated from the installed app.
  // Chromium's single-instance lock is scoped by userData, so sharing it
  // makes a smoke run steal (or lose) the real user's voidr:// handoff.
  const smokeUserDataDirectory = await mkdtemp(resolve(tmpdir(), 'voidr-capture-web-smoke-'));
  const fixture = await requestJson(`${serviceUrl}/loop-test-dev/scenarios/fixtures/${fixtureName}`, {
    method: 'POST',
    headers,
  });
  const prepared = await requestJson(`${serviceUrl}/loop-test-dev/scenarios/prepare`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: `Voidr Capture desktop smoke · ${fixtureName}${smokeRunId ? ` · ${smokeRunId}` : ''}`,
      applicationId: fixture.applicationId,
      environmentSlug: fixture.environmentSlug,
      targetUrl: fixture.targetUrl,
      featureUnderTest:
        'Capturar uma interação Web e produzir evidência durável pelo desktop' +
        (smokeRunId ? ` · ${smokeRunId}` : ''),
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
    const defaultBounds = await control.evaluate(`window.voidrCapture.capture.setControlPanel('default')`);
    const defaultTargetHeight = defaultBounds?.height;
    if (!Number.isFinite(defaultTargetHeight)) throw new Error('O host não informou os bounds do target.');

    const requestStatus = await waitFor('Captura de requests', async () => {
      const value = await control.evaluate('window.voidrCapture.capture.status()');
      return value?.evidence?.requests > 0 ? value : undefined;
    });
    if (!requestStatus.recentSignals?.some((signal) => signal.category === 'requests')) {
      throw new Error('A contagem de requests não trouxe contexto inspecionável.');
    }

    let passiveSmoke;
    if (passiveFailureUrl) {
      const marker = `voidr-passive-smoke-${Date.now()}`;
      const endpointUrl = new URL(passiveFailureUrl);
      endpointUrl.username = '';
      endpointUrl.password = '';
      endpointUrl.search = '';
      endpointUrl.hash = '';
      const localEndpoint = `${endpointUrl.origin}${endpointUrl.pathname}`;
      const endpoint = passiveExpectedEndpoint ?? localEndpoint;
      const result = await target.evaluate(`(async()=>{
        console.error(${JSON.stringify(marker)});
        console.error(${JSON.stringify(marker)});
        const response=await fetch(${JSON.stringify(passiveFailureUrl)}, {
          headers:{'x-failure-mode':'http_500','x-failure-target':'/produtores'}
        });
        return {status:response.status};
      })()`);
      if (result?.status !== 500) {
        throw new Error(`A fixture passiva respondeu HTTP ${result?.status ?? 'desconhecido'}.`);
      }
      await waitFor('Feedback técnico local do CDP', async () => {
        const value = await control.evaluate('window.voidrCapture.capture.status()');
        const signals = Array.isArray(value?.recentSignals) ? value.recentSignals : [];
        const consoleSignal = signals.some(
          (signal) =>
            signal.category === 'errors' &&
            signal.title === 'ConsoleError' &&
            signal.detail === 'ConsoleError registrado no console.',
        );
        const networkSignal = signals.some(
          (signal) =>
            signal.category === 'requests' &&
            signal.title?.includes('HTTP 500') &&
            signal.detail?.includes(localEndpoint) &&
            !signal.detail?.includes('?'),
        );
        return consoleSignal && networkSignal ? value : undefined;
      });
      passiveSmoke = { marker, endpoint };
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
    const noteBounds = await control.evaluate(`window.voidrCapture.capture.setControlPanel('annotation')`);
    const noteTargetHeight = await waitFor('Área nativa reservada para nota', async () => {
      const rendererReady = await control.evaluate(
        `document.querySelector('.capture-shell')?.classList.contains('capture-shell-note')`,
      );
      const panelTop = await control.evaluate(`document.querySelector('.dock-note')?.getBoundingClientRect().top`);
      const targetBottom = Number(noteBounds?.y ?? 0) + Number(noteBounds?.height ?? 0);
      return rendererReady && noteBounds?.height <= defaultTargetHeight - 60 && panelTop >= targetBottom
        ? noteBounds.height
        : undefined;
    });

    const notesBeforeScreen = Number(
      (await control.evaluate('window.voidrCapture.capture.status()'))?.evidence?.notes ?? 0,
    );

    await control.evaluate(`(()=>{
      const element=[...document.querySelectorAll('.annotation-action')]
        .find((item)=>item.textContent?.includes('Elemento'));
      if(!element) throw new Error('Ação de nota em elemento não encontrada para testar Esc.');
      element.click();
      return true;
    })()`);
    await waitFor('Seleção de elemento antes do Esc', async () => {
      const active = await control.evaluate(
        `document.querySelector('.annotation-notice')?.textContent?.includes('Selecione um elemento')`,
      );
      return active || undefined;
    });
    await dispatchEscape(control);
    await waitFor('Esc do controle voltou ao seletor de notas', async () => {
      const state = await control.evaluate(`(()=>({
        chooser:Boolean(document.querySelector('.annotation-capture-row')),
        selecting:Boolean(document.querySelector('.annotation-notice')),
      }))()`);
      return state?.chooser && !state.selecting ? state : undefined;
    });
    const notesAfterElementEscape = Number(
      (await control.evaluate('window.voidrCapture.capture.status()'))?.evidence?.notes ?? 0,
    );
    if (notesAfterElementEscape !== notesBeforeScreen) {
      throw new Error('Esc durante seleção de elemento criou uma evidência.');
    }

    await control.evaluate(`(()=>{
      const element=[...document.querySelectorAll('.annotation-action')]
        .find((item)=>item.textContent?.includes('Elemento'));
      if(!element) throw new Error('Elemento não ficou disponível depois do primeiro cancelamento.');
      element.click();
      return true;
    })()`);
    await waitFor('Cancelamento explícito da seleção de elemento', async () => {
      const button = await control.evaluate(`[...document.querySelectorAll('.dock-actions button')]
        .some((item)=>item.textContent?.trim()==='Cancelar seleção')`);
      return button || undefined;
    });
    await control.evaluate(`(()=>{
      const cancel=[...document.querySelectorAll('.dock-actions button')]
        .find((item)=>item.textContent?.trim()==='Cancelar seleção');
      if(!cancel) throw new Error('Ação Cancelar seleção não encontrada.');
      cancel.click();
      return true;
    })()`);
    await waitFor('Botão Cancelar seleção voltou ao seletor de notas', async () => {
      const chooser = await control.evaluate(`Boolean(document.querySelector('.annotation-capture-row'))`);
      return chooser || undefined;
    });

    await control.evaluate(`(()=>{
      const element=[...document.querySelectorAll('.annotation-action')]
        .find((item)=>item.textContent?.includes('Elemento'));
      if(!element) throw new Error('Elemento não ficou disponível para testar o cancelamento no overlay.');
      element.click();
      return true;
    })()`);
    await waitFor('Botão Cancelar no overlay de elemento', async () => {
      const ready = await target.evaluate(`Boolean(document.querySelector('[data-voidr-selection-cancel]'))`);
      return ready || undefined;
    });
    await target.evaluate(`document.querySelector('[data-voidr-selection-cancel]')?.click(); true`);
    await waitFor('Cancelamento no overlay voltou ao seletor de notas', async () => {
      const state = await control.evaluate(`(()=>({
        chooser:Boolean(document.querySelector('.annotation-capture-row')),
        selecting:Boolean(document.querySelector('.annotation-notice')),
      }))()`);
      return state?.chooser && !state.selecting ? state : undefined;
    });

    await control.evaluate(`(()=>{
      const element=[...document.querySelectorAll('.annotation-action')]
        .find((item)=>item.textContent?.includes('Elemento'));
      if(!element) throw new Error('Elemento não ficou disponível para testar Esc no target.');
      element.click();
      return true;
    })()`);
    await waitFor('Seleção de elemento com foco no target', async () => {
      const active = await control.evaluate(
        `document.querySelector('.annotation-notice')?.textContent?.includes('Selecione um elemento')`,
      );
      return active || undefined;
    });
    await waitFor('Seletor de elemento no target', async () => {
      const state = await target.evaluate(`(()=>({
        overlay:Boolean(document.querySelector('[data-voidr-verification-overlay]')),
        hint:[...document.querySelectorAll('[data-voidr-verification-overlay]')]
          .some((item)=>item.textContent?.includes('Clique em um elemento · Esc para cancelar')),
      }))()`);
      return state?.overlay && state.hint ? state : undefined;
    });
    await Promise.all([dispatchTargetEscape(control), dispatchTargetEscape(control)]);
    await waitFor('Esc físico do target cancelou a seleção de elemento', async () => {
      const state = await control.evaluate(`(()=>({
        chooser:Boolean(document.querySelector('.annotation-capture-row')),
        cancelling:[...document.querySelectorAll('.dock-actions button')]
          .some((item)=>item.textContent?.trim()==='Cancelar seleção'),
        notice:document.querySelector('.annotation-notice')?.textContent||'',
        dock:document.querySelector('.dock-note')?.textContent||'',
      }))()`);
      if (state?.chooser && !state.cancelling) return state;
      throw new Error(JSON.stringify(state));
    });

    await control.evaluate(`(()=>{
      const region=[...document.querySelectorAll('.annotation-action')]
        .find((item)=>item.textContent?.includes('Região'));
      if(!region) throw new Error('Ação de nota em região não encontrada para testar Esc.');
      region.click();
      return true;
    })()`);
    await waitFor('Seleção de região antes do Esc', async () => {
      const active = await control.evaluate(
        `document.querySelector('.annotation-notice')?.textContent?.includes('Arraste sobre uma área')`,
      );
      return active || undefined;
    });
    await waitFor('Overlay de região antes do Esc', async () => {
      const ready = await target.evaluate(`Boolean(
        [...document.querySelectorAll('div')]
          .find((node)=>getComputedStyle(node).zIndex==='2147483647')
      )`);
      return ready || undefined;
    });
    await dispatchTargetEscape(control);
    await waitFor('Esc do target voltou ao seletor de notas', async () => {
      const state = await control.evaluate(`(()=>({
        chooser:Boolean(document.querySelector('.annotation-capture-row')),
        selecting:Boolean(document.querySelector('.annotation-notice')),
        notice:document.querySelector('.annotation-notice')?.textContent||'',
        dock:document.querySelector('.dock-note')?.textContent||'',
      }))()`);
      if (state?.chooser && !state.selecting) return state;
      throw new Error(JSON.stringify(state));
    });

    await sendTargetInput(control, {
      type: 'mouseDown',
      x: 12,
      y: 12,
      button: 'left',
      clickCount: 1,
    });
    await sendTargetInput(control, {
      type: 'mouseUp',
      x: 12,
      y: 12,
      button: 'left',
      clickCount: 1,
    });
    await waitFor('Clique no produto fechou o seletor vazio', async () => {
      const open = await control.evaluate(`Boolean(document.querySelector('.dock-note'))`);
      return open ? undefined : true;
    });
    await control.evaluate(`(()=>{
      const button=[...document.querySelectorAll('.dock-actions button')]
        .find((item)=>item.textContent?.trim()==='Nota');
      if(!button) throw new Error('Ação Nota não encontrada depois do clique fora.');
      button.click();
      return true;
    })()`);
    await waitFor('Seletor de notas reaberto', async () => {
      const chooser = await control.evaluate(`Boolean(document.querySelector('.annotation-capture-row'))`);
      return chooser || undefined;
    });

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
      return state?.title.includes('O que deve ser investigado?') && state.saveDisabled === true ? state : undefined;
    });
    const composerBounds = await control.evaluate(`window.voidrCapture.capture.setControlPanel('annotation-composer')`);
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
    const notesWithoutScreenNote = Number(
      (await control.evaluate('window.voidrCapture.capture.status()'))?.evidence?.notes ?? 0,
    );
    if (notesWithoutScreenNote !== notesBeforeScreen) {
      throw new Error('Abrir a nota na tela persistiu evidência antes da confirmação.');
    }
    await control.evaluate(`(()=>{
      const textarea=document.querySelector('.dock-note-composer textarea');
      if(!textarea) throw new Error('Campo da anotação de tela ausente.');
      const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')?.set;
      setter.call(textarea,'Rascunho que precisa sobreviver à volta.');
      textarea.dispatchEvent(new Event('input',{bubbles:true}));
      return true;
    })()`);
    await dispatchEscape(control);
    await waitFor('Esc no composer preservou o rascunho no seletor', async () => {
      const chooser = await control.evaluate(`Boolean(document.querySelector('.annotation-capture-row'))`);
      return chooser || undefined;
    });
    await control.evaluate(`(()=>{
      const screen=[...document.querySelectorAll('.annotation-action')]
        .find((item)=>item.textContent?.includes('Tela'));
      if(!screen) throw new Error('Ação Tela ausente depois de voltar.');
      screen.click();
      return true;
    })()`);
    await waitFor('Rascunho restaurado depois de voltar', async () => {
      const value = await control.evaluate(`document.querySelector('.dock-note-composer textarea')?.value`);
      return value === 'Rascunho que precisa sobreviver à volta.' ? value : undefined;
    });
    await control.evaluate(`(()=>{
      const textarea=document.querySelector('.dock-note-composer textarea');
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
    await control.evaluate(`(()=>{
      const save=document.querySelector('.annotation-composer-actions button');
      save.click();
      save.click();
      return true;
    })()`);
    await waitFor(
      'Persistência da nota',
      async () => {
        const value = await control.evaluate('window.voidrCapture.capture.status()');
        return value?.evidence?.notes === notesBeforeScreen + 1 ? value : undefined;
      },
      30_000,
    );

    const restoredAfterNoteBounds = await control.evaluate(`window.voidrCapture.capture.setControlPanel('default')`);
    const restoredAfterNote = restoredAfterNoteBounds?.height;
    if (restoredAfterNote !== defaultTargetHeight) {
      throw new Error('O target não restaurou os bounds depois da nota.');
    }
    await control.evaluate(`(()=>{
      const button=[...document.querySelectorAll('.dock-actions button')]
        .find((item)=>item.textContent?.trim()==='Nota');
      if(!button) throw new Error('Ação Nota não encontrada para selecionar região.');
      button.click();
      return true;
    })()`);
    await waitFor('Ação de nota em região', async () => {
      const ready = await control.evaluate(`Boolean(
        [...document.querySelectorAll('.annotation-action')]
          .find((item)=>item.textContent?.includes('Região'))
      )`);
      return ready || undefined;
    });
    await control.evaluate(`(()=>{
      const button=[...document.querySelectorAll('.annotation-action')]
        .find((item)=>item.textContent?.includes('Região'));
      if(!button) throw new Error('Nota em região não está disponível.');
      button.click();
      return true;
    })()`);
    await waitFor('Modo de seleção de região', async () => {
      const active = await control.evaluate(
        `document.querySelector('.annotation-notice')?.textContent?.includes('Arraste sobre uma área')`,
      );
      return active || undefined;
    });
    await waitFor('Overlay de seleção de região', async () => {
      const ready = await target.evaluate(`Boolean(
        [...document.querySelectorAll('div')]
          .find((node)=>getComputedStyle(node).zIndex==='2147483647')
      )`);
      return ready || undefined;
    });
    const region = await target.evaluate(`(()=>({
      start:{x:Math.max(24,innerWidth*.18),y:Math.max(24,innerHeight*.2)},
      end:{x:Math.min(innerWidth-24,innerWidth*.72),y:Math.min(innerHeight-24,innerHeight*.62)}
    }))()`);
    const regionRect = {
      x: Math.min(region.start.x, region.end.x),
      y: Math.min(region.start.y, region.end.y),
      width: Math.abs(region.end.x - region.start.x),
      height: Math.abs(region.end.y - region.start.y),
    };
    await control.evaluate(`window.voidrCapture.capture.selectRegionForTest(
      ${JSON.stringify(regionRect)}
    )`);
    await waitFor('Composer após selecionar região', async () => {
      const state = await control.evaluate(`(()=>({
        title:document.querySelector('.dock-note-composer')?.textContent||'',
        notice:document.querySelector('.annotation-notice')?.textContent||'',
        chooser:Boolean(document.querySelector('.annotation-capture-row')),
      }))()`);
      if (state?.title.includes('Nota em região') && state.title.includes('O que deve ser investigado?')) {
        return state;
      }
      throw new Error(JSON.stringify(state));
    });
    const notesAfterRegionSelection = Number(
      (await control.evaluate('window.voidrCapture.capture.status()'))?.evidence?.notes ?? 0,
    );
    if (notesAfterRegionSelection !== notesBeforeScreen + 1) {
      throw new Error('Selecionar uma região criou evidência sem uma nota confirmada.');
    }
    await control.evaluate(`(()=>{
      const textarea=document.querySelector('.dock-note-composer textarea');
      if(!textarea) throw new Error('Campo da anotação em região ausente.');
      const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')?.set;
      setter.call(textarea,'Esta área perde o feedback visual depois do retry.');
      textarea.dispatchEvent(new Event('input',{bubbles:true}));
      return true;
    })()`);
    await waitFor('Salvar anotação em região habilitado', async () => {
      const enabled = await control.evaluate(
        `document.querySelector('.annotation-composer-actions button')?.disabled===false`,
      );
      return enabled || undefined;
    });
    await control.evaluate(`document.querySelector('.annotation-composer-actions button').click()`);
    await waitFor(
      'Persistência da nota em região',
      async () => {
        const value = await control.evaluate('window.voidrCapture.capture.status()');
        return value?.evidence?.notes === notesBeforeScreen + 2 ? value : undefined;
      },
      30_000,
    );

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
    for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) {
      await sendTargetInput(control, {
        type,
        x: point.x,
        y: point.y,
        ...(type === 'mouseMove' ? {} : { button: 'left', clickCount: 1 }),
      });
    }
    await waitFor('Composer após selecionar elemento', async () => {
      const title = await control.evaluate(`document.querySelector('.dock-note-composer')?.textContent`);
      return title?.includes('Nota em elemento') && title.includes('O que deve ser investigado?') ? title : undefined;
    });
    const notesAfterSelection = Number(
      (await control.evaluate('window.voidrCapture.capture.status()'))?.evidence?.notes ?? 0,
    );
    if (notesAfterSelection !== notesBeforeScreen + 2) {
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
    await waitFor(
      'Persistência da nota em elemento',
      async () => {
        const value = await control.evaluate('window.voidrCapture.capture.status()');
        return value?.evidence?.notes === notesBeforeScreen + 3 ? value : undefined;
      },
      30_000,
    );
    await control.evaluate(`(()=>{
      const button=document.querySelector('button[title="Ver requisições"]');
      if(!button) throw new Error('Detalhes de requisições não encontrados.');
      button.click();
      return true;
    })()`);
    const evidenceBounds = await control.evaluate(`window.voidrCapture.capture.setControlPanel('evidence')`);
    const evidenceTargetHeight = await waitFor('Área nativa reservada para evidências', async () => {
      const rendererReady = await control.evaluate(
        `document.querySelector('.capture-shell')?.classList.contains('capture-shell-evidence')`,
      );
      const detailVisible = await control.evaluate(`Boolean(document.querySelector('.dock-evidence-list article'))`);
      const panelTop = await control.evaluate(`document.querySelector('.dock-evidence')?.getBoundingClientRect().top`);
      const targetBottom = Number(evidenceBounds?.y ?? 0) + Number(evidenceBounds?.height ?? 0);
      if (
        !rendererReady ||
        !detailVisible ||
        evidenceBounds?.height > defaultTargetHeight - 140 ||
        panelTop < targetBottom
      ) {
        throw new Error(
          JSON.stringify({
            rendererReady,
            detailVisible,
            panelTop,
            defaultTargetHeight,
            evidenceBounds,
          }),
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
    const restoredAfterEvidence = await control.evaluate(`window.voidrCapture.capture.setControlPanel('default')`);
    if (restoredAfterEvidence?.height !== defaultTargetHeight) {
      throw new Error('O target não restaurou os bounds depois das evidências.');
    }

    await control.evaluate(`(()=>{
      const noteButton=[...document.querySelectorAll('.dock-actions button')]
        .find((item)=>item.textContent?.trim()==='Nota');
      noteButton?.click();
      return true;
    })()`);
    await waitFor('Seletor para testar proteção do rascunho', async () => {
      const chooser = await control.evaluate(`Boolean(document.querySelector('.annotation-capture-row'))`);
      return chooser || undefined;
    });
    await control.evaluate(`(()=>{
      const screen=[...document.querySelectorAll('.annotation-action')]
        .find((item)=>item.textContent?.includes('Tela'));
      screen?.click();
      return true;
    })()`);
    await waitFor('Composer para testar proteção do rascunho', async () => {
      const composer = await control.evaluate(`Boolean(document.querySelector('.dock-note-composer textarea'))`);
      return composer || undefined;
    });
    await control.evaluate(`(()=>{
      const textarea=document.querySelector('.dock-note-composer textarea');
      const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')?.set;
      setter.call(textarea,'Rascunho que não pode sumir ao finalizar.');
      textarea.dispatchEvent(new Event('input',{bubbles:true}));
      const finish=[...document.querySelectorAll('.dock-actions button')]
        .find((item)=>item.textContent?.trim()==='Finalizar');
      finish?.click();
      return true;
    })()`);
    await waitFor('Finalização bloqueada pelo rascunho', async () => {
      const state = await control.evaluate(`(()=>({
        statusText:document.querySelector('.annotation-notice')?.textContent||'',
        draft:document.querySelector('.dock-note-composer textarea')?.value||'',
      }))()`);
      return state?.statusText.includes('nota não salva') && state.draft === 'Rascunho que não pode sumir ao finalizar.'
        ? state
        : undefined;
    });
    const statusAfterBlockedFinalization = await control.evaluate('window.voidrCapture.capture.status()');
    if (statusAfterBlockedFinalization?.stage !== 'recording') {
      throw new Error('O teste finalizou mesmo com um rascunho não salvo.');
    }
    await control.evaluate(`document.querySelector('button[aria-label="Descartar anotação"]')?.click()`);
    await waitFor('Rascunho descartado explicitamente', async () => {
      const open = await control.evaluate(`Boolean(document.querySelector('.dock-note'))`);
      return open ? undefined : true;
    });
    const notesAfterDiscard = Number(
      (await control.evaluate('window.voidrCapture.capture.status()'))?.evidence?.notes ?? 0,
    );
    if (notesAfterDiscard !== notesBeforeScreen + 3) {
      throw new Error('Descartar o rascunho alterou o contador de notas.');
    }

    const voiceNotesBefore = Number(
      (await control.evaluate('window.voidrCapture.capture.status()'))?.evidence?.voiceNotes ?? 0,
    );
    const voicePcmBase64 = voicePcmPath
      ? (await readFile(voicePcmPath)).toString('base64')
      : deterministicVoicePcmBase64();
    await control.evaluate(`window.voidrCapture.capture.injectVoiceDraftForTest({
      pcmBase64: ${JSON.stringify(voicePcmBase64)}
    })`);
    const voiceBounds = await control.evaluate(`window.voidrCapture.capture.setControlPanel('voice')`);
    await waitFor('Revisão local da nota de voz', async () => {
      const state = await control.evaluate(`(()=>({
        voiceShell:document.querySelector('.capture-shell')?.classList.contains('capture-shell-voice'),
        title:document.querySelector('.dock-voice')?.textContent||'',
        preview:document.querySelector('.dock-voice audio')?.src||'',
        panelTop:document.querySelector('.dock-voice')?.getBoundingClientRect().top,
      }))()`);
      const targetBottom = Number(voiceBounds?.y ?? 0) + Number(voiceBounds?.height ?? 0);
      return state?.voiceShell &&
        state.title.includes('Ouça antes de adicionar') &&
        state.preview.startsWith('blob:') &&
        state.panelTop >= targetBottom
        ? state
        : undefined;
    });
    if (voiceScreenshotPath) {
      await delay(250);
      const screenshot = await control.call('Page.captureScreenshot', {
        format: 'png',
      });
      await writeFile(voiceScreenshotPath, Buffer.from(screenshot.data, 'base64'));
    }
    const voiceNotesAfterReview = Number(
      (await control.evaluate('window.voidrCapture.capture.status()'))?.evidence?.voiceNotes ?? 0,
    );
    if (voiceNotesAfterReview !== voiceNotesBefore) {
      throw new Error('Revisar voz criou evidência antes da confirmação.');
    }
    const voicePreviewBeforeSelection = await control.evaluate(`document.querySelector('.dock-voice audio')?.src||''`);
    await control.evaluate(`(()=>{
      const select=[...document.querySelectorAll('.dock-voice button')]
        .find((item)=>item.textContent?.trim()==='Selecionar área');
      if(!select) throw new Error('Ação para selecionar a área da voz não encontrada.');
      select.click();
      return true;
    })()`);
    await waitFor('Modo de região da nota de voz', async () => {
      const hidden = await control.evaluate(`!document.querySelector('.dock-voice')`);
      return hidden || undefined;
    });
    await dispatchTargetEscape(control);
    await waitFor('Escape devolveu a revisão da voz', async () => {
      const state = await control.evaluate(`(()=>({
        title:document.querySelector('.dock-voice')?.textContent||'',
        preview:document.querySelector('.dock-voice audio')?.src||'',
      }))()`);
      return state?.title.includes('Área da tela (opcional)') && state.preview === voicePreviewBeforeSelection
        ? state
        : undefined;
    });
    await control.evaluate(`(()=>{
      const select=[...document.querySelectorAll('.dock-voice button')]
        .find((item)=>item.textContent?.trim()==='Selecionar área');
      if(!select) throw new Error('Ação para selecionar novamente a área não encontrada.');
      select.click();
      return true;
    })()`);
    await waitFor('Segundo modo de região da nota de voz', async () => {
      const hidden = await control.evaluate(`!document.querySelector('.dock-voice')`);
      return hidden || undefined;
    });
    await control.evaluate(`window.voidrCapture.capture.selectRegionForTest({
      x: 64, y: 72, width: 320, height: 180
    })`);
    await waitFor('Recorte vinculado à nota de voz', async () => {
      const state = await control.evaluate(`(()=>({
        title:document.querySelector('.dock-voice')?.textContent||'',
        preview:document.querySelector('.dock-voice audio')?.src||'',
        remove:Boolean(document.querySelector('.voice-visual-remove')),
      }))()`);
      return state?.title.includes('Área selecionada') && state.preview === voicePreviewBeforeSelection && state.remove
        ? state
        : undefined;
    });
    await control.evaluate(`(()=>{
      const finish=[...document.querySelectorAll('.dock-actions button')]
        .find((item)=>item.textContent?.trim()==='Finalizar');
      finish?.click();
      return true;
    })()`);
    await waitFor('Finalização bloqueada pela voz pendente', async () => {
      const state = await control.evaluate(`(()=>({
        stageText:document.querySelector('.dock-voice')?.textContent||'',
        preview:document.querySelector('.dock-voice audio')?.src||'',
      }))()`);
      return state?.stageText.includes('Envie ou descarte a gravação') && state.preview.startsWith('blob:')
        ? state
        : undefined;
    });
    const statusAfterVoiceBlockedFinalization = await control.evaluate('window.voidrCapture.capture.status()');
    if (statusAfterVoiceBlockedFinalization?.stage !== 'recording') {
      throw new Error('O teste finalizou mesmo com voz pendente.');
    }
    await control.evaluate(`(()=>{
      const send=[...document.querySelectorAll('.dock-voice button')]
        .find((item)=>item.textContent?.trim()==='Adicionar ao teste');
      if(!send) throw new Error('Ação para adicionar voz não encontrada.');
      send.click();
      return true;
    })()`);
    const firstVoiceOutcome = await waitFor(
      'Resposta do envio de voz',
      async () => {
        const state = await control.evaluate(`(()=>({
        title:document.querySelector('.dock-voice')?.textContent||'',
        preview:document.querySelector('.dock-voice audio')?.src||'',
      }))()`);
        if (state?.title.includes('Nota de voz adicionada')) return { ...state, success: true };
        if (state?.title.includes('Não foi possível adicionar')) return { ...state, success: false };
        return undefined;
      },
      45_000,
    );
    if (!firstVoiceOutcome.success) {
      if (!firstVoiceOutcome.preview.startsWith('blob:')) {
        throw new Error('A falha de voz apagou o preview local.');
      }
      await control.evaluate(`(()=>{
        const retry=[...document.querySelectorAll('.dock-voice button')]
          .find((item)=>item.textContent?.trim()==='Tentar novamente');
        if(!retry) throw new Error('Retry da voz não está disponível.');
        retry.click();
        return true;
      })()`);
      await waitFor(
        'Retry de voz concluiu sem perder o preview',
        async () => {
          const state = await control.evaluate(`(()=>({
          title:document.querySelector('.dock-voice')?.textContent||'',
          preview:document.querySelector('.dock-voice audio')?.src||'',
        }))()`);
          return (state?.title.includes('Não foi possível adicionar') ||
            state?.title.includes('Nota de voz adicionada')) &&
            (state.title.includes('Nota de voz adicionada') || state.preview.startsWith('blob:'))
            ? state
            : undefined;
        },
        45_000,
      );
    }
    const voiceSucceeded = await control.evaluate(
      `document.querySelector('.dock-voice')?.textContent?.includes('Nota de voz adicionada')`,
    );
    if (requireVoiceSuccess && !voiceSucceeded) {
      throw new Error('A nota de voz com fala válida não chegou à persistência durável.');
    }
    const voiceNotesAfterSend = Number(
      (await control.evaluate('window.voidrCapture.capture.status()'))?.evidence?.voiceNotes ?? 0,
    );
    if (voiceNotesAfterSend !== voiceNotesBefore + (voiceSucceeded ? 1 : 0)) {
      throw new Error('O contador de voz não corresponde ao resultado durável.');
    }
    await control.evaluate(`(()=>{
      const close=Boolean(document.querySelector('.dock-voice')?.textContent?.includes('Nota de voz adicionada'))
        ? [...document.querySelectorAll('.dock-voice button')].find((item)=>item.textContent?.trim()==='Fechar')
        : document.querySelector('.dock-voice button[aria-label="Descartar gravação"]');
      if(!close) throw new Error('Ação para fechar a nota de voz não encontrada.');
      close.click();
      return true;
    })()`);
    await waitFor('Voz concluída ou descartada explicitamente', async () => {
      const open = await control.evaluate(`Boolean(document.querySelector('.dock-voice'))`);
      return open ? undefined : true;
    });
    const restoredAfterVoice = await control.evaluate(`window.voidrCapture.capture.setControlPanel('default')`);
    if (restoredAfterVoice?.height !== defaultTargetHeight) {
      throw new Error('O target não restaurou os bounds depois da voz.');
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
    const persistedPassiveFeedback = passiveSmoke
      ? await waitFor('Falhas passivas canônicas no ClickHouse', async () => {
          const counts = await storedPassiveCounts(finalStatus.sessionId, passiveSmoke.endpoint, passiveSecretProbe);
          if (
            counts.httpFailures !== 1 ||
            counts.consoleErrors !== 1 ||
            counts.leakedQueryUrls !== 0 ||
            counts.leakedSecrets !== 0
          ) {
            throw new Error(JSON.stringify(counts));
          }
          return counts;
        })
      : undefined;
    const persistedAnnotations = await waitFor('Anotações e crop da região no teste', async () => {
      const cycle = await requestJson(
        `${serviceUrl}/loop-test-dev/scenarios/${encodeURIComponent(finalStatus.context.scenarioId)}` +
          `/cycles/${encodeURIComponent(finalStatus.context.cycleId)}`,
        { headers },
      );
      const annotations = Array.isArray(cycle.annotations) ? cycle.annotations : [];
      const currentAnnotations = annotations.filter((item) => {
        const createdAt = Date.parse(String(item?.createdAt ?? ''));
        return Number.isFinite(createdAt) && createdAt >= smokeStartedAt - 1_000;
      });
      const regionAnnotation = currentAnnotations.find((item) => item?.kind === 'region');
      const elementAnnotation = currentAnnotations.find((item) => item?.kind === 'element');
      const screenAnnotation = currentAnnotations.find((item) => item?.kind === 'screen');
      if (
        currentAnnotations.length !== 3 ||
        !regionAnnotation?.screenshotRef ||
        !regionAnnotation?.cropRef ||
        !elementAnnotation?.screenshotRef ||
        !elementAnnotation?.cropRef ||
        !screenAnnotation?.screenshotRef
      )
        return undefined;
      return currentAnnotations.map((item) => ({
        kind: item.kind,
        screenshot: Boolean(item.screenshotRef),
        crop: Boolean(item.cropRef),
      }));
    });
    const persistedVoiceVisual = voiceSucceeded
      ? await waitFor('Recorte da voz no contexto e no download de evidências', async () => {
          const context = await requestJson(
            `${serviceUrl}/verification-dev/verifications/` +
              `${encodeURIComponent(finalStatus.context.verificationId)}/context`,
            { headers },
          );
          const transcript = Array.isArray(context.transcript) ? context.transcript : [];
          const segment = [...transcript].reverse().find((item) => item?.visual?.kind === 'region');
          if (!segment?.visual?.screenshotRef || !segment?.visual?.cropRef) return undefined;
          const [screenshot, crop] = await Promise.all([
            requestEvidenceAsset(finalStatus.context.verificationId, segment.visual.screenshotRef),
            requestEvidenceAsset(finalStatus.context.verificationId, segment.visual.cropRef),
          ]);
          return {
            kind: segment.visual.kind,
            rect: segment.visual.rect,
            screenshotBytes: screenshot.bytes,
            cropBytes: crop.bytes,
          };
        })
      : undefined;
    const passiveReviewFlow = passiveSmoke ? await exercisePassiveReviewFlow(finalStatus) : undefined;
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
          persistedPassiveFeedback,
          passiveReviewFlow,
          persistedAnnotations,
          persistedVoiceVisual,
          voiceOutcome: voiceSucceeded ? 'persisted' : 'retryable_failure_preserved',
          finalizationFeedback,
          nativeTargetLayout: {
            defaultHeight: defaultTargetHeight,
            noteHeight: noteTargetHeight,
            composerHeight: composerTargetHeight,
            evidenceHeight: evidenceTargetHeight,
            voiceHeight: voiceBounds?.height,
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
    await Promise.race([new Promise((resolvePromise) => child.once('exit', resolvePromise)), delay(2_000)]);
    if (child.exitCode === null) child.kill('SIGKILL');
    await rm(smokeUserDataDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`Voidr Capture smoke falhou: ${error.message}\n`);
  process.exitCode = 1;
});
