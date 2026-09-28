import type { Action } from "./actions.js";

type NavigationAction = Extract<Action, { kind: "navigate" }>;

/** Only authored navigation instructions contribute targets. Page text and test data never do. */
export function navigationActions(instruction: string, baseUrl: string, stepKind?: "action" | "assertion"): NavigationAction[] {
  if (stepKind === "assertion" || !/\b(abrir|abra|acesse|acessar|navegar|navegue|open|navigate|visit|go to)\b/i.test(instruction)
    || /\b(não|nao|not|never)\s+(?:\w+\s+)?(abrir|abra|acesse|acessar|navegar|navegue|open|navigate|visit|go)\b/i.test(instruction)) return [];
  const base = new URL(baseUrl);
  const targets = new Set<string>();
  // Absolute HTTP(S) URLs or slash-prefixed routes, quoted or surrounded by prose.
  for (const match of instruction.matchAll(/(?:^|[\s("'`])((?:https?:\/\/|\/)[^\s<>"'`)]*)/gi)) {
    const raw = match[1]!.replace(/[.,;]+$/, "");
    if (raw.startsWith("//") || raw.includes("\\") || raw.includes("{{")) continue;
    try {
      const url = new URL(raw, base);
      if (url.origin === base.origin && ["http:", "https:"].includes(url.protocol) && !url.username && !url.password) targets.add(url.href);
    } catch { /* A malformed reference is not a navigation capability. */ }
  }
  return [...targets].slice(0, 10).map((url, index) => ({ id: `navigation_${index}`, kind: "navigate", url }));
}
