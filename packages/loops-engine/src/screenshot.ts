import type { Page } from 'playwright-core';

export type CaptureInfo = { method: 'playwright' | 'chromium-compositor'; fontsPending: boolean };

/** Capture the rendered viewport even if an external font never finishes loading.
 * No DOM/CSS changes, network replay, or fabricated image. Other failures remain
 * errors. The fallback is explicit in the evidence metadata. */
export async function captureViewport(page: Page, options: {
  type: 'png' | 'jpeg'; quality?: number; timeout?: number;
  onCapture?: (info: CaptureInfo) => void;
}): Promise<Buffer> {
  const { onCapture, ...screenshotOptions } = options;
  try {
    const image = await page.screenshot({ ...screenshotOptions, timeout: options.timeout ?? 3_000 });
    onCapture?.({ method: 'playwright', fontsPending: false });
    return image;
  } catch (error) {
    if (!(error instanceof Error) || !/Timeout.*exceeded/s.test(error.message)
      || !error.message.includes('waiting for fonts to load') || page.isClosed()) throw error;
    const session = await page.context().newCDPSession(page);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const image = await Promise.race([
        session.send('Page.captureScreenshot', { format: options.type, quality: options.quality,
          fromSurface: true, captureBeyondViewport: false }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Chromium viewport capture timed out')), 3_000); }),
      ]);
      onCapture?.({ method: 'chromium-compositor', fontsPending: true });
      return Buffer.from(image.data, 'base64');
    } finally {
      clearTimeout(timer);
      await session.detach().catch(() => undefined);
    }
  }
}
