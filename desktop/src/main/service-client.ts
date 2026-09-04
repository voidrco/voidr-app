import { z } from "zod";
import {
  desktopCaptureLaunchSchema,
  desktopCaptureResolutionSchema,
  desktopLoopCycleDetailSchema,
  desktopLoopCycleSummarySchema,
  desktopLoopSummarySchema,
  desktopWorkspaceIdentitySchema,
  localRuntimeConfigSchema,
  mobileAttachInputSchema,
  redactText,
  type DesktopCaptureLaunch,
  type DesktopCaptureResolution,
  type DesktopCycleParticipant,
  type DesktopLoopApplicationType,
  type DesktopLoopCycleDetail,
  type DesktopLoopCycleSummary,
  type DesktopLoopEvidenceItem,
  type DesktopLoopSummary,
  type DesktopLoopWorkspaceState,
  type DesktopWorkspaceIdentity,
  type LocalRuntimeConfig,
  type MobileAttachInput,
  type SafeWebContext,
} from "@voidr/capture-contracts";
import { parseDesktopCaptureLaunch, type SecretLoopLaunch } from "./deep-link";

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
      participant: z
        .object({
          name: z.string().optional(),
          email: z.string().optional(),
          role: z.string().optional(),
          picture: z.string().optional(),
        })
        .passthrough()
        .nullish(),
      createdAt: z.string().datetime().optional(),
      harness: z
        .object({ name: z.string().optional() })
        .passthrough()
        .nullish(),
      harnessDelivery: z
        .object({
          state: z.enum([
            "waiting",
            "preparing",
            "available",
            "acknowledged",
            "failed",
          ]),
        })
        .passthrough()
        .nullish(),
    })
    .passthrough(),
});

const captureCompatibilitySchema = z.object({
  status: z.enum(["current", "update_available", "blocked"]),
  compatible: z.boolean(),
  updateAvailable: z.boolean(),
  appVersion: z.string(),
  latestVersion: z.string(),
  minimumSupportedVersion: z.string(),
  hostProtocol: z.string(),
  collectorContract: z.object({
    readinessMethod: z.literal("isCaptureReady"),
    version: z.number().int().positive(),
  }),
  environment: z.enum(["preview", "production"]),
});

const captureDownloadSchema = z.object({
  url: z.string().url(),
  filename: z.string().min(1).max(200),
  version: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  expiresAt: z.coerce.date(),
});

export type CaptureCompatibility = z.infer<typeof captureCompatibilitySchema>;
export type CaptureUpdateDownload = z.infer<typeof captureDownloadSchema>;

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
const VOICE_INGEST_TIMEOUT_MS = 75_000;
const COLLECTOR_INDEX_BUDGET_MS = 1_500;
const COLLECTOR_INDEX_REQUEST_TIMEOUT_MS = 5_000;
const COLLECTOR_INDEX_POLL_INTERVAL_MS = 750;

export class VoidrApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "VoidrApiError";
  }
}

function record(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : {};
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown, fallback = "", maxLength = 4_000): string {
  return typeof value === "string"
    ? redactText(value).trim().slice(0, maxLength)
    : fallback;
}

function integerValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function isoDate(value: unknown): string | null {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
    return null;
  return new Date(value).toISOString();
}

function applicationType(value: unknown): DesktopLoopApplicationType {
  return ["WEB", "MOBILE", "API", "VOICE"].includes(String(value).toUpperCase())
    ? (String(value).toUpperCase() as DesktopLoopApplicationType)
    : "WEB";
}

function loopWorkspaceState(value: unknown): DesktopLoopWorkspaceState {
  const normalized = String(value);
  if (["recording", "processing", "prepared"].includes(normalized))
    return "collecting";
  if (
    ["ready", "decision_required", "fix_proposed", "awaiting_retest"].includes(
      normalized,
    )
  ) {
    return "ready_to_review";
  }
  if (normalized === "confirmed") return "ready_to_resolve";
  if (normalized === "failed") return "attention";
  return [
    "waiting_for_tests",
    "collecting",
    "ready_to_review",
    "ready_to_resolve",
    "attention",
  ].includes(normalized)
    ? (normalized as DesktopLoopWorkspaceState)
    : "waiting_for_tests";
}

