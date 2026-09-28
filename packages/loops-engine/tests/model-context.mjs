import assert from 'node:assert/strict';
import { choice, noul } from '@typesafe-ai/sdk';
import { boundedSystemOne, MODEL_REQUEST_BYTES } from '../src/model-context.ts';
import { modelAction, createDecider } from '../src/decide.ts';

const responseFor = request => ({ model: 'test', usage: { input_tokens: 7, output_tokens: 3 },
  answers: Object.fromEntries(Object.entries(request.questions).map(([key, question]) => [key,
    question.type === 'noul' ? { type: 'noul', noul: 0.1 }
      : { type: 'choice', choice: Object.keys(question.criteria).at(-1), confidence: 1, probabilities: {} }])) });
const state = { text: '完整证据'.repeat(2500), exact: 'Blue Top quantity 13', history: ['Submission uncertain; do not repeat'] };
const questions = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`q${i}`, noul('Check exact evidence ' + 'x'.repeat(4000))]));
const calls = [];
const result = await boundedSystemOne({ systemOne: async request => {
  assert.deepEqual(request.state, state, 'Every split retains the full evidence and mutation history');
  assert.ok(Buffer.byteLength(JSON.stringify(request)) <= MODEL_REQUEST_BYTES);
  calls.push(request); return responseFor(request);
} }, { state, questions });
assert.ok(calls.length > 1);
assert.deepEqual(Object.keys(result.answers).sort(), Object.keys(questions).sort());
assert.equal(result.usage.input_tokens, calls.length * 7);
assert.equal(result.usage.output_tokens, calls.length * 3);
assert.equal(result.context.rejectedRequestUsageUnknown, false);

let retries = 0;
const choices = { state: 'small', questions: { a: noul('A'), b: choice('Select', { first: 'wrong', last: 'right' }) } };
const recovered = await boundedSystemOne({ systemOne: async request => {
  retries++;
  if (Object.keys(request.questions).length > 1) throw Error('400 max_tokens_exceeded');
  return responseFor(request);
} }, choices);
assert.equal(retries, 3, 'Context rejection is retried only with strictly smaller question groups');
assert.equal(recovered.answers.b.choice, 'last');
assert.equal(recovered.context.rejectedRequestUsageUnknown, true);
assert.equal(recovered.usage.input_tokens, 14);
let oversizeCalls = 0;
await assert.rejects(boundedSystemOne({ systemOne: async () => { oversizeCalls++; } }, {
  state: 'x'.repeat(MODEL_REQUEST_BYTES), questions: { assertion: noul('Prove absence') },
}), /inconclusive; no evidence was discarded/);
assert.equal(oversizeCalls, 0);
await assert.rejects(boundedSystemOne({ systemOne: async () => { throw Error('401 Unauthorized'); } }, choices), /401/);
const controller = new AbortController();
await assert.rejects(boundedSystemOne({ systemOne: async () => { controller.abort(); throw Error('max_tokens_exceeded'); } }, choices, controller.signal), /abort/i);

const control = { frame: 2, index: 99, name: 'Identical name', context: 'Large panel '.repeat(200),
  options: [{ value: 'code-42', label: 'São Paulo' }] };
const action = { id: 'a498', kind: 'select', control, value: 'code-42' };
const description = JSON.parse(modelAction(action));
assert.deepEqual(description.target, { frame: 2, index: 99 });
assert.equal(description.value, 'code-42'); assert.equal(description.label, 'São Paulo');
assert.ok(modelAction(action).length < 160);
assert.deepEqual(JSON.parse(modelAction({ id: 'nav', kind: 'navigate', url: 'https://example.com/journey' })),
  { kind: 'navigate', url: 'https://example.com/journey' });

// End-to-end decider contract: a failing assertion remains failing after split,
// including when the relevant evidence is the final region/choice.
const evidence = Array.from({ length: 96 }, (_, i) => ({ id: `e0_${i}`, frame: 0, index: i,
  text: `Row ${i}: ` + 'Context '.repeat(20), values: [{ name: 'quantity', value: i === 95 ? '13' : '3' }] }));
const observation = { url: 'https://example.com', text: 'Blue Top quantity 13 ' + 'Context '.repeat(2500), controls: [], evidence };
const snapshot = structuredClone(observation);
const decision = await createDecider({ systemOne: async request => {
  const response = responseFor(request);
  const answers = { needsHuman: { type: 'noul', noul: 0 }, satisfied: { type: 'noul', noul: 0.1 },
    status: { type: 'choice', choice: 'blocked', confidence: 1 }, intent: { type: 'choice', choice: 'assertion', confidence: 1 },
    evidence: { type: 'choice', choice: 'e0_95', confidence: 1 }, assertionPredicate: { type: 'choice', choice: 'contains', confidence: 1 } };
  for (const key of Object.keys(request.questions)) if (key in answers) response.answers[key] = answers[key];
  return response;
} })({ steps: ['Verify "Blue Top" quantity 3'], stepIndex: 0, stepKind: 'assertion', observation, actions: [], history: [] });
assert.equal(decision.assertion.evidence.id, 'e0_95');
assert.equal(decision.assertion.probability, 0.1);
assert.equal(decision.answer.choice, 'blocked');
assert.deepEqual(observation, snapshot, 'Authoritative observation must remain unchanged');
console.log('OK: bounded complete context, Unicode bytes, provider recovery, costs, cancellation, exact action references and failing assertions.');
