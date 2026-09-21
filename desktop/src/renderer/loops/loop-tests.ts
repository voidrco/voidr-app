import type { DesktopLoopCycleSummary } from '@voidr/capture-contracts';
import type { AiRun } from '../../shared/ai-tester';
import { aiStatus } from './AiTesterWorkspace';

export function aiTestStatus(run: AiRun) {
  if (run.status !== 'completed') return { label: aiStatus[run.status] ?? run.status, tone: 'neutral' as const };
  if (run.results.some(result => result.outcome === 'divergence')) return { label: 'Divergência encontrada', tone: 'error' as const };
  if (!run.results.length || run.results.some(result => result.outcome !== 'passed')) return { label: 'Não foi possível verificar', tone: 'warning' as const };
  const partial = Boolean(run.plan?.gaps?.length || run.plan?.scenarios?.some(scenario => !run.plan?.journeys.some(journey => journey.scenarioId === scenario.id && journey.scenarioVersion === scenario.version)));
  return partial ? { label: 'Passou · cobertura parcial', tone: 'warning' as const } : { label: 'Passou', tone: 'success' as const };
}

export function loopTests(cycles: DesktopLoopCycleSummary[], runs: AiRun[]) {
  const human = cycles.map(cycle => ({ id: cycle.id, at: cycle.createdAt, kind: 'human' as const, cycle }));
  const ai = runs.filter(run => !run.captureCycles?.length).map(run => ({ id: `ai:${run.runId}`, at: run.createdAt ?? null, kind: 'ai' as const, run }));
  return [...human, ...ai].sort((a, b) => Date.parse(b.at ?? '') - Date.parse(a.at ?? '') || a.id.localeCompare(b.id));
}

export function aiCycleResult(cycleId: string, runs: AiRun[]) {
  const run = runs.find(run => run.captureCycles?.some(capture => capture.cycleId === cycleId));
  const capture = run?.captureCycles.find(capture => capture.cycleId === cycleId);
  return run && capture ? { run, journeyId: capture.journeyId, result: run.results.find(result => result.journeyId === capture.journeyId) } : undefined;
}
