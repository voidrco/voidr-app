import { z } from 'zod';

export const CAPTURE_HOST_VERSION = 'CAPTURE-HOST/1' as const;

const boundedId = z.string().trim().min(1).max(200);
const opaqueId = z.string().uuid();

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized === '::1' ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized)
  );
}

export function isTrustedWebUrl(input: string, allowLoopbackHttp = true): boolean {
  try {
    const url = new URL(input);
    if (url.username || url.password) return false;
    if (url.protocol === 'https:') return true;
    return allowLoopbackHttp && url.protocol === 'http:' && isLoopbackHostname(url.hostname);
  } catch {
    return false;
  }
}

const trustedWebUrlSchema = z
  .string()
  .url()
  .max(16_384)
  .refine((value) => isTrustedWebUrl(value), 'Use HTTPS ou HTTP em loopback, sem credenciais na URL.');

export const capturePlatformSchema = z.enum(['web', 'android', 'ios', 'api']);
export type CapturePlatform = z.infer<typeof capturePlatformSchema>;

export const captureStageSchema = z.enum([
  'idle',
  'preparing',
  'ready',
  'recording',
  'stopping',
  'sealed',
  'attaching',
  'processing',
  'ready_for_review',
  'offline',
  'recoverable_error',
  'terminal_error',
]);
export type CaptureStage = z.infer<typeof captureStageSchema>;

export const captureEnvelopeSchema = z.object({
  version: z.literal(CAPTURE_HOST_VERSION),
  id: opaqueId,
  type: z.enum(['request', 'receipt', 'event']),
  command: z.enum([
    'doctor',
    'prepare.web',
    'start.web',
    'stop.web',
    'annotate.element',
    'annotate.screen',
    'mobile.devices',
    'mobile.launch',
    'mobile.session.discover',
    'mobile.session.attach',
    'open.cycle',
  ]),
  generation: opaqueId.optional(),
  occurredAt: z.string().datetime(),
  payload: z.record(z.string(), z.unknown()),
});
export type CaptureEnvelope = z.infer<typeof captureEnvelopeSchema>;

export const localRuntimeConfigSchema = z
  .object({
    serviceUrl: trustedWebUrlSchema,
    collectorUrl: trustedWebUrlSchema,
    collectorScriptUrl: trustedWebUrlSchema,
    platformUrl: trustedWebUrlSchema,
    localAdapter: z.boolean().default(true),
    localDevKey: z.string().min(8).max(200),
    organizationId: boundedId,
  })
  .superRefine((runtime, context) => {
    for (const key of ['serviceUrl', 'collectorUrl', 'collectorScriptUrl', 'platformUrl'] as const) {
      const url = new URL(runtime[key]);
      if (url.search || url.hash) {
        context.addIssue({ code: 'custom', path: [key], message: 'Endpoints não aceitam query ou fragment.' });
      }
      if (runtime.localAdapter && !isLoopbackHostname(url.hostname)) {
        context.addIssue({ code: 'custom', path: [key], message: 'O adapter local aceita somente endpoints de loopback.' });
      }
      if (!runtime.localAdapter && url.protocol !== 'https:') {
        context.addIssue({ code: 'custom', path: [key], message: 'Endpoints remotos exigem HTTPS.' });
      }
    }
  });
export type LocalRuntimeConfig = z.infer<typeof localRuntimeConfigSchema>;

export const prepareWebInputSchema = z.object({
  recordingUrl: trustedWebUrlSchema,
  runtime: localRuntimeConfigSchema,
});
export type PrepareWebInput = z.infer<typeof prepareWebInputSchema>;

export const safeWebContextSchema = z.object({
  scenarioId: boundedId,
  cycleId: opaqueId,
  lifecycleGeneration: opaqueId,
  safeTargetUrl: trustedWebUrlSchema,
  scenarioName: z.string().trim().min(1).max(300),
  applicationId: boundedId,
  verificationId: opaqueId,
  verificationGeneration: opaqueId,
  lifecycleVersion: z.number().int().nonnegative(),
  cycleNumber: z.number().int().positive().optional(),
  harnessName: z.string().trim().max(120).optional(),
});
export type SafeWebContext = z.infer<typeof safeWebContextSchema>;

