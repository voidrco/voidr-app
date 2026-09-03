import { z } from "zod";

export const CAPTURE_HOST_VERSION = "CAPTURE-HOST/1" as const;
export const VOIDR_CAPTURE_LAUNCH_VERSION = "VOIDR-CAPTURE-LAUNCH/1" as const;
export const VOIDR_WORKSPACE_LINK_VERSION = "VOIDR-WORKSPACE-LINK/1" as const;
export const PENDING_CAPTURE_ORGANIZATION_ID = "org_pending_launch" as const;

const boundedId = z.string().trim().min(1).max(200);
const opaqueId = z.string().uuid();

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "::1" ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized)
  );
}

export function isTrustedWebUrl(
  input: string,
  allowLoopbackHttp = true,
): boolean {
  try {
    const url = new URL(input);
    if (url.username || url.password) return false;
    if (url.protocol === "https:") return true;
    return (
      allowLoopbackHttp &&
      url.protocol === "http:" &&
      isLoopbackHostname(url.hostname)
    );
  } catch {
    return false;
  }
}

const trustedWebUrlSchema = z
  .string()
  .url()
  .max(16_384)
  .refine(
    (value) => isTrustedWebUrl(value),
    "Use HTTPS ou HTTP em loopback, sem credenciais na URL.",
  );

export const capturePlatformSchema = z.enum(["web", "android", "ios", "api"]);
export type CapturePlatform = z.infer<typeof capturePlatformSchema>;

export const desktopCaptureSurfaceSchema = z.enum(["web", "mobile", "api"]);
export type DesktopCaptureSurface = z.infer<typeof desktopCaptureSurfaceSchema>;

export const harnessDeliveryStateSchema = z.enum([
  "waiting",
  "preparing",
  "available",
  "acknowledged",
  "failed",
]);
export type HarnessDeliveryState = z.infer<typeof harnessDeliveryStateSchema>;

/**
 * Secret-free descriptor transported by the operating-system protocol handler.
 * Authorization is resolved by the signed-in app (or the explicit localhost
 * adapter) after launch; the URI itself never grants access to a Cycle.
 */
export const desktopCaptureLaunchSchema = z
  .object({
    version: z.literal(VOIDR_CAPTURE_LAUNCH_VERSION),
    organizationId: boundedId,
    loopId: boundedId,
    cycleId: opaqueId,
    attemptId: opaqueId.optional(),
    roundId: boundedId.optional(),
    assignmentId: boundedId.optional(),
    surface: desktopCaptureSurfaceSchema,
    access: z.enum(["organization", "participant"]).default("organization"),
    deployment: z
      .enum(["local", "preview", "staging", "production"])
      .default("local"),
    previewSlug: z
      .string()
      .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/)
      .optional(),
  })
  .superRefine((launch, context) => {
    if (launch.deployment === "preview" && !launch.previewSlug) {
      context.addIssue({
        code: "custom",
        path: ["previewSlug"],
        message: "Preview slug is required",
      });
    }
    if (launch.deployment !== "preview" && launch.previewSlug) {
      context.addIssue({
        code: "custom",
        path: ["previewSlug"],
        message: "Preview slug is not allowed",
      });
    }
  });
export type DesktopCaptureLaunch = z.infer<typeof desktopCaptureLaunchSchema>;

/**
 * Secret-free workspace selection sent by the authenticated Web platform to
 * the native app. The URI selects a tenant only; the desktop still proves the
 * user's membership with its own OAuth flow before any workspace data loads.
 */
export const desktopWorkspaceLinkSchema = z
  .object({
    version: z.literal(VOIDR_WORKSPACE_LINK_VERSION),
    organizationId: boundedId.regex(/^org_[A-Za-z0-9]+$/),
    deployment: z.enum(["local", "preview", "staging", "production"]),
    previewSlug: z
      .string()
      .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/)
      .optional(),
  })
  .superRefine((link, context) => {
    if (link.deployment === "preview" && !link.previewSlug) {
      context.addIssue({
        code: "custom",
        path: ["previewSlug"],
        message: "Preview slug is required",
      });
    }
    if (link.deployment !== "preview" && link.previewSlug) {
      context.addIssue({
        code: "custom",
        path: ["previewSlug"],
        message: "Preview slug is not allowed",
      });
    }
  });
