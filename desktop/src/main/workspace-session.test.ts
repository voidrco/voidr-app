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

    const session = await createWorkspaceSession(localRuntime, { accessToken });

    expect(session.accessToken).toBeUndefined();
    expect(accessToken).not.toHaveBeenCalled();
  });

  it('blocks production before a tenant handoff arrives', async () => {
    const accessToken = vi.fn();

    await expect(
      createWorkspaceSession(
        {
          ...remoteRuntime,
          organizationId: 'org_pending_launch',
        },
        { accessToken },
      ),
    ).rejects.toThrow('Conecte este aplicativo');
    expect(accessToken).not.toHaveBeenCalled();
  });

  it('requests an organization-scoped token for a remote workspace', async () => {
    const accessToken = vi.fn().mockResolvedValue('access-token');

    const session = await createWorkspaceSession(
      {
        ...remoteRuntime,
        organizationId: 'org_gWjyShjiTKA1ndtD',
      },
      { accessToken },
    );

    expect(session.accessToken).toBe('access-token');
    expect(accessToken).toHaveBeenCalledWith(
      'organization',
      'org_gWjyShjiTKA1ndtD',
    );
  });

  it('rejects a remote endpoint before requesting a bearer token', async () => {
    const accessToken = vi.fn().mockResolvedValue('access-token');

    await expect(
      createWorkspaceSession(
        {
          ...remoteRuntime,
          serviceUrl: 'https://attacker.example/v1',
          organizationId: 'org_gWjyShjiTKA1ndtD',
        },
        { accessToken },
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
    ).toBe('https://platform.voidr.co/loops');

    expect(
      workspacePlatformLoopsUrl({
        ...remoteRuntime,
        serviceUrl: 'https://pilot.api-preview.voidr.co/v1',
        platformUrl: 'https://pilot.app-preview.voidr.co',
        organizationId: 'org_gWjyShjiTKA1ndtD',
      }),
    ).toBe('https://pilot.app-preview.voidr.co/loops');

    expect(() =>
      workspacePlatformLoopsUrl({
        ...remoteRuntime,
        platformUrl: 'https://attacker.example',
        organizationId: 'org_gWjyShjiTKA1ndtD',
      }),
    ).toThrow('não é confiável');
  });
});
