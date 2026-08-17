import { describe, expect, it, vi } from 'vitest';
import type {
  DesktopLoopCycleDetail,
  DesktopLoopCycleSummary,
} from '@voidr/capture-contracts';
import { loadWorkspaceCycleDetail } from './workspace-cycle-recovery';

const cycleId = '8785d2ae-487e-4fda-9ab4-02ca671c495e';

const summary: DesktopLoopCycleSummary = {
  id: cycleId,
  loopId: 'lts_smoke',
  number: 3,
  status: 'ready',
  mission: 'Validar a jornada',
  environment: 'local',
  applicationType: 'WEB',
  participant: null,
  participantRole: null,
  participantAvatarUrl: null,
  artifactReady: true,
  diagnosisReady: true,
  updatedAt: '2026-08-14T00:22:52.504Z',
  createdAt: '2026-08-14T00:21:52.839Z',
};

const detail: DesktopLoopCycleDetail = {
  loopId: 'lts_smoke',
  cycleId,
  cycleNumber: 3,
  durationMs: 2_850,
  replayAvailable: true,
  counts: {
    annotations: 1,
    actions: 8,
    consoleErrors: 0,
    failedRequests: 0,
    transcriptSegments: 0,
  },
  evidence: [],
};

const noWait = vi.fn(async () => undefined);

describe('workspace cycle detail recovery', () => {
  it('returns an available detail without refreshing the cycle list', async () => {
    const listCycles = vi.fn();

    const result = await loadWorkspaceCycleDetail({
      cycleId,
      getCycle: vi.fn().mockResolvedValue(detail),
      listCycles,
      wait: noWait,
    });

    expect(result).toEqual({ state: 'loaded', detail });
    expect(listCycles).not.toHaveBeenCalled();
  });

  it('recovers when the list projection becomes readable before the detail', async () => {
    const getCycle = vi
      .fn<() => Promise<DesktopLoopCycleDetail>>()
      .mockRejectedValueOnce(new Error(`LoopCycle with identifier '${cycleId}' not found`))
      .mockResolvedValueOnce(detail);

    const result = await loadWorkspaceCycleDetail({
      cycleId,
      getCycle,
      listCycles: vi.fn().mockResolvedValue([summary]),
      wait: noWait,
    });

    expect(result).toEqual({ state: 'loaded', detail, cycles: [summary] });
    expect(getCycle).toHaveBeenCalledTimes(2);
  });

  it('moves to the newest valid cycle when the selected one disappeared', async () => {
    const replacement = { ...summary, id: '756d80fd-6fc6-4385-b483-d5c08f549066', number: 2 };
    const getCycle = vi.fn().mockRejectedValue(new Error('not found'));

    const result = await loadWorkspaceCycleDetail({
      cycleId,
      getCycle,
      listCycles: vi.fn().mockResolvedValue([replacement]),
      wait: noWait,
    });

    expect(result).toEqual({
      state: 'selection_changed',
      cycles: [replacement],
      selectedCycleId: replacement.id,
    });
    expect(getCycle).toHaveBeenCalledTimes(1);
  });

  it('returns a product state instead of leaking a persistent backend error', async () => {
    const result = await loadWorkspaceCycleDetail({
      cycleId,
      getCycle: vi.fn().mockRejectedValue(new Error('remote IPC internals')),
      listCycles: vi.fn().mockResolvedValue([summary]),
      wait: noWait,
    });

    expect(result).toEqual({ state: 'failed' });
  });

  it('keeps a persistent not-found state recoverable without exposing its message', async () => {
    const result = await loadWorkspaceCycleDetail({
      cycleId,
      getCycle: vi.fn().mockRejectedValue(new Error(`LoopCycle '${cycleId}' not found`)),
      listCycles: vi.fn().mockResolvedValue([summary]),
      wait: noWait,
    });

    expect(result).toEqual({ state: 'temporarily_unavailable', cycles: [summary] });
  });
});
