import { z } from 'zod';

export const updateStateSchema = z.object({
  phase: z.enum(['idle', 'sign-in', 'checking', 'current', 'downloading', 'verifying', 'ready', 'installing', 'error', 'manual', 'disabled']),
  currentVersion: z.string(),
  startup: z.boolean().optional(),
  version: z.string().optional(),
  notes: z.string().optional(),
  transferred: z.number().nonnegative().optional(),
  total: z.number().positive().optional(),
  bytesPerSecond: z.number().nonnegative().optional(),
  message: z.string().optional(),
});
export type UpdateState = z.infer<typeof updateStateSchema>;
