import { describe, expect, it } from 'vitest';
import { inspectCollectorStopAttempt } from './collector-stop';

describe('collector Stop receipt', () => {
  it('accepts only a positive durable terminal receipt', () => {
    expect(
      inspectCollectorStopAttempt({
        sessionId: 'session-1',
        ok: true,
        flushed: true,
        sealed: true,
        sealedThrough: 4,
      }).receipt,
    ).toMatchObject({ sessionId: 'session-1', sealedThrough: 4 });
  });

  it('treats a pending seal as retryable without exposing schema internals', () => {
    const result = inspectCollectorStopAttempt({
      sessionId: 'session-1',
      ok: false,
      flushed: true,
      sealed: false,
      sealedThrough: 0,
      status: 'pending',
    });

    expect(result.receipt).toBeUndefined();
    expect(result.retryable).toBe(true);
    expect(result.message).toContain('ainda não confirmou');
    expect(result.message).not.toContain('invalid_value');
  });

  it('fails closed when the durable-seal rollout is disabled', () => {
    const result = inspectCollectorStopAttempt({
      sessionId: 'session-1',
      ok: false,
      flushed: true,
      sealed: false,
      sealedThrough: 0,
      status: 'pending',
      code: 'LOOP_SEALED_SESSION_V1_DISABLED',
    });
    expect(result.retryable).toBe(false);
    expect(result.receipt).toBeUndefined();
  });

  it('redacts unsafe server detail before surfacing it', () => {
    const result = inspectCollectorStopAttempt({
      sessionId: 'session-1',
      ok: false,
      flushed: false,
      sealed: false,
      sealedThrough: 0,
      error: 'Authorization: Bearer super-secret-token-value',
    });

    expect(result.message).not.toContain('super-secret-token-value');
  });
});
