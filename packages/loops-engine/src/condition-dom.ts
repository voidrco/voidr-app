import { isBusyText } from './browser.js';
import { createHash } from 'node:crypto';
import type { Frame, Locator, Page } from 'playwright-core';
import type { SemanticTarget, VerificationCondition } from '@voidr/capture-contracts';

export type ConditionCandidate = {
  id: string; frameUrl: string; tag: string; role: string; name: string; text: string;
  value?: string; valueMatchesExpected?: boolean; visible: boolean; enabled: boolean; context: string; form: string;
  selectorMatch: boolean; truncated: boolean;
};
export type ConditionSnapshot = {
  url: string; candidates: ConditionCandidate[]; complete: boolean; fingerprint: string;
  scopeText: string; reasons: string[];
};
export type ConditionScope = { roots: Locator[]; frames: Frame[]; complete: boolean; reasons: string[]; pageFrames: Frame[] };

export function fingerprint(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function targetLocator(root: Locator, target: SemanticTarget) {
  if (target.role) return root.getByRole(target.role, { includeHidden: true });
  return root.locator('*');
}

function readCandidate(node: Element, options: { selector?: string; expected?: string }) {
  const input = node as HTMLInputElement;
  const text = ((node as HTMLElement).innerText ?? node.textContent ?? '').replace(/\s+/g, ' ').trim();
  const labelledBy = (node.getAttribute('aria-labelledby') ?? '').split(/\s+/).map(id => node.ownerDocument.getElementById(id)?.textContent ?? '').join(' ').trim();
  const labels = Array.from(input.labels ?? []).map(label => label.innerText).join(' ');
  const context = node.closest('section, article, form, [role=dialog], [role=region]');
  const form = input.form ?? node.closest('form');
  const value = ['INPUT', 'SELECT', 'TEXTAREA'].includes(node.tagName) && !['password', 'file', 'hidden'].includes(input.type) ? input.value : undefined;
  const match = (() => { try { return Boolean(options.selector && node.matches(options.selector)); } catch { return false; } })();
  return { tag: node.tagName, role: node.getAttribute('role') ?? '',
    name: node.getAttribute('aria-label') || labelledBy || labels || node.getAttribute('placeholder') || text.slice(0, 200),
    text: text.slice(0, 4000), value, valueMatchesExpected: options.expected !== undefined && ['INPUT', 'SELECT', 'TEXTAREA'].includes(node.tagName) ? input.value === options.expected : undefined, context: (context?.textContent ?? '').slice(0, 4000),
    form: (form?.getAttribute('aria-label') || form?.id || form?.textContent || '').slice(0, 2000),
    selectorMatch: match, truncated: text.length > 4000,
    excluded: Boolean(node.closest('[data-voidr-overlay]')) || ['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT'].includes(node.tagName) };
}

async function frameVisible(frame: Frame): Promise<boolean> {
  if (!frame.parentFrame()) return true;
  const handle = await frame.frameElement();
  try { return await handle.isVisible() && await frameVisible(frame.parentFrame()!); }
  finally { await handle.dispose(); }
}

async function rootCandidates(deps: { root: Locator; target: SemanticTarget; limit: number; prefix: string; expected?: string; fieldsOnly?: boolean }) {
  const { root, target, limit, prefix, expected } = deps;
  const locator = deps.fieldsOnly ? root.locator('input, select, textarea, [contenteditable=true]') : targetLocator(root, target);
  const count = await locator.count();
  const frame = await root.elementHandle().then(async handle => {
    if (!handle) throw new Error('Escopo desapareceu.');
    try { return await handle.ownerFrame(); } finally { await handle.dispose(); }
  });
  if (!frame) throw new Error('Frame do escopo indisponível.');
  const visible = await frameVisible(frame);
  const candidates = await Promise.all(Array.from({ length: Math.min(count, limit) }, async (_, index) => {
    const item = locator.nth(index);
    const [data, isVisible, enabled] = await Promise.all([item.evaluate(readCandidate, { selector: target.selector, expected }), item.isVisible(), item.isEnabled()]);
    return { ...data, id: `${prefix}_${index}`, frameUrl: frame.url(), visible: visible && isVisible, enabled };
  }));
  const included = candidates.filter(item => !item.excluded);
  return { candidates: included, complete: count <= limit && included.every(item => !item.truncated) };
}

export async function pageScope(page: Page, frameUrl?: string): Promise<ConditionScope> {
  const frames = page.frames().filter(frame => !frameUrl || frame.url() === frameUrl);
  const states = await Promise.all(frames.map(async frame => {
    try {
      const ready = await frame.evaluate(() => document.readyState === 'complete' && Boolean(document.body));
      return { root: frame.locator('body'), ready };
    } catch { return { root: frame.locator('body'), ready: false }; }
  }));
  const complete = frames.length > 0 && states.every(state => state.ready);
  return { frames, pageFrames: page.frames(), roots: states.filter(state => state.ready).map(state => state.root), complete,
    reasons: complete ? [] : ['Um frame do escopo não pôde ser lido integralmente.'] };
}

export async function inspectConditionScope(deps: { page: Page; scope: ConditionScope; target: SemanticTarget; limit: number; expected?: string; fieldsOnly?: boolean }): Promise<ConditionSnapshot> {
  const results = await Promise.all(deps.scope.roots.map(async (root, index) => {
    try {
      const [result, text, partial] = await Promise.all([
        rootCandidates({ ...deps, root, prefix: `r${index}` }), root.innerText(),
        root.evaluate(node => {
          const elements = [node, ...node.querySelectorAll('*')];
          return elements.some(element => element.getAttribute('aria-busy') === 'true'
            || element.getAttribute('aria-rowcount') === '-1' || element.getAttribute('aria-setsize') === '-1'
            || Number(element.getAttribute('aria-rowcount') ?? 0) > element.querySelectorAll('[role=row],tr').length
            || Number(element.getAttribute('aria-setsize') ?? 0) > (element.parentElement?.children.length ?? 0));
        }),
      ]);
      return { ...result, text: text.slice(0, 24000), complete: result.complete && text.length <= 24000 && !partial && !isBusyText(text) };
    } catch { return { candidates: [], text: '', complete: false }; }
  }));
  const allCandidates = results.flatMap(result => result.candidates);
  const candidates = allCandidates.slice(0, deps.limit);
  const complete = deps.scope.complete && allCandidates.length <= deps.limit && results.every(result => result.complete)
    && deps.scope.frames.every(frame => !frame.isDetached()) && deps.page.frames().length === deps.scope.pageFrames.length && deps.scope.pageFrames.every(frame => deps.page.frames().includes(frame));
  const data = { url: deps.page.url(), candidates, complete, scopeText: results.map(result => result.text).join('\n') };
  return { ...data, fingerprint: fingerprint(data), reasons: [...deps.scope.reasons,
    ...(complete ? [] : ['Busca parcial, página em carregamento ou limite de captura atingido.'])] };
}

export function requiresCompleteScope(condition: VerificationCondition) {
  return condition.evidence.completeness === 'scope' || ['not_visible', 'absent', 'count_equals'].includes(condition.operator);
}

export async function pageFingerprint(page: Page) {
  const frames = page.frames();
  const documents = await Promise.all(frames.map(async frame => ({ url: frame.url(), state: await frame.evaluate(() => {
    const root = document.documentElement.cloneNode(true) as Element;
    root.querySelectorAll('[data-voidr-overlay]').forEach(node => node.remove());
    const inputs = Array.from(document.querySelectorAll('input, select, textarea')).map(node => {
      const input = node as HTMLInputElement;
      return [input.value, input.checked, input.disabled];
    });
    const shadows = Array.from(document.querySelectorAll('*')).flatMap(node => node.shadowRoot ? [node.shadowRoot.innerHTML] : []);
    return { dom: root.outerHTML, inputs, shadows };
  }) })));
  return fingerprint({ url: page.url(), documents, complete: frames.length === page.frames().length && frames.every(frame => !frame.isDetached()) });
}

export function urlSnapshot(page: Page, frameUrl?: string): ConditionSnapshot {
  const frames = frameUrl ? page.frames().filter(frame => frame.url() === frameUrl) : [page.mainFrame()];
  const complete = frames.length === 1 && !frames[0]!.isDetached();
  const data = { url: frames[0]?.url() ?? page.url(), candidates: [], complete, scopeText: '' };
  return { ...data, fingerprint: fingerprint(data), reasons: complete ? [] : ['Frame da URL não identificado de forma única.'] };
}
