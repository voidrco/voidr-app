import { describe, expect, it, vi } from 'vitest';
import { createWorkspaceSession, workspacePlatformLoopsUrl } from './workspace-session';

const localRuntime = {
  serviceUrl: 'http://127.0.0.1:3000/v1',
  collectorUrl: 'http://127.0.0.1:3100',
  collectorScriptUrl: 'http://127.0.0.1:8889/dist/recorder.min.js',
  platformUrl: 'http://127.0.0.1:3030',
  localAdapter: true,
  localDevKey: 'voidr-verification-local',
  organizationId: 'org_verification_local',
};

const remoteRuntime = {
  ...localRuntime,
  serviceUrl: 'https://api.voidr.co/v1',
  collectorUrl: 'https://collector.voidr.co',
  collectorScriptUrl: 'https://cdn.voidr.co/voidr-collector/default/latest/recorder.min.js',
  platformUrl: 'https://platform.voidr.co',
  localAdapter: false,
};

describe('workspace session', () => {
  it('does not authenticate the explicit localhost adapter', async () => {
    const accessToken = vi.fn();
    const cachedAccessToken = vi.fn();

    const session = await createWorkspaceSession(localRuntime, { accessToken, cachedAccessToken });

    expect(session.accessToken).toBeUndefined();
    expect(accessToken).not.toHaveBeenCalled();
    expect(cachedAccessToken).not.toHaveBeenCalled();
  });

  it('blocks production before a tenant handoff arrives', async () => {
    const accessToken = vi.fn();
    const cachedAccessToken = vi.fn();

    await expect(
      createWorkspaceSession(
        {
          ...remoteRuntime,
          organizationId: 'org_pending_launch',
        },
        { accessToken, cachedAccessToken },
      ),
    ).rejects.toThrow('Conecte este aplicativo');
    expect(accessToken).not.toHaveBeenCalled();
  });

  it('uses only an already connected organization-scoped token for a remote workspace', async () => {
    const accessToken = vi.fn();
    const cachedAccessToken = vi.fn().mockReturnValue('access-token');

    const session = await createWorkspaceSession(
      {
        ...remoteRuntime,
        organizationId: 'org_gWjyShjiTKA1ndtD',
      },
      { accessToken, cachedAccessToken },
    );

    expect(session.accessToken).toBe('access-token');
    expect(cachedAccessToken).toHaveBeenCalledWith(
      'organization',
      'org_gWjyShjiTKA1ndtD',
    );
    expect(accessToken).not.toHaveBeenCalled();
  });

  it('trusts the explicit staging service and platform pair', async () => {
    const accessToken = vi.fn();
    const cachedAccessToken = vi.fn().mockReturnValue('staging-access-token');
    const stagingRuntime = {
      ...remoteRuntime,
      serviceUrl: 'https://api-staging.voidr.co/v1',
      platformUrl: 'https://platform-staging.voidr.co',
      organizationId: 'org_XpZs54aP8Oop8qUz',
    };

    const session = await createWorkspaceSession(stagingRuntime, { accessToken, cachedAccessToken });

    expect(session.accessToken).toBe('staging-access-token');
    expect(cachedAccessToken).toHaveBeenCalledWith(
      'organization',
      'org_XpZs54aP8Oop8qUz',
    );
    expect(workspacePlatformLoopsUrl(stagingRuntime)).toBe(
      'https://platform-staging.voidr.co/loops?capture=desktop',
    );
  });

  it('rejects a remote endpoint before requesting a bearer token', async () => {
    const accessToken = vi.fn();
    const cachedAccessToken = vi.fn().mockReturnValue('access-token');

    await expect(
      createWorkspaceSession(
        {
          ...remoteRuntime,
          serviceUrl: 'https://attacker.example/v1',
          organizationId: 'org_gWjyShjiTKA1ndtD',
        },
        { accessToken, cachedAccessToken },
      ),
    ).rejects.toThrow('não é confiável');
    expect(accessToken).not.toHaveBeenCalled();
  });

  it('opens only the platform paired with the trusted workspace channel', () => {
    expect(
      workspacePlatformLoopsUrl({
        ...remoteRuntime,
        organizationId: 'org_gWjyShjiTKA1ndtD',
      }),
    ).toBe('https://platform.voidr.co/loops?capture=desktop');

    expect(
      workspacePlatformLoopsUrl({
        ...remoteRuntime,
        serviceUrl: 'https://pilot.api-preview.voidr.co/v1',
        platformUrl: 'https://pilot.app-preview.voidr.co',
        organizationId: 'org_gWjyShjiTKA1ndtD',
      }),
    ).toBe('https://pilot.app-preview.voidr.co/loops?capture=desktop');

    expect(() =>
      workspacePlatformLoopsUrl({
        ...remoteRuntime,
        platformUrl: 'https://attacker.example',
        organizationId: 'org_gWjyShjiTKA1ndtD',
      }),
    ).toThrow('não é confiável');
  });
});