export type DesktopWorkspaceLink = z.infer<typeof desktopWorkspaceLinkSchema>;

/** Safe, canonical identity projected by /auth/me after desktop OAuth. */
export const desktopWorkspaceIdentitySchema = z.object({
  organizationId: boundedId,
  name: z.string().trim().min(1).max(200),
  logoUrl: trustedWebUrlSchema.nullable(),
  user: z.object({
    name: z.string().trim().min(1).max(200),
    email: z.string().trim().email().max(320),
    picture: trustedWebUrlSchema.nullable(),
  }),
});
export type DesktopWorkspaceIdentity = z.infer<
  typeof desktopWorkspaceIdentitySchema
>;

/** Canonical Voidr profile projected for a human-owned Cycle. */
export const desktopCycleParticipantSchema = z.object({
  name: z.string().trim().min(1).max(160),
  role: z.string().trim().min(1).max(120).nullable(),
  picture: trustedWebUrlSchema.nullable(),
});
export type DesktopCycleParticipant = z.infer<
  typeof desktopCycleParticipantSchema
>;

/** Safe projection returned to the control renderer after main-process resolution. */
export const desktopCaptureResolutionSchema = z.object({
  version: z.literal(VOIDR_CAPTURE_LAUNCH_VERSION),
  captureAdapter: z.literal("voidr_app"),
  surface: desktopCaptureSurfaceSchema,
  loopId: boundedId,
  cycleId: opaqueId,
  roundId: boundedId.optional(),
  assignmentId: boundedId.optional(),
  cycleNumber: z.number().int().positive(),
  applicationId: boundedId,
  environment: boundedId,
  mission: z.string().trim().min(1).max(1_000),
  targetUrl: trustedWebUrlSchema,
  participant: desktopCycleParticipantSchema.nullable(),
  cycleStartedAt: z.string().datetime(),
  harnessName: z.string().trim().max(120).optional(),
});
export type DesktopCaptureResolution = z.infer<
  typeof desktopCaptureResolutionSchema
>;

export const captureStageSchema = z.enum([
  "idle",
  "preparing",
  "ready",
  "recording",
  "stopping",
  "sealed",
  "attaching",
  "processing",
  "ready_for_review",
  "offline",
  "recoverable_error",
  "terminal_error",
]);
export type CaptureStage = z.infer<typeof captureStageSchema>;

