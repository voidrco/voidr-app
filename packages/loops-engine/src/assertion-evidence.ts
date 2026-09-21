import type { Frame } from "playwright-core";

export const EVIDENCE_SELECTOR = 'body, tr, [role=row], li, p, h1, h2, h3, label, input, select, textarea, [role=status], [role=alert], section, article, div, span';
export type EvidenceSnapshot = { text: string; values: { name: string; value: string; checked?: boolean }[] };
export type AssertionEvidence = EvidenceSnapshot & { id: string; frame: number; index: number; ancestorIndexes?: number[] };

export function readEvidence(nodes: Element[] | Element) {
  const helpers = { snapshot(element: HTMLElement): EvidenceSnapshot | null {
    if (!element.checkVisibility({ checkVisibilityCSS: true }) || element.closest('[data-voidr-overlay], [inert]')) return null;
    const text = (element.innerText ?? "").replace(/\s+/g, " ").trim();
    if (text.length > (element.tagName === 'BODY' ? 24_000 : 600)) return null;
    const fields = element.matches('input, select, textarea') ? [element] : Array.from(element.querySelectorAll('input, select, textarea'));
    const values = fields.filter(field => field.checkVisibility({ checkVisibilityCSS: true })
      && !['password', 'hidden', 'file'].includes((field as HTMLInputElement).type))
      .map(field => {
        const input = field as HTMLInputElement;
        return { name: input.getAttribute('aria-label') || input.name || input.id || input.type,
          value: input.value, ...(['checkbox', 'radio'].includes(input.type) ? { checked: input.checked } : {}) };
      });
    return text || values.length ? { text, values } : null;
  } };
  const elements = Array.isArray(nodes) ? nodes : [nodes];
  const indexes = new Map(elements.map((node, index) => [node, index]));
  const ancestors = (node: Element): number[] => {
    const parent = node.parentElement;
    if (!parent) return [];
    const index = indexes.get(parent);
    return [...(index === undefined ? [] : [index]), ...ancestors(parent)];
  };
  const seen = new Set<string>();
  return elements.map((node, index) => ({ node, index }))
    .sort((a, b) => Number(a.node.tagName === 'BODY') - Number(b.node.tagName === 'BODY'))
    .flatMap(({ node, index }) => {
    const value = helpers.snapshot(node as HTMLElement);
    if (!value) return [];
    const fingerprint = JSON.stringify(value);
    if (seen.has(fingerprint)) return [];
    seen.add(fingerprint);
    return [{ ...value, index, ancestorIndexes: ancestors(node) }];
  }).slice(0, 100);
}

export async function frameEvidence(frame: Frame, frameIndex: number): Promise<AssertionEvidence[]> {
  return frame.locator(EVIDENCE_SELECTOR).evaluateAll(readEvidence)
    .then(items => items.map(item => ({ ...item, frame: frameIndex, id: `e${frameIndex}_${item.index}` })));
}
