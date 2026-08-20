import { get } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { openExternal } = vi.hoisted(() => ({ openExternal: vi.fn() }));
vi.mock('electron', () => ({ shell: { openExternal } }));

import { LoopParticipantAuthSession } from './loop-participant-auth';

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

    const session = new LoopParticipantAuthSession();
    await expect(
      session.accessToken('organization', 'org_voidrProduction'),
    ).resolves.toContain('organization-access');

    const authorize = new URL(authorizationUrl);
    expect(authorize.searchParams.get('audience')).toBe('https://service.bounties4.com/');
    expect(authorize.searchParams.get('organization')).toBe('org_voidrProduction');
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
