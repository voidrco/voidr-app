import path from 'node:path';

export const CONTROL_SCHEME = 'voidr-app';
export const CONTROL_ORIGIN = `${CONTROL_SCHEME}://app`;

export function resolveControlAsset(rendererRoot: string, requestUrl: string): string | null {
  try {
    if (/(?:^|[/\\])\.\.(?:[/\\]|$)|%2e/i.test(requestUrl)) return null;
    const url = new URL(requestUrl);
    if (url.protocol !== `${CONTROL_SCHEME}:` || url.host !== 'app' || url.search || url.hash) {
      return null;
    }
    const pathname = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const resolved = path.resolve(rendererRoot, `.${pathname}`);
    const relative = path.relative(rendererRoot, resolved);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
    return resolved;
  } catch {
    return null;
  }
}

export function isControlRendererUrl(input: string, developmentOrigin?: string): boolean {
  try {
    const url = new URL(input);
    if (developmentOrigin && url.origin === new URL(developmentOrigin).origin) return true;
    return url.protocol === `${CONTROL_SCHEME}:` && url.host === 'app';
  } catch {
    return false;
  }
}
