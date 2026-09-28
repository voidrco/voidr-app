import type { Questions, SystemOneRequest, SystemOneResult, TypeSafeClient } from '@typesafe-ai/sdk';

// A transport budget, not a token estimate. Keep headroom for the provider's
// schema/choice expansion. The provider may impose a smaller token limit.
export const MODEL_REQUEST_BYTES = 48_000;
export type ContextAttempt = { questions: string[]; bytes: number; outcome: 'answered' | 'context_limit'; choices?: string[] };

/** Split independent questions over the SAME complete observation. Never truncate
 * evidence, values, history or choice alternatives to manufacture a passing result.
 * This only repeats model inference; it cannot replay a browser interaction. */
export async function boundedSystemOne<Q extends Questions>(
  client: Pick<TypeSafeClient, 'systemOne'>, request: SystemOneRequest<Q>, signal?: AbortSignal,
) {
  const attempts: ContextAttempt[] = [];
  const size = (questions: Questions) => Buffer.byteLength(JSON.stringify({ ...request, questions }), 'utf8');
  function merge(responses: SystemOneResult<Questions>[], answers: SystemOneResult<Questions>['answers']) {
    if (responses.some(response => response.model !== responses[0]!.model)) {
      throw new Error('Model changed during context-split decision; observe again before acting.');
    }
    return { model: responses[0]!.model, answers, usage: responses.reduce((usage, response) => ({
      input_tokens: usage.input_tokens + response.usage.input_tokens,
      output_tokens: usage.output_tokens + response.usage.output_tokens,
    }), { input_tokens: 0, output_tokens: 0 }) };
  }
  function cannotFit(key: string) {
    return new Error(`Model context cannot fit the complete observation and question ${key}. Verification remains inconclusive; no evidence was discarded.`);
  }
  async function selectInGroups(key: string, question: Questions[string], providerRejected: boolean): Promise<SystemOneResult<Questions>> {
    // Only selectors with an explicit abstention option can be paged safely.
    // Status/intent classifications must remain complete closed questions.
    if (question.type !== 'choice') throw cannotFit(key);
    const fallback = ['none', 'unsure'].find(id => Object.hasOwn(question.criteria, id));
    if (!fallback) throw cannotFit(key);
    const entries = Object.entries(question.criteria).filter(([id]) => id !== fallback);
    if (entries.length < 2) throw cannotFit(key);
    const make = (items: typeof entries) => ({ ...question,
      criteria: Object.fromEntries([...items, [fallback, question.criteria[fallback]!]]) });
    const groups: (typeof entries)[] = [];
    let group: typeof entries = [];
    const maxCount = providerRejected ? Math.ceil(entries.length / 2) : entries.length;
    for (const entry of entries) {
      if (group.length && (group.length >= maxCount || size({ [key]: make([...group, entry]) }) > MODEL_REQUEST_BYTES)) {
        groups.push(group); group = [];
      }
      group.push(entry);
      if (size({ [key]: make(group) }) > MODEL_REQUEST_BYTES) throw cannotFit(key);
    }
    if (group.length) groups.push(group);
    if (groups.length < 2) throw cannotFit(key);
    const responses: SystemOneResult<Questions>[] = [];
    const winners: typeof entries = [];
    for (const items of groups) {
      const response = await run({ [key]: make(items) });
      const answer = response.answers[key];
      if (!answer || answer.type !== 'choice' || !Object.hasOwn(make(items).criteria, answer.choice)) {
        throw new Error('Model selected an alternative outside its context group; no action authorized.');
      }
      responses.push(response);
      if (answer.choice !== fallback) winners.push([answer.choice, question.criteria[answer.choice]!]);
    }
    // Compare the original, complete descriptions of winners, never a model
    // summary. If every group abstains, keep that abstention (not a passed test).
    if (winners.length >= entries.length) throw cannotFit(key);
    const final = winners.length ? await run({ [key]: make(winners) }) : responses.at(-1)!;
    return merge(winners.length ? [...responses, final] : responses, final.answers);
  }
  async function run(questions: Questions): Promise<SystemOneResult<Questions>> {
    signal?.throwIfAborted();
    const keys = Object.keys(questions);
    const payload = { ...request, questions };
    const bytes = size(questions);
    const only = keys.length === 1 ? questions[keys[0]!] : undefined;
    const choiceIds = only?.type === 'choice' ? Object.keys(only.criteria) : undefined;
    let providerRejected = false;
    if (bytes <= MODEL_REQUEST_BYTES) {
      try {
        const response = await client.systemOne(payload, { signal });
        attempts.push({ questions: keys, bytes, outcome: 'answered', ...(choiceIds ? { choices: choiceIds } : {}) });
        return response;
      } catch (error) {
        // Do not retry authentication, network errors or cancellation here. SDK
        // transport recovery remains separate from inference context recovery.
        signal?.throwIfAborted();
        if (!(error instanceof Error) || !error.message.includes('max_tokens_exceeded')) throw error;
        providerRejected = true;
        attempts.push({ questions: keys, bytes, outcome: 'context_limit', ...(choiceIds ? { choices: choiceIds } : {}) });
      }
    }
    if (keys.length === 1) return selectInGroups(keys[0]!, questions[keys[0]!]!, providerRejected);
    if (!keys.length) throw cannotFit('(none)');
    const middle = Math.ceil(keys.length / 2);
    const left = await run(Object.fromEntries(keys.slice(0, middle).map(key => [key, questions[key]!] )));
    const right = await run(Object.fromEntries(keys.slice(middle).map(key => [key, questions[key]!] )));
    return merge([left, right], { ...left.answers, ...right.answers });
  }
  const response = await run(request.questions);
  return { ...response, answers: response.answers as SystemOneResult<Q>['answers'],
    context: { attempts, rejectedRequestUsageUnknown: attempts.some(attempt => attempt.outcome === 'context_limit') } };
}
