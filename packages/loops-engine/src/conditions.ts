import type { Page } from 'playwright-core';
import type { ConditionResult, VerificationCondition, VerificationPlan, VerificationStatus } from '@voidr/capture-contracts';
import { inspectConditionScope, pageScope, requiresCompleteScope, targetLocator, fingerprint, urlSnapshot, type ConditionCandidate, type ConditionScope, type ConditionSnapshot } from './condition-dom.js';
import { identifyCandidates, judgeCondition, selectRegion, type JudgmentContext } from './evidence-verification.js';

export function composeVerification(plan: VerificationPlan, results: ConditionResult[]): VerificationStatus {
  const evaluate = (id: string): VerificationStatus => {
    const condition = results.find(result => result.condition.id === id);
    if (condition) return condition.status;
    const group = plan.groups.find(item => item.id === id);
    if (!group) return 'unverified';
    const children = group.children.map(evaluate);
    if (group.operator === 'all') return children.includes('failed') ? 'failed' : children.every(status => status === 'passed') ? 'passed' : 'unverified';
    return children.includes('passed') ? 'passed' : children.every(status => status === 'failed') ? 'failed' : 'unverified';
  };
  return evaluate(plan.root);
}

type ConditionInput = JudgmentContext & { page: Page; condition: VerificationCondition; limit: number; cache?: Map<string, ConditionResult> };

async function resolveScope(deps: ConditionInput): Promise<ConditionScope> {
  const scope = await pageScope(deps.page, deps.condition.scope.frameUrl);
  const target = deps.condition.scope.target;
  if (deps.condition.scope.kind === 'page' || !target) return scope;
  const snapshot = await inspectConditionScope({ ...deps, scope, target });
  if (!snapshot.complete) return { ...scope, roots: [], complete: false, reasons: snapshot.reasons };
  const selected = await selectRegion(deps, target, snapshot.candidates);
  if (!selected) return { ...scope, roots: [], complete: false, reasons: ['Região solicitada não identificada com segurança.'] };
  const [rootIndex, index] = selected.id.slice(1).split('_').map(Number);
  const root = scope.roots[rootIndex!];
  if (!root) return { ...scope, roots: [], complete: false, reasons: ['Região deixou de existir.'] };
  const selectedRoot = targetLocator(root, target).nth(index!);
  const nestedFrames = await selectedRoot.locator('iframe,frame').count();
  return { ...scope, roots: [selectedRoot], complete: scope.complete && nestedFrames === 0,
    reasons: nestedFrames ? ['A região contém frames cuja cobertura integral não foi comprovada.'] : scope.reasons };
}

function objectiveStatus(condition: VerificationCondition, matches: ConditionCandidate[], complete: boolean): VerificationStatus {
  const visible = matches.filter(candidate => candidate.visible);
  switch (condition.operator) {
    case 'visible': return visible.length ? 'passed' : complete ? 'failed' : 'unverified';
    case 'not_visible': return visible.length ? 'failed' : complete ? 'passed' : 'unverified';
    case 'absent': return matches.length ? 'failed' : complete ? 'passed' : 'unverified';
    case 'count_equals': return complete ? matches.length === condition.expected ? 'passed' : 'failed' : 'unverified';
  }
  if (matches.length !== 1) return 'unverified';
  const actual = matches[0]!;
  const checks = {
    enabled: actual.enabled, disabled: !actual.enabled,
    value_equals: actual.valueMatchesExpected === true,
    text_equals: actual.text === condition.expected,
    text_contains: actual.text.includes(String(condition.expected)),
  };
  if (condition.operator === 'value_equals' && actual.valueMatchesExpected === undefined) return 'unverified';
  if (actual.truncated && condition.operator.startsWith('text_')) return 'unverified';
  const holds = checks[condition.operator as keyof typeof checks];
  return holds === undefined ? 'unverified' : holds ? 'passed' : 'failed';
}

