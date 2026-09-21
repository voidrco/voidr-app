import { z } from 'zod';

export function isAllowedLoopTarget(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || (url.protocol === 'http:' &&
      (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.hostname.endsWith('.local')));
  } catch { return false; }
}

export const loopApplicationSchema = z.object({
  id: z.string().min(1), name: z.string(), type: z.enum(['WEB', 'API', 'MOBILE', 'DESKTOP', 'VOICE']),
});
export const loopEnvironmentSchema = z.object({ slug: z.string().min(1), name: z.string(), applicationUrl: z.string() });
export const createLoopInputSchema = z.object({
  applicationId: z.string().min(1).max(200),
  environmentSlug: z.string().min(1).max(200),
  targetUrl: z.string().trim().refine(isAllowedLoopTarget, 'Use HTTPS ou um endereço local válido.'),
  featureUnderTest: z.string().trim().min(1, 'Descreva o que a equipe deve testar.').max(300),
  accessMode: z.enum(['organization_only', 'authenticated_link']).default('organization_only'),
});
export const createdLoopSchema = z.object({ id: z.string().min(1), reused: z.boolean() });
export type LoopApplication = z.infer<typeof loopApplicationSchema>;
export type LoopEnvironment = z.infer<typeof loopEnvironmentSchema>;
export type CreateLoopInput = z.infer<typeof createLoopInputSchema>;
export type CreatedLoop = z.infer<typeof createdLoopSchema>;
