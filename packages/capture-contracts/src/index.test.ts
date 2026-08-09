import { describe, expect, it } from 'vitest';
import {
  CAPTURE_HOST_VERSION,
  captureEnvelopeSchema,
  isTrustedWebUrl,
  localRuntimeConfigSchema,
  mobileAttachInputSchema,
  redactText,
  redactUrl,
} from './index';

describe('CAPTURE-HOST/1 contracts', () => {
  it('rejects an unknown command and stale protocol', () => {
    expect(() =>
      captureEnvelopeSchema.parse({
        version: 'CAPTURE-HOST/0',
        id: crypto.randomUUID(),
        type: 'request',
        command: 'exec',
        occurredAt: new Date().toISOString(),
        payload: {},
      }),
    ).toThrow();
    expect(CAPTURE_HOST_VERSION).toBe('CAPTURE-HOST/1');
  });

  it('pins mobile attach to a UUID verification and lifecycle version', () => {
    expect(() =>
      mobileAttachInputSchema.parse({
        verificationId: '../tenant',
        sessionId: 's-1',
        lifecycleVersion: -1,
        runtime: {},
      }),
    ).toThrow();
  });

  it('removes launch capabilities from URLs and logs', () => {
    const safe = redactUrl(
      'http://localhost:8080/?voidr_record=1&token=secret#voidr-loop-v2=secret',
    );
    expect(safe).not.toContain('secret');
    expect(redactText('Authorization: Bearer abcdefghijklmnop')).not.toContain(
      'abcdefghijklmnop',
    );
    expect(redactUrl('https://admin:secret@example.com/path')).not.toContain('secret');
    expect(
      redactText('token="eyJheader123.payload123.signature123" api_key=api_abcdefghijklmnop'),
    ).not.toContain('eyJheader123');
  });

  it('allows insecure HTTP only on loopback and never accepts URL credentials', () => {
    expect(isTrustedWebUrl('http://localhost:8080/')).toBe(true);
    expect(isTrustedWebUrl('http://127.0.0.1:3000/')).toBe(true);
    expect(isTrustedWebUrl('http://10.0.0.8:8080/')).toBe(false);
    expect(isTrustedWebUrl('https://example.com/')).toBe(true);
    expect(isTrustedWebUrl('https://user:password@example.com/')).toBe(false);
  });

  it('prevents the local credential from being redirected to non-loopback endpoints', () => {
    const local = {
      serviceUrl: 'http://localhost:3000/v1',
      collectorUrl: 'http://localhost:3100',
      collectorScriptUrl: 'http://localhost:8889/dist/recorder.min.js',
      platformUrl: 'http://localhost:3030',
      localAdapter: true,
      localDevKey: 'local-secret',
      organizationId: 'org_local',
    };
    expect(localRuntimeConfigSchema.safeParse(local).success).toBe(true);
    expect(
      localRuntimeConfigSchema.safeParse({ ...local, serviceUrl: 'https://attacker.example/v1' })
        .success,
    ).toBe(false);
    expect(
      localRuntimeConfigSchema.safeParse({ ...local, collectorUrl: 'http://localhost:3100?next=x' })
        .success,
    ).toBe(false);
  });
});
