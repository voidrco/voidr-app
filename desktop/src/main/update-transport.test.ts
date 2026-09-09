import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ autoUpdater: Object.assign(new EventEmitter(), { setFeedURL: vi.fn(), checkForUpdates: vi.fn() }) }));
import { autoUpdater } from 'electron';
import { MacUpdateTransport } from './update-transport';
const nativeFetch = globalThis.fetch;
let transport: MacUpdateTransport | undefined;
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  autoUpdater.removeAllListeners();
  await transport?.cleanup();
});
describe('native update transport', () => {
  it('rejects bytes that do not match the release checksum', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('abc')));
    transport = new MacUpdateTransport();
    await expect(transport.download({ version: '0.1.18', url: 'https://storage.example/app.zip', sha256: '0'.repeat(64) }, vi.fn())).rejects.toThrow('hash mismatch');
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
  });

  it('downloads bytes privately and reports measured progress', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('abc', { headers: { 'content-length': '3' } })));
    transport = new MacUpdateTransport();
    const progress = vi.fn();
    const file = await transport.download({ version: '0.1.18', url: 'https://storage.example/app.zip', sizeBytes: 3 }, progress);
    expect(await readFile(file, 'utf8')).toBe('abc');
    expect(progress).toHaveBeenLastCalledWith(3, 3, expect.any(Number));
    expect(vi.mocked(fetch).mock.calls[0]![1]).not.toHaveProperty('headers');
    await transport.cleanup();
    expect(existsSync(file)).toBe(false);
  });
  it('rejects truncated data before native verification', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ab')));
    transport = new MacUpdateTransport();
    await expect(transport.download({ version: '0.1.18', url: 'https://storage.example/app.zip', sizeBytes: 3 }, vi.fn())).rejects.toThrow('Incomplete');
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
  });
  it('serves only the local artifact and waits for native signature verification', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('abc')));
    transport = new MacUpdateTransport();
    const release = { version: '0.1.18', url: 'https://storage.example/app.zip?secret=hidden', sizeBytes: 3 };
    const file = await transport.download(release, vi.fn());
    let feedUrl = '';
    vi.mocked(autoUpdater.setFeedURL).mockImplementation(({ url }) => { feedUrl = url; });
    let check: Promise<void> | undefined;
    vi.mocked(autoUpdater.checkForUpdates).mockImplementation(() => {
      check = (async () => {
        const feed = await (await nativeFetch(feedUrl)).json() as { url: string };
        expect(feedUrl).toMatch(/^http:\/\/127\.0\.0\.1:/);
        expect(JSON.stringify(feed)).not.toContain('secret');
        expect(await (await nativeFetch(feed.url)).text()).toBe('abc');
        expect((await nativeFetch(new URL('/wrong', feedUrl))).status).toBe(404);
        autoUpdater.emit('update-downloaded');
      })();
      void check.catch(() => autoUpdater.emit('error', new Error('test assertion')));
    });
    await transport.stage(file, release);
    await check;
    expect(autoUpdater.listenerCount('update-downloaded')).toBe(0);
    await expect(nativeFetch(feedUrl)).rejects.toThrow();
  });
  it('fails closed when the native updater rejects the application', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('abc')));
    transport = new MacUpdateTransport();
    const release = { version: '0.1.18', url: 'https://storage.example/app.zip' };
    const file = await transport.download(release, vi.fn());
    vi.mocked(autoUpdater.checkForUpdates).mockImplementation(() => { autoUpdater.emit('error', new Error('signature mismatch')); });
    await expect(transport.stage(file, release)).rejects.toThrow('Native update verification');
  });
});
