import { z } from 'zod';

export const pendingAiLaunchesSchema = z.array(z.object({ loopId: z.string().min(1).max(200), runId: z.string().uuid() })).max(20);
export type PendingAiLaunch = z.infer<typeof pendingAiLaunchesSchema>[number];
export const aiLaunchEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('pending'), launches: pendingAiLaunchesSchema }),
  z.object({ type: z.literal('connected') }),
  z.object({ type: z.literal('disconnected') }),
]);
export type AiLaunchEvent = z.infer<typeof aiLaunchEventSchema>;
