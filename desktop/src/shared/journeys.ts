import { z } from "zod";

export const journeyConfigSchema = z
  .object({
    url: z
      .string()
      .url()
      .max(4096)
      .refine((value) => {
        const url = new URL(value);
        return (
          ["http:", "https:"].includes(url.protocol) &&
          !url.username &&
          !url.password
        );
      }, "Use uma URL HTTP ou HTTPS sem credenciais."),
    steps: z.array(z.string().trim().min(1).max(2000)).min(1).max(40),
    expected: z.array(z.string().trim().min(1).max(1000)).max(20),
    headed: z.boolean(),
    maxActions: z.number().int().min(1).max(150),
  })
  .strict();
const point = z.object({ x: z.number(), y: z.number() });
export const journeyInteractionSchema = z.object({
  phase: z.enum(["target", "acting", "typing", "settled"]),
  kind: z.enum(["click", "fill", "select", "check", "uncheck", "enter"]),
  label: z.string(),
  target: point.extend({ width: z.number(), height: z.number() }).optional(),
  point: point.optional(),
  viewport: z.object({
    width: z.number().positive(),
    height: z.number().positive(),
  }),
});
export const journeyTimingSchema = z.object({
  id: z.number(),
  parentId: z.number().optional(),
  stepIndex: z.number().nullable(),
  category: z.enum([
    "jev",
    "page",
    "playwright",
    "capture",
    "pacing",
    "engine",
  ]),
  label: z.string(),
  startMs: z.number(),
  durationMs: z.number().optional(),
  selfMs: z.number().optional(),
  status: z.enum(["running", "completed", "error"]),
});
export const journeyResultSchema = z.object({
  status: z.string(),
  reason: z.string(),
  output: z.string(),
  completedSteps: z.number(),
  totalSteps: z.number(),
  actions: z.number(),
  decisions: z.number(),
  durationMs: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  verification: z.enum(["text", "model"]),
  timings: z.object({
    spans: z.array(journeyTimingSchema),
    durationMs: z.number(),
    unmeasuredMs: z.number(),
  }),
});
export const journeyEventSchema = z.object({
  type: z.enum([
    "started",
    "observation",
    "interaction",
    "step_started",
    "action",
    "step_done",
    "finished",
    "timing",
    "recovery",
    "fatal",
  ]),
  message: z.string().optional(),
  stepIndex: z.number().optional(),
  confidence: z.number().optional(),
  screenshot: z.string().startsWith("data:image/").optional(),
  url: z.string().optional(),
  result: journeyResultSchema.optional(),
  interaction: journeyInteractionSchema.optional(),
  executed: z.boolean().optional(),
  timing: journeyTimingSchema.optional(),
});
export const journeyStateSchema = z.object({
  revision: z.number(),
  running: z.boolean(),
  stopping: z.boolean(),
  configured: z.boolean(),
  config: journeyConfigSchema,
  example: journeyConfigSchema,
  stepIndex: z.number(),
  completedSteps: z.number(),
  screenshot: z.string().optional(),
  url: z.string().optional(),
  interaction: journeyInteractionSchema.optional(),
  events: z.array(journeyEventSchema),
  timings: z.array(journeyTimingSchema),
  result: journeyResultSchema.optional(),
  error: z.string().optional(),
});
export type JourneyState = z.infer<typeof journeyStateSchema>;
export type JourneyEvent = z.infer<typeof journeyEventSchema>;
export type JourneyConfig = z.infer<typeof journeyConfigSchema>;

export function applyJourneyEvent(
  state: JourneyState,
  event: JourneyEvent,
): JourneyState {
  const terminal = event.type === "finished" || event.type === "fatal";
  return {
    ...state,
    revision: state.revision + 1,
    running: terminal ? false : state.running,
    stopping: terminal ? false : state.stopping,
    stepIndex: event.stepIndex ?? state.stepIndex,
    completedSteps:
      event.type === "step_done"
        ? (event.stepIndex ?? 0) + 1
        : state.completedSteps,
    screenshot: event.screenshot ?? state.screenshot,
    url: event.url ?? state.url,
    interaction: event.interaction ?? state.interaction,
    result: event.result ?? state.result,
    error: event.type === "fatal" ? event.message : state.error,
    events: event.message
      ? [
          ...state.events,
          { ...event, screenshot: undefined, result: undefined },
        ].slice(-300)
      : state.events,
    timings: event.timing
      ? [
          ...state.timings.filter((span) => span.id !== event.timing!.id),
          event.timing,
        ]
      : state.timings,
  };
}
