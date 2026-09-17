const DOCUMENT = /\b(?:\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}|\d{3}\.\d{3}\.\d{3}-\d{2})\b/g;
const NUMBER = /\b\d+(?:[.,]\d+)*(?:\s*(?:milhões|milhão|mil))?\b/gi;

export function normalizeNumber(value: string) {
  const multiplier = /milh/i.test(value) ? 1_000_000 : /mil/i.test(value) ? 1_000 : 1;
  const digits = value.replace(/[^\d.,]/g, "");
  const decimal = digits.includes(",") ? digits.replaceAll(".", "").replace(",", ".")
    : digits.replace(/\.(?=\d{3}(?:\.|$))/g, "");
  return String(Number(decimal) * multiplier);
}

export function extractValues(instruction: string) {
  const journey = instruction.replace(/^\s*\d+[.)]\s*/, "");
  const documents = journey.match(DOCUMENT) ?? [];
  const numbers = (journey.replace(DOCUMENT, "").match(NUMBER) ?? []).map(normalizeNumber);
  const quoted = [...journey.matchAll(/["“]([^"”]+)["”]|'([^']+)'/g)].map((match) => match[1] ?? match[2] ?? "");
  const emails = journey.match(/\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/gi) ?? [];
  const assignments = [...journey.matchAll(/(?:\bcom|\bwith|\bpor|\bfor|:)\s+([^\n;]+)$/gi)]
    .map((match) => match[1]!.replace(/[.!]$/, "").trim());
  return [...new Set([...quoted, ...documents, ...emails, ...numbers, ...assignments])]
    .filter((value) => value.length > 0 && value.length <= 1_000).slice(0, 20);
}
