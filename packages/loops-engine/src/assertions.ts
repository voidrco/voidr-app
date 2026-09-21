import assert from "node:assert/strict";
import type { Page } from "playwright-core";
import type { Interaction } from "./actions.js";
import { EVIDENCE_SELECTOR, readEvidence, type AssertionEvidence, type EvidenceSnapshot } from "./assertion-evidence.js";
import { prepareTarget } from "./target.js";
import { paintInteraction } from "./visuals.js";
import { unmeasured, type Measure } from "./timing.js";
import { assertionTerms } from "./values.js";

export type AssertionResult = {
  stepIndex: number; instruction: string; status: "passed" | "failed" | "unverified";
  method: "semantic+dom"; probability: number; expected?: EvidenceSnapshot; actual?: EvidenceSnapshot;
  reason: string; screenshot?: string; interaction?: Interaction; durationMs: number;
  predicate: string; terms: string[];
  url: string;
};
type AssertionOptions = {
  page: Page; stepIndex: number; instruction: string; evidence?: AssertionEvidence;
  probability: number; confidence: number; signal?: AbortSignal; measure?: Measure;
  evidenceSupport?: number;
  predicate?: string;
  onInteraction?: (interaction: Interaction, screenshot?: string) => Promise<void>;
};

function verifyTerms(result: AssertionResult) {
  if (result.predicate === 'semantic') return;
  const text = [result.actual?.text, ...(result.actual?.values.map(value => value.value) ?? [])].join(' ').replace(/\s+/g, ' ');
  const contains = (term: string) => /^\d+(?:\.\d+)?$/.test(term)
    ? new RegExp(`(?<![\\d.,])${term.replaceAll('.', '\\.')}(?![\\d.,])`).test(text)
    : text.includes(term.replace(/\s+/g, ' '));
  const invalid = result.terms.filter(term => result.predicate === 'absent' ? contains(term) : !contains(term));
  assert.equal(invalid.length, 0, `Valores esperados ${result.predicate === 'absent' ? 'ausentes' : 'presentes'} na evidência: ${invalid.join(', ')}`);
}

async function inspect(deps: AssertionOptions, result: AssertionResult) {
  const { page, evidence } = deps;
  assert.ok(evidence, 'Não foi encontrada uma região da página para verificar a condição.');
  const supported = deps.evidenceSupport === undefined ? deps.confidence >= 0.5 : deps.evidenceSupport >= 0.6;
  assert.ok(supported, 'A região selecionada não oferece evidência suficiente para verificar toda a condição.');
  const frame = page.frames()[evidence.frame];
  const target = await frame?.locator(EVIDENCE_SELECTOR).nth(evidence.index).elementHandle();
  assert.ok(target, 'A evidência não existe mais na página.');
  try {
    const prepared = await prepareTarget({ target, page, signal: deps.signal,
      onScrollFrame: deps.onInteraction ? screenshot => { void deps.onInteraction!({ kind: 'scroll', phase: 'scrolling', label: 'Localizando evidência', viewport: page.viewportSize()! }, screenshot).catch(() => undefined); } : undefined });
    const interaction: Interaction = { kind: 'assert', phase: 'checking', label: deps.instruction, target: prepared.box, point: prepared.point, viewport: prepared.viewport };
    result.interaction = interaction;
    await paintInteraction(page, interaction);
    await deps.onInteraction?.(interaction);
    deps.signal?.throwIfAborted();
    assert.ok(await target.isVisible(), 'A evidência não está visível.');
    const observed = (await target.evaluate(readEvidence))[0];
    result.actual = observed ? { text: observed.text, values: observed.values } : undefined;
    assert.deepEqual(result.actual, result.expected, 'A evidência mudou antes da verificação.');
    if (deps.probability > 0.4 && deps.probability < 0.6) throw new Error('A avaliação da condição permanece incerta.');
    result.status = 'failed';
    verifyTerms(result);
    assert.ok(deps.probability >= 0.6, 'A evidência observada não satisfaz a condição solicitada.');
    result.status = 'passed';
    result.reason = 'Condição avaliada pelo Jev; visibilidade, texto e valores reconferidos no DOM pelo Playwright.';
  } finally { await target.dispose(); }
}

export async function verifyAssertion(deps: AssertionOptions): Promise<AssertionResult> {
  const started = performance.now();
  const result: AssertionResult = { stepIndex: deps.stepIndex, instruction: deps.instruction,
    status: 'unverified', method: 'semantic+dom', probability: deps.probability,
    expected: deps.evidence ? { text: deps.evidence.text, values: deps.evidence.values } : undefined,
    reason: '', durationMs: 0, predicate: deps.predicate ?? 'semantic', terms: assertionTerms(deps.instruction), url: deps.page.url() };
  const tracing = deps.page.context().tracing;
  await tracing.group(`ASSERT: ${deps.instruction}`);
  try {
    await (deps.measure ?? unmeasured)('playwright', 'Assert: conferir evidência no DOM', () => inspect(deps, result));
  } catch (error) {
    deps.signal?.throwIfAborted();
    result.reason = error instanceof Error ? error.message.slice(0, 1000) : 'Não foi possível verificar a condição.';
  } finally { await tracing.groupEnd().catch(() => undefined); }
  result.interaction = { ...result.interaction, kind: 'assert', phase: result.status === "unverified" ? "checking" : result.status, label: deps.instruction,
    viewport: deps.page.viewportSize() ?? { width: 1280, height: 900 } };
  await tracing.group(`${result.status === 'passed' ? 'PASS' : 'FAIL'}: ${deps.instruction}`);
  try {
    await paintInteraction(deps.page, result.interaction);
    result.screenshot = `data:image/jpeg;base64,${(await deps.page.screenshot({ type: 'jpeg', quality: 80 })).toString('base64')}`;
    await deps.onInteraction?.(result.interaction, result.screenshot);
  } finally { await tracing.groupEnd().catch(() => undefined); }
  result.durationMs = Math.round(performance.now() - started);
  return result;
}
