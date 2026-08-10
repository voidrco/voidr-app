import { describe, expect, it } from 'vitest';
import { parseDesktopCaptureLaunch, parseLoopLaunch } from './deep-link';

describe('desktop Loop bootstrap', () => {
  it('parses the secret-free operating-system handoff', () => {
    expect(
      parseDesktopCaptureLaunch(
        'voidr://capture/loops/lts_checkout/cycles/88ad0919-9754-4787-8a43-fc4bf79e52bd?organization=org_itau&surface=web&v=1',
      ),
    ).toEqual({
      version: 'VOIDR-CAPTURE-LAUNCH/1',
      organizationId: 'org_itau',
      loopId: 'lts_checkout',
      cycleId: '88ad0919-9754-4787-8a43-fc4bf79e52bd',
      surface: 'web',
    });
  });

  it('rejects extra parameters, fragments and unsupported surfaces', () => {
    for (const value of [
      'voidr://capture/loops/lts_checkout/cycles/88ad0919-9754-4787-8a43-fc4bf79e52bd?organization=org_itau&surface=web&v=1&token=secret',
      'voidr://capture/loops/lts_checkout/cycles/88ad0919-9754-4787-8a43-fc4bf79e52bd?organization=org_itau&surface=voice&v=1',
      'voidr://capture/loops/lts_checkout/cycles/88ad0919-9754-4787-8a43-fc4bf79e52bd?organization=org_itau&surface=web&v=1#secret',
      'voidr://capture/loops/lts_checkout/cycles/88ad0919-9754-4787-8a43-fc4bf79e52bd?surface=web&v=1',
    ]) {
      expect(() => parseDesktopCaptureLaunch(value)).toThrow();
    }
  });

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
