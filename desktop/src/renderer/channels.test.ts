import { describe, expect, it } from 'vitest';
import type { LocalRuntimeConfig } from '@voidr/capture-contracts';
import {
  restoreRuntime,
  runtimeForDeployment,
  serializeWorkspaceBinding,
  workspaceContextLabel,
} from './channels';

const local: LocalRuntimeConfig = {
  serviceUrl: 'http://127.0.0.1:3000/v1',
  collectorUrl: 'http://localhost:3100',
  collectorScriptUrl: 'http://localhost:8889/dist/recorder.min.js',
  platformUrl: 'http://localhost:3030',
  localAdapter: true,
  localDevKey: 'voidr-verification-local',
  organizationId: 'org_local',
};

describe('capture deployment channels', () => {
  it('rejects a production link in a local build', () => {
    expect(() => runtimeForDeployment('production', local, 'org_production'))
      .toThrow('Este Voidr Capture é do ambiente local');
  });

  it('keeps a local link on loopback and binds its organization', () => {
    expect(runtimeForDeployment('local', local, 'org_fixture')).toMatchObject({
      serviceUrl: 'http://127.0.0.1:3000/v1',
      localAdapter: true,
      localDevKey: 'voidr-verification-local',
      organizationId: 'org_fixture',
    });
  });

  it('rejects a staging link in a local build', () => {
    expect(() => runtimeForDeployment('staging', local, 'org_itau'))
      .toThrow('Este Voidr Capture é do ambiente local');
  });

  it('rejects a preview link in a local build', () => {
    expect(() =>
      runtimeForDeployment('preview', local, 'org_serasa_agro', 'release-hive-tctx'),
    ).toThrow('Este Voidr Capture é do ambiente local');
  });

  it('ignores a stale persisted runtime when a local launch arrives', () => {
    const stale = {
      ...local,
      serviceUrl: 'http://127.0.0.1:3999/v1',
      collectorUrl: 'http://127.0.0.1:3998',
      localDevKey: 'obsolete-key',
    };

    expect(runtimeForDeployment('local', stale, 'org_fixture')).toMatchObject({
      serviceUrl: 'http://127.0.0.1:3000/v1',
      collectorUrl: 'http://localhost:3100',
      collectorScriptUrl: 'http://localhost:8889/dist/recorder.min.js',
      localDevKey: 'voidr-verification-local',
      organizationId: 'org_fixture',
    });
  });

  it('restores only the organization binding from renderer storage', () => {
    const restored = restoreRuntime(
      JSON.stringify({
        organizationId: 'org_blip',
        serviceUrl: 'https://attacker.example/v1',
        localAdapter: true,
        localDevKey: 'attacker-key',
      }),
    );

    expect(restored).toMatchObject({
      organizationId: 'org_blip',
      serviceUrl: 'http://127.0.0.1:3000/v1',
      localAdapter: true,
      localDevKey: 'voidr-verification-local',
    });
    expect(JSON.parse(serializeWorkspaceBinding(restored))).toEqual({
      organizationId: 'org_blip',
    });
  });

  it('uses an actionable workspace label before the first production handoff', () => {
    expect(
      workspaceContextLabel({
        ...local,
        organizationId: 'org_pending_launch',
      }),
    ).toBe('Conecte seu workspace');
    expect(workspaceContextLabel(local)).toBe('Workspace local');
  });
});
