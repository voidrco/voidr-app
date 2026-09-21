import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { shell } from 'electron';
import { z } from 'zod';
import { authCallbackPage } from './auth-callback-page';
import type { AuthTokenStore } from './auth-token-store';

const tokenResponseSchema = z.object({
  access_token: z.string().min(32),
  token_type: z.literal('Bearer'),
  expires_in: z.number().int().positive().max(86_400),
  refresh_token: z.string().min(1).optional(),
});

const cachedTokenSchema = z.object({ value: z.string().min(32), expiresAt: z.number().finite(), refreshToken: z.string().optional() });
type CachedToken = z.infer<typeof cachedTokenSchema>;
type LoopAuthProfile = 'organization' | 'participant';
type AuthCacheKey = string;

const organizationIdSchema = z.string().trim().regex(/^org_[A-Za-z0-9]+$/).max(100);

const ORGANIZATION_AUTH = {
  domain: 'bounties4.us.auth0.com',
  clientId: 'c4eLr6uaq98KB2dCKNkmP9bz6sS3gJfS',
  audience: 'https://service.bounties4.com/',
  callbackPort: 47_821,
} as const;

export class LoopParticipantAuthSession {
  readonly #cached = new Map<AuthCacheKey, CachedToken>();
  readonly #flights = new Map<AuthCacheKey, Promise<string>>();
  readonly #refreshes = new Map<AuthCacheKey, Promise<string | undefined>>();
  readonly #revisions = new Map<AuthCacheKey, number>();
  constructor(private readonly store?: AuthTokenStore) {}

