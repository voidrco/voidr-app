import type { Page } from 'playwright-core';
import { journeyInputSchema, type JourneyInput } from '../shared/journeys';

export class JourneyIntervention {
  private active?: { page: () => Page; resolve: () => void; reject: (error: Error) => void; queue: Promise<void>; refreshing: boolean; resuming: boolean };

  constructor(private readonly deps: { signal: AbortSignal; secrets: Record<string, string>; emit: (event: unknown) => void }) {}

  async wait(page: () => Page) {
    const done = new Promise<void>((resolve, reject) => {
      this.active = { page, resolve, reject, queue: Promise.resolve(), refreshing: false, resuming: false };
    });
    const abort = () => this.active?.reject(new Error('Execução cancelada.'));
    this.deps.signal.addEventListener('abort', abort, { once: true });
    if (this.deps.signal.aborted) abort();
    const timer = setInterval(() => void this.refresh(), 800);
    void this.refresh();
    try { await done; }
    finally { clearInterval(timer); this.deps.signal.removeEventListener('abort', abort); this.active = undefined; }
  }

  resume() {
    const active = this.active;
    if (!active || active.resuming) return;
    active.resuming = true;
    void active.queue.then(() => active.resolve());
  }

  input(value: unknown) {
    const parsed = journeyInputSchema.safeParse(value);
    const active = this.active;
    if (!parsed.success || !active || active.resuming || this.deps.signal.aborted) return;
    active.queue = active.queue.then(async () => {
      if (this.active !== active || this.deps.signal.aborted) return;
      await this.perform(active.page(), parsed.data);
    }).catch(() => {
      if (this.active === active && !this.deps.signal.aborted)
        this.deps.emit({ type: 'intervention', message: 'Não foi possível interagir. Confira a página e selecione o campo novamente.' });
    });
  }

  private async perform(page: Page, input: JourneyInput) {
    if (input.type === 'fill') return this.fill(page, input.value);
    if (input.type === 'key') return page.keyboard.press(input.key);
    if (input.type === 'wheel') return page.mouse.wheel(0, input.deltaY);
    const viewport = page.viewportSize();
    if (!viewport) throw new Error('Página indisponível.');
    await page.mouse.click(input.x * viewport.width, input.y * viewport.height);
  }

  private async fill(page: Page, value: string) {
    this.deps.secrets[`MANUAL_INPUT_${Object.keys(this.deps.secrets).length}`] = value;
    for (const frame of page.frames()) {
      const field = frame.locator('input:focus, textarea:focus');
      if (!await field.count()) continue;
      await field.evaluate(element => {
        element.setAttribute('data-voidr-secret', 'true');
        (element as HTMLElement).style.setProperty('-webkit-text-security', 'disc', 'important');
      });
      await field.fill(value, { timeout: 3000 });
      return;
    }
    throw new Error('Selecione um campo.');
  }

  private async refresh() {
    const active = this.active;
    if (!active || active.refreshing || this.deps.signal.aborted) return;
    active.refreshing = true;
    try {
      const page = active.page();
      const screenshot = await page.screenshot({ type: 'jpeg', quality: 80, timeout: 2000 });
      if (this.active === active) this.deps.emit({ type: 'observation', url: page.url(), screenshot: `data:image/jpeg;base64,${screenshot.toString('base64')}` });
    } catch {}
    finally { active.refreshing = false; }
  }
}
