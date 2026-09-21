import { ScenarioCoverage } from './ScenarioCoverage';
import { useEffect, useState } from 'react';
import { Button, VoidrMark } from '@voidr/capture-design-system';
import type { LocalRuntimeConfig } from '@voidr/capture-contracts';
import type { AiState } from '../../shared/ai-tester';
import type { JourneyState } from '../../shared/journeys';
import { LoopsWorkspace } from './LoopsWorkspace';

export const aiStatus: Record<string, string> = { planning: 'Preparando jornadas', ready: 'Pronto para executar', running: 'Executando',
  awaiting_intervention: 'Aguardando autenticação', completed: 'Execução concluída', cancelled: 'Cancelada', interrupted: 'Interrompida',
  blocked: 'Faltam informações', planning_failed: 'Falha ao preparar', passed: 'Passou', divergence: 'Divergência encontrada', unable_to_verify: 'Não foi possível verificar' };

const planningStages: Record<string, string> = { reading_sources: 'Lendo fontes', reading_sessions: 'Lendo sessões dos participantes', extracting_angles: 'Identificando ângulos de teste', mapping_coverage: 'Consolidando cenários', preparing_journeys: 'Preparando jornadas', saving_scenarios: 'Salvando cenários' };

function AiPreparation({ state }: { state: AiState }) {
  const planning = state.busy && (!state.run || state.run.status === 'planning');
  const title = planning ? planningStages[state.run?.planningStage ?? ''] ?? 'Preparando jornadas' : aiStatus[state.run?.status ?? ''] ?? 'Preparando execução';
  return <section className="ai-tester-preparation" aria-label="Estado do Voidr AI" aria-busy={planning}>
    {state.busy && <span className="ai-tester-spinner" aria-hidden="true" />}
    <h2 role="status">{title}</h2>
    <p>{planning ? 'Analisando a descrição do Loop e os testes dos participantes para definir o que testar.'
      : state.run?.status === 'cancelled' ? 'A execução foi cancelada. O plano continua disponível no Loop.'
      : 'Consulte as jornadas e os resultados acima para acompanhar esta execução.'}</p>
    {planning && <p>O navegador aparecerá quando a primeira jornada começar. Isso pode levar alguns minutos.</p>}
  </section>;
}