  #key(profile: LoopAuthProfile, organizationId?: string) {
    const config = this.#configuration(profile);
    return JSON.stringify([profile, organizationId ?? '', config.issuer.origin, config.clientId, config.audience]);
  }

  #load(key: string) {
    if (!this.#cached.has(key)) {
      try {
        const saved = this.store?.read(key);
        if (saved) this.#cached.set(key, cachedTokenSchema.parse(JSON.parse(saved)));
      } catch { return undefined; }
    }
    return this.#cached.get(key);
  }

  #save(key: string, token: CachedToken, revision: number) {
    if ((this.#revisions.get(key) ?? 0) !== revision) throw new Error('Esta sessão foi desconectada.');
    this.store?.write(key, JSON.stringify(token));
    this.#cached.set(key, token);
  }

  cachedAccessToken(
    profile: LoopAuthProfile = 'participant',
    organizationId?: string,
  ): string | undefined {
    const organization = profile === 'organization'
      ? organizationIdSchema.parse(organizationId)
      : undefined;
    const cacheKey = this.#key(profile, organization);
    const cached = this.#load(cacheKey);
    if (!cached || cached.expiresAt - Date.now() <= 60_000) {
      return undefined;
    }
    return cached.value;
  }

  clear(profile: LoopAuthProfile = 'participant', organizationId?: string): void {
    const organization = profile === 'organization'
      ? organizationIdSchema.parse(organizationId)
      : undefined;
    const key = this.#key(profile, organization);
    this.#revisions.set(key, (this.#revisions.get(key) ?? 0) + 1);
    this.#cached.delete(key);
    this.store?.remove(key);
  }

  async restoreAccessToken(profile: LoopAuthProfile = 'participant', organizationId?: string): Promise<string | undefined> {
    organizationId = profile === 'organization' ? organizationIdSchema.parse(organizationId) : undefined;
    const cached = this.cachedAccessToken(profile, organizationId);
    if (cached) return cached;
    const key = this.#key(profile, organizationId);
    if (!this.#load(key)?.refreshToken) return undefined;
    const pending = this.#refreshes.get(key);
    if (pending) return pending;
    const task = this.#refresh(profile, organizationId, key);
    this.#refreshes.set(key, task);
    try { return await task; } finally { this.#refreshes.delete(key); }
  }

  async #refresh(profile: LoopAuthProfile, organizationId: string | undefined, key: string) {
    const config = this.#configuration(profile);
    const previous = this.#load(key)!;
    const revision = this.#revisions.get(key) ?? 0;
    const response = await fetch(new URL('/oauth/token', config.issuer), {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, redirect: 'error', signal: AbortSignal.timeout(15000),
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: config.clientId, refresh_token: previous.refreshToken! }),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      if (error.error === 'invalid_grant' && (this.#revisions.get(key) ?? 0) === revision) { this.clear(profile, organizationId); return undefined; }
      throw new Error('Não foi possível renovar sua sessão. Tente novamente.');
    }
    const body = tokenResponseSchema.parse(await response.json());
    this.#save(key, { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000, refreshToken: body.refresh_token ?? previous.refreshToken }, revision);
    return body.access_token;
  }

  async accessToken(
    profile: LoopAuthProfile = 'participant',
    organizationId?: string,
  ): Promise<string> {
    const organization = profile === 'organization'
      ? organizationIdSchema.parse(organizationId)
      : undefined;
    const cacheKey = this.#key(profile, organization);
    const cached = await this.restoreAccessToken(profile, organization);
    if (cached) return cached;
    const inFlight = this.#flights.get(cacheKey);
    if (inFlight) return inFlight;
    if (
      profile === 'organization' &&
      [...this.#flights.keys()].some((key) => key.startsWith('["organization",'))
    ) {
      throw new Error(
        'Já existe uma autenticação de workspace em andamento. Conclua ou feche essa janela e tente novamente.',
      );
    }
    const flight = this.#authorize(profile, organization);
    this.#flights.set(cacheKey, flight);
    try {
      return await flight;
    } finally {
      this.#flights.delete(cacheKey);
    }
  }

  #configuration(profile: LoopAuthProfile) {
    const organization = profile === 'organization';
    const domain = organization
      ? process.env.VOIDR_ORGANIZATION_AUTH_DOMAIN?.trim() || ORGANIZATION_AUTH.domain
      : process.env.VOIDR_PARTICIPANT_AUTH_DOMAIN?.trim();
    const clientId = organization
      ? process.env.VOIDR_ORGANIZATION_AUTH_CLIENT_ID?.trim() || ORGANIZATION_AUTH.clientId
      : process.env.VOIDR_PARTICIPANT_AUTH_CLIENT_ID?.trim();
    const audience = organization
      ? process.env.VOIDR_ORGANIZATION_AUTH_AUDIENCE?.trim() || ORGANIZATION_AUTH.audience
      : process.env.VOIDR_PARTICIPANT_AUTH_AUDIENCE?.trim();
    if (!domain || !clientId || !audience) {
      throw new Error('A autenticação de participantes não está configurada no Voidr Capture.');
    }
    const issuer = new URL(domain.startsWith('https://') ? domain : `https://${domain}`);
    if (issuer.protocol !== 'https:' || issuer.username || issuer.password || issuer.search || issuer.hash) {
      throw new Error('A configuração de autenticação do Voidr Capture é inválida.');
    }
    return { issuer, clientId, audience };
  }

  async #authorize(profile: LoopAuthProfile, organizationId?: string): Promise<string> {
    const organization = profile === 'organization';
    const { issuer, clientId, audience } = this.#configuration(profile);
    const cacheKey = this.#key(profile, organizationId);
    const revision = this.#revisions.get(cacheKey) ?? 0;
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const state = randomBytes(24).toString('base64url');
    const callback = await this.#listenForCallback(
      state,
      organization ? ORGANIZATION_AUTH.callbackPort : 0,
    );
    const redirectUri = `http://127.0.0.1:${callback.port}/callback`;
    const authorize = new URL('/authorize', issuer);
    authorize.searchParams.set('response_type', 'code');
    authorize.searchParams.set('client_id', clientId);
    authorize.searchParams.set('redirect_uri', redirectUri);
    authorize.searchParams.set('scope', this.store ? 'openid profile email offline_access' : 'openid profile email');
    authorize.searchParams.set('audience', audience);
    if (!organization) authorize.searchParams.set('connection', 'google-oauth2');
    if (organizationId) authorize.searchParams.set('organization', organizationId);
    authorize.searchParams.set('code_challenge', challenge);
    authorize.searchParams.set('code_challenge_method', 'S256');
    authorize.searchParams.set('state', state);
    try {
      await shell.openExternal(authorize.toString());
      const code = await callback.code;
      const response = await fetch(new URL('/oauth/token', issuer), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: clientId,
          code_verifier: verifier,
          code,
          redirect_uri: redirectUri,
        }),
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error('Sua conta não pôde ser confirmada no app.');
      const body = tokenResponseSchema.parse(await response.json());
      this.#save(cacheKey, {
        value: body.access_token,
        expiresAt: Date.now() + body.expires_in * 1_000,
        refreshToken: body.refresh_token,
      }, revision);
      return body.access_token;
    } finally {
      await callback.close();
    }
  }

  async #listenForCallback(expectedState: string, port: number): Promise<{
    port: number;
    code: Promise<string>;
    close: () => Promise<void>;
  }> {
    let server: Server;
    let resolveCode!: (value: string) => void;
    let rejectCode!: (reason: Error) => void;
    const code = new Promise<string>((resolve, reject) => {
      resolveCode = resolve;
      rejectCode = reject;
    });
    server = createServer((request, response) => {
      try {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        if (url.pathname !== '/callback') {
          response.writeHead(404).end();
          return;
        }
        const state = url.searchParams.get('state');
        const authorizationCode = url.searchParams.get('code');
        if (state !== expectedState || !authorizationCode) {
          response.writeHead(400, {
            'Content-Type': 'text/plain; charset=utf-8',
          });
          response.end('Não foi possível validar esta autenticação. Volte ao Voidr Capture.');
          rejectCode(new Error('A resposta do login não corresponde a esta tentativa.'));
          return;
        }
        response.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer',
        });
        response.end(authCallbackPage);
        resolveCode(authorizationCode);
      } catch {
        response.writeHead(400).end();
        rejectCode(new Error('A resposta do login é inválida.'));
      }
    });
    server.listen(port, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      server.close();
      throw new Error('O Voidr Capture não conseguiu iniciar o retorno seguro do login.');
    }
    const timeout = setTimeout(() => {
      rejectCode(new Error('O login expirou. Tente abrir o convite novamente.'));
      void new Promise<void>((resolve) => server.close(() => resolve()));
    }, 120_000);
    return {
      port: address.port,
      code,
      close: async () => {
        clearTimeout(timeout);
        if (!server.listening) return;
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        // macOS can keep the loopback listener unavailable for a few ticks
        // after close. Wait briefly so switching organizations cannot strand
        // the next PKCE attempt on the previous callback socket.
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
      },
    };
  }
}
