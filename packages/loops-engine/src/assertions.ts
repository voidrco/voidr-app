import { pageFingerprint } from './condition-dom.js';
import { resolveSecret } from './runtime-secrets.js';
import type { Page } from 'playwright-core';
import type { ConditionResult, VerificationPlan } from '@voidr/capture-contracts';
import type { Interaction } from './actions.js';
import type { AssertionEvidence, EvidenceSnapshot } from './assertion-evidence.js';
import { createTypeSafeClient } from './client.js';
import { composeVerification, legacyVerification, verifyCondition } from './conditions.js';
import type { ObservedAction } from './evidence-verification.js';
import { paintInteraction } from './visuals.js';
import { unmeasured, type Measure } from './timing.js';

export type AssertionResult = {
  stepIndex: number; instruction: string; status: 'passed' | 'failed' | 'unverified';
  method: 'semantic+dom'; probability: number; expected?: EvidenceSnapshot; actual?: EvidenceSnapshot;
  reason: string; screenshot?: string; interaction?: Interaction; durationMs: number;
  predicate: string; terms: string[]; url: string;
  verification?: VerificationPlan; conditions?: ConditionResult[];
};
type AssertionOptions = {
  page: Page; stepIndex: number; instruction: string; evidence?: AssertionEvidence;
  probability: number; confidence: number; signal?: AbortSignal; measure?: Measure;
  evidenceSupport?: number; predicate?: string;
  secrets?: Record<string, string>; verification?: VerificationPlan; observedActions?: ObservedAction[];
  attempt?: number; cache?: Map<string, ConditionResult>;
  redact?: <T>(value: T) => T;
  onUsage?: (tokens: { input_tokens: number; output_tokens: number }) => void;
  client?: ReturnType<typeof createTypeSafeClient>;
  onInteraction?: (interaction: Interaction, screenshot?: string) => Promise<void>;
};

async function inspect(deps: AssertionOptions, result: AssertionResult) {
  const client = deps.client ?? createTypeSafeClient();
  const revision = await pageFingerprint(deps.page).catch(() => undefined);
  const verification = deps.verification ?? legacyVerification(deps.instruction);
  result.verification = verification;
  const context = { page: deps.page, client, measure: deps.measure ?? unmeasured, signal: deps.signal, observedActions: deps.observedActions ?? [],
    redact: deps.redact ?? (<T>(value: T) => value), record: () => undefined,
    usage: deps.onUsage ?? (() => undefined), limit: deps.attempt ? 240 : 120, cache: deps.cache };
  const conditions: ConditionResult[] = [];
  result.conditions = conditions;
  for (const condition of verification.conditions) {
    deps.signal?.throwIfAborted();
    try {
      const resolved = typeof condition.expected === 'string' ? { ...condition, expected: resolveSecret(condition.expected, deps.secrets) } : condition;
      const checked = await verifyCondition({ ...context, condition: resolved });
      conditions.push({ ...checked, condition });
    } catch (error) {
      deps.signal?.throwIfAborted();
      conditions.push({ condition, status: 'unverified', reason: error instanceof Error ? error.message.slice(0, 1000) : 'Evidência indisponível.',
        evidence: { url: deps.page.url(), complete: false, fingerprint: '', observed: [] }, judgments: [] });
    }
  }
  if (!revision || await pageFingerprint(deps.page).catch(() => undefined) !== revision) {
    result.conditions = conditions.map(condition => ({ ...condition, status: 'unverified',
      reason: 'A página mudou entre as condições; o conjunto precisa de uma nova observação consistente.' }));
    result.reason = 'A página mudou entre as condições; não foi possível compor um resultado consistente.';
    return;
  }
  result.conditions = conditions;
  result.status = composeVerification(verification, conditions);
  result.reason = conditions.filter(condition => result.status === 'passed' ? condition.status === 'passed' : condition.status !== 'passed')
    .map(condition => `${condition.condition.id}: ${condition.reason}`).join(' ').slice(0, 2000);
}

export async function verifyAssertion(deps: AssertionOptions): Promise<AssertionResult> {
  const started = performance.now();
  const result: AssertionResult = { stepIndex: deps.stepIndex, instruction: deps.instruction,
    status: 'unverified', method: 'semantic+dom', probability: deps.probability,
    reason: '', durationMs: 0, predicate: 'structured', terms: [], url: deps.page.url() };
  const tracing = deps.page.context().tracing;
  result.interaction = { kind: 'assert', phase: 'checking', label: deps.instruction,
    viewport: deps.page.viewportSize() ?? { width: 1280, height: 900 } };
  await paintInteraction(deps.page, result.interaction);
  await deps.onInteraction?.(result.interaction);
  await tracing.group(`ASSERT: ${deps.instruction}`);
  try {
    await (deps.measure ?? unmeasured)('engine', 'Verificar condições e compor resultado', () => inspect(deps, result));
  } catch (error) {
    deps.signal?.throwIfAborted();
    result.reason = error instanceof Error ? error.message.slice(0, 1000) : 'Não foi possível verificar a condição.';
  } finally { await tracing.groupEnd().catch(() => undefined); }
  result.interaction = { kind: 'assert', phase: result.status === 'unverified' ? 'checking' : result.status, label: deps.instruction,
    viewport: deps.page.viewportSize() ?? { width: 1280, height: 900 } };
  await tracing.group(`${result.status.toUpperCase()}: ${deps.instruction}`);
  try {
    await paintInteraction(deps.page, result.interaction);
    result.screenshot = `data:image/jpeg;base64,${(await deps.page.screenshot({ type: 'jpeg', quality: 80 })).toString('base64')}`;
    await deps.onInteraction?.(result.interaction, result.screenshot);
  } finally { await tracing.groupEnd().catch(() => undefined); }
  result.durationMs = Math.round(performance.now() - started);
  return result;
}
