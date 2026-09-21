import type { Control } from "./browser.js";

export function readControls(elements: Element[] | Node, options: number | { frame: number; selectors: string[] }) {
  const { frame, selectors } = typeof options === "number" ? { frame: options, selectors: [] } : options;
  const helpers = {
    visible(node: Element) { return node.checkVisibility({ checkVisibilityCSS: true }); },

    references(node: HTMLElement) {
      const tag = node.tagName.toLowerCase();
      return {
        domId: node.id,
        selectors: [node.id ? `${tag}#${CSS.escape(node.id)}` : "",
          ...["data-testid", "data-test", "name"].map(key => node.getAttribute(key)
            ? `${tag}[${key}="${CSS.escape(node.getAttribute(key)!)}"]` : "")].filter(Boolean),
        matchedSelectors: selectors.filter(selector => {
          try { return node.matches(selector); } catch { return false; }
        }),
      };
    },

    section(node: HTMLElement) {
      const state = { parent: node.parentElement };
      for (let depth = 0; state.parent && depth < 6; depth += 1, state.parent = state.parent.parentElement) {
        const heading = state.parent.querySelector<HTMLElement>(":scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > legend, :scope > [role=heading]");
        if (heading && helpers.visible(heading)) return heading.innerText.trim().slice(0, 200);
      }
      return "";
    },

    context(node: HTMLElement) {
      const row = node.closest<HTMLElement>("tr, [role=row], li, label");
      const state = { parent: row ?? node.parentElement };
      for (let depth = 0; state.parent && depth < 5; depth += 1, state.parent = state.parent.parentElement) {
        const text = state.parent.innerText?.trim() ?? "";
        if (text.length > 700) break;
        if (text && text !== node.innerText?.trim()) return text.slice(0, 500);
      }
      return row?.innerText?.slice(0, 500) ?? "";
    },

    name(node: HTMLInputElement) {
      const labelledBy = (node.getAttribute("aria-labelledby") ?? "").split(/\s+/)
        .map(id => document.getElementById(id)?.textContent ?? "").join(" ").trim();
      const labels = Array.from(node.labels ?? []).map(label => label.innerText).join(" ");
      const icon = node.querySelector('i, svg, img');
      const iconName = /(?:times|close|remove|trash)/i.test(icon?.getAttribute("class") ?? "") ? "Remove / close"
        : /search/i.test(icon?.getAttribute("class") ?? "") ? "Search" : "";
      return (node.getAttribute("aria-label") || labelledBy || labels || node.innerText?.trim() || node.placeholder
        || node.getAttribute("title") || icon?.getAttribute("aria-label") || icon?.getAttribute("alt")
        || node.querySelector("svg title")?.textContent || iconName || node.id || helpers.context(node)).slice(0, 350);
    },

    availability(node: HTMLElement): Control["availability"] {
      if (modal && !modal.contains(node)) return "blocked_by_modal";
      const rect = node.getBoundingClientRect();
      if (rect.bottom <= 0 || rect.top >= innerHeight || rect.right <= 0 || rect.left >= innerWidth) return "offscreen";
      const x = (Math.max(0, rect.left) + Math.min(innerWidth, rect.right)) / 2;
      const y = (Math.max(0, rect.top) + Math.min(innerHeight, rect.bottom)) / 2;
      const root = node.getRootNode() as Document | ShadowRoot;
      const hit = root.elementFromPoint(x, y);
      return hit && (node === hit || node.contains(hit)) ? "ready" : "obscured";
    },

    control(element: Element, index: number): Control[] {
      const node = element as HTMLInputElement;
      if (!helpers.visible(node) || node.disabled || node.closest('[inert], [aria-disabled="true"]') || node.readOnly
        || ["hidden", "file"].includes(node.type)) return [];
      return [{ index, frame, tag: node.tagName.toLowerCase(), type: node.getAttribute("role") ?? node.type ?? "",
        ...helpers.references(node), visibleText: (node.innerText ?? "").trim().slice(0, 350),
        ariaLabel: node.getAttribute("aria-label") ?? "", placeholder: node.placeholder ?? "", section: helpers.section(node),
        expanded: node.getAttribute("aria-expanded"), controlsId: node.getAttribute("aria-controls") ?? "",
        required: node.required || node.getAttribute("aria-required") === "true",
        name: helpers.name(node), value: node.type === "password" ? (node.value ? "[redacted]" : "")
          : node.isContentEditable ? node.innerText : node.value ?? "",
        checked: node.checked ?? node.getAttribute("aria-checked") === "true", focused: node.matches(":focus"),
        href: node.getAttribute("href") ? new URL(node.getAttribute("href")!, document.baseURI).href : "",
        min: node.min ?? "", max: node.max ?? "", step: node.step ?? "", editable: node.isContentEditable,
        context: helpers.context(node), availability: helpers.availability(node), inModal: Boolean(modal?.contains(node)),
        options: node.tagName === "SELECT" ? Array.from((element as HTMLSelectElement).options)
          .map(option => ({ value: option.value, label: option.label, disabled: option.disabled })) : [],
      }];
    },

  };
  const dialogs = Array.from(document.querySelectorAll<HTMLElement>('dialog[open], [aria-modal="true"], [role="dialog"], .modal.show, .modal.in'))
    .filter(helpers.visible).filter(node => {
      const rect = node.getBoundingClientRect();
      return node.matches(':modal, [aria-modal="true"]')
        || (getComputedStyle(node).position === "fixed" && rect.width >= innerWidth * .8 && rect.height >= innerHeight * .8);
    }).sort((a, b) => (Number.parseInt(getComputedStyle(a).zIndex) || 0) - (Number.parseInt(getComputedStyle(b).zIndex) || 0));
  const modal = dialogs.at(-1);

  const nodes = Array.isArray(elements) ? elements : [elements as Element];
  return { controls: nodes.flatMap(helpers.control), activeModal: modal ? { frame, text: modal.innerText.slice(0, 2000) } : undefined };
}
