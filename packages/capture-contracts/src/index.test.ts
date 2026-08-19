import { describe, expect, it } from 'vitest';
import {
  CAPTURE_HOST_VERSION,
  VOIDR_CAPTURE_LAUNCH_VERSION,
  annotationInputSchema,
  captureEnvelopeSchema,
  captureStatusSchema,
  desktopCaptureLaunchSchema,
  desktopCaptureResolutionSchema,
  desktopLoopCycleDetailSchema,
  isTrustedWebUrl,
  localRuntimeConfigSchema,
  mobileAttachInputSchema,
  redactText,
  redactUrl,
} from './index';

describe('CAPTURE-HOST/1 contracts', () => {
  it('supports contextual notes for element, region and full-screen capture', () => {
    for (const kind of ['element', 'region', 'screen'] as const) {
      expect(annotationInputSchema.parse({ kind, note: 'Esperado × observado' })).toEqual({
        kind,
        note: 'Esperado × observado',
      });
    }
    expect(() => annotationInputSchema.parse({ kind: 'region', note: ' ' })).toThrow();
  });

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

  it('keeps desktop launch descriptors secret-free and cycle-bound', () => {
    const launch = desktopCaptureLaunchSchema.parse({
      version: VOIDR_CAPTURE_LAUNCH_VERSION,
      organizationId: 'org_itau',
      loopId: 'lts_checkout',
      cycleId: '88ad0919-9754-4787-8a43-fc4bf79e52bd',
      surface: 'web',
    });
    expect(JSON.stringify(launch)).not.toMatch(/token|secret|authorization/i);
    expect(launch.organizationId).toBe('org_itau');
    expect(() =>
      desktopCaptureLaunchSchema.parse({ ...launch, cycleId: '../another-tenant' }),
    ).toThrow();
  });

  it('carries only the canonical participant projection into the desktop handoff', () => {
    const resolution = desktopCaptureResolutionSchema.parse({
      version: VOIDR_CAPTURE_LAUNCH_VERSION,
      captureAdapter: 'voidr_app',
      surface: 'web',
      loopId: 'lts_checkout',
      cycleId: '88ad0919-9754-4787-8a43-fc4bf79e52bd',
      cycleNumber: 2,
      applicationId: 'app_checkout',
      environment: 'local',
      mission: 'Concluir o checkout',
      targetUrl: 'http://localhost:8080/',
      participant: {
        name: 'Milson Ramos de Carvalho Júnior',
        role: 'Software Developer',
        picture: 'https://images.example/milson.png',
      },
      cycleStartedAt: '2026-08-17T15:45:00.000Z',
    });
    expect(resolution.participant?.role).toBe('Software Developer');
    expect(JSON.stringify(resolution)).not.toMatch(/email|actorId|token|authorization/i);
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
    const sessionSafe = redactUrl(
      'https://example.com/checkout?sessionId=sensitive&password=hunter2&filter=open',
    );
    expect(sessionSafe).toBe('https://example.com/checkout?filter=open');
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

  it('bounds the renderer evidence projection without accepting raw request payloads', () => {
    const status = captureStatusSchema.parse({
      stage: 'recording',
      elapsedMs: 320,
      evidence: { pages: 1, clicks: 0, requests: 1, errors: 0, notes: 0, voiceNotes: 0 },
      recentSignals: [
        {
          id: crypto.randomUUID(),
          category: 'requests',
          atMs: 280,
          title: 'GET · HTTP 200',
          detail: 'http://localhost:8080/checkout · 18 ms · document',
          tone: 'success',
        },
      ],
    });
    expect(status.recentSignals?.[0]?.category).toBe('requests');
    expect(JSON.stringify(status.recentSignals)).not.toMatch(/authorization|cookie|postData/i);
    expect(() =>
      captureStatusSchema.parse({
        ...status,
        recentSignals: Array.from({ length: 61 }, (_, index) => ({
          id: `signal-${index}`,
          category: 'requests',
          atMs: index,
          title: 'GET · HTTP 200',
        })),
      }),
    ).toThrow();
  });

  it('keeps the desktop Loop detail bounded and free of raw storage references', () => {
    const detail = desktopLoopCycleDetailSchema.parse({
      loopId: 'lts_checkout',
      cycleId: '88ad0919-9754-4787-8a43-fc4bf79e52bd',
      cycleNumber: 2,
      durationMs: 4_200,
      replayAvailable: true,
      counts: { annotations: 1, actions: 4, consoleErrors: 0, failedRequests: 0, transcriptSegments: 0 },
      evidence: [{
        id: 'annotation-1',
        kind: 'annotation',
        atMs: 920,
        title: 'Botão não respondeu',
        detail: null,
        tone: 'warning',
      }],
    });
    expect(JSON.stringify(detail)).not.toMatch(/evidenceRef|signedUrl|authorization|cookie/i);
    expect(() => desktopLoopCycleDetailSchema.parse({
      ...detail,
      evidence: Array.from({ length: 201 }, (_, index) => ({
        id: `evidence-${index}`,
        kind: 'action',
        atMs: index,
        title: 'Evento',
        detail: null,
        tone: 'neutral',
      })),
    })).toThrow();
  });
});
