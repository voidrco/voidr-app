export type JourneyConfig = {
  url: string;
  steps: string[];
  stepKinds?: ("action" | "assertion")[];
  expected: string[];
  headed: boolean;
  maxActions: number;
};

export function parseSteps(value: string) {
  return value.split(/\r?\n/).map((line) => line.replace(/^\s*(?:\d+[.)]|[-*])\s*/, "").trim()).filter(Boolean);
}

export function validateConfig(input: unknown): JourneyConfig {
  if (!input || typeof input !== "object") throw new Error("Informe a URL e os passos da jornada.");
  const raw = input as Record<string, unknown>;
  const url = new URL(String(raw.url ?? ""));
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Use uma URL HTTP ou HTTPS sem credenciais embutidas.");
  }
  const steps = typeof raw.steps === "string" ? parseSteps(raw.steps) : raw.steps;
  if (!Array.isArray(steps) || !steps.length || steps.length > 40
    || steps.some((step) => typeof step !== "string" || !step.trim() || step.length > 2_000)) {
    throw new Error("Escreva de 1 a 40 passos, um por linha, com até 2.000 caracteres cada.");
  }
  const expected = typeof raw.expected === "string" ? parseSteps(raw.expected) : raw.expected ?? [];
  if (!Array.isArray(expected) || expected.length > 20
    || expected.some((text) => typeof text !== "string" || !text.trim() || text.length > 1_000)) {
    throw new Error("Informe os textos esperados, um por linha.");
  }
  const maxActions = Number(raw.maxActions ?? 60);
  if (!Number.isInteger(maxActions) || maxActions < 1 || maxActions > 150) {
    throw new Error("O limite deve estar entre 1 e 150 decisões.");
  }
  const stepKinds = raw.stepKinds as JourneyConfig['stepKinds'];
  if (stepKinds && (!Array.isArray(stepKinds) || stepKinds.length !== steps.length
    || stepKinds.some(kind => !['action', 'assertion'].includes(kind)))) throw new Error('Classificação dos passos inválida.');
  return { url: url.href, steps, stepKinds, expected, headed: raw.headed === true, maxActions };
}
