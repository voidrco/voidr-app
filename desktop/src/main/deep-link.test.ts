import { describe, expect, it } from 'vitest';
import { parseLoopLaunch } from './deep-link';

describe('desktop Loop bootstrap', () => {
  it('consumes a v1 capability without returning it in the target URL', () => {
    const token = 'secret-capability-that-never-reaches-the-renderer';
    const envelope = Buffer.from(JSON.stringify({ token, originalHash: '#checkout' })).toString(
      'base64url',
    );
    const parsed = parseLoopLaunch(
      `http://localhost:8080/?voidr_record=1&voidr_mode=loop-test&voidr_bootstrap=v1&voidr_scenario_id=lts_1#voidr-loop-v1=${envelope}`,
    );
    expect(parsed.token).toBe(token);
    expect(parsed.safeUrl).toBe('http://localhost:8080/#checkout');
    expect(parsed.safeUrl).not.toContain('voidr_');
  });

  it('fails closed on a malformed secure fragment', () => {
    expect(() =>
      parseLoopLaunch(
        'http://localhost:8080/?voidr_mode=loop-test&voidr_bootstrap=v1&voidr_scenario_id=lts_1#voidr-loop-v1=bad%60',
      ),
    ).toThrow();
  });
});