async function evaluateSnapshot(deps: ConditionInput, snapshot: ConditionSnapshot): Promise<VerificationStatus> {
  const condition = deps.condition;
  if (requiresCompleteScope(condition) && !snapshot.complete) return 'unverified';
  if (condition.evidence.transition && !deps.observedActions.some(action => action.outcome === 'completed' && action.after)) return 'unverified';
  if (condition.operator.startsWith('url_')) {
    if (!snapshot.complete) return 'unverified';
    const url = snapshot.url;
    const holds = condition.operator === 'url_equals' ? url === condition.expected : url.includes(String(condition.expected));
    return holds ? condition.evidence.transition ? judgeCondition(deps, condition, snapshot) : 'passed' : 'failed';
  }
  if (condition.operator === 'semantic') return snapshot.complete ? judgeCondition(deps, condition, snapshot) : 'unverified';
  const identified = await identifyCandidates(deps, condition.target, snapshot);
  const complete = snapshot.complete && identified.uncertain.length === 0;
  if (!complete && ['count_equals', 'absent', 'not_visible'].includes(condition.operator)) return 'unverified';
  if (identified.uncertain.length && !['visible', 'not_visible', 'absent'].includes(condition.operator)) return 'unverified';
  const status = objectiveStatus(condition, identified.matches, complete);
  if (condition.evidence.transition && status === 'passed') return judgeCondition(deps, condition, snapshot);
  return status;
}

function conditionReason(status: VerificationStatus, snapshot: ConditionSnapshot) {
  if (status === 'passed') return 'Condição comprovada no escopo observado.';
  if (status === 'failed') return 'Foi observada uma contradição à condição.';
  if (!snapshot.complete) return snapshot.reasons.join(' ') || 'Busca incompleta no escopo solicitado.';
  return 'Identidade, relação, transição ou evidência insuficiente para comprovar a condição.';
}

function candidateTarget(condition: VerificationCondition) {
  if (condition.operator === 'semantic') return { description: condition.target.description };
  return condition.target;
}

export async function verifyCondition(deps: ConditionInput): Promise<ConditionResult> {
  const judgments: Record<string, unknown>[] = [];
  const context = { ...deps, record: (judgment: Record<string, unknown>) => { judgments.push(judgment); deps.record(judgment); } };
  const scope = await resolveScope(context);
  const expected = deps.condition.operator === 'value_equals' ? String(deps.condition.expected) : undefined;
  const target = candidateTarget(deps.condition);
  const read = () => deps.condition.operator.startsWith('url_') ? Promise.resolve(urlSnapshot(deps.page, deps.condition.scope.frameUrl))
    : inspectConditionScope({ ...deps, scope, target, expected, fieldsOnly: deps.condition.operator === 'semantic' });
  const snapshot = await read();
  const key = fingerprint({ condition: deps.condition, snapshot: snapshot.fingerprint, actions: deps.observedActions });
  const cached = deps.cache?.get(key);
  if (cached) return { ...cached, reason: `${cached.reason} Evidência sem alteração; julgamento anterior reutilizado.` };
  const status = await evaluateSnapshot(context, snapshot);
  deps.signal?.throwIfAborted();
  const current = await read();
  const stable = current.fingerprint === snapshot.fingerprint;
  const result: ConditionResult = { condition: deps.condition, status: stable ? status : 'unverified',
    reason: stable ? conditionReason(status, snapshot) : 'O DOM mudou durante a avaliação; é necessária nova evidência.',
    evidence: { url: snapshot.url, complete: snapshot.complete, fingerprint: snapshot.fingerprint,
      observed: [{ scopeText: snapshot.scopeText }, ...snapshot.candidates] }, judgments };
  if (stable) deps.cache?.set(key, result);
  return result;
}

export function legacyVerification(instruction: string): VerificationPlan {
  return { version: 1, root: 'legacy', groups: [], conditions: [{ id: 'legacy', target: { description: instruction },
    operator: 'semantic', scope: { kind: 'page' }, evidence: { completeness: 'scope', transition: false } }] };
}
