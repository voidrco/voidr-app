import { get } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { openExternal } = vi.hoisted(() => ({ openExternal: vi.fn() }));
vi.mock('electron', () => ({ shell: { openExternal } }));

import { LoopParticipantAuthSession } from './loop-participant-auth';
import type { AuthTokenStore } from './auth-token-store';

function tokenStore() {
  const entries = new Map<string, string>();
  const store: AuthTokenStore = { read: key => entries.get(key), write: (key, value) => { entries.set(key, value); }, remove: key => { entries.delete(key); } };
  return { store, entries };
}

const savedKey = (organization = 'org_firstTenant') => JSON.stringify(['organization', organization, 'https://bounties4.us.auth0.com', 'c4eLr6uaq98KB2dCKNkmP9bz6sS3gJfS', 'https://service.bounties4.com/']);

describe('LoopParticipantAuthSession', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.VOIDR_PARTICIPANT_AUTH_DOMAIN;
    delete process.env.VOIDR_PARTICIPANT_AUTH_CLIENT_ID;
    delete process.env.VOIDR_PARTICIPANT_AUTH_AUDIENCE;
    delete process.env.VOIDR_ORGANIZATION_AUTH_DOMAIN;
    delete process.env.VOIDR_ORGANIZATION_AUTH_CLIENT_ID;
    delete process.env.VOIDR_ORGANIZATION_AUTH_AUDIENCE;
  });

  it('restores a session after process replacement and removes it on logout', async () => {
    const { store, entries } = tokenStore();
    entries.set(savedKey(), JSON.stringify({ value: 'persistent-access-token-for-first-tenant', expiresAt: Date.now() + 600000 }));
    const session = new LoopParticipantAuthSession(store);
    expect(await session.restoreAccessToken('organization', 'org_firstTenant')).toBe('persistent-access-token-for-first-tenant');
    expect(await session.restoreAccessToken('organization', 'org_secondTenant')).toBeUndefined();
    session.clear('organization', 'org_firstTenant');
    expect(await new LoopParticipantAuthSession(store).restoreAccessToken('organization', 'org_firstTenant')).toBeUndefined();
  });

  it('renews once and persists the rotated refresh token across restarts', async () => {
    const { store, entries } = tokenStore();
    entries.set(savedKey(), JSON.stringify({ value: 'expired-access-token-for-first-tenant', expiresAt: 1, refreshToken: 'old-refresh' }));
    const request = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ access_token: 'renewed-access-token-for-first-tenant', token_type: 'Bearer', expires_in: 600, refresh_token: 'rotated-refresh' })));
    const session = new LoopParticipantAuthSession(store);
    const results = await Promise.all([session.restoreAccessToken('organization', 'org_firstTenant'), session.restoreAccessToken('organization', 'org_firstTenant')]);
    expect(results).toEqual(['renewed-access-token-for-first-tenant', 'renewed-access-token-for-first-tenant']);
    expect(request).toHaveBeenCalledOnce();
    expect(JSON.parse(entries.get(savedKey())!).refreshToken).toBe('rotated-refresh');
    expect(await new LoopParticipantAuthSession(store).restoreAccessToken('organization', 'org_firstTenant')).toBe(results[0]);
  });

  it('preserves the session on transient failure but removes a revoked grant', async () => {
    const { store, entries } = tokenStore();
    entries.set(savedKey(), JSON.stringify({ value: 'expired-access-token-for-first-tenant', expiresAt: 1, refreshToken: 'refresh' }));
    const request = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('offline'));
    const session = new LoopParticipantAuthSession(store);
    await expect(session.restoreAccessToken('organization', 'org_firstTenant')).rejects.toThrow();
    expect(entries.has(savedKey())).toBe(true);
    request.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }));
    expect(await session.restoreAccessToken('organization', 'org_firstTenant')).toBeUndefined();
    expect(entries.has(savedKey())).toBe(false);
  });

  it('does not restore a session when logout happens during renewal', async () => {
    const { store, entries } = tokenStore();
    entries.set(savedKey(), JSON.stringify({ value: 'expired-access-token-for-first-tenant', expiresAt: 1, refreshToken: 'refresh' }));
    let resolve!: (response: Response) => void;
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(done => { resolve = done; }));
    const session = new LoopParticipantAuthSession(store);
    const pending = session.restoreAccessToken('organization', 'org_firstTenant');
    session.clear('organization', 'org_firstTenant');
    resolve(new Response(JSON.stringify({ access_token: 'renewed-access-token-for-first-tenant', token_type: 'Bearer', expires_in: 600 })));
    await expect(pending).rejects.toThrow('desconectada');
    expect(entries.has(savedKey())).toBe(false);
  });

  it('authenticates an organization launch with the primary Voidr audience', async () => {
    let authorizationUrl = '';
    openExternal.mockImplementation(async (value: string) => {
      authorizationUrl = value;
      const authorize = new URL(value);
      const callback = new URL(authorize.searchParams.get('redirect_uri')!);
      callback.searchParams.set('code', 'organization-code');
      callback.searchParams.set('state', authorize.searchParams.get('state')!);
      setTimeout(
        () => get(callback, (response) => response.resume()).on('error', () => undefined),
        0,
      );
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: 'organization-access-token-that-stays-in-main-process',
          token_type: 'Bearer',
          expires_in: 600,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const { store, entries } = tokenStore();
    const session = new LoopParticipantAuthSession(store);
    await expect(
      session.accessToken('organization', 'org_voidrProduction'),
    ).resolves.toContain('organization-access');

    const authorize = new URL(authorizationUrl);
    expect(authorize.searchParams.get('audience')).toBe('https://service.bounties4.com/');
    expect(authorize.searchParams.get('organization')).toBe('org_voidrProduction');
    expect(authorize.searchParams.get('scope')).toContain('offline_access');
    expect(entries.size).toBe(1);
    expect(new LoopParticipantAuthSession(store).cachedAccessToken('organization', 'org_voidrProduction')).toContain('organization-access');
    expect(authorize.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:47821/callback');
  });

  it('never reuses an organization token for a different tenant', async () => {
    const openedOrganizations: string[] = [];
    openExternal.mockImplementation(async (value: string) => {
      const authorize = new URL(value);
      openedOrganizations.push(authorize.searchParams.get('organization') ?? '');
      const callback = new URL(authorize.searchParams.get('redirect_uri')!);
      callback.searchParams.set('code', `code-${openedOrganizations.length}`);
      callback.searchParams.set('state', authorize.searchParams.get('state')!);
      setTimeout(
        () => get(callback, (response) => response.resume()).on('error', () => undefined),
        0,
      );
    });
    let token = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(
        JSON.stringify({
          access_token: `organization-access-token-${++token}-that-stays-in-main-process`,
          token_type: 'Bearer',
          expires_in: 600,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const session = new LoopParticipantAuthSession();
    const first = await session.accessToken('organization', 'org_firstTenant');
    const second = await session.accessToken('organization', 'org_secondTenant');

    expect(first).not.toBe(second);
    expect(openedOrganizations).toEqual(['org_firstTenant', 'org_secondTenant']);
  });

  it('uses system-browser PKCE and keeps the access token in main-process memory', async () => {
    process.env.VOIDR_PARTICIPANT_AUTH_DOMAIN = 'tenant.example.test';
    process.env.VOIDR_PARTICIPANT_AUTH_CLIENT_ID = 'capture-participant-client';
    process.env.VOIDR_PARTICIPANT_AUTH_AUDIENCE = 'https://api.example.test/loop-participant';
    let authorizationUrl = '';
    openExternal.mockImplementation(async (value: string) => {
      authorizationUrl = value;
      const authorize = new URL(value);
      const callback = new URL(authorize.searchParams.get('redirect_uri')!);
      callback.searchParams.set('code', 'single-use-code');
      callback.searchParams.set('state', authorize.searchParams.get('state')!);
      setTimeout(
        () => get(callback, (response) => response.resume()).on('error', () => undefined),
        0,
      );
    });
    const tokenRequest = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: 'participant-access-token-that-stays-in-main-process',
          token_type: 'Bearer',
          expires_in: 600,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const session = new LoopParticipantAuthSession();
    const first = await session.accessToken();
    const second = await session.accessToken();

    expect(first).toBe('participant-access-token-that-stays-in-main-process');
    expect(second).toBe(first);
    expect(openExternal).toHaveBeenCalledOnce();
    const authorize = new URL(authorizationUrl);
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorize.searchParams.get('connection')).toBe('google-oauth2');
    expect(authorizationUrl).not.toContain(first);
    expect(tokenRequest).toHaveBeenCalledOnce();
  });
});