function participantName(value: unknown): string | null {
  const participant = record(value);
  return (
    stringValue(participant.name, "", 160) ||
    stringValue(participant.email, "", 160) ||
    stringValue(participant.actorName, "", 160) ||
    null
  );
}

function participantAvatarUrl(value: unknown): string | null {
  const picture = stringValue(record(value).picture, "", 16_384);
  if (!picture) return null;
  try {
    const url = new URL(picture);
    return ["https:", "http:"].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

function participantRole(value: unknown): string | null {
  return stringValue(record(value).role, "", 120) || null;
}

function participantIdentity(value: unknown): DesktopCycleParticipant | null {
  const name = participantName(value);
  if (!name) return null;
  return {
    name,
    role: participantRole(value),
    picture: participantAvatarUrl(value),
  };
}

function evidenceKind(value: unknown): DesktopLoopEvidenceItem["kind"] {
  const kind = String(value).toLowerCase();
  if (kind === "recording" || kind === "replay") return "replay";
  if (kind === "annotation") return "annotation";
  if (kind === "screenshot" || kind === "frame" || kind === "crop")
    return "screenshot";
  if (kind === "network" || kind === "request") return "network";
  if (kind === "console" || kind === "console_error") return "console";
  if (kind === "transcript" || kind === "voice") return "transcript";
  return "action";
}

function evidenceTone(
  kind: DesktopLoopEvidenceItem["kind"],
  label: string,
): DesktopLoopEvidenceItem["tone"] {
  if (kind === "console" || /\b(?:4\d\d|5\d\d|fail|error)\b/i.test(label))
    return "error";
  if (kind === "annotation" || kind === "transcript") return "warning";
  if (kind === "replay" || kind === "screenshot") return "success";
  return "neutral";
}

function messageFrom(value: unknown, fallback: string): string {
  if (!value || typeof value !== "object") return fallback;
  const record = value as Record<string, unknown>;
  if (typeof record.message === "string") return redactText(record.message);
  if (typeof record.error === "string") return redactText(record.error);
  if (record.error && typeof record.error === "object") {
    const message = (record.error as Record<string, unknown>).message;
    if (typeof message === "string") return redactText(message);
  }
  return fallback;
}

async function boundedJson(response: Response): Promise<Json> {
  const declaredSize = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declaredSize) &&
    declaredSize > MAX_CONTROL_RESPONSE_BYTES
  ) {
    throw new Error("A resposta do serviço excedeu o limite permitido.");
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_CONTROL_RESPONSE_BYTES) {
    throw new Error("A resposta do serviço excedeu o limite permitido.");
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
    redirect: "error",
    signal: init.signal ?? AbortSignal.timeout(15_000),
  });
  const payload = await boundedJson(response);
  if (!response.ok) {
    throw new VoidrApiError(
      messageFrom(payload, `Voidr API respondeu HTTP ${response.status}`),
      response.status,
    );
  }
  return (unwrap && payload.data !== undefined ? payload.data : payload) as T;
}

export class VoidrServiceClient {
  readonly runtime: LocalRuntimeConfig;

  constructor(runtime: unknown) {
    this.runtime = localRuntimeConfigSchema.parse(runtime);
  }

