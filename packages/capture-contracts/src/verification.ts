import { z } from 'zod';

const text = z.string().trim().min(1).max(2000);
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
export const semanticTargetSchema = z.object({
  description: text,
  role: z.enum(['button', 'link', 'textbox', 'spinbutton', 'combobox', 'checkbox', 'radio', 'heading', 'form', 'region', 'dialog', 'alert', 'status', 'row', 'listitem']).optional(),
  name: text.optional(),
  selector: text.optional(),
}).strict();
export const verificationConditionSchema = z.object({
  id, target: semanticTargetSchema,
  operator: z.enum(['visible', 'not_visible', 'absent', 'value_equals', 'text_equals', 'text_contains', 'count_equals', 'url_equals', 'url_contains', 'enabled', 'disabled', 'semantic']),
  scope: z.object({ kind: z.enum(['page', 'region']), target: semanticTargetSchema.optional(), frameUrl: text.optional() }).strict(),
  expected: z.union([z.string().max(2000), z.number().finite()]).optional(),
  evidence: z.object({ completeness: z.enum(['target', 'scope']), transition: z.boolean() }).strict(),
}).strict();
export const verificationSchema = z.object({
  version: z.literal(1), root: id,
  conditions: z.array(verificationConditionSchema).min(1).max(32),
  groups: z.array(z.object({ id, operator: z.enum(['all', 'any']), children: z.array(id).min(1).max(32) }).strict()).max(16),
}).strict().superRefine((plan, ctx) => {
  const nodes = [...plan.conditions, ...plan.groups];
  const byId = new Map(nodes.map(node => [node.id, node]));
  const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (byId.size !== nodes.length) issue('Verification IDs must be unique.');
  const visited = new Set<string>();
  const visit = (key: string, path: string[]): void => {
    const node = byId.get(key);
    if (!node || path.includes(key) || path.length > 8) return issue('Invalid, cyclic or too deep verification graph.');
    if (visited.has(key)) return;
    visited.add(key);
    if ('children' in node) node.children.forEach(child => visit(child, [...path, key]));
  };
  visit(plan.root, []);
  if (visited.size !== nodes.length) issue('Every condition and group must belong to the root expression.');
  plan.conditions.forEach(condition => {
    if (condition.scope.kind === 'region' && !condition.scope.target) issue('Region scope requires a semantic target.');
    if (condition.scope.kind === 'page' && condition.scope.target) issue('Page scope cannot contain a region target.');
    if (['value_equals', 'text_equals', 'text_contains', 'url_equals', 'url_contains'].includes(condition.operator)
      && typeof condition.expected !== 'string') issue('This operator requires an explicit string expectation.');
    if (['text_contains', 'url_equals', 'url_contains'].includes(condition.operator) && !condition.expected) issue('This operator requires a nonempty expectation.');
    if (['visible', 'not_visible', 'absent', 'enabled', 'disabled'].includes(condition.operator) && condition.expected !== undefined) issue('This operator uses its target, not a separate expectation.');
    if (condition.operator === 'count_equals' && (typeof condition.expected !== 'number'
      || !Number.isInteger(condition.expected) || condition.expected < 0)) issue('Count requires a nonnegative integer.');
    if (['absent', 'not_visible', 'count_equals'].includes(condition.operator)
      && condition.evidence.completeness !== 'scope') issue('Absence and count require complete scope evidence.');
    if (condition.operator.startsWith('url_') && condition.scope.kind !== 'page') issue('URL requires page scope.');
  });
});
export type SemanticTarget = z.infer<typeof semanticTargetSchema>;
export type VerificationCondition = z.infer<typeof verificationConditionSchema>;
export type VerificationPlan = z.infer<typeof verificationSchema>;
export type VerificationStatus = 'passed' | 'failed' | 'unverified';

export const conditionResultSchema = z.object({
  condition: verificationConditionSchema,
  status: z.enum(['passed', 'failed', 'unverified']), reason: z.string(),
  evidence: z.object({ url: z.string(), complete: z.boolean(), fingerprint: z.string(),
    observed: z.array(z.record(z.string(), z.unknown())) }),
  judgments: z.array(z.record(z.string(), z.unknown())),
});
export type ConditionResult = z.infer<typeof conditionResultSchema>;

export const conditionSummarySchema = z.object({
  id, status: z.enum(['passed', 'failed', 'unverified']), reason: z.string().max(2000),
  evidenceFingerprint: z.string().max(64),
});
