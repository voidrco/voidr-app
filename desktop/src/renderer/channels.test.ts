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
  it('routes a production link to baked HTTPS endpoints even from a dev build', () => {
    const runtime = runtimeForDeployment('production', local, 'org_production');

    expect(runtime).toMatchObject({
      serviceUrl: 'https://api.voidr.co/v1',
      collectorUrl: 'https://collector.voidr.co',
      localAdapter: false,
      organizationId: 'org_production',
    });
  });

  it('keeps a local link on loopback and binds its organization', () => {
    expect(runtimeForDeployment('local', local, 'org_fixture')).toMatchObject({
      serviceUrl: 'http://127.0.0.1:3000/v1',
      localAdapter: true,
      localDevKey: 'voidr-verification-local',
      organizationId: 'org_fixture',
    });
  });

  it('derives branch preview endpoints without accepting arbitrary origins', () => {
    expect(
      runtimeForDeployment('preview', local, 'org_serasa_agro', 'release-hive-tctx'),
    ).toMatchObject({
      serviceUrl: 'https://release-hive-tctx.api-preview.voidr.co/v1',
      collectorUrl: 'https://collector-staging.voidr.co',
      platformUrl: 'https://release-hive-tctx.app-preview.voidr.co',
      localAdapter: false,
      organizationId: 'org_serasa_agro',
    });
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
        ...runtimeForDeployment('production', local, 'org_pending_launch'),
      }),
    ).toBe('Conecte seu workspace');
    expect(workspaceContextLabel(local)).toBe('Workspace local');
  });
});
