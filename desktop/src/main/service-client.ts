import { z } from 'zod';
import {
  desktopCaptureLaunchSchema,
  desktopCaptureResolutionSchema,
  localRuntimeConfigSchema,
  mobileAttachInputSchema,
  redactText,
  type DesktopCaptureLaunch,
  type DesktopCaptureResolution,
  type LocalRuntimeConfig,
  type MobileAttachInput,
  type SafeWebContext,
} from '@voidr/capture-contracts';
import type { SecretLoopLaunch } from './deep-link';

const validationSchema = z.object({
  valid: z.literal(true),
  scenarioId: z.string().min(1),
  scenarioName: z.string().min(1),
  applicationId: z.string().min(1),
  collectorApiKey: z.string().min(1),
  attachToken: z.string().min(1),
  verificationCapability: z.object({
    token: z.string().min(20),
    expiresAt: z.string().datetime(),
  }),
  verification: z
    .object({
      verificationId: z.string().uuid(),
      generation: z.string().uuid(),
      bindingId: z.string().uuid().optional(),
      loopId: z.string().optional(),
      cycleId: z.string().uuid().optional(),
      cycleNumber: z.number().int().positive().optional(),
      lifecycleVersion: z.number().int().nonnegative(),
      mission: z.string().optional(),
      targetUrl: z.string().url().optional(),
      harness: z.object({ name: z.string().optional() }).passthrough().optional(),
      harnessDelivery: z
        .object({
          state: z.enum(['waiting', 'preparing', 'available', 'acknowledged', 'failed']),
        })
        .passthrough()
        .optional(),
    })
    .passthrough(),
});

const desktopHandoffSchema = desktopCaptureResolutionSchema.extend({
  recordingUrl: z.string().url().max(16_384).optional(),
  recordingExpiresAt: z.coerce.date().optional(),
});

export type ResolvedDesktopHandoff = DesktopCaptureResolution & {
  recordingUrl?: string;
  recordingExpiresAt?: Date;
};

export interface SecretWebAuthorization {
  safeContext: SafeWebContext;
  collectorApiKey: string;
  attachToken: string;
  verificationToken: string;
  verificationExpiresAt: string;
  mission: string;
}

type Json = Record<string, unknown>;
const MAX_CONTROL_RESPONSE_BYTES = 2 * 1024 * 1024;

function messageFrom(value: unknown, fallback: string): string {
  if (!value || typeof value !== 'object') return fallback;
  const record = value as Record<string, unknown>;
  if (typeof record.message === 'string') return redactText(record.message);
  if (typeof record.error === 'string') return redactText(record.error);
  if (record.error && typeof record.error === 'object') {
    const message = (record.error as Record<string, unknown>).message;
    if (typeof message === 'string') return redactText(message);
  }
  return fallback;
}

async function boundedJson(response: Response): Promise<Json> {
  const declaredSize = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredSize) && declaredSize > MAX_CONTROL_RESPONSE_BYTES) {
    throw new Error('A resposta do serviço excedeu o limite permitido.');
  }
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_CONTROL_RESPONSE_BYTES) {
    throw new Error('A resposta do serviço excedeu o limite permitido.');
  }
  if (!text) return {};
  try {
    return JSON.parse(text) as Json;
  } catch {
    return {};
  }
}

async function jsonRequest<T = Json>(
  url: string,
  init: RequestInit,
  unwrap = true,
): Promise<T> {
  const response = await fetch(url, {
    ...init,
    redirect: 'error',
    signal: init.signal ?? AbortSignal.timeout(15_000),
  });
  const payload = await boundedJson(response);
  if (!response.ok) {
    throw new Error(messageFrom(payload, `Voidr API respondeu HTTP ${response.status}`));
  }
  return (unwrap && payload.data !== undefined ? payload.data : payload) as T;
}

export class VoidrServiceClient {
  readonly runtime: LocalRuntimeConfig;

  constructor(runtime: unknown) {
    this.runtime = localRuntimeConfigSchema.parse(runtime);
  }

