import type { ElementHandle, Page } from "playwright-core";

async function animateScroll(target: ElementHandle, alignment: "center" | "start" | "end") {
  await target.evaluate(async (node, block) => {
    const element = node as Element;
    const parents: Element[] = [];
    const state = { node: element.parentElement };
    while (state.node) {
      parents.push(state.node);
      state.node = state.node.parentElement ?? (state.node.getRootNode() as ShadowRoot).host as HTMLElement | null;
    }
    const positions = parents.map(parent => ({ parent, x: parent.scrollLeft, y: parent.scrollTop }));
    element.scrollIntoView({ block, inline: "center", behavior: "instant" });
    const changed = positions.map(position => ({ ...position, toX: position.parent.scrollLeft, toY: position.parent.scrollTop }))
      .filter(position => position.x !== position.toX || position.y !== position.toY);
    if (!changed.length || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    changed.forEach(({ parent, x, y }) => parent.scrollTo({ left: x, top: y, behavior: "instant" }));
    await new Promise<void>(resolve => {
      const started = performance.now();
      const animation = { tick() {
        const progress = Math.min(1, (performance.now() - started) / 120);
        const eased = 1 - (1 - progress) ** 3;
        changed.forEach(({ parent, x, y, toX, toY }) => parent.scrollTo({ left: x + (toX - x) * eased, top: y + (toY - y) * eased, behavior: "instant" }));
        if (progress < 1) requestAnimationFrame(animation.tick);
        else resolve();
      } };
      requestAnimationFrame(animation.tick);
    });
  }, alignment);
}

export async function scrollTarget(target: ElementHandle, alignment: "center" | "start" | "end") {
  const frames: ElementHandle[] = [];
  const state = { frame: await target.ownerFrame() };
  while (state.frame?.parentFrame()) {
    frames.push(await state.frame.frameElement());
    state.frame = state.frame.parentFrame();
  }
  try {
    await Promise.all([animateScroll(target, alignment), ...frames.map(frame => animateScroll(frame, "center"))]);
  } finally { await Promise.all(frames.map(frame => frame.dispose())); }
}

export async function streamScroll(page: Page, onFrame?: (screenshot: string) => void) {
  if (!onFrame) return async () => {};
  const session = await page.context().newCDPSession(page);
  session.on("Page.screencastFrame", event => {
    void session.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => undefined);
    onFrame(`data:image/jpeg;base64,${event.data}`);
  });
  await session.send("Page.startScreencast", { format: "jpeg", quality: 65, maxWidth: 1280, maxHeight: 900 });
  return async () => { await session.detach().catch(() => undefined); };
}