  async workspaceIdentity(
    remoteAccessToken: string,
  ): Promise<DesktopWorkspaceIdentity> {
    const value = await jsonRequest<Json>(
      `${this.runtime.serviceUrl}/auth/me`,
      {
        headers: { Authorization: `Bearer ${remoteAccessToken}` },
      },
    );
    const organization = record(value.organization);
    const organizationId = stringValue(
      value.organizationId ?? organization.id,
      "",
      200,
    );
    const email = stringValue(value.email, "", 320);
    return desktopWorkspaceIdentitySchema.parse({
      organizationId,
      name: stringValue(
        organization.displayName ??
          organization.display_name ??
          organization.name,
        organizationId,
        200,
      ),
      logoUrl: participantAvatarUrl({ picture: value.logoUrl }),
      user: {
        name: stringValue(value.name, email, 200),
        email,
        picture: participantAvatarUrl(value),
      },
    });
  }

  async listLoops(remoteAccessToken?: string): Promise<DesktopLoopSummary[]> {
    const values = await jsonRequest<unknown[]>(
      `${this.runtime.serviceUrl}/${this.loopRoot()}`,
      {
        headers: this.workspaceHeaders(remoteAccessToken),
      },
    );
    return values.map((value) => {
      const item = record(value);
      const latest = record(item.latestCycle);
      const workspace = record(item.workspace);
      const workspaceCounts = record(workspace.counts);
      const testCounts = record(workspaceCounts.tests);
      const participants = list(workspace.participants)
        .slice(0, 100)
        .map((raw, index) => {
          const participant = record(raw);
          return {
            id: stringValue(participant.id, `participant-${index + 1}`, 200),
            name: participantName(participant) ?? `Participante ${index + 1}`,
            role: participantRole(participant),
            picture: participantAvatarUrl(participant),
          };
        });
      const testCount = integerValue(testCounts.total ?? item.cycle);
      return desktopLoopSummarySchema.parse({
        id: stringValue(item.id),
        name: stringValue(item.name, "Loop sem nome", 300),
        applicationId: stringValue(item.applicationId),
        applicationType: applicationType(item.applicationType),
        targetUrl: stringValue(item.targetUrl),
        environment: stringValue(
          item.environmentSlug ?? item.environment,
          "default",
        ),
        status: stringValue(item.status, "recording", 80),
        cycleCount: testCount,
        sessionsRecorded: integerValue(item.sessionsRecorded),
        workspaceState: loopWorkspaceState(
          workspace.state ?? latest.status ?? item.status,
        ),
        testCount,
        participantCount: integerValue(workspaceCounts.participants),
        evidenceCount: integerValue(workspaceCounts.evidence),
        participants,
        updatedAt: isoDate(item.updatedAt),
        latestCycle: item.latestCycle
          ? {
              id: stringValue(latest.id),
              number: Math.max(1, integerValue(latest.number)),
              status: stringValue(latest.status, "recording", 80),
              updatedAt: isoDate(latest.updatedAt),
            }
          : null,
      });
    });
  }

  async listLoopCycles(
    loopId: string,
    remoteAccessToken?: string,
  ): Promise<DesktopLoopCycleSummary[]> {
    const safeLoopId = z.string().trim().min(1).max(200).parse(loopId);
    const values = await jsonRequest<unknown[]>(
      `${this.runtime.serviceUrl}/${this.loopRoot()}/${encodeURIComponent(safeLoopId)}/cycles`,
      { headers: this.workspaceHeaders(remoteAccessToken) },
    );
    return values.map((value) => {
      const item = record(value);
      return desktopLoopCycleSummarySchema.parse({
        id: stringValue(item.cycleId ?? item.verificationId),
        loopId: stringValue(item.loopId, safeLoopId),
        number: Math.max(1, integerValue(item.cycleNumber)),
        status: stringValue(item.visibleStatus ?? item.status, "recording", 80),
        mission: stringValue(
          item.mission,
          "Executar a jornada definida para este Loop",
          1_000,
        ),
        environment: stringValue(item.environment, "default"),
        applicationType: applicationType(item.applicationType),
        participant: participantName(item.participant),
        participantRole: participantRole(item.participant),
        participantAvatarUrl: participantAvatarUrl(item.participant),
        artifactReady: item.artifactReady === true,
        diagnosisReady: item.diagnosisReady === true,
        updatedAt: isoDate(item.updatedAt),
        createdAt: isoDate(item.createdAt),
      });
    });
  }

