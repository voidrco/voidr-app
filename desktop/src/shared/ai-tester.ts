import { verificationSchema, conditionSummarySchema } from '@voidr/capture-contracts';
import { z } from 'zod';

export const aiScenarioSchema = z.object({ id: z.string(), version: z.string(), title: z.string(), objective: z.string(),
  angle: z.string(), actor: z.string(), prerequisites: z.array(z.string()), data: z.array(z.string()),
  expectation: z.object({ text: z.string(), status: z.enum(['confirmed', 'hypothesis', 'conflict']), sources: z.array(z.string()) }),
  sources: z.array(z.string()), blockers: z.array(z.string()), state: z.enum(['runnable', 'suggested', 'blocked']) });
export type AiScenario = z.infer<typeof aiScenarioSchema>;

export const aiJourneySchema = z.object({ id: z.string(), scenarioId: z.string().optional(), scenarioVersion: z.string().optional(), objective: z.string(), prerequisites: z.array(z.string()),
  data: z.array(z.string()), blockers: z.array(z.string()), sources: z.array(z.string()),
  steps: z.array(z.object({ kind: z.enum(['action', 'assertion']), instruction: z.string(), verification: verificationSchema.optional(), sources: z.array(z.string()) })) });
export const aiResultSchema = z.object({ journeyId: z.string(), outcome: z.enum(['passed', 'divergence', 'unable_to_verify', 'cancelled', 'blocked']),
  reason: z.string(), completedSteps: z.number(), durationMs: z.number(),
  assertions: z.array(z.object({ stepIndex: z.number(), status: z.enum(['passed', 'failed', 'unverified']), reason: z.string(), conditions: z.array(conditionSummarySchema).optional() })) });
export const aiArtifactSchema = z.object({ id: z.string(), journeyId: z.string(), name: z.string(), contentType: z.string(), size: z.number(), uploaded: z.boolean() });
export const aiRunSchema = z.object({ runId: z.string().uuid(), loopId: z.string(), status: z.string(), targetUrl: z.string(), environment: z.string(),
  captureCycles: z.array(z.object({ journeyId: z.string(), cycleId: z.string() })).default([]),
  plan: z.object({ journeys: z.array(aiJourneySchema), warnings: z.array(z.string()), scenarios: z.array(aiScenarioSchema).optional(), gaps: z.array(z.string()).optional() }).optional(),
  sources: z.array(z.object({ id: z.string(), kind: z.string(), version: z.string(), label: z.string().optional(), path: z.string().optional(), commit: z.string().optional() })).default([]),
  results: z.array(aiResultSchema).default([]), artifacts: z.array(aiArtifactSchema).default([]),
  planningStage: z.string().optional(),
  sequence: z.number().default(0), journeyId: z.string().optional(), stepIndex: z.number().optional(),
  cancelRequested: z.boolean().default(false), error: z.string().optional(), createdAt: z.string().optional() });
export const aiStateSchema = z.object({ run: aiRunSchema.optional(), busy: z.boolean(), uploadPending: z.boolean(), error: z.string().optional() });
export type AiRun = z.infer<typeof aiRunSchema>;
export type AiJourney = z.infer<typeof aiJourneySchema>;
export type AiResult = z.infer<typeof aiResultSchema>;
export type AiState = z.infer<typeof aiStateSchema>;
export type AiRequest = { runtime: import('@voidr/capture-contracts').LocalRuntimeConfig; loopId: string; runId?: string };