export const captureEnvelopeSchema = z.object({
  version: z.literal(CAPTURE_HOST_VERSION),
  id: opaqueId,
  type: z.enum(["request", "receipt", "event"]),
  command: z.enum([
    "doctor",
    "prepare.web",
    "start.web",
    "stop.web",
    "annotate.element",
    "annotate.screen",
    "mobile.devices",
    "mobile.launch",
    "mobile.session.discover",
    "mobile.session.attach",
    "open.cycle",
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
    for (const key of [
      "serviceUrl",
      "collectorUrl",
      "collectorScriptUrl",
      "platformUrl",
    ] as const) {
      const url = new URL(runtime[key]);
      if (url.search || url.hash) {
        context.addIssue({
          code: "custom",
          path: [key],
          message: "Endpoints não aceitam query ou fragment.",
        });
      }
      if (runtime.localAdapter && !isLoopbackHostname(url.hostname)) {
        context.addIssue({
          code: "custom",
          path: [key],
          message: "O adapter local aceita somente endpoints de loopback.",
        });
      }
      if (!runtime.localAdapter && url.protocol !== "https:") {
        context.addIssue({
          code: "custom",
          path: [key],
          message: "Endpoints remotos exigem HTTPS.",
        });
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
  participant: desktopCycleParticipantSchema.nullable().optional(),
  cycleStartedAt: z.string().datetime().optional(),
  harnessName: z.string().trim().max(120).optional(),
  harnessDeliveryState: harnessDeliveryStateSchema.optional(),
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
  kind: z.enum(["element", "region", "screen"]),
  note: z.string().trim().min(1).max(1000),
});
export type AnnotationInput = z.infer<typeof annotationInputSchema>;

export const capturedSignalCategorySchema = z.enum([
  "pages",
  "clicks",
  "requests",
  "errors",
  "notes",
  "voiceNotes",
]);
export type CapturedSignalCategory = z.infer<
  typeof capturedSignalCategorySchema
>;

/**
 * Small, secret-free projection used by the desktop control surface. Raw
 * headers, bodies, screenshots and replay payloads stay in the evidence
 * stores and are never copied into renderer state.
 */
export const capturedSignalSchema = z.object({
  id: opaqueId,
  category: capturedSignalCategorySchema,
  atMs: z.number().int().nonnegative(),
  title: z.string().trim().min(1).max(240),
  detail: z.string().trim().max(1_000).optional(),
  tone: z.enum(["neutral", "success", "warning", "error"]).default("neutral"),
});
export type CapturedSignal = z.infer<typeof capturedSignalSchema>;

/**
 * Secret-free workspace projections consumed by the desktop Home. The main
 * process deliberately reduces Loop API responses before crossing IPC: the
 * renderer receives product context and evidence labels, never storage refs,
 * signed assets, request payloads or authorization material.
 */
export const desktopLoopApplicationTypeSchema = z.enum([
  "WEB",
  "MOBILE",
  "API",
  "VOICE",
]);
export type DesktopLoopApplicationType = z.infer<
  typeof desktopLoopApplicationTypeSchema
>;

export const desktopLoopCycleStatusSchema = z.string().trim().min(1).max(80);
export type DesktopLoopCycleStatus = z.infer<
  typeof desktopLoopCycleStatusSchema
>;

export const desktopLoopWorkspaceStateSchema = z.enum([
  "waiting_for_tests",
  "collecting",
  "ready_to_review",
  "ready_to_resolve",
  "attention",
]);
export type DesktopLoopWorkspaceState = z.infer<
  typeof desktopLoopWorkspaceStateSchema
>;

export const desktopLoopParticipantSummarySchema = z.object({
  id: boundedId,
  name: z.string().trim().min(1).max(160),
  role: z.string().trim().min(1).max(120).nullable(),
  picture: trustedWebUrlSchema.nullable(),
});
export type DesktopLoopParticipantSummary = z.infer<
  typeof desktopLoopParticipantSummarySchema
>;

export const desktopLoopSummarySchema = z.object({
  id: boundedId,
  name: z.string().trim().min(1).max(300),
  applicationId: boundedId,
  applicationType: desktopLoopApplicationTypeSchema,
  targetUrl: z.string().trim().max(16_384),
  environment: boundedId,
  status: desktopLoopCycleStatusSchema,
  cycleCount: z.number().int().nonnegative(),
  sessionsRecorded: z.number().int().nonnegative(),
  workspaceState: desktopLoopWorkspaceStateSchema,
  testCount: z.number().int().nonnegative(),
  participantCount: z.number().int().nonnegative(),
  evidenceCount: z.number().int().nonnegative(),
  participants: z.array(desktopLoopParticipantSummarySchema).max(100),
  updatedAt: z.string().datetime().nullable(),
  latestCycle: z
    .object({
      id: opaqueId,
      number: z.number().int().positive(),
      status: desktopLoopCycleStatusSchema,
      updatedAt: z.string().datetime().nullable(),
    })
    .nullable(),
});
export type DesktopLoopSummary = z.infer<typeof desktopLoopSummarySchema>;

export const desktopLoopCycleSummarySchema = z.object({
  id: opaqueId,
  loopId: boundedId,
  number: z.number().int().positive(),
  status: desktopLoopCycleStatusSchema,
  mission: z.string().trim().min(1).max(1_000),
  environment: boundedId,
  applicationType: desktopLoopApplicationTypeSchema,
  participant: z.string().trim().min(1).max(160).nullable(),
  participantRole: z.string().trim().min(1).max(120).nullable(),
  participantAvatarUrl: trustedWebUrlSchema.nullable(),
  artifactReady: z.boolean(),
  diagnosisReady: z.boolean(),
  updatedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime().nullable(),
});
export type DesktopLoopCycleSummary = z.infer<
  typeof desktopLoopCycleSummarySchema
>;

export const desktopLoopEvidenceKindSchema = z.enum([
  "replay",
  "annotation",
  "screenshot",
  "network",
  "console",
  "transcript",
  "action",
]);
export type DesktopLoopEvidenceKind = z.infer<
  typeof desktopLoopEvidenceKindSchema
>;

export const desktopLoopEvidenceItemSchema = z.object({
  id: boundedId,
  kind: desktopLoopEvidenceKindSchema,
  atMs: z.number().int().nonnegative().nullable(),
  title: z.string().trim().min(1).max(240),
  detail: z.string().trim().max(1_000).nullable(),
  tone: z.enum(["neutral", "success", "warning", "error"]),
});
export type DesktopLoopEvidenceItem = z.infer<
  typeof desktopLoopEvidenceItemSchema
>;

export const desktopLoopCycleDetailSchema = z.object({
  loopId: boundedId,
  cycleId: opaqueId,
  cycleNumber: z.number().int().positive(),
  durationMs: z.number().int().nonnegative(),
  replayAvailable: z.boolean(),
  counts: z.object({
    annotations: z.number().int().nonnegative(),
    actions: z.number().int().nonnegative(),
    consoleErrors: z.number().int().nonnegative(),
    failedRequests: z.number().int().nonnegative(),
    transcriptSegments: z.number().int().nonnegative(),
  }),
  evidence: z.array(desktopLoopEvidenceItemSchema).max(200),
});
export type DesktopLoopCycleDetail = z.infer<
  typeof desktopLoopCycleDetailSchema
>;

export const androidDeviceSchema = z.object({
  serial: boundedId,
  state: z.enum(["device", "offline", "unauthorized", "unknown"]),
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
  recentSignals: z.array(capturedSignalSchema).max(60).optional(),
  message: z.string().max(500).optional(),
  errorCode: z.string().max(100).optional(),
});
export type CaptureStatus = z.infer<typeof captureStatusSchema>;

export function createEnvelope(
  command: CaptureEnvelope["command"],
  payload: Record<string, unknown>,
  options: Partial<Pick<CaptureEnvelope, "generation" | "type">> = {},
): CaptureEnvelope {
  return captureEnvelopeSchema.parse({
    version: CAPTURE_HOST_VERSION,
    id: crypto.randomUUID(),
    type: options.type ?? "request",
    command,
    generation: options.generation,
    occurredAt: new Date().toISOString(),
    payload,
  });
}

export function redactUrl(input: string): string {
  try {
    const url = new URL(input);
    url.username = "";
    url.password = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/token|secret|password|key|authorization|session|voidr_/i.test(key))
        url.searchParams.delete(key);
    }
    if (/^#voidr-loop-v\d+=/i.test(url.hash)) url.hash = "";
    return url.toString();
  } catch {
    return "[invalid-url]";
  }
}

export function redactText(input: string): string {
  return input
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]")
    .replace(
      /(["']?(?:token|secret|authorization|apiKey)["']?\s*[:=]\s*["'])[^"'\s]{8,}/gi,
      "$1[redacted]",
    )
    .replace(
      /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
      "[redacted-token]",
    )
    .replace(/\b(?:sk|api)[-_][A-Za-z0-9_-]{16,}\b/gi, "[redacted-key]")
    .replace(
      /([?&](?:token|key|secret|authorization|voidr_[^=]*)=)[^&#\s]+/gi,
      "$1[redacted]",
    )
    .slice(0, 4_000);
}
