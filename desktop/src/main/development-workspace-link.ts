import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { parseDesktopWorkspaceLink } from './deep-link';
import type { DesktopWorkspaceLink } from '@voidr/capture-contracts';

type LinkRequest = { nonce?: unknown; link?: unknown };
async function requestBody(request: IncomingMessage): Promise<LinkRequest> {
  const state = { size: 0, chunks: [] as Buffer[] };
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    state.size += bytes.length;
    if (state.size > 4096) throw new Error('Link excede o limite.');
    state.chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(state.chunks).toString('utf8')) as LinkRequest;
}

export class DevelopmentWorkspaceLink {
  private used = false;
  private server?: Server;
  private timer?: ReturnType<typeof setTimeout>;
  close() { clearTimeout(this.timer); this.server?.close(); this.server = undefined; }

  async open(platformUrl: string, onLink: (link: DesktopWorkspaceLink) => void) {
    this.close();
    this.used = false;
    const url = new URL(platformUrl);
    const nonce = randomBytes(24).toString('hex');
    const server = createServer((request, response) => {
      void this.accept({ request, response, origin: url.origin, nonce, onLink }).catch(() => {
        if (!response.headersSent) response.writeHead(400);
        response.end();
      });
    });
    server.requestTimeout = 10_000;
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    this.server = server;
    this.timer = setTimeout(() => this.close(), 300_000);
    this.timer.unref();
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Não foi possível conectar a plataforma.');
    url.searchParams.set('capturePort', String(address.port));
    url.searchParams.set('captureNonce', nonce);
    return url.toString();
  }

  private async accept(deps: { request: IncomingMessage; response: ServerResponse; origin: string; nonce: string; onLink: (link: DesktopWorkspaceLink) => void }) {
    const { request, response, origin, nonce, onLink } = deps;
    if (request.headers.origin !== origin || request.url !== '/workspace') { response.writeHead(403).end(); return; }
    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Cache-Control', 'no-store');
    if (request.method === 'OPTIONS') {
      response.setHeader('Access-Control-Allow-Methods', 'POST');
      response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      response.setHeader('Access-Control-Allow-Private-Network', 'true');
      response.writeHead(204).end(); return;
    }
    if (request.method !== 'POST' || request.headers['content-type'] !== 'application/json') { response.writeHead(405).end(); return; }
    const body = await requestBody(request);
    const received = Buffer.from(typeof body.nonce === 'string' ? body.nonce : '');
    if (received.length !== nonce.length || !timingSafeEqual(received, Buffer.from(nonce)) || typeof body.link !== 'string') throw new Error('Link inválido.');
    const link = parseDesktopWorkspaceLink(body.link);
    if (link.deployment !== 'local') throw new Error('Ambiente inválido.');
    if (this.used) throw new Error('Link já utilizado.');
    this.used = true;
    onLink(link);
    response.writeHead(204).end();
    this.close();
  }
}