export const collectorStopReceiptSchema = z.object({
  sessionId: boundedId,
  ok: z.literal(true),
  flushed: z.literal(true),
  sealed: z.literal(true),
  sealedThrough: z.number().int().positive(),
});
export type CollectorStopReceipt = z.infer<typeof collectorStopReceiptSchema>;

export const annotationInputSchema = z.object({
  kind: z.enum(['element', 'screen']),
  note: z.string().trim().min(1).max(1000),
});
export type AnnotationInput = z.infer<typeof annotationInputSchema>;

export const androidDeviceSchema = z.object({
  serial: boundedId,
  state: z.enum(['device', 'offline', 'unauthorized', 'unknown']),
  model: z.string().max(120).optional(),
  product: z.string().max(120).optional(),
  transportId: z.string().max(40).optional(),
});
export type AndroidDevice = z.infer<typeof androidDeviceSchema>;

export const androidLaunchInputSchema = z.object({
  serial: boundedId,
  packageName: z.string().regex(/^[A-Za-z][A-Za-z0-9_.]{2,199}$/),
});
export type AndroidLaunchInput = z.infer<typeof androidLaunchInputSchema>;

export const mobileAttachInputSchema = z.object({
  verificationId: opaqueId,
  sessionId: boundedId,
  lifecycleVersion: z.number().int().nonnegative(),
  runtime: localRuntimeConfigSchema,
});
export type MobileAttachInput = z.infer<typeof mobileAttachInputSchema>;

export const captureStatusSchema = z.object({
  stage: captureStageSchema,
  platform: capturePlatformSchema.optional(),
  generation: opaqueId.optional(),
  context: safeWebContextSchema.optional(),
  sessionId: boundedId.optional(),
  elapsedMs: z.number().int().nonnegative().default(0),
  evidence: z.object({
    pages: z.number().int().nonnegative(),
    clicks: z.number().int().nonnegative(),
    requests: z.number().int().nonnegative(),
    errors: z.number().int().nonnegative(),
    notes: z.number().int().nonnegative(),
    voiceNotes: z.number().int().nonnegative(),
  }),
  message: z.string().max(500).optional(),
  errorCode: z.string().max(100).optional(),
});
export type CaptureStatus = z.infer<typeof captureStatusSchema>;

export function createEnvelope(
  command: CaptureEnvelope['command'],
  payload: Record<string, unknown>,
  options: Partial<Pick<CaptureEnvelope, 'generation' | 'type'>> = {},
): CaptureEnvelope {
  return captureEnvelopeSchema.parse({
    version: CAPTURE_HOST_VERSION,
    id: crypto.randomUUID(),
    type: options.type ?? 'request',
    command,
    generation: options.generation,
    occurredAt: new Date().toISOString(),
    payload,
  });
}

export function redactUrl(input: string): string {
  try {
    const url = new URL(input);
    url.username = '';
    url.password = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/token|secret|key|authorization|voidr_/i.test(key)) url.searchParams.delete(key);
    }
    if (/^#voidr-loop-v\d+=/i.test(url.hash)) url.hash = '';
    return url.toString();
  } catch {
    return '[invalid-url]';
  }
}

export function redactText(input: string): string {
  return input
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [redacted]')
    .replace(/(["']?(?:token|secret|authorization|apiKey)["']?\s*[:=]\s*["'])[^"'\s]{8,}/gi, '$1[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[redacted-token]')
    .replace(/\b(?:sk|api)[-_][A-Za-z0-9_-]{16,}\b/gi, '[redacted-key]')
    .replace(/([?&](?:token|key|secret|authorization|voidr_[^=]*)=)[^&#\s]+/gi, '$1[redacted]')
    .slice(0, 4_000);
}
