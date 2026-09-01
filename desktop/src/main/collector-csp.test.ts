import { describe, expect, it } from 'vitest';
import { allowCollectorInContentSecurityPolicy } from './collector-csp';

describe('allowCollectorInContentSecurityPolicy', () => {
  it('adds the collector origin to an existing connect-src directive', () => {
    const headers = allowCollectorInContentSecurityPolicy(
      {
        'Content-Security-Policy': [
          "default-src 'self'; connect-src 'self' https://*.blip.ai; img-src https:",
        ],
      },
      'https://collector.voidr.co/path',
    );

    expect(headers?.['Content-Security-Policy']?.[0]).toContain(
      "connect-src 'self' https://*.blip.ai https://collector.voidr.co",
    );
  });

  it('derives connect-src from default-src when the page relies on the fallback', () => {
    const headers = allowCollectorInContentSecurityPolicy(
      { 'content-security-policy': ["default-src 'self'; img-src data:"] },
      'https://collector.voidr.co',
    );

    expect(headers?.['content-security-policy']?.[0]).toContain(
      "connect-src 'self' https://collector.voidr.co",
    );
  });

  it('does not narrow a policy that has neither connect-src nor default-src', () => {
    const policy = 'img-src https: data:';
    expect(
      allowCollectorInContentSecurityPolicy(
        { 'Content-Security-Policy': [policy] },
        'https://collector.voidr.co',
      )?.['Content-Security-Policy']?.[0],
    ).toBe(policy);
  });
});
