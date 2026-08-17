import type {
  DesktopLoopCycleDetail,
  DesktopLoopCycleSummary,
} from '@voidr/capture-contracts';

type Wait = (milliseconds: number) => Promise<void>;

type LoadWorkspaceCycleInput = {
  cycleId: string;
  getCycle: () => Promise<DesktopLoopCycleDetail>;
  listCycles: () => Promise<DesktopLoopCycleSummary[]>;
  wait?: Wait;
};

export type WorkspaceCycleLoadResult =
  | {
      state: 'loaded';
      detail: DesktopLoopCycleDetail;
      cycles?: DesktopLoopCycleSummary[];
    }
  | {
      state: 'selection_changed';
      cycles: DesktopLoopCycleSummary[];
      selectedCycleId: string;
    }
  | {
      state: 'temporarily_unavailable';
      cycles?: DesktopLoopCycleSummary[];
    }
  | {
      state: 'failed';
    };

const defaultWait: Wait = (milliseconds) =>
  new Promise((resolve) => window.setTimeout(resolve, milliseconds));

function isNotFound(error: unknown): boolean {
  return error instanceof Error && /not found|não encontrad|identifier/i.test(error.message);
}

/**
 * The cycle list and its evidence detail are separate projections. Immediately
 * after a cycle changes state, the list may be ahead of the detail read model.
 * Reconcile the list and retry briefly so that this normal convergence never
 * leaks an IPC/backend error into the product UI.
 */
export async function loadWorkspaceCycleDetail({
  cycleId,
  getCycle,
  listCycles,
  wait = defaultWait,
}: LoadWorkspaceCycleInput): Promise<WorkspaceCycleLoadResult> {
  try {
    return { state: 'loaded', detail: await getCycle() };
  } catch (error) {
    if (!isNotFound(error)) return { state: 'failed' };
    await wait(250);
  }

  let cycles: DesktopLoopCycleSummary[] | undefined;
  try {
    cycles = await listCycles();
  } catch {
    // A failed reconciliation must not prevent the bounded detail retry.
  }

  if (cycles && !cycles.some((cycle) => cycle.id === cycleId)) {
    return {
      state: 'selection_changed',
      cycles,
      selectedCycleId: cycles[0]?.id ?? '',
    };
  }

  try {
    return { state: 'loaded', detail: await getCycle(), cycles };
  } catch (error) {
    if (!isNotFound(error)) return { state: 'failed' };
    await wait(750);
  }

  try {
    return { state: 'loaded', detail: await getCycle(), cycles };
  } catch (error) {
    return isNotFound(error)
      ? { state: 'temporarily_unavailable', cycles }
      : { state: 'failed' };
  }
}
