import { describe, expect, it, vi } from 'vitest';
import { captureReducer, initialCaptureState, isGenerationCurrent, SingleFlight } from './index';

describe('capture kernel', () => {
  it('fences stale generations and reaches review only after seal/attach', () => {
    const generation = crypto.randomUUID();
    let state = captureReducer(initialCaptureState, { type: 'PREPARE', platform: 'web', generation });
    expect(isGenerationCurrent(state, crypto.randomUUID())).toBe(false);
    state = captureReducer(state, { type: 'PREPARED' });
    state = captureReducer(state, { type: 'START', startedAt: Date.now(), sessionId: 's-1' });
    state = captureReducer(state, { type: 'STOP' });
    state = captureReducer(state, { type: 'SEALED', sessionId: 's-1', sealedAt: Date.now() });
    state = captureReducer(state, { type: 'ATTACH' });
    state = captureReducer(state, { type: 'READY' });
    expect(state.stage).toBe('ready_for_review');
  });

  it('rejects dishonest transitions', () => {
    expect(() => captureReducer(initialCaptureState, { type: 'READY' })).toThrow(
      'Invalid capture transition',
    );
  });

  it('makes Stop single-flight', async () => {
    const flight = new SingleFlight<number>();
    const operation = vi.fn(async () => 7);
    const [a, b] = await Promise.all([flight.run(operation), flight.run(operation)]);
    expect([a, b]).toEqual([7, 7]);
    expect(operation).toHaveBeenCalledTimes(1);
  });
});
