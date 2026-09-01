const CSP_HEADER = 'content-security-policy';

function extendPolicy(policy: string, collectorOrigin: string): string {
  const directives = policy
    .split(';')
    .map((directive) => directive.trim())
    .filter(Boolean);
  const connectIndex = directives.findIndex((directive) =>
    /^connect-src(?:\s|$)/i.test(directive),
  );

  if (connectIndex >= 0) {
    const sources = directives[connectIndex]!
      .split(/\s+/)
      .slice(1)
      .filter((source) => source !== "'none'");
    if (!sources.includes(collectorOrigin)) sources.push(collectorOrigin);
    directives[connectIndex] = `connect-src ${sources.join(' ')}`;
    return directives.join('; ');
  }

  const defaultDirective = directives.find((directive) =>
    /^default-src(?:\s|$)/i.test(directive),
  );
  if (!defaultDirective) return policy;
  const defaultSources = defaultDirective
    .split(/\s+/)
    .slice(1)
    .filter((source) => source !== "'none'");
  directives.push(`connect-src ${[...defaultSources, collectorOrigin].join(' ')}`);
  return directives.join('; ');
}

export function allowCollectorInContentSecurityPolicy(
  responseHeaders: Record<string, string[]> | undefined,
  collectorUrl: string,
): Record<string, string[]> | undefined {
  if (!responseHeaders) return responseHeaders;
  const collectorOrigin = new URL(collectorUrl).origin;
  const next = { ...responseHeaders };

  for (const [name, values] of Object.entries(responseHeaders)) {
    if (name.toLowerCase() !== CSP_HEADER) continue;
    next[name] = values.map((policy) => extendPolicy(policy, collectorOrigin));
  }
  return next;
}