  async getLoopCycle(
    loopId: string,
    cycleId: string,
    remoteAccessToken?: string,
  ): Promise<DesktopLoopCycleDetail> {
    const safeLoopId = z.string().trim().min(1).max(200).parse(loopId);
    const safeCycleId = z.string().uuid().parse(cycleId);
    const value = await jsonRequest<Json>(
      `${this.runtime.serviceUrl}/${this.loopRoot()}/${encodeURIComponent(safeLoopId)}` +
        `/cycles/${encodeURIComponent(safeCycleId)}`,
      { headers: this.workspaceHeaders(remoteAccessToken) },
    );
    const context = record(value.context);
    const counts = record(context.counts);
    const replayAvailable = record(context.replay).available === true;
    const evidence = list(context.evidence ?? value.evidence)
      .slice(0, 200)
      .filter(
        (raw) => evidenceKind(record(raw).kind) !== "replay" || replayAvailable,
      )
      .map((raw, index) => {
        const item = record(raw);
        const kind = evidenceKind(item.kind);
        const rawTitle = stringValue(
          item.label,
          kind === "replay" ? "Replay do teste" : "Evidência",
          240,
        );
        const title =
          kind === "replay" &&
          /^(?:session replay|replay da sessão)$/i.test(rawTitle)
            ? "Replay do teste"
            : rawTitle;
        const detail = stringValue(item.detail || item.note, "", 1_000) || null;
        return {
          id: `${kind}-${index + 1}`,
          kind,
          atMs: item.atMs == null ? null : integerValue(item.atMs),
          title,
          detail,
          tone: evidenceTone(kind, `${title} ${detail ?? ""}`),
        } satisfies DesktopLoopEvidenceItem;
      });
    return desktopLoopCycleDetailSchema.parse({
      loopId: stringValue(value.loopId, safeLoopId),
      cycleId: stringValue(value.id, safeCycleId),
      cycleNumber: Math.max(
        1,
        integerValue(value.number ?? context.cycleNumber),
      ),
      durationMs: integerValue(context.durationMs),
      replayAvailable,
      counts: {
        annotations: integerValue(counts.annotations),
        actions: integerValue(counts.actions),
        consoleErrors: integerValue(counts.consoleErrors),
        failedRequests: integerValue(counts.failedRequests),
        transcriptSegments: integerValue(counts.transcriptSegments),
      },
      evidence,
    });
  }