export function AiTesterWorkspace({ runtime, onRunning }: { runtime: LocalRuntimeConfig; onRunning: (running: boolean) => void }) {
  const [state, setState] = useState<AiState>({ busy: false, uploadPending: false });
  const [engineRunning, setEngineRunning] = useState(false);
  const [error, setError] = useState('');
  const [managedRunId, setManagedRunId] = useState<string>();
  const [finalizing, setFinalizing] = useState(false);
  useEffect(() => {
    const unsubscribe = window.voidrCapture.aiTester.onChange(setState);
    void window.voidrCapture.aiTester.status().then(setState);
    const updateEngine = (value: JourneyState) => { setManagedRunId(value.managedRunId); setFinalizing(Boolean(value.finalizing)); };
    const unsubscribeEngine = window.voidrCapture.journeys.onChange(updateEngine);
    void window.voidrCapture.journeys.status().then(updateEngine);
    return () => { unsubscribe(); unsubscribeEngine(); };
  }, []);
  useEffect(() => { onRunning(state.busy || engineRunning); }, [state.busy, engineRunning, onRunning]);
  const invoke = (operation: Promise<unknown>) => { setError(''); void operation.catch(() => setError('Não foi possível concluir. Tente novamente.')); };
  const run = state.run;
  const input = run ? { runtime, loopId: run.loopId, runId: run.runId } : undefined;
  return <div className="ai-tester-workspace">
    {run && <section className="ai-tester-context" aria-label="Execução do Voidr AI">
      <div className="ai-tester-heading"><VoidrMark size={20} /><strong>Voidr AI · {finalizing && managedRunId === run.runId ? 'Finalizando evidências' : run.status === 'planning' ? planningStages[run.planningStage ?? ''] ?? aiStatus.planning : aiStatus[run.status] ?? run.status}</strong>
        {!state.busy && <Button size="sm" variant="ghost" onClick={() => invoke(window.voidrCapture.aiTester.clear())}>Jornada avulsa</Button>}
        {run.plan && <span>{run.results.length}/{run.plan.journeys.length} jornadas</span>}
        {state.busy && <Button size="sm" variant="ghost" onClick={() => invoke(window.voidrCapture.aiTester.cancel())}>Cancelar</Button>}
        {run.status === 'awaiting_intervention' && state.busy && <Button size="sm" onClick={() => invoke(window.voidrCapture.aiTester.resume())}>Continuar após autenticação</Button>}
        {!state.busy && input && run.status === 'ready' && <Button size="sm" onClick={() => invoke(window.voidrCapture.aiTester.start(input))}>Executar jornadas preparadas</Button>}
        {!state.busy && ['cancelled', 'planning_failed'].includes(run.status) && <Button size="sm" onClick={() => invoke(window.voidrCapture.aiTester.start({ runtime, loopId: run.loopId }))}>Executar plano do Loop</Button>}
        {!state.busy && input && (state.uploadPending || ['running', 'awaiting_intervention', 'interrupted'].includes(run.status)) &&
          <Button size="sm" onClick={() => invoke(window.voidrCapture.aiTester.retry(input))}>Reenviar resultados e evidências</Button>}
      </div>
      {run.status === 'awaiting_intervention' && <p>Conclua a autenticação na prévia abaixo. A sessão será mantida.</p>}
      {(state.error || error || run.error) && <p role="alert">{error || state.error || run.error}</p>}
      {run.plan?.scenarios && <ScenarioCoverage scenarios={run.plan.scenarios} run={run} />}
      {(run.plan || run.sources.length > 0) && <details open={!state.busy}><summary>Jornadas, resultados e fontes</summary>
        {run.plan?.warnings.map((warning, index) => <p key={index}>{warning}</p>)}
        {run.plan?.journeys.map(journey => {
          const result = run.results.find(item => item.journeyId === journey.id);
          return <article key={journey.id} className="ai-tester-journey">
            <strong>{journey.objective}</strong><span>{result ? aiStatus[result.outcome] : journey.blockers.length ? 'Bloqueada' : run.journeyId === journey.id ? aiStatus[run.status] : 'Aguardando'}</span>
            {result && <p>{result.reason}</p>}{journey.blockers.map((blocker, index) => <p key={index}>{blocker}</p>)}
            <details><summary>Passos e origem</summary>
              {journey.prerequisites.length > 0 && <p>Pré-condições: {journey.prerequisites.join('; ')}</p>}
              {journey.data.length > 0 && <p>Dados: {journey.data.join('; ')}</p>}
              <ol>{journey.steps.map((step, index) => <li key={index}>{step.kind === 'assertion' ? '✓ ' : ''}{step.instruction}</li>)}</ol>
              {run.sources.filter(source => journey.sources.includes(source.id)).map(source => <p key={source.id}>{source.kind === 'description' ? 'Descrição do Loop' : source.label ?? `Captura ${source.id}`} · versão {source.version.slice(0, 12)}</p>)}
            </details>
            {input && run.artifacts.filter(artifact => artifact.journeyId === journey.id).map(artifact => <Button key={artifact.id} variant="ghost" size="sm" disabled={!artifact.uploaded}
              onClick={() => invoke(window.voidrCapture.aiTester.artifact({ ...input, artifactId: artifact.id }))}>{artifact.name}{artifact.uploaded ? '' : ' · envio pendente'}</Button>)}
          </article>;
        })}
      </details>}
    </section>}
    {(run ? managedRunId !== run.runId : state.busy) && <AiPreparation state={state} />}
    {((!run && !state.busy) || (run && managedRunId === run.runId)) && <LoopsWorkspace onRunning={setEngineRunning} />}
  </div>;
}
