import { createReadStream } from 'node:fs';
import { mkdtemp, open, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { autoUpdater } from 'electron';
import type { UpdateRelease } from './update-controller';

const MAX_UPDATE_BYTES = 1_500_000_000;

export class MacUpdateTransport {
  private directory?: string;
  async download(release: UpdateRelease, progress: (received: number, total: number | undefined, speed: number) => void): Promise<string> {
    if (!release.url) throw new Error('Missing update URL');
    const url = new URL(release.url);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid update URL');
    this.directory = await mkdtemp(path.join(tmpdir(), 'voidr-update-'));
    const file = path.join(this.directory, 'update.zip');
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15 * 60_000) });
    if (!response.ok || !response.body) throw new Error('Update download failed');
    const length = Number(response.headers.get('content-length')) || undefined;
    const total = release.sizeBytes ?? length;
    if (total && total > MAX_UPDATE_BYTES) throw new Error('Update too large');
    const output = await open(file, 'wx', 0o600);
    const reader = response.body.getReader();
    const hash = createHash('sha256');
    let received = 0;
    let lastProgress = 0;
    const started = Date.now();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        hash.update(value);
        if (received > MAX_UPDATE_BYTES || (total && received > total)) throw new Error('Invalid update size');
        await output.writeFile(value);
        if (Date.now() - lastProgress >= 250) {
          progress(received, total, received * 1_000 / Math.max(1, Date.now() - started));
          lastProgress = Date.now();
        }
      }
      if (!received || (total && total !== received)) throw new Error('Incomplete update');
      if (release.sha256 && hash.digest('hex') !== release.sha256) throw new Error('Update hash mismatch');
      await output.sync();
      progress(received, total ?? received, received * 1_000 / Math.max(1, Date.now() - started));
      return file;
    } finally {
      await reader.cancel().catch(() => undefined);
      await output.close();
    }
  }

  async stage(file: string, release: UpdateRelease): Promise<void> {
    const size = (await stat(file)).size;
    const secret = randomBytes(32).toString('hex');
    // The native updater verifies the replacement application's code signature.
    // Only the already downloaded ZIP is served; auth and signed URLs never
    // reach Squirrel or the renderer. Bind exclusively to IPv4 loopback.
    let origin = '';
    const server = createServer((request, response) => {
      if (request.method !== 'GET' || request.headers.host !== new URL(origin).host) {
        response.writeHead(404).end(); return;
      }
      response.setHeader('Cache-Control', 'no-store');
      if (request.url === `/${secret}/feed`) {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ url: `${origin}/${secret}/update.zip`, name: release.version, notes: release.notes ?? '' }));
      } else if (request.url === `/${secret}/update.zip`) {
        response.setHeader('Content-Type', 'application/zip');
        response.setHeader('Content-Length', size);
        const stream = createReadStream(file);
        stream.on('error', () => response.destroy());
        response.on('close', () => stream.destroy());
        stream.pipe(response);
      } else response.writeHead(404).end();
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Update feed unavailable');
    origin = `http://127.0.0.1:${address.port}`;
    let cleanupListeners = () => {};
    try {
      await new Promise<void>((resolve, reject) => {
        const ready = () => resolve();
        const failed = () => reject(new Error('Native update verification failed'));
        const timer = setTimeout(failed, 120_000);
        cleanupListeners = () => {
          clearTimeout(timer);
          autoUpdater.removeListener('update-downloaded', ready);
          autoUpdater.removeListener('error', failed);
          autoUpdater.removeListener('update-not-available', failed);
        };
        autoUpdater.once('update-downloaded', ready);
        autoUpdater.once('error', failed);
        autoUpdater.once('update-not-available', failed);
        autoUpdater.setFeedURL({ url: `${origin}/${secret}/feed`, serverType: 'default' });
        autoUpdater.checkForUpdates();
      });
    } finally {
      cleanupListeners();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
  async cleanup(): Promise<void> {
    if (this.directory) await rm(this.directory, { recursive: true, force: true });
    this.directory = undefined;
  }
}