  async prepareLoopCycle(
    loopId: string,
    remoteAccessToken?: string,
  ): Promise<DesktopCaptureLaunch> {
    const safeLoopId = z.string().trim().min(1).max(200).parse(loopId);
    const value = await jsonRequest<Json>(
      `${this.runtime.serviceUrl}/${this.loopRoot()}/${encodeURIComponent(safeLoopId)}/capture`,
      {
        method: "POST",
        headers: {
          ...this.workspaceHeaders(remoteAccessToken),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ idempotencyKey: crypto.randomUUID() }),
      },
    );
    return parseDesktopCaptureLaunch(stringValue(value.launchUrl));
  }

  async resolveDesktopLaunch(
    input: unknown,
    remoteAccessToken?: string,
  ): Promise<ResolvedDesktopHandoff> {
    const launch: DesktopCaptureLaunch =
      desktopCaptureLaunchSchema.parse(input);
    const participant = launch.access === "participant";
    if (!this.runtime.localAdapter && !remoteAccessToken) {
      throw new Error(
        "A conta Google precisa ser confirmada antes de iniciar este teste.",
      );
    }
    const endpoint = participant
      ? `loop-participant/captures/${encodeURIComponent(launch.loopId)}/${encodeURIComponent(launch.cycleId)}`
      : `${this.runtime.localAdapter ? "loop-test-dev/scenarios" : "loop-test/scenarios"}/${encodeURIComponent(launch.loopId)}` +
        `/cycles/${encodeURIComponent(launch.cycleId)}/capture-handoff`;
    const value = await jsonRequest<Json>(
      `${this.runtime.serviceUrl}/${endpoint}`,
      {
        headers: this.runtime.localAdapter
          ? this.localHeaders(launch.organizationId)
          : { Authorization: `Bearer ${remoteAccessToken}` },
      },
    );
    const handoff = desktopHandoffSchema.parse({
      ...value,
      roundId: launch.roundId,
      assignmentId: launch.assignmentId,
      participant: participantIdentity(value.participant),
      cycleStartedAt: isoDate(value.cycleStartedAt),
    });
    if (
      handoff.loopId !== launch.loopId ||
      handoff.cycleId !== launch.cycleId ||
      handoff.surface !== launch.surface
    ) {
      throw new Error(
        "O Service retornou um handoff diferente do link solicitado.",
      );
    }
    if (handoff.surface === "web" && !handoff.recordingUrl) {
      throw new Error(
        "A autorização Web não foi emitida para o Voidr Capture.",
      );
    }
    return handoff;
  }

  async claimDesktopLaunch(
    launchInput: unknown,
    app: {
      appVersion: string;
      appPlatform: 'darwin' | 'win32' | 'linux';
      appArch: string;
    },
    remoteAccessToken?: string,
  ): Promise<void> {
    const launch = desktopCaptureLaunchSchema.parse(launchInput);
    // Participant acknowledgment will use its dedicated narrow controller in
    // the next compatibility slice. Old launch descriptors also remain valid.
    if (!launch.attemptId || launch.access === 'participant') return;
    await jsonRequest(
      `${this.runtime.serviceUrl}/${this.loopRoot()}/${encodeURIComponent(launch.loopId)}` +
        `/cycles/${encodeURIComponent(launch.cycleId)}/capture-attempts/${encodeURIComponent(launch.attemptId)}/claim`,
      {
        method: 'POST',
        headers: {
          ...this.workspaceHeaders(remoteAccessToken),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(app),
      },
    );
  }

  async reportDesktopLaunchState(
    launchInput: unknown,
    state:
      | 'preparing'
      | 'recording'
      | 'finalizing'
      | 'processing'
      | 'ready_for_review'
      | 'recoverable_error'
      | 'terminal_error',
    remoteAccessToken?: string,
    errorCode?: string,
  ): Promise<void> {
    const launch = desktopCaptureLaunchSchema.parse(launchInput);
    if (!launch.attemptId || launch.access === 'participant') return;
    await jsonRequest(
      `${this.runtime.serviceUrl}/${this.loopRoot()}/${encodeURIComponent(launch.loopId)}` +
        `/cycles/${encodeURIComponent(launch.cycleId)}/capture-attempts/${encodeURIComponent(launch.attemptId)}/events`,
      {
        method: 'POST',
        headers: {
          ...this.workspaceHeaders(remoteAccessToken),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ state, ...(errorCode ? { errorCode } : {}) }),
      },
    );
  }

  async validateWebLaunch(
    launch: SecretLoopLaunch,
    lifecycleGeneration: string,
  ): Promise<SecretWebAuthorization> {
    const value = await jsonRequest<Json>(
      `${this.runtime.serviceUrl}/loop-test/scenarios/recording-token/validate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scenarioId: launch.scenarioId,
          token: launch.token,
          lifecycleGeneration,
          captureHost: "voidr_app",
          ...(launch.cycleId ? { cycleId: launch.cycleId } : {}),
        }),
      },
    );
    const validation = validationSchema.parse(value);
    const verification = validation.verification;
    const cycleId =
      verification.cycleId ?? launch.cycleId ?? verification.verificationId;
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
        ...(verification.cycleNumber
          ? { cycleNumber: verification.cycleNumber }
          : {}),
        ...(verification.participant
          ? { participant: participantIdentity(verification.participant) }
          : {}),
        ...(verification.createdAt
          ? { cycleStartedAt: verification.createdAt }
          : {}),
        ...(verification.harness?.name
          ? { harnessName: verification.harness.name }
          : {}),
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
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
    endpoint:
      | "lifecycle-events"
      | "annotations"
      | "evidence-assets"
      | "voice-segments"
      | "seal",
    body: Json,
  ): Promise<Json> {
    const result = await jsonRequest<Json>(
      `${this.runtime.serviceUrl}/verification-ingest/verifications/${encodeURIComponent(authorization.safeContext.verificationId)}/${endpoint}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${authorization.verificationToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        ...(endpoint === "voice-segments"
          ? { signal: AbortSignal.timeout(VOICE_INGEST_TIMEOUT_MS) }
          : {}),
      },
    );
    const lifecycleVersion = Number(
      result.lifecycleVersion ??
        (result.verification as Record<string, unknown> | undefined)
          ?.lifecycleVersion,
    );
    if (Number.isInteger(lifecycleVersion) && lifecycleVersion >= 0) {
      authorization.safeContext.lifecycleVersion = Math.max(
        authorization.safeContext.lifecycleVersion,
        lifecycleVersion,
      );
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
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: collectorApiKey }),
      },
      false,
    );
    const token =
      (typeof init.token === "string" && init.token) ||
      (typeof (init.data as Json | undefined)?.token === "string" &&
        ((init.data as Json).token as string));
    if (!token)
      throw new Error("O Collector não emitiu uma autorização de leitura.");

    const deadline = Date.now() + timeoutMs;
    let lastStatus = "pending";
    while (Date.now() < deadline) {
      let response: Response;
      try {
        response = await fetch(
          `${this.runtime.collectorUrl}/sessions/${encodeURIComponent(sessionId)}/ensure-indexed?budgetMs=${COLLECTOR_INDEX_BUDGET_MS}`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            // Keep the body for compatibility with collector revisions that
            // accepted the budget there. The current endpoint reads the query.
            body: JSON.stringify({ budgetMs: COLLECTOR_INDEX_BUDGET_MS }),
            redirect: "error",
            signal: AbortSignal.timeout(COLLECTOR_INDEX_REQUEST_TIMEOUT_MS),
          },
        );
      } catch (error) {
        // A claimed ingest can outlive one HTTP request while continuing on
        // the server. Treat that request timeout/network interruption as a
        // polling miss and keep checking until the outer readiness budget.
        lastStatus =
          error instanceof Error && error.name === "TimeoutError"
            ? "request-timeout"
            : "request-error";
        await new Promise((resolve) =>
          setTimeout(resolve, COLLECTOR_INDEX_POLL_INTERVAL_MS),
        );
        continue;
      }
      const value = await boundedJson(response);
      lastStatus = typeof value.status === "string" ? value.status : lastStatus;
      const readiness = value.readinessToken as Json | undefined;
      const indexedThrough = Number(
        readiness?.indexedThrough ?? value.indexedThrough,
      );
      const indexVersion = Number(
        readiness?.indexVersion ?? value.indexVersion ?? value.ingestVersion,
      );
      if (
        response.ok &&
        ["ready", "indexed"].includes(lastStatus) &&
        ((Number.isInteger(indexedThrough) &&
          indexedThrough >= sealedThrough) ||
          // Compatibility with collector revisions that return a successful
          // terminal index version but omit the redundant watermark fields.
          // The desktop already holds the durable seal receipt for this exact
          // session, so a positive terminal index version is authoritative.
          (!Number.isFinite(indexedThrough) &&
            lastStatus === "indexed" &&
            Number.isInteger(indexVersion) &&
            indexVersion > 0))
      ) {
        return Number.isFinite(indexedThrough) ? indexedThrough : sealedThrough;
      }
      if (response.status === 409 && lastStatus === "failed") {
        throw new Error(messageFrom(value, "A indexação da Session falhou."));
      }
      await new Promise((resolve) =>
        setTimeout(resolve, COLLECTOR_INDEX_POLL_INTERVAL_MS),
      );
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
    return jsonRequest<Json[]>(
      `${this.runtime.serviceUrl}/verification-dev/verifications?limit=50`,
      {
        headers: this.localHeaders(),
      },
    );
  }

  async attachMobileSession(input: unknown): Promise<Json> {
    const parsed: MobileAttachInput = mobileAttachInputSchema.parse(input);
    return jsonRequest(
      `${this.runtime.serviceUrl}/verification-dev/verifications/${encodeURIComponent(parsed.verificationId)}/mobile-session`,
      {
        method: "POST",
        headers: { ...this.localHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          lifecycleVersion: parsed.lifecycleVersion,
          idempotencyKey: `desktop-mobile-attach:${parsed.verificationId}:${parsed.sessionId}`,
          sessionId: parsed.sessionId,
        }),
      },
    );
  }

  async doctor(): Promise<
    Array<{
      service: string;
      url: string;
      ok: boolean;
      latencyMs: number;
      detail: string;
    }>
  > {
    const checks = [
      ["Service", `${this.runtime.serviceUrl.replace(/\/v1\/?$/, "")}/health`],
      ["Collector", `${this.runtime.collectorUrl}/health`],
      ["Collector script", this.runtime.collectorScriptUrl],
      ["Platform", this.runtime.platformUrl],
    ] as const;
    return Promise.all(
      checks.map(async ([service, url]) => {
        const started = Date.now();
        try {
          const response = await fetch(url, {
            signal: AbortSignal.timeout(4_000),
            redirect: "error",
            cache: "no-store",
          });
          let detail = `HTTP ${response.status}`;
          let ok = response.ok;
          if (ok && service === "Collector script") {
            const source = await response.text();
            ok = source.includes("isCaptureReady");
            detail = ok
              ? "Contrato isCaptureReady disponível"
              : "Collector incompatível: isCaptureReady ausente";
          }
          return {
            service,
            url,
            ok,
            latencyMs: Date.now() - started,
            detail,
          };
        } catch (error) {
          return {
            service,
            url,
            ok: false,
            latencyMs: Date.now() - started,
            detail:
              error instanceof Error
                ? redactText(error.message)
                : "indisponível",
          };
        }
      }),
    );
  }

  async captureCompatibility(
    appVersion: string,
    hostProtocol: string,
  ): Promise<CaptureCompatibility> {
    const query = new URLSearchParams({ appVersion, hostProtocol });
    const value = await jsonRequest(
      `${this.runtime.serviceUrl}/capture/compatibility?${query.toString()}`,
      { method: "GET" },
    );
    return captureCompatibilitySchema.parse(value);
  }

  async captureUpdateDownload(
    platform: "mac" | "windows" | "linux",
    arch: "arm64" | "x64",
    accessToken: string,
  ): Promise<CaptureUpdateDownload> {
    const query = new URLSearchParams({ platform, arch });
    const value = await jsonRequest(
      `${this.runtime.serviceUrl}/capture/download?${query.toString()}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    );
    return captureDownloadSchema.parse(value);
  }

  private localHeaders(
    organizationId = this.runtime.organizationId,
  ): Record<string, string> {
    if (!this.runtime.localAdapter) return {};
    return {
      "x-voidr-dev-key": this.runtime.localDevKey,
      "x-voidr-organization-id": organizationId,
    };
  }

  private workspaceHeaders(remoteAccessToken?: string): Record<string, string> {
    if (this.runtime.localAdapter) return this.localHeaders();
    if (!remoteAccessToken) {
      throw new Error(
        "Conecte sua conta Voidr antes de carregar este workspace.",
      );
    }
    return { Authorization: `Bearer ${remoteAccessToken}` };
  }

  private loopRoot(): string {
    return this.runtime.localAdapter
      ? "loop-test-dev/scenarios"
      : "loop-test/scenarios";
  }
}
