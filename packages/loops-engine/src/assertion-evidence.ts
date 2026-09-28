import type { Frame } from "playwright-core";

export const EVIDENCE_SELECTOR = 'body, tr, [role=row], li, p, h1, h2, h3, label, input, select, textarea, [role=status], [role=alert], section, article, div, span';
export type EvidenceSnapshot = { text: string; values: { name: string; value: string; checked?: boolean }[];
  context?: { scope: 'document' | 'region'; url: string; title: string; readyState: string;
    controls: { tag: string; type: string; name: string; id: string }[]; embeddedDocuments: number } };
export type AssertionEvidence = EvidenceSnapshot & { id: string; frame: number; index: number; ancestorIndexes?: number[] };

export function readEvidence(nodes: Element[] | Element) {
  const helpers = { visible(node: Element) {
    return node.checkVisibility({ checkVisibilityCSS: true })
      && !node.closest('[data-voidr-overlay], [inert]') && (node as HTMLInputElement).type !== 'hidden';
  }, snapshot(element: HTMLElement): EvidenceSnapshot | null {
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
    const controls = Array.from(element.querySelectorAll('input, select, textarea, button, a, [role=button]'));
    if (element.matches('input, select, textarea, button, a, [role=button]')) controls.unshift(element);
    return text || values.length || controls.some(helpers.visible) ? { text, values, context: {
      scope: element.tagName === 'BODY' ? 'document' : 'region',
      url: element.ownerDocument.location.href, title: element.ownerDocument.title,
      readyState: element.ownerDocument.readyState,
      // Structural identity only: password values and credentials must never
      // enter a snapshot, even though a visible password field is evidence.
      controls: controls.filter(helpers.visible).map(node => ({ tag: node.tagName.toLowerCase(),
        type: (node as HTMLInputElement).type ?? '', id: node.id,
        name: node.getAttribute('aria-label') || (node as HTMLInputElement).name || (node as HTMLElement).innerText || node.id })),
      embeddedDocuments: Array.from(element.querySelectorAll('iframe, frame')).filter(helpers.visible).length,
    } } : null;
  }, ancestors(node: Element): number[] {
    const parent = node.parentElement;
    if (!parent) return [];
    const index = indexes.get(parent);
    return [...(index === undefined ? [] : [index]), ...helpers.ancestors(parent)];
  } };
  const elements = Array.isArray(nodes) ? nodes : [nodes];
  const indexes = new Map(elements.map((node, index) => [node, index]));
  const seen = new Set<string>();
  const snapshots = elements.map((node, index) => ({ node, index }))
    .sort((a, b) => Number(a.node.tagName === 'BODY') - Number(b.node.tagName === 'BODY'))
    .flatMap(({ node, index }) => {
    const value = helpers.snapshot(node as HTMLElement);
    if (!value) return [];
    const fingerprint = JSON.stringify(value);
    if (seen.has(fingerprint)) return [];
    seen.add(fingerprint);
    return [{ ...value, index, ancestorIndexes: helpers.ancestors(node) }];
  });
  const document = snapshots.find(item => item.context?.scope === 'document');
  // Prefer small regions while reserving a slot for whole-document assertions.
  return [...snapshots.filter(item => item !== document).slice(0, document ? 99 : 100),
    ...(document ? [document] : [])];
}

export async function frameEvidence(frame: Frame, frameIndex: number): Promise<AssertionEvidence[]> {
  return frame.locator(EVIDENCE_SELECTOR).evaluateAll(readEvidence)
    .then(items => items.map(item => ({ ...item, frame: frameIndex, id: `e${frameIndex}_${item.index}` })));
}