  async resolveDesktopLaunch(input: unknown): Promise<ResolvedDesktopHandoff> {
    const launch: DesktopCaptureLaunch = desktopCaptureLaunchSchema.parse(input);
    const root = this.runtime.localAdapter ? 'loop-test-dev/scenarios' : 'loop-test/scenarios';
    const value = await jsonRequest<Json>(
      `${this.runtime.serviceUrl}/${root}/${encodeURIComponent(launch.loopId)}` +
        `/cycles/${encodeURIComponent(launch.cycleId)}/capture-handoff`,
      { headers: this.localHeaders(launch.organizationId) },
    );
    const handoff = desktopHandoffSchema.parse(value);
    if (
      handoff.loopId !== launch.loopId ||
      handoff.cycleId !== launch.cycleId ||
      handoff.surface !== launch.surface
    ) {
      throw new Error('O Service retornou um handoff diferente do link solicitado.');
    }
    if (handoff.surface === 'web' && !handoff.recordingUrl) {
      throw new Error('A autorização Web não foi emitida para o Voidr Capture.');
    }
    return handoff;
  }

  async validateWebLaunch(
    launch: SecretLoopLaunch,
    lifecycleGeneration: string,
  ): Promise<SecretWebAuthorization> {
    const value = await jsonRequest<Json>(
      `${this.runtime.serviceUrl}/loop-test/scenarios/recording-token/validate`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scenarioId: launch.scenarioId,
          token: launch.token,
          lifecycleGeneration,
          captureHost: 'voidr_app',
          ...(launch.cycleId ? { cycleId: launch.cycleId } : {}),
        }),
      },
    );
    const validation = validationSchema.parse(value);
    const verification = validation.verification;
    const cycleId = verification.cycleId ?? launch.cycleId ?? verification.verificationId;
    return {
      safeContext: {
        scenarioId: validation.scenarioId,
        cycleId,
        lifecycleGeneration,
        safeTargetUrl: launch.safeUrl,
        scenarioName: validation.scenarioName,
        applicationId: validation.applicationId,
        verificationId: verification.verificationId,
        verificationGeneration: verification.generation,
        lifecycleVersion: verification.lifecycleVersion,
        ...(verification.cycleNumber ? { cycleNumber: verification.cycleNumber } : {}),
        ...(verification.harness?.name ? { harnessName: verification.harness.name } : {}),
        ...(verification.harnessDelivery?.state
          ? { harnessDeliveryState: verification.harnessDelivery.state }
          : {}),
      },
      collectorApiKey: validation.collectorApiKey,
      attachToken: validation.attachToken,
      verificationToken: validation.verificationCapability.token,
      verificationExpiresAt: validation.verificationCapability.expiresAt,
      mission: verification.mission ?? validation.scenarioName,
    };
  }

  async attachWebSession(
    authorization: SecretWebAuthorization,
    sessionId: string,
  ): Promise<Json> {
    const context = authorization.safeContext;
    return jsonRequest(
      `${this.runtime.serviceUrl}/loop-test/scenarios/${encodeURIComponent(context.scenarioId)}/sessions`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          token: authorization.attachToken,
          lifecycleGeneration: context.lifecycleGeneration,
          attemptIndex: 1,
        }),
      },
    );
  }

  async verificationIngest(
    authorization: SecretWebAuthorization,
    endpoint: 'lifecycle-events' | 'annotations' | 'evidence-assets' | 'voice-segments' | 'seal',
    body: Json,
  ): Promise<Json> {
    const result = await jsonRequest<Json>(
      `${this.runtime.serviceUrl}/verification-ingest/verifications/${encodeURIComponent(authorization.safeContext.verificationId)}/${endpoint}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${authorization.verificationToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    );
    const lifecycleVersion = Number(
      result.lifecycleVersion ??
        (result.verification as Record<string, unknown> | undefined)?.lifecycleVersion,
    );
    if (Number.isInteger(lifecycleVersion) && lifecycleVersion >= 0) {
      authorization.safeContext.lifecycleVersion = lifecycleVersion;
    }
    return result;
  }

  async waitForCollectorReadiness(
    sessionId: string,
    collectorApiKey: string,
    sealedThrough: number,
    timeoutMs = 25_000,
  ): Promise<number> {
    const init = await jsonRequest<Json>(
      `${this.runtime.collectorUrl}/init`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: collectorApiKey }),
      },
      false,
    );
    const token =
      (typeof init.token === 'string' && init.token) ||
      (typeof (init.data as Json | undefined)?.token === 'string' &&
        ((init.data as Json).token as string));
    if (!token) throw new Error('O Collector não emitiu uma autorização de leitura.');

    const deadline = Date.now() + timeoutMs;
    let lastStatus = 'pending';
    while (Date.now() < deadline) {
      const response = await fetch(
        `${this.runtime.collectorUrl}/sessions/${encodeURIComponent(sessionId)}/ensure-indexed`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ budgetMs: 1_500 }),
          redirect: 'error',
          signal: AbortSignal.timeout(5_000),
        },
      );
      const value = await boundedJson(response);
      lastStatus = typeof value.status === 'string' ? value.status : lastStatus;
      const readiness = value.readinessToken as Json | undefined;
      const indexedThrough = Number(readiness?.indexedThrough ?? value.indexedThrough);
      if (
        response.ok &&
        ['ready', 'indexed'].includes(lastStatus) &&
        Number.isInteger(indexedThrough) &&
        indexedThrough >= sealedThrough
      ) {
        return indexedThrough;
      }
      if (response.status === 409 && lastStatus === 'failed') {
        throw new Error(messageFrom(value, 'A indexação da Session falhou.'));
      }
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
    throw new Error(`A indexação não confirmou o watermark (${lastStatus}).`);
  }

  async getVerificationStatus(verificationId: string): Promise<Json> {
    return jsonRequest(
      `${this.runtime.serviceUrl}/verification-dev/verifications/${encodeURIComponent(verificationId)}/status`,
      { headers: this.localHeaders() },
    );
  }

  async listLocalVerifications(): Promise<Json[]> {
    return jsonRequest<Json[]>(`${this.runtime.serviceUrl}/verification-dev/verifications?limit=50`, {
      headers: this.localHeaders(),
    });
  }

  async attachMobileSession(input: unknown): Promise<Json> {
    const parsed: MobileAttachInput = mobileAttachInputSchema.parse(input);
    return jsonRequest(
      `${this.runtime.serviceUrl}/verification-dev/verifications/${encodeURIComponent(parsed.verificationId)}/mobile-session`,
      {
        method: 'POST',
        headers: { ...this.localHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lifecycleVersion: parsed.lifecycleVersion,
          idempotencyKey: `desktop-mobile-attach:${parsed.verificationId}:${parsed.sessionId}`,
          sessionId: parsed.sessionId,
        }),
      },
    );
  }

  async doctor(): Promise<
    Array<{ service: string; url: string; ok: boolean; latencyMs: number; detail: string }>
  > {
    const checks = [
      ['Service', `${this.runtime.serviceUrl.replace(/\/v1\/?$/, '')}/health`],
      ['Collector', `${this.runtime.collectorUrl}/health`],
      ['Collector script', this.runtime.collectorScriptUrl],
      ['Platform', this.runtime.platformUrl],
    ] as const;
    return Promise.all(
      checks.map(async ([service, url]) => {
        const started = Date.now();
        try {
          const response = await fetch(url, {
            signal: AbortSignal.timeout(4_000),
            redirect: 'error',
            cache: 'no-store',
          });
          return {
            service,
            url,
            ok: response.ok,
            latencyMs: Date.now() - started,
            detail: response.ok ? `HTTP ${response.status}` : `HTTP ${response.status}`,
          };
        } catch (error) {
          return {
            service,
            url,
            ok: false,
            latencyMs: Date.now() - started,
            detail: error instanceof Error ? redactText(error.message) : 'indisponível',
          };
        }
      }),
    );
  }

  private localHeaders(organizationId = this.runtime.organizationId): Record<string, string> {
    if (!this.runtime.localAdapter) return {};
    return {
      'x-voidr-dev-key': this.runtime.localDevKey,
      'x-voidr-organization-id': organizationId,
    };
  }
}
