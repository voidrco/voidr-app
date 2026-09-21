import type { BrowserContext, CDPSession, Page } from 'playwright-core';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { inspectCollectorStopAttempt } from './collector-stop';
import { redactText } from '@voidr/capture-contracts';
import { allowCollectorInContentSecurityPolicy } from './collector-csp';
import { secretRedactor } from '@voidr/loops-engine';

export type AiCollectorInput = { scriptUrl: string; collectorUrl: string; targetUrl?: string; options: Record<string, unknown> };
const WORLD = 'voidr-ai-collector';
const safeUrl = (input: string) => { try { const url = new URL(input); return `${url.origin}${url.pathname}`; } catch { return ''; } };

export class AiCollectorWorker {
  private pages = new Map<Page, Promise<{ cdp: CDPSession; contextId?: number }>>();
  private pending = new Set<Promise<unknown>>();
  private script = '';
  private context?: BrowserContext;
  constructor(private readonly input: AiCollectorInput, private readonly secrets: Record<string, string> = {}) {}

  async setup(context: BrowserContext) {
    this.context = context;
    if (this.input.targetUrl && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(this.input.collectorUrl).hostname))
      await context.grantPermissions(['local-network-access'], { origin: new URL(this.input.targetUrl).origin });
    const response = await fetch(this.input.scriptUrl, { redirect: 'error', signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error('Collector indisponível.');
    this.script = await response.text();
    if (Buffer.byteLength(this.script) > 5 * 1024 * 1024) throw new Error('Collector inválido.');
    context.on('page', page => { void this.attach(page).catch(() => undefined); });
    await Promise.all(context.pages().map(page => this.attach(page)));
  }

  private attach(page: Page) {
    const previous = this.pages.get(page);
    if (previous) return previous;
    const task = this.configure(page);
    this.pages.set(page, task);
    return task;
  }

  private async configure(page: Page) {
    const cdp = await page.context().newCDPSession(page);
    const state: { cdp: CDPSession; contextId?: number } = { cdp };
    const { frameTree } = await cdp.send('Page.getFrameTree');
    cdp.on('Runtime.executionContextCreated', ({ context }) => {
      if (context.name === WORLD && context.auxData?.frameId === frameTree.frame.id) state.contextId = context.id;
    });
    cdp.on('Runtime.executionContextsCleared', () => { state.contextId = undefined; });
    await Promise.all([cdp.send('Runtime.enable'), cdp.send('Page.enable'), cdp.send('Network.enable')]);
    cdp.on('Fetch.requestPaused', event => {
      const task = (async () => {
        const headers = event.responseHeaders ?? [];
        const rewritten = headers.map(header => {
          const value = allowCollectorInContentSecurityPolicy({ [header.name]: [header.value] }, this.input.collectorUrl);
          return { name: header.name, value: value?.[header.name]?.[0] ?? header.value };
        });
        await cdp.send('Fetch.continueResponse', { requestId: event.requestId, responseCode: event.responseStatusCode ?? 200, responseHeaders: rewritten });
      })().catch(() => cdp.send('Fetch.continueRequest', { requestId: event.requestId }).catch(() => undefined));
      this.pending.add(task);
      void task.finally(() => this.pending.delete(task));
    });
    await cdp.send('Fetch.enable', { patterns: [{ resourceType: 'Document', requestStage: 'Response' }] });
    const source = `if(window === window.top) { ${this.script}\n;globalThis.__voidrAiReady = new Promise(resolve => { const start = () => Promise.resolve(globalThis.VoidrCollector.init(${JSON.stringify(this.input.options)})).then(() => resolve(globalThis.VoidrCollector.isCaptureReady()), () => resolve(false)); if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, {once:true}); else start(); }); }`;
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source, worldName: WORLD });
    const world = await cdp.send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: WORLD });
    state.contextId = world.executionContextId;
    if (/^https?:/.test(page.url())) await cdp.send('Runtime.evaluate', { expression: source, contextId: state.contextId });
    page.on('response', response => {
      if (response.url().startsWith(this.input.collectorUrl)) return;
      this.enqueue(page, 'captureNetwork', { type: response.request().resourceType() === 'fetch' ? 'fetch' : 'resource',
        url: safeUrl(response.url()), method: response.request().method(), status: response.status(), timestamp: Date.now() });
    });
    page.on('requestfailed', request => {
      if (!request.url().startsWith(this.input.collectorUrl)) this.enqueue(page, 'captureNetwork', {
        type: 'fetchError', url: safeUrl(request.url()), method: request.method(), status: 0, timestamp: Date.now() });
    });
    page.on('pageerror', error => this.enqueue(page, 'captureException', redactText(error.message).slice(0, 1000)));
    page.on('console', message => {
      if (message.type() === 'error' && !message.text().startsWith('VoidrCollector')) this.enqueue(page, 'captureException', redactText(message.text()).slice(0, 1000));
    });
    return state;
  }

  private async evaluate(page: Page, expression: string) {
    const state = await this.attach(page);
    if (!state.contextId) throw new Error('Collector aguardando navegação.');
    const result = await state.cdp.send('Runtime.evaluate', { expression, contextId: state.contextId, awaitPromise: true, returnByValue: true, timeout: 8000 });
    if (result.exceptionDetails) throw new Error('Collector não confirmou a operação.');
    return result.result.value;
  }

  private enqueue(page: Page, method: string, value: unknown) {
    const task = this.ready(page).then(() => this.evaluate(page, `globalThis.VoidrCollector.${method}(${JSON.stringify(secretRedactor(this.secrets).redact(value))})`)).catch(() => undefined);
    this.pending.add(task);
    void task.finally(() => this.pending.delete(task));
  }

  async ready(page: Page) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (await this.evaluate(page, 'globalThis.__voidrAiReady').catch(() => false)) return;
      await delay(100);
    }
    throw new Error('O Collector não iniciou a gravação desta página.');
  }

  async finish(output: string) {
    const pages = this.context?.pages().filter(page => /^https?:/.test(page.url())) ?? [];
    await Promise.all([...this.pending]);
    await Promise.all(pages.map(async page => {
      await this.ready(page);
      await this.evaluate(page, 'globalThis.VoidrCollector.flush()');
    }));
    const page = pages.at(-1);
    if (!page) throw new Error('Nenhuma página disponível para finalizar a captura.');
    await Promise.all(pages.filter(item => item !== page).map(item => this.evaluate(item, 'globalThis.VoidrCollector.pause()')));
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = inspectCollectorStopAttempt(await this.evaluate(page, 'globalThis.VoidrCollector.stopAndFinalize()'));
      if (result.receipt) {
        await writeFile(join(output, 'collector-receipt.json'), JSON.stringify(result.receipt), { mode: 0o600 });
        return;
      }
      if (!result.retryable) break;
      await delay(500);
    }
    throw new Error('Collector não confirmou o fechamento durável.');
  }
}
