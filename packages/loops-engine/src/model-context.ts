import type { Questions, SystemOneRequest, SystemOneResult, TypeSafeClient } from '@typesafe-ai/sdk';

// A transport budget, not a token estimate. Keep headroom for the provider's
// schema/choice expansion. The provider may impose a smaller token limit.
export const MODEL_REQUEST_BYTES = 48_000;
export type ContextAttempt = { questions: string[]; bytes: number; outcome: 'answered' | 'context_limit' };

/** Split independent questions over the SAME complete observation. Never truncate
 * evidence, values, history or choice alternatives to manufacture a passing result.
 * This only repeats model inference; it cannot replay a browser interaction. */
export async function boundedSystemOne<Q extends Questions>(
  client: Pick<TypeSafeClient, 'systemOne'>, request: SystemOneRequest<Q>, signal?: AbortSignal,
) {
  const attempts: ContextAttempt[] = [];
  async function run(questions: Questions): Promise<SystemOneResult<Questions>> {
    signal?.throwIfAborted();
    const keys = Object.keys(questions);
    const payload = { ...request, questions };
    const bytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
    if (bytes <= MODEL_REQUEST_BYTES) {
      try {
        const response = await client.systemOne(payload, { signal });
        attempts.push({ questions: keys, bytes, outcome: 'answered' });
        return response;
      } catch (error) {
        // Do not retry authentication, network errors or cancellation here. SDK
        // transport recovery remains separate from inference context recovery.
        signal?.throwIfAborted();
        if (!(error instanceof Error) || !error.message.includes('max_tokens_exceeded')) throw error;
        attempts.push({ questions: keys, bytes, outcome: 'context_limit' });
      }
    }
    if (keys.length <= 1) {
      throw new Error(`Model context cannot fit the complete observation and question ${keys[0] ?? '(none)'}. Verification remains inconclusive; no evidence was discarded.`);
    }
    const middle = Math.ceil(keys.length / 2);
    const left = await run(Object.fromEntries(keys.slice(0, middle).map(key => [key, questions[key]!] )));
    const right = await run(Object.fromEntries(keys.slice(middle).map(key => [key, questions[key]!] )));
    if (left.model !== right.model) throw new Error('Model changed during context-split decision; observe again before acting.');
    return { model: left.model, answers: { ...left.answers, ...right.answers }, usage: {
      input_tokens: left.usage.input_tokens + right.usage.input_tokens,
      output_tokens: left.usage.output_tokens + right.usage.output_tokens,
    } };
  }
  const response = await run(request.questions);
  return { ...response, answers: response.answers as SystemOneResult<Q>['answers'],
    context: { attempts, rejectedRequestUsageUnknown: attempts.some(attempt => attempt.outcome === 'context_limit') } };
}
