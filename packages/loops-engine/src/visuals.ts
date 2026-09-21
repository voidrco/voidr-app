import type { Page } from "playwright-core";
import type { Interaction } from "./actions.js";

export async function paintInteraction(page: Page, interaction: Interaction) {
  await page.evaluate(event => {
    const host = document.querySelector('[data-voidr-overlay]') ?? document.body.appendChild(document.createElement('div'));
    host.setAttribute('data-voidr-overlay', '');
    const state = host as HTMLElement & { visual?: ShadowRoot };
    if (!state.visual) {
      state.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
      state.visual = state.attachShadow({ mode: 'closed' });
      state.visual.innerHTML = '<div id="box"></div><div id="label"></div>';
    }
    const root = state.visual;
    const box = root.getElementById('box')!, label = root.getElementById('label')!;
    const color = event.phase === 'failed' ? '#ef7777' : event.kind === 'assert' ? '#32d49b' : '#91c7f3';
    box.style.cssText = 'position:absolute;border:2px solid;border-radius:5px;box-sizing:border-box;';
    box.style.borderColor = color;
    box.style.background = `${color}20`;
    box.hidden = !event.target;
    if (event.target) Object.assign(box.style, { left: `${event.target.x}px`, top: `${event.target.y}px`, width: `${event.target.width}px`, height: `${event.target.height}px` });
    label.hidden = event.kind !== 'assert';
    label.style.cssText = `position:absolute;bottom:16px;left:16px;max-width:85%;padding:10px 14px;background:#101820ed;border:1px solid ${color};border-radius:6px;color:${color};font:14px sans-serif;`;
    label.textContent = `${event.phase === 'passed' ? '✓ Verificação confirmada: ' : event.phase === 'failed' ? '✕ Verificação falhou: ' : event.kind === 'assert' ? 'Verificando: ' : ''}${event.label}`;
  }, interaction);
}
